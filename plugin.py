"""Vidosser - a collection of video viewing tools for WanGP.

Current tools (modules):
  * frame_step: step video frames with the mouse wheel (one notch = one frame,
    Shift + wheel = 10 frames; by default only while fullscreen) or the keyboard (S / A = next / previous frame,
    W / Q = jump forward / back), also in fullscreen.
  * save_frame: D (or a middle click / wheel click on the video) = save the displayed frame as PNG/JPG, extracted server-side from
    the source video with WanGP's own decoder (lossless, exact frame), either with
    a "save as" dialog or straight into a folder.

The browser part is ``vidosser.js``, injected through the official
``add_custom_js`` plugin API. The "Vidosser" tab edits ``settings.json`` (kept in
this folder) and applies changes live; it also hosts the hidden JS <-> Python
bridge used by save_frame. No core WanGP file is modified.
"""
import base64
import copy
import io
import json
import math
import os
import shutil
import subprocess
import tempfile
import traceback
import urllib.parse
from pathlib import Path

import gradio as gr

from shared.utils.plugins import WAN2GPPlugin

PLUGIN_VERSION = "1.2.0"
_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
SETTINGS_PATH = os.path.join(_PLUGIN_DIR, "settings.json")
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".mpeg", ".mpg", ".ogv"}
KEY_ACTIONS = [("next_frame", "Fotograma siguiente"), ("prev_frame", "Fotograma anterior"),
               ("jump_forward", "Salto adelante"), ("jump_back", "Salto atrás"),
               ("save_frame_as", "Guardar fotograma")]

DEFAULT_SETTINGS = {
    "general": {
        "default_fps": 16,          # used only when the real fps cannot be detected
        "min_video_size": 100,      # ignore tiny videos (thumbnails) smaller than this, in px
        "show_overlay": True,       # small info badge on the video (not possible in native <video> fullscreen)
        "overlay_ms": 1200,         # how long the badge stays visible (ms)
    },
    "keys": {                       # one key per action (case-insensitive, ignored while typing)
        "enabled": True,
        "next_frame": "s",
        "prev_frame": "a",
        "jump_forward": "w",
        "jump_back": "q",
        "save_frame_as": "d",
    },
    "frame_step": {
        "enabled": True,
        "wheel_enabled": True,      # one wheel notch = one frame
        "wheel_fullscreen_only": True,  # wheel steps only while a video (or its container) is fullscreen;
                                        # outside fullscreen the wheel scrolls the page as usual
        "shift_frames": 10,         # frames per notch while Shift is held
        "invert_direction": False,  # False: wheel down = next frame, wheel up = previous frame
        "jump_mode": "seconds",     # "seconds": jump_seconds converted with the video fps, "frames": jump_frames
        "jump_seconds": 0.5,
        "jump_frames": 8,
    },
    "save_frame": {
        "enabled": True,
        "format": "png",            # "png" | "jpg"
        "jpg_quality": 95,          # 1..100
        "mode": "ask",              # "ask": save-as dialog | "direct": straight into `folder`
        "folder": "",               # "" = <WanGP outputs folder>/frames
        "middle_click_save": True,  # middle mouse button (wheel click) on a video = save frame
    },
}
_CHOICES = {("frame_step", "jump_mode"): ("seconds", "frames"),
            ("save_frame", "format"): ("png", "jpg"),
            ("save_frame", "mode"): ("ask", "direct")}
_ALLOW_EMPTY = {("save_frame", "folder")}


def _coerce(section, key, default, value):
    if isinstance(default, bool):
        return value if isinstance(value, bool) else default
    if (section, key) in _CHOICES:
        value = str(value).strip().lower()
        if value == "jpeg":
            value = "jpg"
        return value if value in _CHOICES[(section, key)] else default
    if isinstance(default, str):
        if not isinstance(value, str):
            return default
        value = value.strip()
        if not value:
            return "" if (section, key) in _ALLOW_EMPTY else default
        return value.lower() if section == "keys" else value
    if isinstance(default, (int, float)):
        ok = isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 and math.isfinite(value)
        if not ok:
            return default
        return int(round(value)) if isinstance(default, int) else float(value)
    return default


def load_settings(path=None):
    settings = copy.deepcopy(DEFAULT_SETTINGS)
    path = path or SETTINGS_PATH
    try:
        with open(path, "r", encoding="utf-8") as reader:
            user_settings = json.load(reader)
    except FileNotFoundError:
        return settings
    except Exception as e:  # never break WanGP start-up because of a bad settings file
        print(f"[Vidosser] Ignoring invalid settings.json: {e}")
        return settings
    if not isinstance(user_settings, dict):
        return settings
    _migrate_legacy(user_settings)
    for section, defaults in DEFAULT_SETTINGS.items():
        user_section = user_settings.get(section)
        if not isinstance(user_section, dict):
            continue
        for key, default in defaults.items():
            if key in user_section:
                settings[section][key] = _coerce(section, key, default, user_section[key])
    settings["save_frame"]["jpg_quality"] = max(1, min(100, settings["save_frame"]["jpg_quality"]))
    return settings


def _migrate_legacy(user_settings):
    """Accept settings files of older versions. Missing keys always fall back to the
    built-in defaults (see load_settings), so a settings.json from any earlier version
    keeps working and is never required to be replaced on update."""
    fs = user_settings.get("frame_step")
    if isinstance(fs, dict):    # <= 1.0: keyboard options lived in frame_step as key_*
        keys = user_settings.setdefault("keys", {})
        if isinstance(keys, dict):
            for action, _label in KEY_ACTIONS:
                if f"key_{action}" in fs and action not in keys:
                    keys[action] = fs[f"key_{action}"]
            if "keyboard_enabled" in fs and "enabled" not in keys:
                keys["enabled"] = fs["keyboard_enabled"]


def save_settings(settings, path=None):
    path = path or SETTINGS_PATH
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as writer:
        json.dump(settings, writer, indent=2, ensure_ascii=False)
        writer.write("\n")
    os.replace(tmp, path)


def validate_keys(keys):
    """keys: dict action -> key. Returns (normalized dict, list of errors)."""
    errors, normalized, used = [], {}, {}
    labels = dict(KEY_ACTIONS)
    for action, _label in KEY_ACTIONS:
        key = str(keys.get(action) or "").strip()
        key = key.lower()
        if len(key) != 1 or not key.isprintable() or key.isspace():
            errors.append(f"«{labels[action]}»: pon una sola tecla (letra, número o signo).")
            continue
        if key in used:
            errors.append(f"La tecla «{key.upper()}» está repetida en «{labels[used[key]]}» y «{labels[action]}».")
            continue
        used[key] = action
        normalized[action] = key
    return normalized, errors


def build_js(settings=None):
    settings = settings or load_settings()
    with open(os.path.join(_PLUGIN_DIR, "vidosser.js"), "r", encoding="utf-8") as reader:
        script = reader.read()
    # The snippet is appended inside WanGP's main JS function body; it is wrapped
    # in its own IIFE and receives its configuration as a JSON literal.
    return script.replace("__VIDOSSER_SETTINGS__", json.dumps(settings)).replace("__VIDOSSER_VERSION__", PLUGIN_VERSION)


_CSS = """
<style>
.vidosser-hidden { display: none !important; }
.vidosser-key-input textarea, .vidosser-key-input input { text-align: center; font-family: ui-monospace, Consolas, monospace; font-size: 1.2em; text-transform: uppercase; }
</style>
"""


class VidosserPlugin(WAN2GPPlugin):
    def __init__(self):
        super().__init__()
        self.name = "Vidosser"
        self.version = PLUGIN_VERSION
        self.description = "Collection of video viewing tools: frame stepping (wheel, S/A, W/Q) and save displayed frame (D), also in fullscreen."
        self.server_config = None

    def setup_ui(self):
        self.request_global("server_config")
        self.add_custom_js(build_js())
        self.add_tab(tab_id="vidosser", label="Vidosser", component_constructor=self.create_ui)

    # ------------------------------------------------------------- folders
    def _save_path(self):
        config = self.server_config if isinstance(self.server_config, dict) else {}
        return config.get("save_path") or "outputs"

    def default_folder(self):
        return os.path.abspath(os.path.join(self._save_path(), "frames"))

    def resolve_folder(self, folder):
        folder = str(folder or "").strip().strip('"')
        return os.path.abspath(os.path.expanduser(folder)) if folder else self.default_folder()

    def check_folder(self, folder, create=True):
        """Returns (ok, absolute path, message)."""
        path = self.resolve_folder(folder)
        try:
            if not os.path.isdir(path):
                if os.path.exists(path):
                    return False, path, "existe pero no es una carpeta"
                if not create:
                    return True, path, "no existe todavía (se creará al guardar)"
                os.makedirs(path, exist_ok=True)
            fd, probe = tempfile.mkstemp(prefix=".vidosser_", dir=path)
            os.close(fd)
            os.remove(probe)
            return True, path, "lista para guardar"
        except Exception as e:
            return False, path, f"no se puede escribir ({e})"

    # ---------------------------------------------------------------- UI tab
    def create_ui(self):
        current = lambda section, key: (lambda: load_settings()[section][key])
        gr.HTML(_CSS)
        gr.Markdown(f"## Vidosser {PLUGIN_VERSION}\nHerramientas para ver vídeos. Los cambios se guardan en `settings.json` de la carpeta del plugin "
                    "y se aplican al momento en esta pestaña del navegador (en otras pestañas ya abiertas, al recargar). No hace falta reiniciar WanGP.")
        with gr.Group():
            gr.Markdown("### Teclas\nHaz clic en un cuadro y pulsa la tecla que quieras (Retroceso = borrar). "
                        "Las teclas no hacen nada mientras escribes en un cuadro de texto, ni con Ctrl/Alt/Cmd.")
            key_boxes = []
            with gr.Row():
                for action, label in KEY_ACTIONS:
                    key_boxes.append(gr.Textbox(label=label, value=current("keys", action), max_lines=1, min_width=120,
                                                elem_id=f"vidosser_key_{action}", elem_classes="vidosser-key-input"))
            keys_enabled = gr.Checkbox(label="Atajos de teclado activados", value=current("keys", "enabled"), elem_id="vidosser_keys_enabled")
        with gr.Group():
            gr.Markdown("### Paso de fotogramas")
            with gr.Row():
                wheel_enabled = gr.Checkbox(label="Rueda del ratón: 1 muesca = 1 fotograma", value=current("frame_step", "wheel_enabled"), elem_id="vidosser_wheel_enabled")
                wheel_fs_only = gr.Checkbox(label="Rueda solo a pantalla completa (fuera de ella la rueda desplaza la página como siempre)",
                                            value=current("frame_step", "wheel_fullscreen_only"), elem_id="vidosser_wheel_fullscreen_only")
                invert = gr.Checkbox(label="Invertir sentido de la rueda", value=current("frame_step", "invert_direction"), elem_id="vidosser_invert")
                shift_frames = gr.Number(label="Fotogramas con Shift + rueda", value=current("frame_step", "shift_frames"), precision=0, minimum=1, elem_id="vidosser_shift_frames")
            with gr.Row():
                jump_mode = gr.Radio(label="Salto (W / Q)", choices=[("En segundos", "seconds"), ("En fotogramas", "frames")], value=current("frame_step", "jump_mode"), elem_id="vidosser_jump_mode")
                jump_seconds = gr.Number(label="Segundos por salto", value=current("frame_step", "jump_seconds"), minimum=0.01, elem_id="vidosser_jump_seconds")
                jump_frames = gr.Number(label="Fotogramas por salto", value=current("frame_step", "jump_frames"), precision=0, minimum=1, elem_id="vidosser_jump_frames")
        with gr.Group():
            gr.Markdown("### Guardar fotograma")
            with gr.Row():
                sf_format = gr.Radio(label="Formato", choices=[("PNG (sin pérdida)", "png"), ("JPG", "jpg")], value=current("save_frame", "format"), elem_id="vidosser_format")
                jpg_quality = gr.Slider(label="Calidad JPG", minimum=1, maximum=100, step=1, value=current("save_frame", "jpg_quality"), elem_id="vidosser_jpg_quality")
                sf_mode = gr.Radio(label="Modo", choices=[("Preguntar dónde guardar", "ask"), ("Guardar directamente en la carpeta", "direct")], value=current("save_frame", "mode"), elem_id="vidosser_mode")
            with gr.Row():
                folder = gr.Textbox(label="Carpeta (modo directo, en el equipo donde corre WanGP)", value=current("save_frame", "folder"),
                                    placeholder=self.default_folder(), max_lines=1, scale=4, elem_id="vidosser_folder")
                check_btn = gr.Button("Comprobar carpeta", scale=1, elem_id="vidosser_check_folder")
            folder_status = gr.Markdown("", elem_id="vidosser_folder_status")
            middle_click = gr.Checkbox(label="Clic central (clic de la rueda) sobre el vídeo = guardar fotograma", value=current("save_frame", "middle_click_save"),
                                       elem_id="vidosser_middle_click_save")
        with gr.Group():
            gr.Markdown("### Indicador")
            with gr.Row():
                show_overlay = gr.Checkbox(label="Mostrar indicador sobre el vídeo", value=current("general", "show_overlay"), elem_id="vidosser_show_overlay")
                default_fps = gr.Number(label="FPS si no se pueden detectar", value=current("general", "default_fps"), minimum=1, elem_id="vidosser_default_fps")
        save_btn = gr.Button("Guardar ajustes", variant="primary", elem_id="vidosser_save_settings")
        status = gr.Markdown("", elem_id="vidosser_status")

        with gr.Group(elem_classes="vidosser-hidden"):
            settings_json = gr.Textbox(value=lambda: json.dumps(load_settings()), elem_id="vidosser_settings_json", show_label=False)
            bridge_req = gr.Textbox(value="", elem_id="vidosser_bridge_req", show_label=False)
            bridge_resp = gr.Textbox(value="", elem_id="vidosser_bridge_resp", show_label=False)
            bridge_btn = gr.Button("bridge", elem_id="vidosser_bridge_btn")

        inputs = key_boxes + [keys_enabled, wheel_enabled, invert, shift_frames, jump_mode, jump_seconds, jump_frames,
                              sf_format, jpg_quality, sf_mode, folder, show_overlay, default_fps, middle_click, wheel_fs_only]
        save_btn.click(fn=self._save_from_ui, inputs=inputs, outputs=[status, settings_json], show_progress="hidden").then(
            fn=None, inputs=[settings_json], outputs=None, js="(s) => { if (window.vidosser) window.vidosser.applySettings(s); }")
        check_btn.click(fn=self._check_folder_ui, inputs=[folder], outputs=[folder_status], show_progress="hidden")
        bridge_btn.click(fn=self._bridge, inputs=[bridge_req], outputs=[bridge_resp], show_progress="hidden").then(
            fn=None, inputs=[bridge_resp], outputs=None, js="(r) => { if (window.vidosser) window.vidosser.core.bridgeResponse(r); }")

    def _check_folder_ui(self, folder):
        ok, path, message = self.check_folder(folder, create=True)
        return f"{'✅' if ok else '❌'} `{path}`: {message}"

    def _save_from_ui(self, k_next, k_prev, k_jf, k_jb, k_save, keys_enabled, wheel_enabled, invert, shift_frames,
                      jump_mode, jump_seconds, jump_frames, sf_format, jpg_quality, sf_mode, folder, show_overlay, default_fps,
                      middle_click=True, wheel_fs_only=True):
        settings = load_settings()
        keys, errors = validate_keys({"next_frame": k_next, "prev_frame": k_prev, "jump_forward": k_jf,
                                      "jump_back": k_jb, "save_frame_as": k_save})
        def number(value, label, minimum, maximum, integer):
            try:
                v = float(value)
            except (TypeError, ValueError):
                v = float("nan")
            if not math.isfinite(v) or v < minimum or v > maximum:
                errors.append(f"«{label}» debe estar entre {minimum} y {maximum}.")
                return None
            return int(round(v)) if integer else round(v, 3)
        shift_frames = number(shift_frames, "Fotogramas con Shift + rueda", 1, 1000, True)
        jump_seconds = number(jump_seconds, "Segundos por salto", 0.01, 600, False)
        jump_frames = number(jump_frames, "Fotogramas por salto", 1, 100000, True)
        jpg_quality = number(jpg_quality, "Calidad JPG", 1, 100, True)
        default_fps = number(default_fps, "FPS si no se pueden detectar", 1, 1000, False)
        folder = str(folder or "").strip().strip('"')
        if sf_mode == "direct" or folder:
            ok, path, message = self.check_folder(folder, create=sf_mode == "direct")
            if not ok:
                errors.append(f"Carpeta `{path}`: {message}.")
        if errors:
            return "❌ No se ha guardado:\n\n- " + "\n- ".join(errors), gr.update()
        settings["keys"].update(keys, enabled=bool(keys_enabled))
        settings["frame_step"].update(wheel_enabled=bool(wheel_enabled), wheel_fullscreen_only=bool(wheel_fs_only), invert_direction=bool(invert), shift_frames=shift_frames,
                                      jump_mode=jump_mode if jump_mode in ("seconds", "frames") else "seconds",
                                      jump_seconds=jump_seconds, jump_frames=jump_frames)
        settings["save_frame"].update(format=sf_format if sf_format in ("png", "jpg") else "png", jpg_quality=jpg_quality,
                                      mode=sf_mode if sf_mode in ("ask", "direct") else "ask", folder=folder,
                                      middle_click_save=bool(middle_click))
        settings["general"].update(show_overlay=bool(show_overlay), default_fps=default_fps)
        try:
            save_settings(settings)
        except Exception as e:
            return f"❌ No se ha podido escribir settings.json: {e}", gr.update()
        return "✅ Ajustes guardados y aplicados (en otras pestañas del navegador ya abiertas, recarga la página).", json.dumps(settings)

    # ------------------------------------------------------------ JS bridge
    def _bridge(self, raw):
        try:
            req = json.loads(raw or "{}")
        except Exception:
            return json.dumps({"ok": False, "error": "petición no válida"})
        try:
            if req.get("action") == "save_frame":
                out = self.save_frame(req)
            else:
                out = {"ok": False, "error": "acción desconocida"}
        except Exception as e:
            traceback.print_exc()
            out = {"ok": False, "error": str(e)}
        out["id"] = req.get("id")
        return json.dumps(out)

    def _allowed_roots(self):
        config = self.server_config if isinstance(self.server_config, dict) else {}
        roots = [os.getcwd(), tempfile.gettempdir(), os.environ.get("GRADIO_TEMP_DIR")]
        roots += [config.get(k) for k in ("save_path", "image_save_path", "audio_save_path")]
        return [os.path.realpath(os.path.abspath(r)) for r in roots if r]

    def video_path_from_url(self, url):
        """Server path of a video shown by Gradio (/gradio_api/file=<path>), mapped back from
        WanGP's browser preview to the source file, restricted to WanGP / Gradio folders."""
        full = urllib.parse.unquote(urllib.parse.urlsplit(str(url or "")).path)
        idx = full.find("file=")
        if idx < 0:
            raise ValueError("este vídeo no es un archivo del servidor")
        path = full[idx + 5:]
        try:
            from shared.gradio.video_preview import _restore_preview_path
            path = _restore_preview_path(path) or path
        except Exception:
            pass
        real = os.path.realpath(os.path.abspath(path))
        if os.path.splitext(real)[1].lower() not in VIDEO_EXTS or not os.path.isfile(real):
            raise ValueError("vídeo no encontrado en el servidor")
        for root in self._allowed_roots():
            try:
                if os.path.commonpath([real, root]) == root:
                    return real
            except ValueError:
                continue
        raise ValueError("vídeo fuera de las carpetas de WanGP")

    @staticmethod
    def extract_frame(source, time_seconds, frame_hint=None):
        """Exact frame at `time_seconds`, decoded like WanGP's own "save frame" feature."""
        try:
            from shared.deepy.video_tools import resolve_video_frame_no
            from shared.utils.utils import get_video_frame
            frame_no = resolve_video_frame_no(source, time_seconds=time_seconds)
            return frame_no, get_video_frame(source, frame_no, return_PIL=True)
        except ImportError:
            pass
        # Fallback (WanGP helpers unavailable): ffmpeg, frame index from the browser.
        from PIL import Image
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            raise RuntimeError("ffmpeg no disponible")
        frame_no = max(0, int(frame_hint or 0))
        out = subprocess.run([ffmpeg, "-v", "error", "-nostdin", "-i", source, "-vf", f"select=eq(n\\,{frame_no})",
                              "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"], capture_output=True, check=True)
        image = Image.open(io.BytesIO(out.stdout))
        image.load()
        return frame_no, image.convert("RGB")

    @staticmethod
    def encode_image(image, fmt, quality):
        buf = io.BytesIO()
        if fmt == "jpg":
            image.convert("RGB").save(buf, format="JPEG", quality=int(quality), optimize=True)
            return buf.getvalue(), "image/jpeg"
        image.save(buf, format="PNG")
        return buf.getvalue(), "image/png"

    @staticmethod
    def write_unique(folder, base, ext, data):
        os.makedirs(folder, exist_ok=True)
        k = 0
        while True:
            path = os.path.join(folder, f"{base}{'_' + str(k) if k else ''}.{ext}")
            try:
                with open(path, "xb") as writer:   # exclusive create: never overwrite
                    writer.write(data)
                return path
            except FileExistsError:
                k += 1

    def save_frame(self, req):
        settings = load_settings()["save_frame"]
        if not settings["enabled"]:
            return {"ok": False, "error": "guardar fotograma está desactivado"}
        source = self.video_path_from_url(req.get("url"))
        t = float(req.get("time", 0))
        if not math.isfinite(t) or t < 0:
            raise ValueError("tiempo no válido")
        frame_no, image = self.extract_frame(source, t, req.get("frame"))
        fmt = settings["format"]
        ext = "jpg" if fmt == "jpg" else "png"
        data, mime = self.encode_image(image, fmt, settings["jpg_quality"])
        base = f"{Path(source).stem}_frame{int(frame_no):05d}"
        result = {"ok": True, "frame": int(frame_no), "width": image.width, "height": image.height, "name": f"{base}.{ext}", "source": source}
        if req.get("mode") == "direct":
            ok, folder, message = self.check_folder(settings["folder"], create=True)
            if not ok:
                return {"ok": False, "error": f"carpeta {folder}: {message}"}
            path = self.write_unique(folder, base, ext, data)
            result.update(path=path, name=os.path.basename(path))
        else:
            result.update(data=base64.b64encode(data).decode("ascii"), mime=mime)
        return result
