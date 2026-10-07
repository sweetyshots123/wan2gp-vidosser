# Vidosser — video viewing tools for Wan2GP

*[Español](README.es.md)* · MIT License · v1.3.0

**Vidosser** is a plugin for [Wan2GP / WanGP](https://github.com/deepbeepmeep/Wan2GP) that adds precise video viewing tools to the WanGP web UI. It currently does frame-by-frame stepping and short jumps with the mouse wheel, by dragging on the video or with the keyboard, saves the exact frame on screen as PNG/JPG at full resolution (with clear on-screen and sound feedback), and loops whole videos or a frame-accurate A-B segment. More tools will be added over time.

It is a regular WanGP plugin, so it doesn't modify any core WanGP file and survives WanGP updates.

> The plugin's own UI text (settings tab, on-screen messages) is currently in Spanish. This README shows each Spanish label with its English meaning.

## Features

**Frame stepping**
- **1 mouse-wheel notch = exactly 1 frame**: no acceleration, no skipped frames, even when you spin the wheel fast. Wheel down = next frame, wheel up = previous. **Shift + wheel = 10 frames** per notch (configurable).
- By default the wheel steps frames **only while a video is fullscreen** (the video player's own fullscreen or the gallery's fullscreen button). Outside fullscreen the wheel scrolls the page as usual, even over a video. This can be turned off.
- **Ctrl + wheel = short jump**: each notch jumps exactly one *short jump* (the same size as Q / W, 0.5 s by default). The modifier is configurable (Ctrl, Alt, Shift, Meta/Cmd or none). Vidosser only blocks the browser's Ctrl + wheel zoom while it is actually stepping a video; everywhere else (and outside fullscreen with the default setting) Ctrl + wheel zooms the page as usual. Trackpad pinch gestures, which browsers report as Ctrl + wheel, are accumulated so that one pinch "step" is one jump instead of dozens.
- **Drag to scrub**: hold the **left mouse button** (or the right one, see *drag button*) on a video and drag horizontally: every 8 px = 1 frame (configurable), drag right = forward, drag left = backward. Counting is position based and exact, so dragging back to where you started returns to the same frame. It starts only after 4 px of mostly horizontal movement, so a plain click still plays/pauses; a playing video pauses when the drag starts, and the click at the end of a drag doesn't restart it. With the **right button**, a plain right click still opens the normal context menu; the menu is blocked only when a drag actually happened. While you drag, the mouse is **locked and hidden** (Pointer Lock, *drag pointer lock*, on by default): the pointer can't hit the edge of the screen, so you can keep scrubbing in one long movement, and it reappears exactly where it was on release. Chrome/Edge show their own *"Press Esc to show your cursor"* banner at the top of the screen each time the lock starts; that is a browser security notice, and it goes away by itself. The lock is always released when you let go of the button, press **Esc** or switch window. If the lock is off or the browser refuses it, the drag keeps working when the pointer leaves the video (pointer capture) and the cursor is just hidden while dragging (*hide cursor while dragging*, on by default); it always comes back on release, Esc, cancel or when the window loses focus. **Shift + drag** = 10 frames per step, **Ctrl + drag** (the short-jump modifier) = one short jump per step. Works inside and outside fullscreen (not affected by *wheel only in fullscreen*), and with a finger on touch screens (horizontal swipe; vertical swipes still scroll). Not used on the video's native control bar (bottom 40 px of a video while its browser controls are shown; when Vidosser hides the controls, the whole picture is draggable), gallery thumbnails, text fields or anything other than the video picture.
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
- **Direct mode**: no dialog; saves into a folder on the machine running WanGP (default `<WanGP outputs>/frames`, created if missing). It **never overwrites**: existing names get `_1`, `_2`… The message shows the full saved path.
- **Clear feedback** on every save: a large message at the bottom of the screen, *Fotograma guardado (frame N): name* (green, 2.5 s, fades out; full path in direct mode; in ask mode it appears once the *Save as* dialog is closed), a short white flash over the video and a camera-shutter sound. Errors show a red message and a low double beep; a cancelled dialog shows a grey *No guardado (cancelado)* message. While a container is fullscreen the message is drawn inside it, so it is visible there too. Each of these can be switched off; the sound volume is adjustable.

**Fullscreen with overlays** (`container_fullscreen`, on by default)
- Browsers can't draw anything over a natively fullscreen `<video>`. So when you **double-click a video** or use the **fullscreen button of WanGP's video player**, Vidosser makes the video's player box fullscreen instead. The video looks the same, but the frame overlay, save messages and loop bar are visible. **Double-click toggles**: outside fullscreen it enters, inside fullscreen (Vidosser's fullscreen or the video's native fullscreen) it exits; Esc works as usual. The two clicks of a double-click don't change the play state: a paused video stays paused and a playing one keeps playing. A double-click right after a drag-scrub is ignored, and a drag never eats a following double-click.
- The fullscreen button **inside the browser's own control bar** of a video can't be intercepted by a web page, so it stays native; there the save is confirmed by the sound.

**Hide the control bar** (`hide_controls`, *only in fullscreen* by default)
- *Ocultar la barra de controles del vídeo* (*hide the video control bar*): *No* (off), *Solo a pantalla completa* (only in fullscreen, default) or *Siempre* (always). Hidden bars are the browser's own `<video>` controls (also in native fullscreen) and WanGP's video player bar in fullscreen; they come back when you leave fullscreen or switch the option off.
- Without the bar: **click** the video or press **Space** to play/pause, and the **whole picture** can be dragged to scrub (no 40 px exclusion).
- *Barra de progreso fina* (*thin progress bar*, `show_thin_progress`, on by default): a 3 px, non-clickable line at the very bottom of the picture shows the position while the controls are hidden.

**Loop**
- **L** turns looping on/off for the current video. *Repetir todos los vídeos en bucle* (*loop all videos*, off by default) makes every video loop, including videos that appear later; turning it off restores each video's own setting.
- **A-B segment**: **I** marks the start (in) and **O** the end (out) at the current frame; playback then repeats exactly frames in…out (frame-accurate, using `requestVideoFrameCallback`), also when out is the last frame. Marking out before in swaps them; moving one end past the other end of an existing segment starts a new segment. **U** clears the segment. Pressing play outside the segment starts at in. Frame stepping is never restricted to the segment.
- Segments are per video (by file) and kept while the page is open. A thin (3 px) orange line on the top edge of the picture shows the segment's position in the clip, so nothing covers the bottom of the picture. Messages confirm each action: *Inicio de bucle: frame N*, *Final de bucle: frame N*, *Bucle borrado*.

**Settings tab**: every option is editable in a **Vidosser** tab and applies instantly, with no restart.

## Default shortcuts

| Action | Default | Notes |
|---|---|---|
| Next / previous frame | Wheel down / up | 1 notch = 1 frame; only in fullscreen by default |
| Jump ×10 frames | Shift + wheel | configurable (`shift_frames`) |
| Short jump (= Q / W) | Ctrl + wheel | modifier configurable (`wheel_jump_modifier`) |
| Scrub frames | drag on the video (left button, or right if chosen) | 8 px = 1 frame; Shift + drag = ×10, Ctrl + drag = short jumps |
| Previous frame | `A` | auto-repeat steps one frame per repeat |
| Next frame | `S` | |
| Jump back | `Q` | 0.5 s by default, or N frames |
| Jump forward | `W` | |
| Save frame | `D` or middle click on the video | PNG/JPG, ask or direct mode |
| Loop on/off (this video) | `L` | |
| Segment start / end | `I` / `O` | A-B loop at the current frame |
| Clear segment | `U` | |
| Fullscreen on / off | double-click the video | enters outside fullscreen, exits inside it (also native); or WanGP's player fullscreen button |
| Play / pause without controls | click the video or `Space` | when the control bar is hidden |

Keys are case-insensitive and remappable; the same key can't be used for two actions. If your existing settings already use one of the new 1.3.0 keys (L, I, O, U) for another action, your key wins and the new action gets a free key (shown in the Vidosser tab). They do nothing while you type in a text field (prompt etc.) or while Ctrl/Alt/Cmd is held, so WanGP's own Alt+… shortcuts keep working. The target video is, in order: the fullscreen video, then the video under the mouse, then the last video you used if it's still visible.

Middle clicks on links, buttons, gallery thumbnails and the rest of the page behave as usual. On a video, the middle click doesn't start Windows autoscroll or Linux paste, saves once per click, and a slight wheel roll while pressing doesn't change the frame.

## Settings (Vidosser tab)

Open the **Vidosser** tab in WanGP, change options, and click **Guardar ajustes** (*Save settings*). Values are validated (duplicate keys, number ranges, folder writable). If anything is invalid, nothing is saved and the reason is shown. Valid settings are written to `settings.json` in the plugin folder and **applied immediately** in that browser tab. Other already-open WanGP tabs pick them up when reloaded.

| Section (Spanish label) | Option | Default | Meaning |
|---|---|---|---|
| **Teclas** (Keys) | *Fotograma siguiente / anterior* (next / previous frame) | `S` / `A` | click the box and press the key you want (Backspace clears) |
| | *Salto adelante / atrás* (jump forward / back) | `W` / `Q` | |
| | *Guardar fotograma* (save frame) | `D` | |
| | *Bucle on/off (este vídeo)* (loop on/off) | `L` | |
| | *Inicio / Final del segmento A-B* (segment in / out) | `I` / `O` | |
| | *Borrar segmento A-B* (clear segment) | `U` | |
| | *Atajos de teclado activados* (keyboard shortcuts on) | on | |
| **Paso de fotogramas** (Frame stepping) | *Rueda del ratón: 1 muesca = 1 fotograma* (wheel stepping) | on | |
| | *Rueda solo a pantalla completa* (wheel only in fullscreen) | on | off = wheel steps over any video, also outside fullscreen |
| | *Invertir sentido de la rueda* (invert wheel) | off | on = wheel up goes forward |
| | *Fotogramas con Shift + rueda* (Shift + wheel frames) | 10 | also used by Shift + drag |
| | *Arrastrar sobre el vídeo = pasar fotogramas* (drag to scrub) | on | inside and outside fullscreen |
| | *Botón para arrastrar* (drag button) | *Izquierdo* (left) | or *Derecho* (right): plain right click = normal context menu |
| | *Píxeles por fotograma al arrastrar* (pixels per frame) | 8 | 1–200 |
| | *Invertir sentido al arrastrar* (invert drag) | off | on = drag right goes back |
| | *Bloquear el puntero al arrastrar* (drag pointer lock) | on | no screen edge while dragging; Chrome shows a *"Press Esc to show your cursor"* banner each time |
| | *Ocultar el cursor mientras arrastras* (hide cursor while dragging) | on | fallback when the lock is off or refused |
| **Salto corto** (Short jump: W / Q and modifier + wheel) | *Salto corto: medida* (unit) | seconds | *En segundos* (seconds) or *En fotogramas* (frames) |
| | *Salto corto: segundos* (seconds) | 0.5 | rounded to whole frames |
| | *Salto corto: fotogramas* (frames) | 8 | |
| | *Modificador + rueda = salto corto* (modifier) | Ctrl | Ctrl, Alt, Shift, Meta (Cmd / Win) or *Ninguno* (none = off). With Shift, Shift + wheel does the short jump instead of the ×10 multiplier (the tab shows a note) |
| **Bucle** (Loop) | *Repetir todos los vídeos en bucle* (loop all videos) | off | applied live, also to videos added later |
| **Guardar fotograma** (Save frame) | *Formato* (format) | PNG | PNG or JPG |
| | *Calidad JPG* (JPG quality) | 95 | 1–100 |
| | *Modo* (mode) | ask | *Preguntar dónde guardar* (ask) or *Guardar directamente en la carpeta* (direct) |
| | *Carpeta* (folder, direct mode) | empty = `<WanGP outputs>/frames` | on the machine running WanGP; **Comprobar carpeta** (*Check folder*) tests that it exists or can be created and is writable |
| | *Clic central … = guardar fotograma* (middle click saves) | on | |
| | *Mensaje «Fotograma guardado»* (save message) | on | |
| | *Duración del mensaje (segundos)* (message duration) | 2.5 | 0.5–30 |
| | *Destello blanco sobre el vídeo* (white flash) | on | |
| | *Sonido de cámara al guardar* (shutter sound) | on | low double beep on errors |
| | *Volumen* (volume) | 60 | 1–100 |
| **Indicador y pantalla completa** (Overlay & fullscreen) | *Mostrar indicador sobre el vídeo* (show overlay) | on | |
| | *Pantalla completa del vídeo con indicadores y mensajes* (fullscreen with overlays) | on | see *Fullscreen with overlays* above |
| | *Ocultar la barra de controles del vídeo* (hide control bar) | *Solo a pantalla completa* | *No* / *Solo a pantalla completa* / *Siempre* |
| | *Barra de progreso fina (3 px)* (thin progress bar) | on | shown only while the controls are hidden |
| | *FPS si no se pueden detectar* (fallback fps) | 16 | used only if the frame rate can't be read |

<details><summary><code>settings.json</code> structure (advanced)</summary>

```json
{
  "general":    { "default_fps": 16, "min_video_size": 100, "show_overlay": true, "overlay_ms": 1200, "container_fullscreen": true,
                  "hide_controls": "fullscreen", "show_thin_progress": true },
  "keys":       { "enabled": true, "next_frame": "s", "prev_frame": "a", "jump_forward": "w", "jump_back": "q", "save_frame_as": "d",
                  "toggle_loop": "l", "mark_in": "i", "mark_out": "o", "clear_segment": "u" },
  "frame_step": { "enabled": true, "wheel_enabled": true, "wheel_fullscreen_only": true, "wheel_jump_modifier": "ctrl",
                  "shift_frames": 10, "invert_direction": false,
                  "drag_scrub": true, "drag_pixels_per_frame": 8, "drag_invert": false, "drag_button": "left",
                  "drag_pointer_lock": true, "drag_hide_cursor": true, "jump_mode": "seconds", "jump_seconds": 0.5, "jump_frames": 8 },
  "loop":       { "enabled": true, "loop_all": false },
  "save_frame": { "enabled": true, "format": "png", "jpg_quality": 95, "mode": "ask", "folder": "", "middle_click_save": true,
                  "toast": true, "toast_ms": 2500, "flash": true, "sound": true, "sound_volume": 60 }
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
Download `wan2gp-vidosser-1.3.0.zip` from [Releases](https://github.com/sweetyshots123/wan2gp-vidosser/releases) and extract it into `Wan2GP/plugins/`, so that you get `Wan2GP/plugins/wan2gp-vidosser/plugin.py`. Then enable it in the Plugins tab and restart WanGP.

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

- In a video's **native fullscreen** (the fullscreen button in the browser's control bar of the video), the wheel, keys and middle click work, but browsers don't allow drawing over a natively fullscreen `<video>`: no overlay, messages, flash, thin progress bar or loop bar there; saves are confirmed by the sound. Chrome always shows its controls on a natively fullscreen video, so Vidosser hides them there with CSS (when *hide control bar* is not *No*). Double-click the video instead (with *fullscreen with overlays* on), or use the gallery's own fullscreen button (top right of the gallery).
- A-B looping relies on seeking back just before frame out+1 would be shown. It is frame-accurate in Chrome/Edge (tested at 16 and 24 fps); on a heavily loaded machine or in browsers without `requestVideoFrameCallback` an occasional extra frame can flash before the wrap.
- Loop segments are kept only while the page is open (not saved to disk).
- Drag to scrub uses the chosen button on the video picture, so the video's own drag gestures there (none in Chrome/Firefox by default) are replaced while it is on. Seeking with the native progress bar is unchanged. Touch scrubbing was tested with emulated touch in Chrome, not on a real phone/tablet.
- Right-button drag: on **Windows** the context menu opens on release, so it is simply skipped after a drag. On **macOS and Linux** browsers open the context menu as soon as the right button is pressed, so a right-button drag usually isn't possible there: use the left button.
- Pointer lock: Chrome/Edge show the *"Press Esc to show your cursor"* banner every time a drag starts the lock; browsers don't let a page hide it. Turn *Bloquear el puntero al arrastrar* off if it bothers you (the cursor is then only hidden, and the drag stops at the screen edge).
- Ctrl + wheel and trackpad pinch: if you choose *Ninguno* (none) as the modifier, Ctrl + wheel zooms the browser as usual.
- The middle click saves when you release the button. In ask mode, if the button is held for more than about 5 seconds, the browser no longer allows the *Save as* dialog and the frame is downloaded instead.
- Direct mode saves on the machine running WanGP. If you use WanGP from another computer over the network, the file lands on the server.
- JPG is lossy; use PNG for a bit-exact frame.
- On macOS, system wheel acceleration can make a fast spin report more notches.
- Keys match the character they type (`a`, `s`…), not the physical key position.
- The UI text is Spanish for now.

## Troubleshooting

- **Middle click does nothing:** many mouse utilities (Logitech Options/G HUB, Razer Synapse, etc.) can remap the wheel click to another function, in which case the browser never receives a middle click. Set it back to "Middle click" for the browser, and check that *Clic central … = guardar fotograma* is enabled in the Vidosser tab.
- **No overlay or messages in fullscreen:** you are in native video fullscreen (see Limitations). Double-click the video instead, or use the gallery's fullscreen button. Check that *Pantalla completa del vídeo con indicadores y mensajes* is on.
- **Ctrl + wheel zooms the page:** that's expected outside fullscreen when *Rueda solo a pantalla completa* is on, or when the pointer isn't over a video with it off.
- **Dragging on a video doesn't scrub / a click doesn't pause any more:** check *Arrastrar sobre el vídeo* in the Vidosser tab; a movement under 4 px counts as a click, more than that as a drag.
- **A banner "Press Esc to show your cursor" appears when I drag:** that is the browser's notice for pointer lock (see Limitations); turn off *Bloquear el puntero al arrastrar* to avoid it.
- **The control bar disappeared:** with *Ocultar la barra de controles del vídeo* = *Solo a pantalla completa* (default) it is hidden in fullscreen only; click or Space plays/pauses. Choose *No* to always show it.
- **No sound on save:** check *Sonido de cámara al guardar* and the volume; browsers only play sound after you have interacted with the page (a key press or click is enough).
- **Wheel scrolls the page instead of stepping:** this is the default outside fullscreen. Go fullscreen, or turn off *Rueda solo a pantalla completa* in the Vidosser tab.
- **Plugin not active after installing:** enable it in the Plugins tab, restart WanGP, and reload the page. The browser console should show `[Vidosser] v1.3.0 loaded`.
- **"Error al guardar: vídeo fuera de las carpetas de WanGP":** the video is outside WanGP's folders (see Compatibility).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
- **1.3.0**: drag on the video to scrub frames (pointer lock with hidden cursor); double-click toggles fullscreen; hide the control bar (in fullscreen by default) with a thin progress line; Ctrl + wheel short jump (configurable modifier, trackpad pinch); save feedback (message, flash, shutter sound); fullscreen with overlays on double-click; loop module (loop all, L toggle, frame-accurate A-B segment with I / O / U).
- **1.2.0**: middle-click (wheel click) save; wheel frame-stepping only in fullscreen by default; settings migration (missing keys use defaults); no `settings.json` shipped.
- **1.1.0**: renamed to *Vidosser* (collection of video tools); keyboard frame stepping and jumps; save exact frame (PNG/JPG, ask/direct); Vidosser settings tab with live apply.
- **1.0.0**: mouse-wheel frame stepping (one notch = one frame, Shift = 10), also in fullscreen.

## License

[MIT](LICENSE) © 2026 sweetyshots123
