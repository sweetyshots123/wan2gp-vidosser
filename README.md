# Vidosser — video viewing tools for Wan2GP

*[Español](README.es.md)* · MIT License · v1.4.6

**Vidosser** is a plugin for [Wan2GP / WanGP](https://github.com/deepbeepmeep/Wan2GP) that adds precise video viewing tools to the WanGP web UI. It currently does frame-by-frame stepping and short jumps with the mouse wheel, by dragging on the video or with the keyboard, saves the exact frame on screen as PNG/JPG at full resolution (with clear on-screen and sound feedback), loops whole videos or a frame-accurate A-B segment, changes the volume by dragging vertically on the video, and keeps the video you are watching in fullscreen when WanGP finishes a new one. More tools will be added over time.

It is a regular WanGP plugin, so it doesn't modify any core WanGP file and survives WanGP updates.

> **Language:** all of Vidosser's on-screen text (settings tab, overlays, messages) is in **English or Spanish, following your browser's language**: Spanish when the browser's first language is any Spanish variant (`es`, `es-ES`, `es-MX`, …), English for every other language. See [Language](#language).

## Features

**Frame stepping**
- **1 mouse-wheel notch = exactly 1 frame**: no acceleration, no skipped frames, even when you spin the wheel fast. Wheel down = next frame, wheel up = previous. **Shift + wheel = 10 frames** per notch (configurable).
- By default the wheel steps frames **only while a video is fullscreen** (the video player's own fullscreen or the gallery's fullscreen button). Outside fullscreen the wheel scrolls the page as usual, even over a video. This can be turned off.
- **Modifier + wheel** (Ctrl by default): configurable in the Vidosser tab as **Short jump** (default: one notch = one short jump, same as Q / W, 0.5 s) or **Playback speed** (each notch changes the playback rate by 0.25× between 0.25× and 2.00×; overlay `Speed 1.25×`). The wheel direction that advances frames also makes playback faster; *Invert wheel direction* flips both. The last speed can be remembered for later videos (on by default). The modifier is configurable (Ctrl, Alt, Shift, Meta/Cmd or none). Vidosser only blocks the browser's Ctrl + wheel zoom while it is actually using that gesture on a video; everywhere else (and outside fullscreen with the default setting) Ctrl + wheel zooms the page as usual. Trackpad pinch gestures, which browsers report as Ctrl + wheel, are accumulated so that one pinch "step" is one action instead of dozens.
- **Drag to scrub**: hold the **left mouse button** (or the right one, see *drag button*) on a video and drag horizontally: every 8 px = 1 frame (configurable), drag right = forward, drag left = backward. Counting is position based and exact, so dragging back to where you started returns to the same frame. It starts only after 4 px of mostly horizontal movement, so a plain click still plays/pauses; a playing video pauses when the drag starts, and the click at the end of a drag doesn't restart it. With the **right button**, a plain right click still opens the normal context menu; the menu is blocked only when a drag actually happened. **The cursor only disappears in fullscreen, and only while you hold the left button down during a drag** (scrub or volume); outside fullscreen, with the right button, after release or when not dragging, the cursor is always visible (outside fullscreen the drag keeps working when the pointer leaves the video, via pointer capture). Vidosser also stops Chrome from hiding the cursor on its own when its controls fade out over a playing video. In fullscreen, while you scrub with the left button, the mouse is **locked and hidden** (Pointer Lock, *drag pointer lock*, on by default): the pointer can't hit the edge of the screen, so you can keep scrubbing in one long movement, and it reappears exactly where it was on release. Chrome/Edge show their own *"Press Esc to show your cursor"* banner at the top of the screen each time the lock starts; that is a browser security notice, and it goes away by itself. The lock is always released when you let go of the button, press **Esc** or switch window. If the lock is off or the browser refuses it, the drag keeps working when the pointer leaves the video (pointer capture) and the cursor is just hidden while dragging (*hide cursor while dragging*, on by default); it always comes back on release, Esc, cancel or when the window loses focus. **Shift + drag** = 10 frames per step, **Ctrl + drag** (the short-jump modifier) = one short jump per step. Works inside and outside fullscreen (not affected by *wheel only in fullscreen*), and with a finger on touch screens (horizontal swipe; vertical swipes still scroll). Not used on the video's native control bar (bottom 40 px of a video while its browser controls are shown; when Vidosser hides the controls, the whole picture is draggable), gallery thumbnails, text fields or anything other than the video picture.
- **Vertical drag = volume** (see *Volume* below): the direction is decided once, after the first 4 px, by the dominant movement (horizontal = frames, vertical = volume, a tie counts as horizontal) and stays locked until you release the button, so a scrub that drifts doesn't touch the volume and vice versa.
- Keyboard: **A / S** = previous / next frame (holding the key keeps stepping one frame at a time). **Q / W** = jump back / forward by 0.5 s (rounded to whole frames at the video's frame rate) or by a fixed number of frames.
- **Wrap around at the ends** (on by default): going past the last frame continues at the first, and going back past the first continues at the last — for drag, wheel, A / S and Q / W (and modifier + wheel). The overlay shows the wrapped frame with a ↻ mark. Off = stop at the ends. Independent of the A-B segment loop.
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
- **Clear feedback** on every save: a large message at the bottom of the screen, *Frame saved (frame N): name* (green, 2.5 s, fades out; full path in direct mode; in ask mode it appears once the *Save as* dialog is closed), a short white flash over the video and a camera-shutter sound. Errors show a red message and a low double beep; a cancelled dialog shows a grey *Not saved (cancelled)* message. While a container is fullscreen the message is drawn inside it, so it is visible there too. Each of these can be switched off; the sound volume is adjustable.

**Volume by vertical drag** (`volume`)
- **Click and hold on the video and drag vertically**: **up = louder, down = quieter**. 2 px = 1 % by default (200 px from 0 % to 100 %), configurable; the direction can be inverted.
- An overlay shows the level while dragging: `Volume ██████░░░░  60 %` (`0 % (muted)` at the bottom).
- Clamped to 0–100 %; if you overshoot a limit and come back, the volume reacts as soon as you turn around.
- On a **muted** video, dragging up unmutes it and starts from 0 %.
- **Volume drag button** (*Volume drag button*, `volume.drag_button`: left by default, or right). If it is the same button as drag-to-scrub (*drag button*), one press does both and the direction decides: the first 4 px of movement pick horizontal (scrub) or vertical (volume) and that is kept until you release. If they are **different buttons**, each button does only its own job: the volume button's drag only changes the volume (only the vertical movement counts, sideways movement is ignored) and the scrub button's drag only steps frames (a vertical drag with it does nothing). Either way the click or context menu that ends a drag is swallowed.
- **Right button**: a plain right click (moving less than 4 px) still opens the browser's context menu; after a right-button drag the menu is blocked (on Windows it opens on release, so it is simply skipped). On macOS / Linux the browser opens the menu as soon as the right button goes down, so use the left button there.
- It doesn't pause the video (scrubbing does). In fullscreen, **only with the left button**, the cursor is hidden while you drag (never with the right button), but **without pointer lock** (Chrome on Windows reports unreliable movement under the lock, and the screen gives plenty of travel for 0–100 %). The click that ends the drag doesn't toggle play. A plain click and the **double-click** (fullscreen) behave exactly as before.
- Works inside and outside fullscreen: Vidosser's fullscreen (double-click), the gallery's fullscreen button and the video's native fullscreen, where the overlay is shown as a subtitle line at the top left. On touch screens a vertical swipe changes the volume **only in fullscreen**; outside fullscreen it keeps scrolling the page.
- *Remember the volume for the next videos* (on by default): the last volume you set (by dragging or with the video's own slider) is applied to videos loaded later, also after a page reload (stored in the browser). Muting is never remembered.

**New video while fullscreen** (`new_video`)
- When WanGP finishes a video, the gallery jumps to it (if you were on the last item). **While you watch a gallery video fullscreen** (Vidosser's container fullscreen, the gallery's own fullscreen or the video's native fullscreen), *In fullscreen, don't jump to the new video* (on by default) **keeps the video you are watching**: same position, still paused or playing, still fullscreen, not even reloaded. The new video is added to the gallery as usual and a message says *New video ready (you're still watching this one)* (not possible in native fullscreen).
- **Outside fullscreen nothing changes**: WanGP jumps to the new video as before.
- **When you leave fullscreen** the newest video is shown, which is what WanGP would have done (*When leaving fullscreen, show the new video*, on by default), so outside fullscreen the gallery keeps following new videos. With it off you stay on the video you were watching (and, as in WanGP whenever you're not on the last item, the gallery stops jumping until you pick the last one again).
- Your own navigation in fullscreen (thumbnails, arrow keys) is never blocked. If the video you watch disappears from the gallery (deleted), the change is applied.
- How it works: Gradio's gallery keeps the same `<video>` element and only changes its `src`; while that video is fullscreen Vidosser refuses that one change and then re-selects the video on screen in the gallery, so Gradio and WanGP's own selection (`select_media`) match what you see and later refreshes keep it.

**Fullscreen with overlays** (`container_fullscreen`, on by default)
- Browsers can't draw anything over a natively fullscreen `<video>`. So when you **double-click a video** or use the **fullscreen button of WanGP's video player**, Vidosser makes the video's player box fullscreen instead. The video looks the same, but the frame overlay, save messages and loop bar are visible. **Double-click toggles**: outside fullscreen it enters, inside fullscreen (Vidosser's fullscreen or the video's native fullscreen) it exits; Esc works as usual. The two clicks of a double-click don't change the play state: a paused video stays paused and a playing one keeps playing. A double-click right after a drag-scrub is ignored, and a drag never eats a following double-click.
- The fullscreen button **inside the browser's own control bar** of a video can't be intercepted by a web page, so it stays native; there the save is confirmed by the sound.

**Hide the control bar** (`hide_controls`, *only in fullscreen* by default)
- *Hide the video control bar*: *No*, *Only in fullscreen* (default) or *Always*. Hidden bars are the browser's own `<video>` controls (also in native fullscreen) and WanGP's video player bar in fullscreen; they come back when you leave fullscreen or switch the option off.
- Without the bar: **click** the video or press **Space** to play/pause, and the **whole picture** can be dragged to scrub (no 40 px exclusion).
- *Thin progress bar* (`show_thin_progress`, on by default): a 3 px, non-clickable line at the very bottom of the picture shows the position while the controls are hidden.

**Loop**
- **L** turns looping on/off for the current video. *Loop all videos* (on by default) makes every video loop, including videos that appear later; turning it off restores each video's own setting.
- **Boomerang** (*Loop mode* in the Vidosser tab, or **B** for the current video): instead of starting again at the beginning, a looping video plays backwards from the last frame to the first, then forwards again, like a bounce. With an A-B segment it bounces between A and B. Going backwards is silent (the video is paused; sound returns when it goes forwards) and follows the playback speed (0.25–2.00×). Backwards uses the frames remembered while the video played forwards, so it is as smooth as forwards from the first bounce on; the very first time after loading, or in the video's native fullscreen, it seeks frame by frame (smooth on small clips, choppier on big ones). Play/pause while going backwards pauses it and play continues backwards; a frame step, scrub or seek stops it there (play then goes forwards); play on a paused last frame goes backwards.
- **A-B segment**: **I** marks the start (in) and **O** the end (out) at the current frame; playback then repeats exactly frames in…out (frame-accurate, using `requestVideoFrameCallback`), also when out is the last frame. Marking out before in swaps them; moving one end past the other end of an existing segment starts a new segment. **U** clears the segment. Pressing play outside the segment starts at in. Frame stepping is never restricted to the segment.
- Segments are per video (by file) and kept while the page is open. A thin (3 px) orange line on the top edge of the picture shows the segment's position in the clip, so nothing covers the bottom of the picture. Messages confirm each action: *Loop start: frame N*, *Loop end: frame N*, *Loop cleared*.

**Settings tab**: every option is editable in a **Vidosser** tab and applies instantly, with no restart.

## Default shortcuts

| Action | Default | Notes |
|---|---|---|
| Next / previous frame | Wheel down / up | 1 notch = 1 frame; only in fullscreen by default |
| Jump ×10 frames | Shift + wheel | configurable (`shift_frames`) |
| Short jump (= Q / W) *or* playback speed | Ctrl + wheel | action configurable (`wheel_mod_action`: `jump` / `speed`); modifier configurable (`wheel_jump_modifier`) |
| Scrub frames | drag horizontally on the video (left button, or right if chosen) | 8 px = 1 frame; Shift + drag = ×10, Ctrl + drag = short jumps |
| Volume | drag vertically on the video (left button, or right if chosen) | up = louder, 2 px = 1 %; button configurable (`volume.drag_button`) |
| Previous frame | `A` | auto-repeat steps one frame per repeat |
| Next frame | `S` | |
| Jump back | `Q` | 0.5 s by default, or N frames |
| Jump forward | `W` | |
| Save frame | `D` or middle click on the video | PNG/JPG, ask or direct mode |
| Loop on/off (this video) | `L` | |
| Boomerang on/off (this video) | `B` | needs the video to loop (or an A-B segment) |
| Segment start / end | `I` / `O` | A-B loop at the current frame |
| Clear segment | `U` | |
| Fullscreen on / off | double-click the video | enters outside fullscreen, exits inside it (also native); or WanGP's player fullscreen button |
| Play / pause without controls | click the video or `Space` | when the control bar is hidden |

Keys are case-insensitive and remappable; the same key can't be used for two actions. If your existing settings already use one of the new 1.3.0 keys (L, I, O, U) for another action, your key wins and the new action gets a free key (shown in the Vidosser tab). They do nothing while you type in a text field (prompt etc.) or while Ctrl/Alt/Cmd is held, so WanGP's own Alt+… shortcuts keep working. The target video is, in order: the fullscreen video, then the video under the mouse, then the last video you used if it's still visible.

Middle clicks on links, buttons, gallery thumbnails and the rest of the page behave as usual. On a video, the middle click doesn't start Windows autoscroll or Linux paste, saves once per click, and a slight wheel roll while pressing doesn't change the frame.

## Settings (Vidosser tab)

Open the **Vidosser** tab in WanGP, change options, and click **Save settings**. Values are validated (duplicate keys, number ranges, folder writable). If anything is invalid, nothing is saved and the reason is shown. Valid settings are written to `settings.json` in the plugin folder and **applied immediately** in that browser tab. Other already-open WanGP tabs pick them up when reloaded.

| Section | Option | Default | Meaning |
|---|---|---|---|
| **Keys** | *Next frame* / *Previous frame* | `S` / `A` | click the box and press the key you want (Backspace clears) |
| | *Jump forward* / *Jump back* | `W` / `Q` | |
| | *Save frame* | `D` | |
| | *Loop on/off (this video)* | `L` | |
| | *Boomerang on/off (this video)* | `B` | |
| | *A-B segment start* / *end* | `I` / `O` | |
| | *Clear A-B segment* | `U` | |
| | *Keyboard shortcuts enabled* | on | |
| **Frame stepping** | *Mouse wheel: 1 notch = 1 frame* | on | |
| | *Wheel only in fullscreen* | on | off = wheel steps over any video, also outside fullscreen |
| | *Invert wheel direction* | off | on = wheel up goes forward |
| | *Frames with Shift + wheel* | 10 | also used by Shift + drag |
| | *Drag on the video = step frames* | on | inside and outside fullscreen |
| | *Drag button* | *Left* | or *Right*: plain right click = normal context menu |
| | *Pixels per frame when dragging* | 8 | 1–200 |
| | *Invert drag direction* | off | on = drag right goes back |
| | *Lock the pointer while dragging* | on | fullscreen + left button scrub only: no screen edge; Chrome shows a *"Press Esc to show your cursor"* banner each time |
| | *Hide the cursor while dragging* | on | only in fullscreen while the left button is held (scrub or volume) |
| | *Wrap around at the ends* | on | after the last frame → first, before the first → last (drag, wheel, keys, jumps); off = clamp |
| **Short jump** (W / Q and modifier + wheel) | *Short jump: unit* | seconds | *In seconds* or *In frames* |
| | *Short jump: seconds* | 0.5 | rounded to whole frames |
| | *Short jump: frames* | 8 | |
| | *Modifier + wheel* | Ctrl | Ctrl, Alt, Shift, Meta (Cmd / Win) or *None* (off). With Shift, Shift + wheel does the action below instead of the ×10 multiplier (the tab shows a note) |
| | *Modifier + wheel does* | Short jump | *Short jump* (one notch = one short jump, same as W / Q) or *Playback speed* (±0.25× per notch, 0.25–2.00; overlay `Speed 1.25×`). Forward for frames = faster; *Invert wheel direction* flips both |
| | *Remember the playback speed for the next videos* | on | only when the action is *Playback speed*; also after a page reload (stored in the browser) |
| **Volume** | *Vertical drag = volume* | on | up = louder; plain click / double-click unchanged |
| | *Volume drag button* | Left | *Right*: the right button changes the volume. Same as *Drag button* = one button, the direction decides; different = each button only does its own job |
| | *Pixels per 1 % of volume* | 2 | 0.2–50 |
| | *Invert volume direction* | off | on = drag down is louder |
| | *Remember the volume for the next videos* | on | also after a page reload (stored in the browser) |
| **Loop** | *Loop all videos* | on | applied live, also to videos added later |
| | *Loop mode* | Normal (back to the start) | *Boomerang (forwards and backwards)*: bounce at the end (and between A and B); `B` switches it per video |
| **New video** | *In fullscreen, don't jump to the new video* | on | only while a gallery video is fullscreen; outside fullscreen WanGP jumps as usual |
| | *When leaving fullscreen, show the new video* | on | what WanGP would have done |
| | *«New video ready» message* | on | not possible in native fullscreen |
| **Save frame** | *Format* | PNG | PNG or JPG |
| | *JPG quality* | 95 | 1–100 |
| | *Mode* | ask | *Ask where to save* or *Save straight into the folder* |
| | *Folder* (direct mode) | empty = `<WanGP outputs>/frames` | on the machine running WanGP; **Check folder** tests that it exists or can be created and is writable |
| | *Middle click (wheel click) on the video = save frame* | on | |
| | *«Frame saved» message* | on | |
| | *Message duration (seconds)* | 2.5 | 0.5–30 |
| | *White flash over the video* | on | |
| | *Camera sound when saving* | on | low double beep on errors |
| | *Volume* | 60 | 1–100 |
| **Overlay and fullscreen** | *Show overlay on the video* | on | |
| | *Video fullscreen with overlays and messages* | on | see *Fullscreen with overlays* above |
| | *Hide the video control bar* | *Only in fullscreen* | *No* / *Only in fullscreen* / *Always* |
| | *Thin progress bar (3 px)* | on | shown only while the controls are hidden |
| | *FPS when they can't be detected* | 16 | used only if the frame rate can't be read |

With a Spanish browser the same tab is shown in Spanish (*Teclas*, *Paso de fotogramas*, *Guardar ajustes*…). The values stored in `settings.json` are the same in both languages.

## Language

- Vidosser shows **every on-screen text in English or Spanish**, picked from the **browser's language** (`navigator.languages[0]`, i.e. the first language in the browser's language settings): **Spanish for any `es-*`** (Spain, Mexico, Argentina, …), **English for everything else** (English is the default and the fallback). There is no setting for it: change the browser's preferred language and reload the page.
- This covers the Vidosser tab (labels, help texts, section headers, dropdown / radio choices, buttons, validation and save messages, *Check folder* result) and everything drawn on the video (overlays, messages, the native-fullscreen subtitle line, save errors coming from the server).
- WanGP itself has no UI language setting (its interface is in English) and Gradio 5.29, the version WanGP uses, has no translation API (`gr.I18n` only exists in newer Gradio versions), so Vidosser builds its tab in English and, in a Spanish browser, switches the tab's texts to Spanish right after the page loads (through a hidden button of the tab, like its other hidden controls). Only the displayed labels change: the values stored in `settings.json` (`"fullscreen"`, `"ctrl"`, `"ask"`…) are the same in both languages, so the same file works for both.
- Not translated: browser messages (Chrome's *"Press Esc to show your cursor"*, the *Save as* dialog), Gradio's and WanGP's own texts, file names and paths, error details coming from the operating system or ffmpeg, the subtitle track name "Vidosser", and the browser-console logs (English).

<details><summary><code>settings.json</code> structure (advanced)</summary>

```json
{
  "general":    { "default_fps": 16, "min_video_size": 100, "show_overlay": true, "overlay_ms": 1200, "container_fullscreen": true,
                  "hide_controls": "fullscreen", "show_thin_progress": true },
  "keys":       { "enabled": true, "next_frame": "s", "prev_frame": "a", "jump_forward": "w", "jump_back": "q", "save_frame_as": "d",
                  "toggle_loop": "l", "toggle_boomerang": "b", "mark_in": "i", "mark_out": "o", "clear_segment": "u" },
  "frame_step": { "enabled": true, "wheel_enabled": true, "wheel_fullscreen_only": true, "wheel_jump_modifier": "ctrl",
                  "shift_frames": 10, "invert_direction": false,
                  "drag_scrub": true, "drag_pixels_per_frame": 8, "drag_invert": false, "drag_button": "left",
                  "drag_pointer_lock": true, "drag_hide_cursor": true, "wrap": true,
                  "jump_mode": "seconds", "jump_seconds": 0.5, "jump_frames": 8,
                  "wheel_mod_action": "jump", "speed_remember": true },
  "loop":       { "enabled": true, "loop_all": true, "mode": "normal" },
  "volume":     { "enabled": true, "drag_volume": true, "drag_pixels_per_percent": 2.0, "drag_invert": false, "drag_button": "left", "remember": true },
  "new_video":  { "enabled": true, "no_autojump_fullscreen": true, "jump_on_fullscreen_exit": true, "notify": true },
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
Download `wan2gp-vidosser-1.4.6.zip` from [Releases](https://github.com/sweetyshots123/wan2gp-vidosser/releases) and extract it into `Wan2GP/plugins/`, so that you get `Wan2GP/plugins/wan2gp-vidosser/plugin.py`. Then enable it in the Plugins tab and restart WanGP.

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

- In a video's **native fullscreen** (the fullscreen button in the browser's control bar of the video), the wheel, keys and middle click work, but browsers don't allow drawing over a natively fullscreen `<video>`: the overlay (frame, volume, save, loop) is shown as a subtitle line at the top left, but there are no big messages, flash, thin progress bar or loop bar; saves are also confirmed by the sound. For the subtitle Vidosser adds a "Vidosser" subtitles track to the video (and hides Chrome's captions button on that video if it had no captions of its own). Chrome always shows its controls on a natively fullscreen video, so Vidosser hides them there with CSS (when *hide control bar* is not *No*). Double-click the video instead (with *fullscreen with overlays* on), or use the gallery's own fullscreen button (top right of the gallery).
- A-B looping relies on seeking back just before frame out+1 would be shown. It is frame-accurate in Chrome/Edge (tested at 16 and 24 fps); on a heavily loaded machine or in browsers without `requestVideoFrameCallback` an occasional extra frame can flash before the wrap.
- Loop segments are kept only while the page is open (not saved to disk).
- Boomerang: browsers can't play video backwards, so Vidosser emulates it with the video paused (no sound backwards). Remembered frames take up to about 256 MB of browser memory for the video being watched (big videos are remembered downscaled to 1280 px, so backwards looks slightly softer than forwards on them). Before the frames are remembered, and in the video's native fullscreen, backwards seeks every frame: depending on the clip (resolution, keyframe spacing) and the computer that can show only a few frames per second.
- Drag to scrub uses the chosen button on the video picture, so the video's own drag gestures there (none in Chrome/Firefox by default) are replaced while it is on. Seeking with the native progress bar is unchanged. Touch scrubbing was tested with emulated touch in Chrome, not on a real phone/tablet.
- Right-button drag: on **Windows** the context menu opens on release, so it is simply skipped after a drag. On **macOS and Linux** browsers open the context menu as soon as the right button is pressed, so a right-button drag usually isn't possible there: use the left button.
- Pointer lock: Chrome/Edge show the *"Press Esc to show your cursor"* banner every time a drag starts the lock; browsers don't let a page hide it. Turn *Lock the pointer while dragging* off if it bothers you (the cursor is then only hidden, and the drag stops at the screen edge).
- Ctrl + wheel and trackpad pinch: if you choose *None* as the modifier, Ctrl + wheel zooms the browser as usual.
- The middle click saves when you release the button. In ask mode, if the button is held for more than about 5 seconds, the browser no longer allows the *Save as* dialog and the frame is downloaded instead.
- Direct mode saves on the machine running WanGP. If you use WanGP from another computer over the network, the file lands on the server.
- JPG is lossy; use PNG for a bit-exact frame.
- On macOS, system wheel acceleration can make a fast spin report more notches.
- Keys match the character they type (`a`, `s`…), not the physical key position.
- *Remember the volume* and *Remember the playback speed* are stored in the browser (localStorage), not in `settings.json`.
- New video while fullscreen: made for WanGP's output gallery when the new item is a video. If the new item is an **image**, Gradio replaces the video player with an image and that can't be prevented. If the video you watch leaves the gallery's visible list (deleted, or pushed out by WanGP's gallery file limit), the change is applied.

## Troubleshooting

- **Middle click does nothing:** many mouse utilities (Logitech Options/G HUB, Razer Synapse, etc.) can remap the wheel click to another function, in which case the browser never receives a middle click. Set it back to "Middle click" for the browser, and check that *Middle click (wheel click) on the video = save frame* is enabled in the Vidosser tab.
- **No overlay or messages in fullscreen:** you are in native video fullscreen (see Limitations). Double-click the video instead, or use the gallery's fullscreen button. Check that *Video fullscreen with overlays and messages* is on.
- **Ctrl + wheel zooms the page:** that's expected outside fullscreen when *Wheel only in fullscreen* is on, or when the pointer isn't over a video with it off.
- **Dragging on a video doesn't scrub / a click doesn't pause any more:** check *Drag on the video = step frames* in the Vidosser tab; a movement under 4 px counts as a click, more than that as a drag.
- **A banner "Press Esc to show your cursor" appears when I drag:** that is the browser's notice for pointer lock (see Limitations); turn off *Lock the pointer while dragging* to avoid it.
- **The control bar disappeared:** with *Hide the video control bar* = *Only in fullscreen* (default) it is hidden in fullscreen only; click or Space plays/pauses. Choose *No* to always show it.
- **No sound on save:** check *Camera sound when saving* and the volume; browsers only play sound after you have interacted with the page (a key press or click is enough).
- **Wheel scrolls the page instead of stepping:** this is the default outside fullscreen. Go fullscreen, or turn off *Wheel only in fullscreen* in the Vidosser tab.
- **Plugin not active after installing:** enable it in the Plugins tab, restart WanGP, and reload the page. The browser console should show `[Vidosser] v1.4.6 loaded`.
- **"Save failed: video outside WanGP's folders"** (Spanish: *"Error al guardar: vídeo fuera de las carpetas de WanGP"*): the video is outside WanGP's folders (see Compatibility).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
- **1.4.6**: choose the mouse button for the vertical volume drag (left / right; a different button from the scrub = volume only).
- **1.4.5**: Boomerang loop mode (forwards then backwards, also between A and B; `B` per video; silent backwards at the playback speed).
- **1.4.4**: modifier + wheel configurable as short jump or playback speed (±0.25×, 0.25–2.00; same invert as frames; remember speed).
- **1.4.3**: wrap around at the ends when scrubbing / stepping / jumping (on by default; switchable).
- **1.4.2**: every on-screen text in English or Spanish, following the browser's language (Spanish for any `es-*`, English otherwise); `settings.json` unchanged.
- **1.4.1**: vertical volume drag fixed in fullscreen (no pointer lock for it; Windows pointer-lock quirks handled for the scrub); the cursor is only hidden while the left button is held during a drag in fullscreen (never outside fullscreen, never by Chrome's idle controls); overlay in native fullscreen as a subtitle.
- **1.4.0**: vertical drag on the video = volume (axis locked by the dominant direction, overlay, sensitivity, invert, remembered volume); in fullscreen, a newly generated video no longer replaces the one you are watching (shown when you leave fullscreen).
- **1.3.0**: drag on the video to scrub frames (pointer lock with hidden cursor); double-click toggles fullscreen; hide the control bar (in fullscreen by default) with a thin progress line; Ctrl + wheel short jump (configurable modifier, trackpad pinch); save feedback (message, flash, shutter sound); fullscreen with overlays on double-click; loop module (loop all, L toggle, frame-accurate A-B segment with I / O / U).
- **1.2.0**: middle-click (wheel click) save; wheel frame-stepping only in fullscreen by default; settings migration (missing keys use defaults); no `settings.json` shipped.
- **1.1.0**: renamed to *Vidosser* (collection of video tools); keyboard frame stepping and jumps; save exact frame (PNG/JPG, ask/direct); Vidosser settings tab with live apply.
- **1.0.0**: mouse-wheel frame stepping (one notch = one frame, Shift = 10), also in fullscreen.

## License

[MIT](LICENSE) © 2026 sweetyshots123
