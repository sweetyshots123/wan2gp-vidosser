# Changelog

All notable changes to Vidosser. Versions follow [Semantic Versioning](https://semver.org/).

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
