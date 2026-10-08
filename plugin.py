"""Vidosser - a collection of video viewing tools for WanGP.

Current tools (modules):
  * frame_step: step video frames with the mouse wheel (one notch = one frame,
    Shift + wheel = 10 frames, Ctrl + wheel = one short jump per notch; by default
    only while fullscreen), by dragging on the video with the left button (8 px =
    one frame) or with the keyboard (S / A = next / previous frame,
    W / Q = jump forward / back), also in fullscreen.
  * volume: click-and-hold on the video and drag vertically = volume (up = louder).
  * new_video: in fullscreen, a newly generated video doesn't replace the one you watch.
  * loop: loop all videos, L = loop on/off for the current video, I / O = A-B segment
    loop (frame accurate), U = clear the segment.
  * container_fs: video fullscreen on its container so overlays / messages stay visible.
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
import time
import traceback
import urllib.parse
from pathlib import Path

import gradio as gr

from shared.utils.plugins import WAN2GPPlugin

PLUGIN_VERSION = "1.4.1"
_PLUGIN_DIR = os.path.dirname(os.path.abspath(__file__))
SETTINGS_PATH = os.path.join(_PLUGIN_DIR, "settings.json")
VIDEO_EXTS = {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".mpeg", ".mpg", ".ogv"}
KEY_ACTIONS = [("next_frame", "Fotograma siguiente"), ("prev_frame", "Fotograma anterior"),
               ("jump_forward", "Salto adelante"), ("jump_back", "Salto atrás"),
               ("save_frame_as", "Guardar fotograma"),
               ("toggle_loop", "Bucle on/off (este vídeo)"), ("mark_in", "Inicio del segmento A-B"),
               ("mark_out", "Final del segmento A-B"), ("clear_segment", "Borrar segmento A-B")]
LOOP_ACTIONS = ("toggle_loop", "mark_in", "mark_out", "clear_segment")

DEFAULT_SETTINGS = {
    "general": {
        "default_fps": 16,          # used only when the real fps cannot be detected
        "min_video_size": 100,      # ignore tiny videos (thumbnails) smaller than this, in px
        "show_overlay": True,       # small info badge on the video (not possible in native <video> fullscreen)
        "overlay_ms": 1200,         # how long the badge stays visible (ms)
        "container_fullscreen": True,
        "hide_controls": "fullscreen",  # hide the video control bars: "off" | "fullscreen" | "always"
        "show_thin_progress": True,     # thin 3 px progress line at the bottom edge while controls are hidden  # video fullscreen (double-click / player button) on its container
                                       # instead of native <video> fullscreen, so overlays/toasts show
    },
    "keys": {                       # one key per action (case-insensitive, ignored while typing)
        "enabled": True,
        "next_frame": "s",
        "prev_frame": "a",
        "jump_forward": "w",
        "jump_back": "q",
        "save_frame_as": "d",
        "toggle_loop": "l",         # loop on/off for the current video
        "mark_in": "i",             # A-B segment loop: start = current frame
        "mark_out": "o",            # A-B segment loop: end = current frame
        "clear_segment": "u",       # remove the A-B segment
    },
    "frame_step": {
        "enabled": True,
        "wheel_enabled": True,      # one wheel notch = one frame
        "wheel_fullscreen_only": True,  # wheel steps only while a video (or its container) is fullscreen;
                                        # outside fullscreen the wheel scrolls the page as usual
        "wheel_jump_modifier": "ctrl",  # modifier + wheel = one short jump (jump_*) per notch:
                                        # "ctrl" | "alt" | "shift" | "meta" | "none"
        "shift_frames": 10,         # frames per notch while Shift is held
        "invert_direction": False,  # False: wheel down = next frame, wheel up = previous frame
        "drag_scrub": True,         # hold the left button on a video and drag horizontally = step frames
        "drag_pixels_per_frame": 8, # horizontal pixels per frame while dragging (1..200)
        "drag_invert": False,       # False: drag right = forward, drag left = backward
        "drag_button": "left",      # "left" | "right" (right: the context menu opens only for a plain right click)
        "drag_pointer_lock": True,  # Pointer Lock while scrubbing horizontally with the LEFT button in fullscreen only:
                                    # no screen edge (Chrome shows its "press Esc" banner); released on button up / blur / Esc
        "drag_hide_cursor": True,   # hide the cursor while the LEFT button is held during a drag in fullscreen only
        "jump_mode": "seconds",     # "seconds": jump_seconds converted with the video fps, "frames": jump_frames
        "jump_seconds": 0.5,
        "jump_frames": 8,
    },
    "loop": {
        "enabled": True,
        "loop_all": True,           # every video plays in loop
    },
    "volume": {
        "enabled": True,
        "drag_volume": True,        # click-and-hold on a video + vertical drag = volume (up = louder)
        "drag_pixels_per_percent": 2.0,  # vertical px per 1 % of volume (0.2..50)
        "drag_invert": False,       # False: drag up = louder
        "remember": True,           # keep the last volume for the next videos (also after a page reload)
    },
    "new_video": {
        "enabled": True,
        "no_autojump_fullscreen": True,   # while a video is fullscreen, a newly generated video doesn't replace it
        "jump_on_fullscreen_exit": True,  # on leaving fullscreen, show the newest video (what WanGP would have done)
        "notify": True,                   # "Nuevo vídeo listo" message in fullscreen
    },
    "save_frame": {
        "enabled": True,
        "format": "png",            # "png" | "jpg"
        "jpg_quality": 95,          # 1..100
        "mode": "ask",              # "ask": save-as dialog | "direct": straight into `folder`
        "folder": "",               # "" = <WanGP outputs folder>/frames
        "middle_click_save": True,  # middle mouse button (wheel click) on a video = save frame
        "toast": True,              # prominent "Fotograma guardado" message
        "toast_ms": 2500,           # how long it stays visible (ms)
        "flash": True,              # white flash over the video when saved
        "sound": True,              # camera-shutter sound on save (error beep on failure); the only
                                    # feedback possible in native <video> fullscreen
        "sound_volume": 60,         # 1..100
    },
}
_CHOICES = {("frame_step", "jump_mode"): ("seconds", "frames"),
            ("save_frame", "format"): ("png", "jpg"),
            ("save_frame", "mode"): ("ask", "direct"),
            ("frame_step", "wheel_jump_modifier"): ("ctrl", "alt", "shift", "meta", "none"),
            ("frame_step", "drag_button"): ("left", "right"),
            ("general", "hide_controls"): ("off", "fullscreen", "always")}
HIDE_CONTROLS_CHOICES = [("No", "off"), ("Solo a pantalla completa", "fullscreen"), ("Siempre", "always")]
DRAG_BUTTON_CHOICES = [("Izquierdo", "left"), ("Derecho", "right")]
JUMP_MODIFIER_CHOICES = [("Ctrl", "ctrl"), ("Alt", "alt"), ("Shift", "shift"), ("Meta (Cmd / Win)", "meta"), ("Ninguno", "none")]
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
    user_keys = user_settings.get("keys") if isinstance(user_settings.get("keys"), dict) else {}
    for section, defaults in DEFAULT_SETTINGS.items():
        user_section = user_settings.get(section)
        if not isinstance(user_section, dict):
            continue
        for key, default in defaults.items():
            if key in user_section:
                settings[section][key] = _coerce(section, key, default, user_section[key])
    settings["save_frame"]["jpg_quality"] = max(1, min(100, settings["save_frame"]["jpg_quality"]))
    settings["save_frame"]["sound_volume"] = max(1, min(100, settings["save_frame"]["sound_volume"]))
    settings["save_frame"]["toast_ms"] = max(500, min(30000, settings["save_frame"]["toast_ms"]))
    settings["frame_step"]["drag_pixels_per_frame"] = max(1, min(200, settings["frame_step"]["drag_pixels_per_frame"]))
    settings["volume"]["drag_pixels_per_percent"] = max(0.2, min(50.0, settings["volume"]["drag_pixels_per_percent"]))
    _resolve_new_key_conflicts(settings["keys"], {a for a, _l in KEY_ACTIONS if a in user_keys})
    return settings


_FALLBACK_KEYS = "lkjhgfpyxbnmzcvrt1234567890"


def _resolve_new_key_conflicts(keys, user_set):
    """A key that only comes from the built-in defaults (e.g. an action added in a newer
    version) must not steal a key the user already assigned to another action: the
    user's key wins and the new action moves to the first free fallback key."""
    taken = {keys[a] for a in user_set}
    for action, _label in KEY_ACTIONS:
        if action in user_set:
            continue
        if keys[action] in taken:
            free = next((k for k in _FALLBACK_KEYS if k not in taken and k not in
                         {keys[a] for a, _l in KEY_ACTIONS if a not in user_set and a != action}), None)
            if free:
                print(f"[Vidosser] key «{keys[action]}» is already used, «{action}» moved to «{free}»")
                keys[action] = free
        taken.add(keys[action])


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
        self.description = ("Collection of video viewing tools: frame stepping (wheel, S/A, W/Q, drag), volume by vertical drag, "
                            "save displayed frame (D), loops, and no jump to a new video while fullscreen.")
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
            for row in ([a for a in KEY_ACTIONS if a[0] not in LOOP_ACTIONS], [a for a in KEY_ACTIONS if a[0] in LOOP_ACTIONS]):
                with gr.Row():
                    for action, label in row:
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
                drag_scrub = gr.Checkbox(label="Arrastrar sobre el vídeo = pasar fotogramas", value=current("frame_step", "drag_scrub"),
                                         elem_id="vidosser_drag_scrub",
                                         info="Derecha = adelante, izquierda = atrás. Un clic sin arrastrar hace lo de siempre (izquierdo: pausa / reproduce; "
                                              "derecho: menú contextual). Shift = ×«Fotogramas con Shift», el modificador del salto corto = saltos cortos. "
                                              "Funciona también fuera de la pantalla completa.")
                drag_button = gr.Dropdown(label="Botón para arrastrar", choices=DRAG_BUTTON_CHOICES, value=current("frame_step", "drag_button"),
                                          elem_id="vidosser_drag_button")
                drag_ppf = gr.Number(label="Píxeles por fotograma al arrastrar", value=current("frame_step", "drag_pixels_per_frame"), precision=0,
                                     minimum=1, maximum=200, elem_id="vidosser_drag_pixels_per_frame")
                drag_invert = gr.Checkbox(label="Invertir sentido al arrastrar", value=current("frame_step", "drag_invert"), elem_id="vidosser_drag_invert")
            with gr.Row():
                drag_pointer_lock = gr.Checkbox(label="Bloquear el puntero al arrastrar (sin tope en el borde de la pantalla)",
                                                value=current("frame_step", "drag_pointer_lock"), elem_id="vidosser_drag_pointer_lock",
                                                info="Solo a pantalla completa, al pasar fotogramas con el botón izquierdo pulsado: el arrastre no se "
                                                     "detiene en el borde de la pantalla. Chrome muestra arriba su aviso «Pulsa Esc para mostrar el "
                                                     "cursor»: es normal. Al soltar el botón, Esc o cambiar de ventana el puntero se libera. Fuera de "
                                                     "la pantalla completa nunca se bloquea.")
                drag_hide_cursor = gr.Checkbox(label="Ocultar el cursor mientras arrastras", value=current("frame_step", "drag_hide_cursor"),
                                               elem_id="vidosser_drag_hide_cursor",
                                               info="Solo a pantalla completa y solo mientras mantienes pulsado el botón izquierdo (fotogramas o "
                                                    "volumen). En cualquier otro caso el cursor nunca desaparece.")
        with gr.Group():
            gr.Markdown("### Volumen\nHaz clic sobre el vídeo, mantén pulsado y arrastra **en vertical**: hacia arriba sube el volumen, hacia abajo lo baja. "
                        "Arrastrar en horizontal sigue pasando fotogramas: la dirección se decide en los primeros 4 px (la que más se mueva) y se mantiene "
                        "hasta que sueltas. Usa el mismo botón que el arrastre de fotogramas; a pantalla completa, con el botón izquierdo, el cursor "
                        "se oculta mientras arrastras (sin bloqueo del puntero).")
            with gr.Row():
                drag_volume = gr.Checkbox(label="Arrastrar en vertical = volumen", value=current("volume", "drag_volume"), elem_id="vidosser_drag_volume",
                                          info="Un clic o un doble clic sin arrastrar hacen lo de siempre. Si el vídeo está silenciado, al subir se activa el sonido. "
                                               "En pantallas táctiles, el deslizamiento vertical solo cambia el volumen a pantalla completa.")
                volume_ppp = gr.Number(label="Píxeles por 1 % de volumen", value=current("volume", "drag_pixels_per_percent"), minimum=0.2, maximum=50, step=0.5,
                                       elem_id="vidosser_volume_pixels_per_percent", info="2 = 200 px de arrastre para pasar de 0 % a 100 %.")
                volume_invert = gr.Checkbox(label="Invertir sentido del volumen (abajo = más alto)", value=current("volume", "drag_invert"), elem_id="vidosser_volume_invert")
                volume_remember = gr.Checkbox(label="Recordar el volumen para los siguientes vídeos", value=current("volume", "remember"), elem_id="vidosser_volume_remember",
                                              info="También tras recargar la página (se guarda en este navegador).")
        with gr.Group():
            gr.Markdown("### Salto corto\nCuánto salta cada pulsación de **W / Q** y cada muesca de la rueda con el modificador elegido.")
            with gr.Row():
                jump_mode = gr.Radio(label="Salto corto: medida", choices=[("En segundos", "seconds"), ("En fotogramas", "frames")], value=current("frame_step", "jump_mode"), elem_id="vidosser_jump_mode")
                jump_seconds = gr.Number(label="Salto corto: segundos", value=current("frame_step", "jump_seconds"), minimum=0.01, elem_id="vidosser_jump_seconds")
                jump_frames = gr.Number(label="Salto corto: fotogramas", value=current("frame_step", "jump_frames"), precision=0, minimum=1, elem_id="vidosser_jump_frames")
                jump_modifier = gr.Dropdown(label="Modificador + rueda = salto corto", choices=JUMP_MODIFIER_CHOICES,
                                            value=current("frame_step", "wheel_jump_modifier"), elem_id="vidosser_wheel_jump_modifier",
                                            info="Una muesca = un salto corto. Si eliges Shift, Shift + rueda hace el salto corto en lugar del multiplicador de Shift.")
        with gr.Group():
            gr.Markdown("### Bucle\n**L** activa o desactiva el bucle del vídeo actual. **I** / **O** marcan el inicio / final de un "
                        "segmento A-B en el fotograma actual: al reproducir, se repite solo ese tramo (exacto al fotograma). **U** borra el segmento. "
                        "El segmento es de cada vídeo y se mantiene mientras la página esté abierta. Las teclas se cambian arriba, en «Teclas».")
            loop_all = gr.Checkbox(label="Repetir todos los vídeos en bucle", value=current("loop", "loop_all"), elem_id="vidosser_loop_all")
        with gr.Group():
            gr.Markdown("### Vídeo nuevo\nCuando WanGP termina un vídeo, normalmente la galería salta a ese vídeo nuevo. "
                        "Fuera de la pantalla completa sigue haciéndolo como siempre.")
            with gr.Row():
                no_autojump = gr.Checkbox(label="A pantalla completa, no saltar al vídeo nuevo", value=current("new_video", "no_autojump_fullscreen"),
                                          elem_id="vidosser_no_autojump_fullscreen",
                                          info="Mientras ves un vídeo de la galería a pantalla completa, sigue en ese vídeo (misma posición, pausa o reproducción, "
                                               "sin salir de la pantalla completa). El vídeo nuevo se añade a la galería igualmente.")
                jump_on_exit = gr.Checkbox(label="Al salir de la pantalla completa, mostrar el vídeo nuevo", value=current("new_video", "jump_on_fullscreen_exit"),
                                           elem_id="vidosser_jump_on_fullscreen_exit",
                                           info="Lo que WanGP habría hecho; así, fuera de la pantalla completa, la galería sigue saltando a los vídeos nuevos.")
                new_notify = gr.Checkbox(label="Aviso «Nuevo vídeo listo»", value=current("new_video", "notify"), elem_id="vidosser_new_video_notify",
                                         info="No se puede mostrar en la pantalla completa nativa del vídeo.")
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
            gr.Markdown("#### Aviso al guardar")
            with gr.Row():
                toast = gr.Checkbox(label="Mensaje «Fotograma guardado»", value=current("save_frame", "toast"), elem_id="vidosser_toast")
                toast_s = gr.Number(label="Duración del mensaje (segundos)", value=lambda: load_settings()["save_frame"]["toast_ms"] / 1000,
                                    minimum=0.5, maximum=30, step=0.5, elem_id="vidosser_toast_s")
                flash = gr.Checkbox(label="Destello blanco sobre el vídeo", value=current("save_frame", "flash"), elem_id="vidosser_flash")
            with gr.Row():
                sound = gr.Checkbox(label="Sonido de cámara al guardar (pitido grave si falla)", value=current("save_frame", "sound"), elem_id="vidosser_sound",
                                    info="Es el único aviso posible en la pantalla completa nativa del vídeo.")
                sound_volume = gr.Slider(label="Volumen", minimum=1, maximum=100, step=1, value=current("save_frame", "sound_volume"), elem_id="vidosser_sound_volume")
        with gr.Group():
            gr.Markdown("### Indicador y pantalla completa")
            with gr.Row():
                show_overlay = gr.Checkbox(label="Mostrar indicador sobre el vídeo", value=current("general", "show_overlay"), elem_id="vidosser_show_overlay")
                container_fs = gr.Checkbox(label="Pantalla completa del vídeo con indicadores y mensajes", value=current("general", "container_fullscreen"),
                                           elem_id="vidosser_container_fullscreen",
                                           info="Doble clic en el vídeo o el botón de pantalla completa del reproductor de WanGP usan una pantalla completa "
                                                "en la que se ven el indicador y los mensajes. El botón de pantalla completa de la barra nativa del navegador sigue siendo nativo.")
                hide_controls = gr.Dropdown(label="Ocultar la barra de controles del vídeo", choices=HIDE_CONTROLS_CHOICES,
                                            value=current("general", "hide_controls"), elem_id="vidosser_hide_controls",
                                            info="Sin barra, el clic (o la barra espaciadora) sigue pausando / reproduciendo y todo el vídeo sirve para arrastrar.")
                thin_progress = gr.Checkbox(label="Barra de progreso fina (3 px) cuando los controles están ocultos", value=current("general", "show_thin_progress"),
                                            elem_id="vidosser_show_thin_progress")
                default_fps = gr.Number(label="FPS si no se pueden detectar", value=current("general", "default_fps"), minimum=1, elem_id="vidosser_default_fps")
        save_btn = gr.Button("Guardar ajustes", variant="primary", elem_id="vidosser_save_settings")
        status = gr.Markdown("", elem_id="vidosser_status")

        with gr.Group(elem_classes="vidosser-hidden"):
            settings_json = gr.Textbox(value=lambda: json.dumps(load_settings()), elem_id="vidosser_settings_json", show_label=False)
            bridge_req = gr.Textbox(value="", elem_id="vidosser_bridge_req", show_label=False)
            bridge_resp = gr.Textbox(value="", elem_id="vidosser_bridge_resp", show_label=False)
            bridge_btn = gr.Button("bridge", elem_id="vidosser_bridge_btn")

        inputs = key_boxes + [keys_enabled, wheel_enabled, invert, shift_frames, jump_mode, jump_seconds, jump_frames,
                              sf_format, jpg_quality, sf_mode, folder, show_overlay, default_fps, middle_click, wheel_fs_only, jump_modifier,
                              toast, toast_s, flash, sound, sound_volume, container_fs, loop_all, drag_scrub, drag_ppf, drag_invert, drag_button, drag_hide_cursor, drag_pointer_lock, hide_controls, thin_progress,
                              drag_volume, volume_ppp, volume_invert, volume_remember, no_autojump, jump_on_exit, new_notify]
        save_btn.click(fn=self._save_from_ui, inputs=inputs, outputs=[status, settings_json], show_progress="hidden").then(
            fn=None, inputs=[settings_json], outputs=None, js="(s) => { if (window.vidosser) window.vidosser.applySettings(s); }")
        check_btn.click(fn=self._check_folder_ui, inputs=[folder], outputs=[folder_status], show_progress="hidden")
        bridge_btn.click(fn=self._bridge, inputs=[bridge_req], outputs=[bridge_resp], show_progress="hidden").then(
            fn=None, inputs=[bridge_resp], outputs=None, js="(r) => { if (window.vidosser) window.vidosser.core.bridgeResponse(r); }")

    def _check_folder_ui(self, folder):
        ok, path, message = self.check_folder(folder, create=True)
        return f"{'✅' if ok else '❌'} `{path}`: {message}"

    _UI_FIELDS = ("keys_enabled", "wheel_enabled", "invert", "shift_frames", "jump_mode", "jump_seconds", "jump_frames",
                  "sf_format", "jpg_quality", "sf_mode", "folder", "show_overlay", "default_fps", "middle_click", "wheel_fs_only",
                  "jump_modifier", "toast", "toast_s", "flash", "sound", "sound_volume", "container_fs", "loop_all", "drag_scrub", "drag_ppf", "drag_invert", "drag_button", "drag_hide_cursor", "drag_pointer_lock", "hide_controls", "thin_progress",
                  "drag_volume", "volume_ppp", "volume_invert", "volume_remember", "no_autojump", "jump_on_exit", "new_notify")

    def _save_from_ui(self, *values):
        """Inputs: one key box per KEY_ACTIONS entry, then the fields of _UI_FIELDS (same order as `inputs`)."""
        n = len(KEY_ACTIONS)
        key_values = dict(zip((a for a, _ in KEY_ACTIONS), values[:n]))
        return self._apply_ui_values(key_values, **dict(zip(self._UI_FIELDS, values[n:])))

    def _apply_ui_values(self, key_values, keys_enabled=True, wheel_enabled=True, invert=False, shift_frames=10,
                         jump_mode="seconds", jump_seconds=0.5, jump_frames=8, sf_format="png", jpg_quality=95, sf_mode="ask",
                         folder="", show_overlay=True, default_fps=16, middle_click=True, wheel_fs_only=True, jump_modifier="ctrl",
                         toast=True, toast_s=2.5, flash=True, sound=True, sound_volume=60, container_fs=True, loop_all=True,
                         drag_scrub=True, drag_ppf=8, drag_invert=False, drag_button="left",
                         drag_hide_cursor=True, drag_pointer_lock=True,
                         hide_controls="fullscreen", thin_progress=True,
                         drag_volume=True, volume_ppp=2.0, volume_invert=False, volume_remember=True,
                         no_autojump=True, jump_on_exit=True, new_notify=True):
        settings = load_settings()
        keys, errors = validate_keys(key_values)
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
        jump_seconds = number(jump_seconds, "Salto corto: segundos", 0.01, 600, False)
        jump_frames = number(jump_frames, "Salto corto: fotogramas", 1, 100000, True)
        jpg_quality = number(jpg_quality, "Calidad JPG", 1, 100, True)
        default_fps = number(default_fps, "FPS si no se pueden detectar", 1, 1000, False)
        toast_s = number(toast_s, "Duración del mensaje (segundos)", 0.5, 30, False)
        sound_volume = number(sound_volume, "Volumen", 1, 100, True)
        drag_ppf = number(drag_ppf, "Píxeles por fotograma al arrastrar", 1, 200, True)
        volume_ppp = number(volume_ppp, "Píxeles por 1 % de volumen", 0.2, 50, False)
        folder = str(folder or "").strip().strip('"')
        if sf_mode == "direct" or folder:
            ok, path, message = self.check_folder(folder, create=sf_mode == "direct")
            if not ok:
                errors.append(f"Carpeta `{path}`: {message}.")
        jump_modifier = str(jump_modifier or "none").lower()
        if jump_modifier not in _CHOICES[("frame_step", "wheel_jump_modifier")]:
            errors.append("«Modificador + rueda = salto corto»: valor no válido.")
        hide_controls = str(hide_controls or "fullscreen").lower()
        if hide_controls not in ("off", "fullscreen", "always"):
            errors.append("«Ocultar la barra de controles del vídeo»: valor no válido.")
        drag_button = str(drag_button or "left").lower()
        if drag_button not in ("left", "right"):
            errors.append("«Botón para arrastrar»: valor no válido.")
        if errors:
            return f"❌ No se ha guardado ({time.strftime('%H:%M:%S')}):\n\n- " + "\n- ".join(errors), gr.update()
        settings["keys"].update(keys, enabled=bool(keys_enabled))
        notes = []
        if jump_modifier == "shift":
            notes.append(f"Nota: el modificador del salto corto es Shift, así que Shift + rueda hace un salto corto y "
                         f"los «Fotogramas con Shift + rueda» ({shift_frames}) no se usan.")
        settings["frame_step"].update(wheel_jump_modifier=jump_modifier, drag_scrub=bool(drag_scrub), drag_pixels_per_frame=drag_ppf,
                                      drag_invert=bool(drag_invert), drag_button=drag_button,
                                      drag_hide_cursor=bool(drag_hide_cursor), drag_pointer_lock=bool(drag_pointer_lock))
        settings["frame_step"].update(wheel_enabled=bool(wheel_enabled), wheel_fullscreen_only=bool(wheel_fs_only), invert_direction=bool(invert), shift_frames=shift_frames,
                                      jump_mode=jump_mode if jump_mode in ("seconds", "frames") else "seconds",
                                      jump_seconds=jump_seconds, jump_frames=jump_frames)
        settings["save_frame"].update(format=sf_format if sf_format in ("png", "jpg") else "png", jpg_quality=jpg_quality,
                                      mode=sf_mode if sf_mode in ("ask", "direct") else "ask", folder=folder,
                                      middle_click_save=bool(middle_click), toast=bool(toast), toast_ms=int(round(toast_s * 1000)),
                                      flash=bool(flash), sound=bool(sound), sound_volume=sound_volume)
        settings["general"].update(show_overlay=bool(show_overlay), default_fps=default_fps, container_fullscreen=bool(container_fs),
                                   hide_controls=hide_controls, show_thin_progress=bool(thin_progress))
        settings["loop"].update(loop_all=bool(loop_all))
        settings["volume"].update(drag_volume=bool(drag_volume), drag_pixels_per_percent=float(volume_ppp), drag_invert=bool(volume_invert),
                                  remember=bool(volume_remember))
        settings["new_video"].update(no_autojump_fullscreen=bool(no_autojump), jump_on_fullscreen_exit=bool(jump_on_exit), notify=bool(new_notify))
        try:
            save_settings(settings)
        except Exception as e:
            return f"❌ No se ha podido escribir settings.json: {e}", gr.update()
        message = (f"✅ Ajustes guardados y aplicados a las {time.strftime('%H:%M:%S')} "
                   "(en otras pestañas del navegador ya abiertas, recarga la página).")
        if notes:
            message += "\n\n⚠️ " + "\n\n⚠️ ".join(notes)
        return message, json.dumps(settings)

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
