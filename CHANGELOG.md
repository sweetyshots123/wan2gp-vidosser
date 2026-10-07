# Changelog

All notable changes to Vidosser. Versions follow [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-10-07
### Added
- **Drag to scrub**: hold the left mouse button (or a finger) on a video and drag horizontally to step frames, `frame_step.drag_pixels_per_frame` px per frame (default 8), right = forward (`drag_invert`). Position based, exact integer targets through the same seek queue (no drift). Starts after a 4 px mostly-horizontal threshold, so a plain click still toggles play/pause; pauses the video on drag start and swallows the click that ends a drag. Uses pointer capture (keeps working outside the video). Shift + drag = `shift_frames` per step, short-jump modifier + drag = one short jump per step. Not used on the native control bar (bottom 40 px of `<video controls>`), thumbnails or other elements. Works in and outside fullscreen (container and native), independent of `wheel_fullscreen_only`. Setting `frame_step.drag_scrub` (default on). `frame_step.drag_button`: `left` (default) or `right`; with the right button the context menu is blocked only after an actual drag, so a plain right click keeps the normal menu (on macOS/Linux the menu opens on press, so use the left button there). All options in the tab.
- **Short jump with the wheel**: holding a modifier while turning the wheel makes each notch one short jump (the same size as `W`/`Q`). Setting `frame_step.wheel_jump_modifier`: `ctrl` (default), `alt`, `shift`, `meta` or `none` (dropdown in the tab). With `shift`, the jump takes precedence over `shift_frames` and the tab shows a note. The browser zoom (Ctrl + wheel) is blocked only while Vidosser is actually stepping a video. Trackpad pinch gestures (synthetic Ctrl + wheel) are accumulated into whole jumps. Respects `wheel_fullscreen_only` and `invert_direction`, and the overlay shows the jump.
- **Save feedback**: prominent message *Fotograma guardado (frame N): name/path* (2.5 s, fades out; drawn inside the fullscreen element when a container is fullscreen), red error message, grey message on cancel, white flash over the video, and a WebAudio camera-shutter sound (error: low double beep). Settings `save_frame.toast`, `toast_ms`, `flash`, `sound`, `sound_volume`.
- **Fullscreen with overlays** (`general.container_fullscreen`, default on): double-clicking a video or using the fullscreen button of WanGP's video player puts the player box fullscreen instead of the bare `<video>`, so the overlay, messages and loop bar are visible. The fullscreen button in the browser's native control bar can't be intercepted and stays native.
- **Loop module**: `loop.loop_all` (loop every video, live, including videos added later); `L` toggles looping of the current video; frame-accurate **A-B segment loop** with `I` (in), `O` (out) and `U` (clear). Out before in is swapped; moving one end past the other end of a complete segment starts a new segment. Segments are per video and kept while the page is open, shown as a bar over the video's bottom edge, and confirmed by messages. Stepping is never clamped to the segment.
- New keys are listed in the tab's key list, with duplicate-key validation across all actions. If an existing `settings.json` already uses one of the new default keys, the user's key wins and the new action gets a free key.
### Changed
- The jump settings are grouped as **Salto corto** in the tab (used by `W`/`Q` and modifier + wheel).
### Fixed
- Stepping backwards from the very end of a video (`currentTime == duration`, e.g. after it ended) could skip one frame.

## [1.2.0] - 2026-10-07
### Added
- **Middle click (wheel click) saves the frame** over a video, or anywhere while a video or its container is fullscreen. Same as `D`, using the configured format, mode and folder. It saves exactly once per click, suppresses Windows/Chrome autoscroll, Linux paste and `auxclick`, and ignores a slight wheel roll while pressed. Middle clicks elsewhere (links, buttons, gallery thumbnails) are untouched. Setting `save_frame.middle_click_save` (default on).
- **`frame_step.wheel_fullscreen_only`** (default on): the wheel steps frames only while a video (or an element containing one) is fullscreen. Outside fullscreen the wheel is not intercepted at all. Keys and middle click are not affected.
### Changed
- `settings.json` is no longer shipped. It is created by the Vidosser tab, ignored by git, and preserved across updates. Missing keys (e.g. from a 1.1.0 file) are filled from the built-in defaults; the 1.0 key layout is migrated automatically.

## [1.1.0] - 2026-10-07
### Added
- Renamed to **Vidosser**, a collection of video viewing tools (folder/id `wan2gp-vidosser`), structured as a core plus modules.
- Keyboard frame stepping: `A`/`S` previous/next frame, `Q`/`W` jump back/forward (0.5 s converted with the video's fps, or N frames).
- **Save frame** (`D`): exact displayed frame at full resolution, extracted server-side from the source video with WanGP's decoder. PNG or JPG (quality), *ask* (Save-as dialog) or *direct* (auto-numbered, never-overwriting files in a folder) mode.
- **Vidosser settings tab**: key capture, frame-stepping options, save options with folder check, overlay; validated, saved to `settings.json`, applied live.
### Fixed
- Chrome could stay stuck "seeking" when several seeks were issued quickly. Seeks are now queued, with a watchdog.

## [1.0.0] - 2026-10-07
### Added
- Mouse-wheel frame stepping in the WanGP UI, also in fullscreen: one wheel notch = exactly one frame (no acceleration or coalescing loss), Shift + wheel = 10 frames, exact fps detection from MP4/MOV/MKV/WebM headers, overlay with frame number.
