# Vidosser — video viewing tools for Wan2GP

*[Español](README.es.md)* · MIT License · v1.2.0

**Vidosser** is a plugin for [Wan2GP / WanGP](https://github.com/deepbeepmeep/Wan2GP) that adds precise video viewing tools to the WanGP web UI. It currently does frame-by-frame stepping with the mouse wheel or keyboard, and saves the exact frame on screen as PNG/JPG at full resolution. More tools will be added over time.

It is a regular WanGP plugin, so it doesn't modify any core WanGP file and survives WanGP updates.

> The plugin's own UI text (settings tab, on-screen messages) is currently in Spanish. This README shows each Spanish label with its English meaning.

## Features

**Frame stepping**
- **1 mouse-wheel notch = exactly 1 frame**: no acceleration, no skipped frames, even when you spin the wheel fast. Wheel down = next frame, wheel up = previous. **Shift + wheel = 10 frames** per notch (configurable).
- By default the wheel steps frames **only while a video is fullscreen** (the video player's own fullscreen or the gallery's fullscreen button). Outside fullscreen the wheel scrolls the page as usual, even over a video. This can be turned off.
- Keyboard: **A / S** = previous / next frame (holding the key keeps stepping one frame at a time). **Q / W** = jump back / forward by 0.5 s (rounded to whole frames at the video's frame rate) or by a fixed number of frames.
- The real frame rate is read from the file (MP4/MOV/MKV/WebM), so stepping is exact for Wan (16 fps), LTX (24/25 fps), interpolated videos (32 fps) and more.
- A playing video pauses on the first step. A small overlay shows `Frame N / last · fps` and fades out.
- Works on the output gallery and every video player in the UI (control video, source video…).

**Save frame**
- **D** or a **middle click (wheel click)** on the video saves the frame you are looking at.
- The frame is extracted on the server **from the original file** with WanGP's own decoder, so it is the exact frame at full resolution. That holds even when the browser shows WanGP's reduced preview, e.g. ProRes 1080p shown as a 1280-px MP4 is still saved at 1920×1080. If a seek is still in progress, it waits for it to finish.
- **PNG** (lossless) or **JPG** (quality 1–100, default 95).
- File name: `<video name>_frame<NNNNN>.png`, e.g. `my_video_frame00023.png`.
- **Ask mode** (default): opens the browser's *Save as* dialog, starting in the last folder used. Cancel saves nothing.
- **Direct mode**: no dialog; saves into a folder on the machine running WanGP (default `<WanGP outputs>/frames`, created if missing). It **never overwrites**: existing names get `_1`, `_2`… The overlay shows the full saved path.

**Settings tab**: every option is editable in a **Vidosser** tab and applies instantly, with no restart.

## Default shortcuts

| Action | Default | Notes |
|---|---|---|
| Next / previous frame | Wheel down / up | 1 notch = 1 frame; only in fullscreen by default |
| Jump ×10 frames | Shift + wheel | configurable (`shift_frames`) |
| Previous frame | `A` | auto-repeat steps one frame per repeat |
| Next frame | `S` | |
| Jump back | `Q` | 0.5 s by default, or N frames |
| Jump forward | `W` | |
| Save frame | `D` or middle click on the video | PNG/JPG, ask or direct mode |

Keys are case-insensitive and remappable. They do nothing while you type in a text field (prompt etc.) or while Ctrl/Alt/Cmd is held, so WanGP's own Alt+… shortcuts keep working. The target video is, in order: the fullscreen video, then the video under the mouse, then the last video you used if it's still visible.

Middle clicks on links, buttons, gallery thumbnails and the rest of the page behave as usual. On a video, the middle click doesn't start Windows autoscroll or Linux paste, saves once per click, and a slight wheel roll while pressing doesn't change the frame.

## Settings (Vidosser tab)

Open the **Vidosser** tab in WanGP, change options, and click **Guardar ajustes** (*Save settings*). Values are validated (duplicate keys, number ranges, folder writable). If anything is invalid, nothing is saved and the reason is shown. Valid settings are written to `settings.json` in the plugin folder and **applied immediately** in that browser tab. Other already-open WanGP tabs pick them up when reloaded.

| Section (Spanish label) | Option | Default | Meaning |
|---|---|---|---|
| **Teclas** (Keys) | *Fotograma siguiente / anterior* (next / previous frame) | `S` / `A` | click the box and press the key you want (Backspace clears) |
| | *Salto adelante / atrás* (jump forward / back) | `W` / `Q` | |
| | *Guardar fotograma* (save frame) | `D` | |
| | *Atajos de teclado activados* (keyboard shortcuts on) | on | |
| **Paso de fotogramas** (Frame stepping) | *Rueda del ratón: 1 muesca = 1 fotograma* (wheel stepping) | on | |
| | *Rueda solo a pantalla completa* (wheel only in fullscreen) | on | off = wheel steps over any video, also outside fullscreen |
| | *Invertir sentido de la rueda* (invert wheel) | off | on = wheel up goes forward |
| | *Fotogramas con Shift + rueda* (Shift + wheel frames) | 10 | |
| | *Salto (W / Q)* (jump mode) | seconds | *En segundos* (seconds) or *En fotogramas* (frames) |
| | *Segundos por salto* (seconds per jump) | 0.5 | rounded to whole frames |
| | *Fotogramas por salto* (frames per jump) | 8 | |
| **Guardar fotograma** (Save frame) | *Formato* (format) | PNG | PNG or JPG |
| | *Calidad JPG* (JPG quality) | 95 | 1–100 |
| | *Modo* (mode) | ask | *Preguntar dónde guardar* (ask) or *Guardar directamente en la carpeta* (direct) |
| | *Carpeta* (folder, direct mode) | empty = `<WanGP outputs>/frames` | on the machine running WanGP; **Comprobar carpeta** (*Check folder*) tests that it exists or can be created and is writable |
| | *Clic central … = guardar fotograma* (middle click saves) | on | |
| **Indicador** (Overlay) | *Mostrar indicador sobre el vídeo* (show overlay) | on | |
| | *FPS si no se pueden detectar* (fallback fps) | 16 | used only if the frame rate can't be read |

<details><summary><code>settings.json</code> structure (advanced)</summary>

```json
{
  "general":    { "default_fps": 16, "min_video_size": 100, "show_overlay": true, "overlay_ms": 1200 },
  "keys":       { "enabled": true, "next_frame": "s", "prev_frame": "a", "jump_forward": "w", "jump_back": "q", "save_frame_as": "d" },
  "frame_step": { "enabled": true, "wheel_enabled": true, "wheel_fullscreen_only": true, "shift_frames": 10,
                  "invert_direction": false, "jump_mode": "seconds", "jump_seconds": 0.5, "jump_frames": 8 },
  "save_frame": { "enabled": true, "format": "png", "jpg_quality": 95, "mode": "ask", "folder": "", "middle_click_save": true }
}
```
Missing keys fall back to these defaults. If you edit the file by hand, reload the page (or restart WanGP).
</details>

## Install

**A. From WanGP's Plugins tab (recommended)**
1. In WanGP open **Plugins** → **Install from URL**.
2. Paste `https://github.com/sweetyshots123/wan2gp-vidosser` and click **Download and Install from URL**.
3. Enable **Vidosser** in the plugin list, click **Restart** (or close and reopen WanGP), then reload the browser page.

**B. With git**
```bash
cd Wan2GP/plugins
git clone https://github.com/sweetyshots123/wan2gp-vidosser.git
```
Then enable **Vidosser** in the Plugins tab and restart WanGP.

**C. From the release zip**
Download `wan2gp-vidosser-1.2.0.zip` from [Releases](https://github.com/sweetyshots123/wan2gp-vidosser/releases) and extract it into `Wan2GP/plugins/`, so that you get `Wan2GP/plugins/wan2gp-vidosser/plugin.py`. Then enable it in the Plugins tab and restart WanGP.

Keep the folder name `wan2gp-vidosser`. Wan2GP's `.gitignore` ignores `plugins/wan2gp-*`, so updating Wan2GP with `git pull` never touches the plugin.

## Update

- **Installed with A or B:** Plugins tab → **Check for Updates** → **Update** next to Vidosser (or run `git pull` inside the plugin folder). Then restart WanGP and reload the page.
- **Installed from a zip or by copying:** replace `plugin.py`, `vidosser.js`, `plugin_info.json`, `__init__.py` (and the READMEs). Then restart WanGP and reload the page. Don't overwrite `settings.json`.

### Your settings are preserved
The repository doesn't ship a `settings.json`. The file is created by the Vidosser tab when you click Save, and it is listed in `.gitignore`, so neither *Update* nor `git pull` overwrites it. When a new version adds options, values missing from your existing `settings.json` take their defaults, so an old file keeps working.

## Uninstall

Plugins tab → **Uninstall** next to Vidosser (or disable it and delete `Wan2GP/plugins/wan2gp-vidosser`), then restart WanGP. This also deletes `settings.json`, so back it up first if you want to keep your settings.

## Compatibility

- Tested with **WanGP 17.17** (Wan2GP `main`, October 2026), which uses **Gradio 5.29.0**. It uses only the official plugin API (`add_custom_js`, `add_tab`, `request_global`).
- **Chrome / Edge** (tested with Chrome 154): full support, including the *Save as* dialog.
- **Firefox / Safari**: stepping and saving work, but there is no *Save as* dialog API, so in ask mode the frame is downloaded like a normal download (or use direct mode). In Firefox, the wheel is counted in its line/pixel units with the same one-notch-one-frame rule.
- Videos must be inside WanGP's folders (WanGP folder, output folders, Gradio temp folder) for server-side saving. Other videos are refused for safety.

## Limitations

- In a video player's **native fullscreen** (the fullscreen button in the video's control bar), the wheel, keys and middle click work, but browsers don't allow drawing over a natively fullscreen `<video>`, so the overlay isn't visible there. The gallery's own fullscreen button (top right of the gallery) does show it.
- The middle click saves when you release the button. In ask mode, if the button is held for more than about 5 seconds, the browser no longer allows the *Save as* dialog and the frame is downloaded instead.
- Direct mode saves on the machine running WanGP. If you use WanGP from another computer over the network, the file lands on the server.
- JPG is lossy; use PNG for a bit-exact frame.
- On macOS, system wheel acceleration can make a fast spin report more notches.
- Keys match the character they type (`a`, `s`…), not the physical key position.
- The UI text is Spanish for now.

## Troubleshooting

- **Middle click does nothing:** many mouse utilities (Logitech Options/G HUB, Razer Synapse, etc.) can remap the wheel click to another function, in which case the browser never receives a middle click. Set it back to "Middle click" for the browser, and check that *Clic central … = guardar fotograma* is enabled in the Vidosser tab.
- **No overlay in fullscreen:** you are in native video fullscreen (see Limitations). Use the gallery's fullscreen button, or watch the frame number after leaving fullscreen.
- **Wheel scrolls the page instead of stepping:** this is the default outside fullscreen. Go fullscreen, or turn off *Rueda solo a pantalla completa* in the Vidosser tab.
- **Plugin not active after installing:** enable it in the Plugins tab, restart WanGP, and reload the page. The browser console should show `[Vidosser] v1.2.0 loaded`.
- **"Error al guardar: vídeo fuera de las carpetas de WanGP":** the video is outside WanGP's folders (see Compatibility).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
- **1.2.0**: middle-click (wheel click) save; wheel frame-stepping only in fullscreen by default; settings migration (missing keys use defaults); no `settings.json` shipped.
- **1.1.0**: renamed to *Vidosser* (collection of video tools); keyboard frame stepping and jumps; save exact frame (PNG/JPG, ask/direct); Vidosser settings tab with live apply.
- **1.0.0**: mouse-wheel frame stepping (one notch = one frame, Shift = 10), also in fullscreen.

## License

[MIT](LICENSE) © 2026 sweetyshots123
