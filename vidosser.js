// ===========================================================================
// Vidosser - a collection of video viewing tools for WanGP (plugin JS).
//
// Layout (add new tools as new MODULE sections at the bottom):
//   CORE                shared helpers used by every module:
//                       exact fps / frame count detection (MP4/MOV/MKV/WebM header,
//                       playback estimate), video targeting (pointer, fullscreen,
//                       last interacted), "is the user typing" guard, overlay badge.
//                       Also: keyboard action registry (configurable keys), the
//                       JS <-> Python bridge (hidden components of the Vidosser tab)
//                       and live settings (applySettings).
//   MODULE frame_step   mouse wheel and keyboard frame stepping:
//                       * 1 wheel notch = exactly 1 frame, Shift + wheel = shift_frames
//                         (wheel_fullscreen_only: only while fullscreen; keys always work)
//                       * wheel_jump_modifier (Ctrl) + wheel = short jump OR playback speed
//                         (frame_step.wheel_mod_action: "jump" | "speed"; speed ±0.25, 0.25..2)
//                       * next_frame / prev_frame (S / A), jump_forward / jump_back
//                         (W / Q: jump_seconds converted with the video fps, or jump_frames)
//                       * drag on the video: horizontal = scrub frames, vertical = volume
//                         (axis chosen by the dominant direction after DRAG_THRESHOLD px, then locked;
//                         a separate volume button, volume.drag_button, drags the volume only)
//                       * wrap (frame_step.wrap): past the last frame -> first, past the first -> last
//                         (drag / wheel / keys / jumps; off = clamp at the ends)
//   MODULE volume       volume helpers for the vertical drag (overlay, clamp, unmute, remember)
//   MODULE container_fs video fullscreen on a container (not native) so overlays/toasts show
//   MODULE loop         loop all videos, loop toggle (L), A-B segment loop (I / O, U = clear),
//                       loop.mode "boomerang" (ping-pong: emulated reverse at the end, also A-B; B = per video)
//   MODULE new_video    in fullscreen, a newly generated video does not replace the one being
//                       watched in the output gallery (no_autojump_fullscreen)
//   MODULE save_frame   save_frame_as (D, or middle click on the video): saves the displayed frame (PNG/JPG), extracted
//                       server-side from the source video (lossless, exact frame),
//                       either with a "save as" dialog or straight into a folder.
// Language: every on-screen text in English or Spanish (i18n(en, es)), Spanish for a browser
// language es-*, English otherwise; the settings tab is switched to Spanish through the hidden
// #vidosser_lang / #vidosser_lang_btn components (see localizeTab at the bottom).
// Settings come from settings.json (injected below by plugin.py, refreshed on page
// load and after "Save" in the Vidosser tab): "general", "keys" + one section per module.
// ===========================================================================
(function () {
    "use strict";
    if (window.__vidosser) return;
    const SETTINGS = __VIDOSSER_SETTINGS__ || {};
    const VERSION = "__VIDOSSER_VERSION__";
    const V = window.__vidosser = { version: VERSION, settings: SETTINGS, core: null, modules: {} };

    // ------------------------------------------------------------------ i18n
    // Every on-screen text exists in English and Spanish: Spanish when the browser's language
    // (navigator.languages[0], else navigator.language) is any es-*, English otherwise (default).
    function detectLang() {
        try {
            const l = (navigator.languages && navigator.languages[0]) || navigator.language || "";
            return /^es(?:[-_]|$)/i.test(String(l)) ? "es" : "en";
        } catch (_) { return "en"; }
    }
    const LANG = detectLang();
    const i18n = (en, es) => (LANG === "es" ? es : en);
    V.lang = LANG; V.i18n = i18n;

    // =======================================================================
    // CORE
    // =======================================================================
    const core = (function (CFG, KEYS) {
        const IS_FIREFOX = /firefox/i.test(navigator.userAgent);
        const COMMON_FPS = [8, 10, 12, 12.5, 15, 16, 20, 23.976, 24, 25, 29.97, 30, 32, 48, 50, 59.94, 60];
        const infos = new WeakMap();
        const mp4Cache = new Map();   // url -> Promise<{fps, frames} | null>

        // ---------------------------------------------- per-video media info
        function getInfo(video) {
            const src = video.currentSrc || video.src || "";
            let s = infos.get(video);
            if (!s || s.src !== src) {
                s = { src, fps: 0, fpsSource: "", frames: 0, fpsPromise: null, rvfc: [], rvfcRunning: false };
                infos.set(video, s);
            }
            return s;
        }

        function snapFps(fps) {
            for (const c of COMMON_FPS) if (Math.abs(fps - c) / c < 0.01) return c;
            return Math.round(fps * 1000) / 1000;
        }

        // ------------------------------------------------- exact fps from MP4/MOV
        async function readRange(url, start, length) {
            const end = start + length - 1;
            const resp = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: "same-origin" });
            if (resp.status === 206) return new Uint8Array(await resp.arrayBuffer());
            if (!resp.ok || !resp.body) return null;
            // Server ignored the Range header: stream until we have the bytes we need.
            if (end > 256 * 1024 * 1024) { try { resp.body.cancel(); } catch (_) {} return null; }
            const reader = resp.body.getReader();
            const chunks = []; let got = 0;
            while (got <= end) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value); got += value.length;
            }
            try { reader.cancel(); } catch (_) {}
            const all = new Uint8Array(got); let off = 0;
            for (const c of chunks) { all.set(c, off); off += c.length; }
            return all.subarray(start, Math.min(got, end + 1));
        }

        const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

        function* boxes(dv, start, end) {
            const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
            let p = start;
            while (p + 8 <= end) {
                let size = dv.getUint32(p);
                const type = fourcc(u8, p + 4);
                let header = 8;
                if (size === 1) { size = Number(dv.getBigUint64(p + 8)); header = 16; }
                else if (size === 0) size = end - p;
                if (size < header || p + size > end) return;
                yield { type, start: p, body: p + header, end: p + size };
                p += size;
            }
        }

        function child(dv, box, type) {
            for (const b of boxes(dv, box.body, box.end)) if (b.type === type) return b;
            return null;
        }

        function parseMoov(bytes) {
            const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const moov = { body: dv.getUint32(0) === 1 ? 16 : 8, end: bytes.byteLength };
            for (const trak of boxes(dv, moov.body, moov.end)) {
                if (trak.type !== "trak") continue;
                const mdia = child(dv, trak, "mdia"); if (!mdia) continue;
                const hdlr = child(dv, mdia, "hdlr");
                if (!hdlr || fourcc(bytes, hdlr.body + 8) !== "vide") continue;
                const mdhd = child(dv, mdia, "mdhd"); if (!mdhd) continue;
                const version = dv.getUint8(mdhd.body);
                const timescale = dv.getUint32(mdhd.body + (version === 1 ? 20 : 12));
                const minf = child(dv, mdia, "minf"); const stbl = minf && child(dv, minf, "stbl");
                const stts = stbl && child(dv, stbl, "stts");
                if (!stts || !timescale) continue;
                const count = dv.getUint32(stts.body + 4);
                let frames = 0, bestCount = 0, bestDelta = 0;
                for (let i = 0; i < count; i++) {
                    const n = dv.getUint32(stts.body + 8 + i * 8), d = dv.getUint32(stts.body + 12 + i * 8);
                    frames += n;
                    if (n > bestCount && d > 0) { bestCount = n; bestDelta = d; }
                }
                if (!bestDelta || !frames) continue;
                return { fps: timescale / bestDelta, frames };
            }
            return null;
        }

        // Matroska / WebM: Segment > Tracks > TrackEntry(TrackType=1) > DefaultDuration (ns per frame)
        function vint(b, p, keepMarker) {
            const first = b[p];
            if (first === undefined || first === 0) return null;
            let len = 1, mask = 0x80;
            while (!(first & mask)) { len++; mask >>= 1; }
            if (p + len > b.length) return null;
            let value = keepMarker ? first : first & (mask - 1), allOnes = value === mask - 1;
            for (let i = 1; i < len; i++) { value = value * 256 + b[p + i]; if (b[p + i] !== 0xff) allOnes = false; }
            return { value, len, unknown: !keepMarker && allOnes };
        }

        function parseMatroska(b) {
            const walk = (start, end, depth, out) => {
                let p = start;
                while (p < end) {
                    const id = vint(b, p, true); if (!id) return;
                    const sz = vint(b, p + id.len, false); if (!sz) return;
                    const body = p + id.len + sz.len;
                    const stop = sz.unknown ? end : Math.min(end, body + sz.value);
                    if (id.value === 0x1F43B675) return "stop";                 // Cluster: tracks are before it
                    if (id.value === 0x18538067 || id.value === 0x1654AE6B) {   // Segment, Tracks
                        if (walk(body, stop, depth + 1, out) === "stop") return "stop";
                    } else if (id.value === 0xAE) {                             // TrackEntry
                        const t = {}; walk(body, stop, depth + 1, t);
                        if (t.type === 1 && t.dur > 0) { out.fps = 1e9 / t.dur; return "stop"; }
                    } else if (id.value === 0x83 || id.value === 0x23E383) {    // TrackType, DefaultDuration
                        let v = 0; for (let i = body; i < stop; i++) v = v * 256 + b[i];
                        if (id.value === 0x83) out.type = v; else out.dur = v;
                    }
                    if (sz.unknown) return;
                    p = body + sz.value;
                }
            };
            const out = {};
            walk(0, b.length, 0, out);
            return out.fps ? { fps: out.fps, frames: 0 } : null;
        }

        async function probeMp4(url) {
            const magic = await readRange(url, 0, 4);
            if (magic && magic.length === 4 && magic[0] === 0x1A && magic[1] === 0x45 && magic[2] === 0xDF && magic[3] === 0xA3) {
                const head = await readRange(url, 0, 512 * 1024);
                return head ? parseMatroska(head) : null;
            }
            let pos = 0;
            for (let i = 0; i < 64; i++) {
                const head = await readRange(url, pos, 16);
                if (!head || head.length < 8) return null;
                const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
                let size = dv.getUint32(0);
                const type = fourcc(head, 4);
                if (!/^[\x20-\x7e]{4}$/.test(type)) return null;          // not an ISO-BMFF file
                if (size === 1) { if (head.length < 16) return null; size = Number(dv.getBigUint64(8)); }
                if (type === "moov") {
                    if (size === 0 || size > 64 * 1024 * 1024) return null;
                    const moov = await readRange(url, pos, size);
                    return moov && moov.length === size ? parseMoov(moov) : null;
                }
                if (size < 8) return null;                                  // size 0 = "to EOF": no moov after it
                pos += size;
            }
            return null;
        }

        function probeCached(url) {
            if (!mp4Cache.has(url)) {
                mp4Cache.set(url, probeMp4(url).catch(() => null));
                if (mp4Cache.size > 200) mp4Cache.delete(mp4Cache.keys().next().value);
            }
            return mp4Cache.get(url);
        }


        // --------------------------------- fps estimate from real playback
        function startRvfc(video) {
            if (typeof video.requestVideoFrameCallback !== "function") return;
            const s = getInfo(video);
            if (s.rvfcRunning) return;
            s.rvfcRunning = true;
            let prev = null;
            const onFrame = (_now, meta) => {
                if (getInfo(video) !== s) { s.rvfcRunning = false; return; }
                if (prev && meta.presentedFrames - prev.presentedFrames === 1) {
                    const delta = meta.mediaTime - prev.mediaTime;
                    if (delta > 0.004 && delta < 0.5) { s.rvfc.push(delta); if (s.rvfc.length > 60) s.rvfc.shift(); }
                }
                prev = meta;
                if (s.fpsSource !== "mp4" && s.rvfc.length >= 8) {
                    const sorted = s.rvfc.slice().sort((a, b) => a - b);
                    const fps = snapFps(1 / sorted[sorted.length >> 1]);
                    if (fps !== s.fps) { s.fps = fps; s.fpsSource = "playback"; }
                }
                if (!video.paused && !video.ended) video.requestVideoFrameCallback(onFrame);
                else s.rvfcRunning = false;
            };
            video.requestVideoFrameCallback(onFrame);
        }

        // Resolves to the video's info object once fps is known (exact header value,
        // playback estimate or default_fps). fpsSource "mp4" = exact (any container).
        function ensureFps(video) {
            const s = getInfo(video);
            if (s.fpsSource === "mp4") return Promise.resolve(s);
            if (!s.fpsPromise) {
                const url = s.src;
                const probe = url && !url.startsWith("data:") ? probeCached(url) : Promise.resolve(null);
                const timeout = new Promise(res => setTimeout(() => res(null), 2500));
                probe.then(info => {                                    // late result (after timeout) still wins
                    if (info && info.fps > 0 && info.fps < 1000 && getInfo(video) === s) {
                        s.fps = info.fps; s.frames = info.frames; s.fpsSource = "mp4";
                    }
                });
                s.fpsPromise = Promise.race([probe, timeout]).then(info => {
                    if (info && info.fps > 0 && info.fps < 1000) {
                        s.fps = info.fps; s.frames = info.frames; s.fpsSource = "mp4";
                    } else if (!s.fps) {
                        s.fps = CFG.default_fps; s.fpsSource = "default";
                    }
                    return s;
                });
            }
            return s.fpsPromise;
        }

        function lastFrameOf(video, s) {
            if (s.fpsSource === "mp4" && s.frames > 0) return s.frames - 1;   // exact count (MP4/MOV)
            const dur = video.duration;
            return Number.isFinite(dur) && dur > 0 ? Math.max(0, Math.round(dur * s.fps) - 1) : Infinity;
        }

        // ------------------------------------------------- video targeting
        let lastVideo = null;                  // most recently interacted video (wheel/click/hover/play/step)
        let pointer = null;                    // last known pointer position (viewport coords)

        function fsElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }

        function eligible(v, fs) {
            if (!(v instanceof HTMLVideoElement)) return false;
            if (!(v.currentSrc || v.src) || v.readyState < 1) return false;
            if (v === fs) return true;
            if (v.closest(".thumbnail-item")) return false;               // gallery thumbnails
            const r = v.getBoundingClientRect();
            return r.width >= CFG.min_video_size && r.height >= CFG.min_video_size;
        }

        function isVisible(v) {
            if (!v || !v.isConnected || !eligible(v, fsElement())) return false;
            const r = v.getBoundingClientRect();
            return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth &&
                   getComputedStyle(v).visibility !== "hidden";
        }

        function biggestVideoIn(root) {
            let best = null, area = 0;
            for (const v of root.querySelectorAll("video")) {
                if (!eligible(v, root)) continue;
                const r = v.getBoundingClientRect(), a = r.width * r.height;
                if (a > area) { area = a; best = v; }
            }
            return best;
        }

        // Video under (x, y), also when the pointer is over controls drawn on top of
        // it inside the same Gradio component. `top` = topmost element at the point.
        function videoAtPoint(x, y, top) {
            const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
            top = top || stack[0];
            const fs = fsElement();
            for (const n of stack) {
                if (!(n instanceof HTMLVideoElement)) continue;
                if (!eligible(n, fs)) return null;
                if (n === top) return n;
                if (fs && fs.contains(n)) return n;
                const block = n.closest(".block") || n.parentElement;
                return block && top instanceof Node && block.contains(top) ? n : null;
            }
            return null;
        }

        // Target for a pointer event (wheel): video in the event path, video under the
        // pointer, or - while something is fullscreen - the fullscreen video.
        function videoForPointerEvent(e) {
            const fs = fsElement();
            const path = e.composedPath ? e.composedPath() : [];
            for (const n of path) {
                if (n instanceof HTMLVideoElement) return eligible(n, fs) ? n : null;
            }
            if (fs instanceof HTMLVideoElement) return eligible(fs, fs) ? fs : null;
            const v = videoAtPoint(e.clientX, e.clientY, path[0] instanceof Element ? path[0] : e.target);
            if (v) return v;
            return fs ? biggestVideoIn(fs) : null;
        }

        // Target for a keyboard shortcut: fullscreen video > video under the pointer >
        // most recently interacted visible video > none.
        function videoForKeyboard() {
            const fs = fsElement();
            if (fs) {
                if (fs instanceof HTMLVideoElement) return eligible(fs, fs) ? fs : null;
                const v = (pointer && videoAtPoint(pointer.x, pointer.y)) || biggestVideoIn(fs);
                if (v) return v;
            }
            if (pointer) { const v = videoAtPoint(pointer.x, pointer.y); if (v) return v; }
            return isVisible(lastVideo) ? lastVideo : null;
        }

        function touch(video) { if (video instanceof HTMLVideoElement) lastVideo = video; }

        // ------------------------------------------------ keyboard guards
        function isEditable(node) {
            if (!node || !(node instanceof Element)) return false;
            const tag = node.tagName;
            return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable ||
                   node.getAttribute("role") === "textbox";
        }

        // True while the user types in a field (prompt boxes...) or a dialog has focus.
        function typingOrModal(e) {
            const path = e && e.composedPath ? e.composedPath() : [];
            if (path.some(isEditable)) return true;
            let a = document.activeElement;
            while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
            if (isEditable(a)) return true;
            return !!(a && a.closest && a.closest('[role="dialog"], [aria-modal="true"], .wangp-confirm-backdrop'));
        }

        // ------------------------------------------------------- overlay
        let overlay = null, overlayTimer = 0;
        // Native <video> fullscreen: no element can be drawn above the video, but its own
        // text tracks are. A "subtitles" track labelled "Vidosser" is added on first use and
        // shows the message as a cue at the top-left (style: ::cue below); its captions
        // button is hidden on videos that had no captions of their own.
        const osd = new WeakMap();
        const osdCss = document.createElement("style");
        osdCss.textContent = "video.vidosser-osd::cue{background:rgba(0,0,0,.7);color:#fff;font:600 24px/1.3 ui-monospace,Consolas,monospace}" +
            "video.vidosser-osd::-webkit-media-controls-toggle-closed-captions-button{display:none!important}";
        (document.head || document.documentElement).appendChild(osdCss);
        function clearOsd(video) {
            const o = video && osd.get(video);
            if (!o) return;
            clearTimeout(o.timer);
            if (o.cue) { try { o.track.removeCue(o.cue); } catch (_) { /* gone */ } o.cue = null; }
            o.track.mode = "hidden";
        }
        function nativeOsd(video, text, sticky = false) {
            let o = osd.get(video);
            if (!o) {
                const own = [...video.textTracks].some(t => t.kind === "subtitles" || t.kind === "captions");
                let track;
                try { track = video.addTextTrack("subtitles", "Vidosser", ""); } catch (_) { return; }
                o = { track, cue: null, timer: 0, own };
                osd.set(video, o);
            }
            if (!o.own) video.classList.add("vidosser-osd");
            const Cue = window.VTTCue;
            if (!Cue) return;
            clearTimeout(o.timer);
            if (o.cue) { try { o.track.removeCue(o.cue); } catch (_) { /* gone */ } }
            const cue = new Cue(0, 1e9, text);
            try { cue.line = 0; cue.align = "start"; cue.position = 2; cue.positionAlign = "line-left"; } catch (_) { /* older engines */ }
            o.track.mode = "showing";
            o.track.addCue(cue); o.cue = cue;
            // a video never played since it was loaded still shows its "poster" state, in which
            // cues are not activated: a seek to the same time ends that state (same frame)
            if (video.paused && !video.seeking && video.played.length === 0 && video.readyState >= 1) {
                try { video.currentTime = video.currentTime; } catch (_) { /* ignore */ }
            }
            o.timer = sticky ? 0 : setTimeout(() => clearOsd(video), CFG.overlay_ms);
        }
        document.addEventListener("fullscreenchange", () => { for (const v of document.querySelectorAll("video.vidosser-osd")) if (fsElement() !== v) clearOsd(v); });
        function showOverlay(video, text) {
            if (!CFG.show_overlay) return;
            const fs = fsElement();
            if (fs === video) { nativeOsd(video, text); return; }   // native <video> fullscreen: shown as a text track cue
            const host = fs || document.body;
            if (!overlay) {
                overlay = document.createElement("div");
                overlay.className = "vidosser-overlay";
                overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;" +
                    "background:rgba(0,0,0,.7);color:#fff;font:600 13px/1.3 ui-monospace,Consolas,monospace;" +
                    "padding:4px 8px;border-radius:6px;white-space:nowrap;transition:opacity .25s;opacity:0;";
            }
            if (overlay.parentNode !== host) host.appendChild(overlay);
            const r = video.getBoundingClientRect();
            let x = r.left, y = r.top;
            if (video.videoWidth && video.videoHeight) {             // top-left of the picture (object-fit: contain)
                const k = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
                x += (r.width - video.videoWidth * k) / 2; y += (r.height - video.videoHeight * k) / 2;
            }
            overlay.style.left = Math.round(x + 8) + "px";
            overlay.style.top = Math.round(y + 8) + "px";
            overlay.textContent = text;
            overlay.style.opacity = "1";
            clearTimeout(overlayTimer);
            overlayTimer = setTimeout(() => { if (overlay) overlay.style.opacity = "0"; }, CFG.overlay_ms);
        }

        // ------------------------------------------------------ feedback
        // Prominent toast (bottom-center), rendered inside the fullscreen element when that
        // is a container (gallery / container fullscreen), else in <body>. Nothing can be
        // drawn over a natively fullscreen <video>: callers use sound() there.
        const nativeVideoFs = () => fsElement() instanceof HTMLVideoElement;
        let toastEl = null, toastTimer = 0;
        function toast(text, kind = "ok", ms = 2500) {
            const fs = fsElement();
            if (fs instanceof HTMLVideoElement) return null;
            const host = fs || document.body;
            if (!toastEl) {
                toastEl = document.createElement("div");
                toastEl.className = "vidosser-toast";
                toastEl.setAttribute("role", "status");
                toastEl.setAttribute("aria-live", "polite");
                toastEl.style.cssText = "position:fixed;left:50%;bottom:48px;transform:translateX(-50%) translateY(8px);" +
                    "z-index:2147483647;pointer-events:none;max-width:min(90vw,900px);padding:12px 20px;border-radius:10px;" +
                    "color:#fff;font:600 15px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);" +
                    "word-break:break-all;text-align:center;opacity:0;transition:opacity .25s,transform .25s;";
            }
            if (toastEl.parentNode !== host) host.appendChild(toastEl);
            toastEl.dataset.kind = kind;
            toastEl.style.background = kind === "error" ? "rgba(190,30,30,.95)" : kind === "info" ? "rgba(60,60,60,.93)" : "rgba(22,128,62,.95)";
            toastEl.textContent = text;
            void toastEl.offsetWidth;
            toastEl.style.opacity = "1"; toastEl.style.transform = "translateX(-50%) translateY(0)";
            clearTimeout(toastTimer);
            toastTimer = setTimeout(() => { toastEl.style.opacity = "0"; toastEl.style.transform = "translateX(-50%) translateY(8px)"; },
                                    Math.max(500, Number(ms) || 2500));
            return toastEl;
        }

        // Brief white flash + border pulse over the video picture (not in native fullscreen).
        function flash(video) {
            const fs = fsElement();
            if (!video || fs === video) return null;
            const r = video.getBoundingClientRect();
            if (!r.width || !r.height) return null;
            const f = document.createElement("div");
            f.className = "vidosser-flash";
            f.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
                "z-index:2147483646;pointer-events:none;background:rgba(255,255,255,.45);box-shadow:inset 0 0 0 4px #fff;" +
                "border-radius:4px;opacity:1;transition:opacity .35s ease-out;";
            (fs || document.body).appendChild(f);
            requestAnimationFrame(() => requestAnimationFrame(() => { f.style.opacity = "0"; }));
            setTimeout(() => f.remove(), 600);
            return f;
        }

        // Camera-shutter sound synthesised with WebAudio (no file). kind "error" = low double beep.
        let audioCtx = null;
        function sound(kind = "ok", volume = 0.6) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return false;
            try {
                if (!audioCtx) audioCtx = new AC();
                if (audioCtx.state === "suspended" && audioCtx.resume) audioCtx.resume();
                const ctx = audioCtx, t0 = ctx.currentTime + 0.01, vol = Math.max(0, Math.min(1, Number(volume)));
                const out = ctx.createGain(); out.gain.value = vol; out.connect(ctx.destination);
                if (kind === "error") {
                    for (const [dt, f] of [[0, 220], [0.16, 180]]) {
                        const o = ctx.createOscillator(), g = ctx.createGain();
                        o.type = "square"; o.frequency.value = f;
                        g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(0.35, t0 + dt + 0.01);
                        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.13);
                        o.connect(g); g.connect(out); o.start(t0 + dt); o.stop(t0 + dt + 0.15);
                    }
                    return true;
                }
                // shutter: two filtered noise clicks (curtain open / close)
                const len = Math.ceil(ctx.sampleRate * 0.2), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
                for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
                for (const [dt, peak, dur] of [[0, 1.0, 0.045], [0.075, 0.7, 0.06]]) {
                    const src = ctx.createBufferSource(); src.buffer = buf;
                    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = dt ? 2600 : 4200; bp.Q.value = 0.9;
                    const g = ctx.createGain();
                    g.gain.setValueAtTime(0.0001, t0 + dt); g.gain.exponentialRampToValueAtTime(peak, t0 + dt + 0.003);
                    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + dur);
                    src.connect(bp); bp.connect(g); g.connect(out); src.start(t0 + dt); src.stop(t0 + dt + dur + 0.02);
                }
                return true;
            } catch (_) { return false; }
        }

        function fpsLabel(s) {
            return (Math.round(s.fps * 1000) / 1000) + " fps" + (s.fpsSource === "default" ? "?" : "");
        }

        // ------------------------------------------------------ seek queue
        // Never abort an in-flight seek: only the latest wanted time is issued when the
        // current seek completes (Chrome can get stuck in "seeking" when seeks from
        // separate key events abort each other). A watchdog re-issues a hung seek.
        const seeks = new WeakMap();
        function seekState(video) {
            let q = seeks.get(video);
            if (!q) {
                q = { desired: null, issued: null, inflight: false, at: 0, watchdog: 0 };
                video.addEventListener("seeked", () => {
                    if (q.inflight && q.desired !== q.issued) issueSeek(video, q);
                    else { q.inflight = false; clearTimeout(q.watchdog); }
                });
                video.addEventListener("emptied", () => { q.inflight = false; clearTimeout(q.watchdog); });
                seeks.set(video, q);
            }
            return q;
        }
        function issueSeek(video, q) {
            q.inflight = true; q.issued = q.desired; q.at = performance.now();
            video.currentTime = q.desired;
            clearTimeout(q.watchdog);
            const arm = () => {
                q.watchdog = setTimeout(() => {
                    if (!q.inflight) return;
                    if (video.seeking) video.currentTime = q.issued;     // hung seek: re-issue (recovers)
                    else if (q.desired !== q.issued) { issueSeek(video, q); return; }
                    else { q.inflight = false; return; }
                    arm();
                }, 1000);
            };
            arm();
        }
        function seekTo(video, t) {
            const q = seekState(video);
            q.desired = t;
            if (!q.inflight || !video.seeking && performance.now() - q.at > 1000) issueSeek(video, q);
        }
        function seekPending(video) { const q = seeks.get(video); return !!(q && q.inflight); }
        // Immediate seek (currentTime reads the new time at once), aborting an in-flight one: only for
        // putting a reversing boomerang video on the frame that is on screen before a user action.
        function seekNow(video, t) { const q = seekState(video); q.desired = t; issueSeek(video, q); }
        // Hooks run before a user action on a video reads its frame (key action, frame step, save, press).
        const userHooks = [];
        function onUserAction(fn) { userHooks.push(fn); }
        function beforeUserAction(video, kind) { for (const h of userHooks) { try { h(video, kind); } catch (_) { /* ignore */ } } }

        // Resolves once the frame on screen is final (no seek in flight or queued).
        function settled(video, timeoutMs = 4000) {
            return new Promise(resolve => {
                let poll = 0;
                const done = () => { clearTimeout(timer); clearInterval(poll); video.removeEventListener("seeked", check); resolve(); };
                const check = () => { if (!video.seeking && !seekPending(video) && video.readyState >= 2) done(); };
                poll = setInterval(check, 50);
                const timer = setTimeout(done, timeoutMs);
                video.addEventListener("seeked", check);
                video.addEventListener("loadeddata", check, { once: true });
                check();
            });
        }

        // ------------------------------------- keyboard action registry
        // Modules register named actions; keys come from settings "keys" (action -> key).
        const actions = {};
        function registerAction(name, handler) { actions[name] = handler; }
        const keyName = k => String(k || "").toLowerCase();

        function onKeyDown(e) {
            if (KEYS.enabled === false || e.defaultPrevented || e.isComposing) return;
            if (e.ctrlKey || e.altKey || e.metaKey) return;             // WanGP uses Alt+S/R/U/F
            const k = keyName(e.key);
            if (!k) return;
            const action = Object.keys(actions).find(name => keyName(KEYS[name]) === k);
            if (!action) return;
            if (typingOrModal(e)) return;                               // prompt boxes, dialogs...
            const video = videoForKeyboard();
            if (!video) return;                                         // nothing to act on: leave the key alone
            e.preventDefault();
            beforeUserAction(video, action);
            actions[action](video, e);                                  // auto-repeat = one action per event
        }

        // Key capture fields of the Vidosser settings tab: press a key to bind it.
        function onKeyCapture(e) {
            const field = e.target;
            if (!(field instanceof Element) || !field.closest(".vidosser-key-input")) return;
            if (e.key === "Tab" || e.ctrlKey || e.altKey || e.metaKey) return;
            e.preventDefault();
            e.stopPropagation();
            let value;
            if (e.key === "Backspace" || e.key === "Delete") value = "";
            else if (e.key.length === 1 && e.key !== " ") value = e.key.toLowerCase();
            else return;
            field.value = value;
            field.dispatchEvent(new Event("input", { bubbles: true }));
        }

        // ------------------------------------------ JS <-> Python bridge
        // Hidden components in the Vidosser tab: request textbox + button; the Python
        // reply is handed back by a JS .then() callback calling bridgeResponse().
        const pending = new Map();
        let chain = Promise.resolve(), seq = 0;
        function bridgeElements() {
            const req = document.querySelector("#vidosser_bridge_req textarea, #vidosser_bridge_req input");
            let btn = document.querySelector("#vidosser_bridge_btn");
            if (btn && !btn.matches("button")) btn = btn.querySelector("button");
            return req && btn ? { req, btn } : null;
        }
        function bridge(payload, timeoutMs = 120000) {
            const run = () => new Promise((resolve, reject) => {
                const el = bridgeElements();
                if (!el) { const err = new Error(i18n("Vidosser bridge not available", "puente de Vidosser no disponible")); err.bridgeMissing = true; reject(err); return; }
                const id = `${Date.now()}-${++seq}`;
                const timer = setTimeout(() => { pending.delete(id); reject(new Error(i18n("timeout", "tiempo de espera agotado"))); }, timeoutMs);
                pending.set(id, { resolve, timer });
                el.req.value = JSON.stringify(Object.assign({ lang: LANG }, payload, { id }));
                el.req.dispatchEvent(new Event("input", { bubbles: true }));
                setTimeout(() => el.btn.click(), 30);
            });
            const p = chain.then(run, run);
            chain = p.catch(() => {});
            return p;
        }
        function bridgeResponse(raw) {
            let r; try { r = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return; }
            const entry = r && pending.get(r.id);
            if (!entry) return;
            pending.delete(r.id); clearTimeout(entry.timer); entry.resolve(r);
        }

        // -------------------------------------------------------- wiring
        window.addEventListener("keydown", onKeyCapture, true);
        window.addEventListener("keydown", onKeyDown, false);           // bubble phase: focused widgets go first
        const trackPointer = e => {
            pointer = { x: e.clientX, y: e.clientY };
            const v = videoAtPoint(e.clientX, e.clientY);
            if (v) lastVideo = v;                                         // hover / click = interaction
        };
        window.addEventListener("pointermove", trackPointer, { capture: true, passive: true });
        window.addEventListener("pointerdown", trackPointer, { capture: true, passive: true });
        document.documentElement.addEventListener("pointerleave", () => { pointer = null; });
        // Media events do not bubble but are visible in the capture phase.
        document.addEventListener("loadedmetadata", e => {
            if (e.target instanceof HTMLVideoElement) ensureFps(e.target);
        }, true);
        document.addEventListener("play", e => {
            if (e.target instanceof HTMLVideoElement) { startRvfc(e.target); lastVideo = e.target; }
        }, true);
        document.querySelectorAll("video").forEach(v => { if (v.readyState >= 1) ensureFps(v); });

        return { CFG, KEYS, IS_FIREFOX, getInfo, ensureFps, lastFrameOf, probeMedia: probeMp4,
                 fsElement, eligible, isVisible, biggestVideoIn, videoAtPoint, videoForPointerEvent,
                 videoForKeyboard, touch, typingOrModal, showOverlay, fpsLabel, settled, seekTo, seekPending, seekNow,
                 onUserAction, beforeUserAction, nativeOsd, clearOsd,
                 toast, flash, sound, nativeVideoFs,
                 registerAction, bridge, bridgeResponse,
                 middlePress: null,                    // video under an ongoing middle-button press (save_frame)
                 dragEndedAt: 0 };                     // time the last drag-scrub ended (frame_step)                  // video under an ongoing middle-button press (save_frame)
    })(Object.assign({
        default_fps: 16,          // fallback when fps cannot be detected (Wan = 16, LTX = 24/25...)
        min_video_size: 100,      // ignore smaller videos (thumbnails), px
        show_overlay: true,
        overlay_ms: 1200,
        container_fullscreen: true, // video fullscreen on its container (overlays/toasts visible) instead of native
        hide_controls: "fullscreen", // hide video control bars: "off" | "fullscreen" | "always"
        show_thin_progress: true,   // 3 px progress line at the bottom edge while the controls are hidden
    }, SETTINGS.general || {}), Object.assign({
        enabled: true,            // keyboard shortcuts on/off
        next_frame: "s",
        prev_frame: "a",
        jump_forward: "w",
        jump_back: "q",
        save_frame_as: "d",
        toggle_loop: "l",
        toggle_boomerang: "b",
        toggle_info: "p",
        prev_video: "e",
        next_video: "r",
        reset_zoom: "z",
        mark_in: "i",
        mark_out: "o",
        clear_segment: "u",
    }, SETTINGS.keys || {}));
    V.core = core;
    V.config = { general: core.CFG, keys: core.KEYS };

    // =======================================================================
    // MODULE volume - volume by vertical drag (the drag itself lives in frame_step)
    // =======================================================================
    // set(v, percent): clamp 0..100, unmute when raising from muted, overlay "Volumen".
    // remember: the last volume (drag or the native slider) is applied to videos loaded
    // later, also after a page reload (localStorage). Only the level, never "muted".
    V.modules.volume = (function (core, CFG) {
        const STORE = "vidosser.volume";
        let remembered = null, applying = false;
        try { const r = Number(localStorage.getItem(STORE)); if (localStorage.getItem(STORE) !== null && r >= 0 && r <= 1) remembered = r; } catch (_) { /* no storage */ }
        const clamp = p => Math.max(0, Math.min(100, Number(p) || 0));
        const level = v => (v.muted ? 0 : v.volume * 100);
        const isThumb = v => !!v.closest(".thumbnail-item");
        const dragOn = () => CFG.enabled !== false && CFG.drag_volume !== false;
        function remember(vol) {
            if (CFG.remember === false) return;
            remembered = vol;
            try { localStorage.setItem(STORE, String(vol)); } catch (_) { /* ignore */ }
        }
        function label(p) {
            const r = Math.round(clamp(p)), n = Math.round(r / 10);
            return `${i18n("Volume", "Volumen")} ${"█".repeat(n)}${"░".repeat(10 - n)} ${String(r).padStart(3)} %` + (r === 0 ? i18n(" (muted)", " (silencio)") : "");
        }
        function set(v, p, overlay = true) {
            p = Math.round(clamp(p));                                // whole percents (the drag keeps its own fraction)
            applying = true;
            try {
                if (p > 0 && v.muted) v.muted = false;               // raising from muted: unmute
                v.volume = p / 100;
            } finally { applying = false; }
            remember(p / 100);
            if (overlay) core.showOverlay(v, label(p));
            return p;
        }
        function applyRemembered(v) {
            if (!(v instanceof HTMLVideoElement) || isThumb(v) || CFG.enabled === false || CFG.remember === false || remembered === null) return;
            if (Math.abs(v.volume - remembered) < 1e-4) return;
            applying = true;
            try { v.volume = remembered; } finally { applying = false; }
        }
        document.addEventListener("loadedmetadata", e => applyRemembered(e.target), true);
        document.addEventListener("volumechange", e => {            // native volume slider: remember it too
            const v = e.target;
            if (applying || !(v instanceof HTMLVideoElement) || isThumb(v) || v.muted || !core.eligible(v, core.fsElement())) return;
            remember(v.volume);
        }, true);
        return { config: CFG, set, level, label, dragOn, remembered: () => remembered };
    })(core, V.config.volume = Object.assign({
        enabled: true,
        drag_volume: true,            // click-and-hold + vertical drag on a video = volume (up = louder)
        drag_pixels_per_percent: 2,   // vertical px per 1 % of volume
        drag_invert: false,           // false: drag up = louder
        // drag_require_ctrl: false (1.4.7): true = hold Ctrl at the press for the volume drag
        // drag_button: "left" | "right" (1.4.6; unset = frame_step.drag_button): same button = axis decides, else volume only
        remember: true,               // keep the last volume for the next videos (also after reload)
    }, SETTINGS.volume || {}));

    // =======================================================================
    // MODULE frame_step - wheel + keyboard frame stepping
    // =======================================================================
    V.modules.frame_step = (function (core, CFG) {
        const IS_FIREFOX = core.IS_FIREFOX;
        const steps = new WeakMap();

        function stepState(video) {
            const src = video.currentSrc || video.src || "";
            let s = steps.get(video);
            if (!s || s.src !== src) {
                s = { src, target: null, targetFps: 0, lastSetTime: null, pending: 0, pendingJumps: 0 };
                steps.set(video, s);
            }
            return s;
        }

        // ------------------------------------------------------- notch counting
        // Returns a signed integer number of notches (positive = wheel down).
        const acc = { tick: 0, px: 0, pinch: 0, last: 0 };
        let lineNotch = 0, pixelNotch = 0;

        function takeWhole(key, sign) {
            const v = acc[key];
            const n = Math.trunc(v + sign * 1e-6);
            acc[key] = v - n;
            return n;
        }

        function countNotches(e) {
            const mode = e.deltaMode;               // read first: Firefox then reports LINE units for mouse wheels
            const useX = e.deltaY === 0 && e.shiftKey && e.deltaX !== 0;   // Shift+wheel -> horizontal on Windows/macOS
            const d = useX ? e.deltaX : e.deltaY;
            if (!d) return 0;
            const sign = Math.sign(d), a = Math.abs(d);
            const now = performance.now();
            if (now - acc.last > 800) { acc.tick = 0; acc.px = 0; acc.pinch = 0; }   // forget stale fractions
            acc.last = now;
            if (mode === 1) {                        // DOM_DELTA_LINE (Firefox mouse wheel): smallest value seen = 1 notch
                lineNotch = lineNotch ? Math.min(lineNotch, a) : a;
                return sign * Math.max(1, Math.round(a / lineNotch));
            }
            if (mode === 2) return sign * Math.max(1, Math.round(a));     // DOM_DELTA_PAGE
            const wd = useX ? e.wheelDeltaX : e.wheelDeltaY;
            if (!IS_FIREFOX && typeof wd === "number" && wd !== 0) {
                // Chromium / Safari: wheelDelta = wheel ticks * 120, independent of DPI scaling,
                // page zoom and coalescing. High-res wheels / touchpads give fractional ticks.
                if (Math.sign(acc.tick) === -sign) acc.tick = 0;
                acc.tick += sign * Math.abs(wd) / 120;
                return takeWhole("tick", sign);
            }
            // Pixel fallback: big integer deltas = classic wheel notches (100, 120, 125, 150 ... px),
            // small deltas = touchpad / smooth wheel -> accumulate.
            if (a >= 50 && Number.isInteger(a)) {
                pixelNotch = pixelNotch ? Math.min(pixelNotch, a) : a;
                return sign * Math.max(1, Math.round(a / pixelNotch));
            }
            if (Math.sign(acc.px) === -sign) acc.px = 0;
            acc.px += d / (pixelNotch || 100);
            return takeWhole("px", sign);
        }

        // Trackpad pinch arrives as wheel events with ctrlKey = true (Chrome/Edge/Firefox)
        // while the Ctrl key is not physically down. Pinch deltas are small and continuous:
        // accumulate them like a touchpad, PINCH_NOTCH delta units = one notch.
        const PINCH_NOTCH = 50;
        function countPinchNotches(e) {
            const d = e.deltaY;
            if (!d) return 0;
            const sign = Math.sign(d), now = performance.now();
            if (now - acc.last > 800) { acc.tick = 0; acc.px = 0; acc.pinch = 0; }
            acc.last = now;
            if (Math.sign(acc.pinch) === -sign) acc.pinch = 0;
            acc.pinch += d / PINCH_NOTCH;
            return takeWhole("pinch", sign);
        }

        // Physical Ctrl key state (to tell a real Ctrl+wheel from a synthetic pinch).
        let ctrlDown = false;
        const trackCtrl = e => { if (typeof e.ctrlKey === "boolean") ctrlDown = e.ctrlKey; };
        window.addEventListener("keydown", e => { ctrlDown = e.key === "Control" ? true : e.ctrlKey; }, true);
        window.addEventListener("keyup", e => { ctrlDown = e.key === "Control" ? false : e.ctrlKey; }, true);
        window.addEventListener("pointermove", trackCtrl, { capture: true, passive: true });
        window.addEventListener("pointerdown", trackCtrl, { capture: true, passive: true });
        window.addEventListener("blur", () => { ctrlDown = false; });

        const MODIFIERS = { ctrl: "ctrlKey", alt: "altKey", shift: "shiftKey", meta: "metaKey" };
        function jumpModifier() {
            const m = String(CFG.wheel_jump_modifier || "none").toLowerCase();
            return MODIFIERS[m] ? m : "";
        }

        // ------------------------------------------------------- stepping
        function jumpFrames(fps) {
            const n = String(CFG.jump_mode).toLowerCase() === "frames"
                ? Math.round(Number(CFG.jump_frames)) : Math.round(Number(CFG.jump_seconds) * fps);
            return Number.isFinite(n) && n >= 1 ? n : 1;
        }

        // Exact-target stepping: an integer target frame is kept while seeks are in
        // flight, so fast wheel spins / key auto-repeat never drift or drop steps.
        function applyPending(video) {
            const info = core.getInfo(video), s = stepState(video);
            if (!info.fps) return;
            const fps = info.fps;
            const jump = jumpFrames(fps);
            const n = s.pending + s.pendingJumps * jump;
            const label = s.pendingJumps && !s.pending ? `${i18n("jump", "salto")} ${s.pendingJumps > 0 ? "+" : "-"}${Math.abs(s.pendingJumps) * jump} fr` +
                (String(CFG.jump_mode).toLowerCase() === "frames" ? "" : ` (${Math.abs(s.pendingJumps) * CFG.jump_seconds} s)`) : "";
            s.pending = 0; s.pendingJumps = 0;
            if (!n) return;
            if (!video.paused) video.pause();
            const last = core.lastFrameOf(video, info);
            const ours = s.target !== null && s.targetFps === fps && s.lastSetTime !== null &&
                         (core.seekPending(video) || Math.abs(video.currentTime - s.lastSetTime) < 0.25 / fps);
            const base = ours ? s.target                                 // keep counting from our queued target
                              : Math.max(0, Math.min(Number.isFinite(last) ? last : Infinity,   // resync (user played / scrubbed);
                                    Math.floor(video.currentTime * fps + 1e-6)));            // at the very end currentTime = duration
            // wrap (frame_step.wrap, default on): past the last frame continues at 0, past 0 continues at the last;
            // multiple wraps in one batch (long drag / held key / fast wheel) are fine. Off = clamp at the ends.
            // A-B segment looping is separate and unchanged. Without a known frame count there is nothing to wrap to.
            let target, wrapped = false;
            if (CFG.wrap !== false && Number.isFinite(last) && last >= 0) {
                const count = last + 1;                                  // frames 0..last inclusive
                target = ((base + n) % count + count) % count;
                wrapped = target !== base + n;
            } else {
                target = Math.max(0, Math.min(last, base + n));
            }
            let t = (target + 0.5) / fps;                                // middle of the frame: no rounding ambiguity
            const dur = video.duration;
            if (Number.isFinite(dur) && dur > 0) t = Math.min(t, Math.max(0, dur - 0.001));
            core.seekTo(video, t);                                      // queued: latest target wins, nothing dropped
            s.target = target; s.targetFps = fps; s.lastSetTime = t;
            core.showOverlay(video, `Frame ${target}` + (Number.isFinite(last) ? ` / ${last}` : "") +
                `  ·  ${core.fpsLabel(info)}` + (label ? `  ·  ${label}` : "") + (wrapped ? "  ·  ↻" : ""));   // ↻ = went round the end
        }

        function queueSteps(video, frames, jumps) {
            core.beforeUserAction(video, "step");                       // boomerang reverse: from the frame on screen
            const s = stepState(video);
            s.pending += frames || 0;
            s.pendingJumps += jumps || 0;
            core.touch(video);
            if (!video.paused) video.pause();                           // stop immediately, even before fps is known
            const info = core.getInfo(video);
            if (info.fpsSource === "mp4") { applyPending(video); return; }
            // First use (or no exact fps): wait for the header probe (max 2.5 s); steps stay queued.
            core.ensureFps(video).then(cur => { if (cur === core.getInfo(video)) applyPending(video); });
        }

        // ---------------------------------------------------------- wheel
        // Plain wheel: 1 notch = 1 frame (Shift: shift_frames). Wheel + wheel_jump_modifier
        // (default Ctrl): either one short jump per notch (same as Q / W) or ±0.25 playbackRate
        // (wheel_mod_action "jump" | "speed", default jump). The modifier wins over the Shift
        // multiplier when both are "shift". Any other Ctrl/Alt/Meta combination is left to the
        // browser (zoom...), and so is everything that does not act on a video.
        // Speed: the same wheel direction that steps frames FORWARD also makes playback FASTER
        // (invert_direction flips both together). Clamped to 0.25..2.00 in 0.25 steps. Overlay "Speed 1.25×".
        const SPEED_MIN = 0.25, SPEED_MAX = 2, SPEED_STEP = 0.25;
        const SPEED_STORE = "vidosser.playbackRate";
        let rememberedSpeed = null;
        try {
            const r = Number(localStorage.getItem(SPEED_STORE));
            if (localStorage.getItem(SPEED_STORE) !== null && r >= SPEED_MIN && r <= SPEED_MAX) rememberedSpeed = r;
        } catch (_) { /* no storage */ }
        function snapSpeed(r) {
            const n = Math.round(Number(r) / SPEED_STEP) * SPEED_STEP;
            return Math.max(SPEED_MIN, Math.min(SPEED_MAX, Math.round(n * 100) / 100));
        }
        function speedOverlay(r) {
            return `${i18n("Speed", "Velocidad")} ${snapSpeed(r).toFixed(2)}×`;
        }
        function rememberSpeed(r) {
            if (CFG.speed_remember === false) return;
            rememberedSpeed = r;
            try { localStorage.setItem(SPEED_STORE, String(r)); } catch (_) { /* ignore */ }
        }
        function setSpeed(video, deltaNotches) {
            // same sign as frame stepping: positive notches (forward) = faster, negative = slower
            const next = snapSpeed((Number(video.playbackRate) || 1) + deltaNotches * SPEED_STEP);
            video.playbackRate = next;
            rememberSpeed(next);
            core.showOverlay(video, speedOverlay(next));
            return next;
        }
        function applyRememberedSpeed(v) {
            if (!(v instanceof HTMLVideoElement) || CFG.enabled === false || CFG.speed_remember === false || rememberedSpeed === null) return;
            if (String(CFG.wheel_mod_action || "jump").toLowerCase() !== "speed") return;
            if (Math.abs((v.playbackRate || 1) - rememberedSpeed) < 1e-4) return;
            try { v.playbackRate = rememberedSpeed; } catch (_) { /* ignore */ }
        }
        document.addEventListener("loadedmetadata", e => applyRememberedSpeed(e.target), true);

        function onWheel(e) {
            if (CFG.enabled === false || !CFG.wheel_enabled) return;
            // wheel_fullscreen_only: outside fullscreen the wheel is left completely alone (page scroll / zoom)
            if (CFG.wheel_fullscreen_only && !core.fsElement()) return;
            const jm = jumpModifier();
            const mod = !!jm && e[MODIFIERS[jm]];
            if (!mod && (e.ctrlKey || e.metaKey || e.altKey)) return;  // keep browser zoom etc.
            const video = core.videoForPointerEvent(e);
            if (!video) return;
            e.preventDefault();                                         // no page scroll / zoom over a video we act on
            e.stopPropagation();
            if (core.middlePress) return;   // wheel nudged while clicking it: don't move away from the frame being saved
            const pinch = jm === "ctrl" && e.ctrlKey && !ctrlDown && !e.metaKey;
            let notches = pinch ? countPinchNotches(e) : countNotches(e);
            if (!notches) return;
            if (CFG.invert_direction) notches = -notches;
            const Z = V.modules.zoom, zoomMode = String(CFG.wheel_action || "frames").toLowerCase() === "zoom";
            if (mod) {
                if (String(CFG.wheel_mod_action || "jump").toLowerCase() === "speed") setSpeed(video, notches);
                else queueSteps(video, 0, notches);
            } else if (zoomMode && e.shiftKey) {
                queueSteps(video, notches, 0);                            // 1.4.11 zoom mode: Shift + wheel = 1 frame
            } else if (zoomMode && Z && Z.possible(video)) {
                Z.wheel(video, notches, e.clientX, e.clientY);            // 1.4.11: forward = zoom in, at the cursor
            } else {
                queueSteps(video, notches * (e.shiftKey ? Math.max(1, Math.round(CFG.shift_frames)) : 1), 0);
            }
        }

        // ------------------------------------------------------- keyboard
        core.registerAction("next_frame", v => { if (CFG.enabled !== false) queueSteps(v, 1, 0); });
        core.registerAction("prev_frame", v => { if (CFG.enabled !== false) queueSteps(v, -1, 0); });
        core.registerAction("jump_forward", v => { if (CFG.enabled !== false) queueSteps(v, 0, 1); });
        core.registerAction("jump_back", v => { if (CFG.enabled !== false) queueSteps(v, 0, -1); });

        window.addEventListener("wheel", onWheel, { capture: true, passive: false });

        // ------------------------------------------------------- drag to scrub
        // Left button (drag_button "left", default) or right button ("right"), or a finger,
        // held on a video and moved horizontally: every
        // drag_pixels_per_frame px = 1 frame (right = forward). Position based: the frame
        // count is trunc(total dx / px), emitted as deltas into the same exact seek queue,
        // so moving back and forth never drifts. Starts only after DRAG_THRESHOLD px of
        // mostly-horizontal movement, so a plain click still toggles play/pause; after a
        // drag the following click is swallowed. Right button: the context menu is blocked
        // only when a drag happened (Windows opens it on release, after the drag); a plain
        // right click keeps the normal menu. (macOS / Linux open the menu on press, so a
        // right-button drag is only possible there if the menu does not take the pointer.) Shift = shift_frames per step, the wheel
        // jump modifier = one short jump per step. Not used on the native control bar
        // (bottom CONTROLS_PX of a <video controls>), thumbnails or anything that is not
        // the video itself. Independent of wheel_fullscreen_only.
        // Vertical drag = volume (volume.drag_volume): the axis is chosen once, when the
        // pointer has moved DRAG_THRESHOLD px, by the dominant direction (|dy| > |dx| =
        // vertical, ties = horizontal), and stays locked until the button is released. Up =
        // louder (volume.drag_invert), volume.drag_pixels_per_percent px per 1 %, clamped
        // 0..100 and re-anchored at the limits (moving back reacts at once). A volume drag
        // does not pause the video and swallows the click that ends it, like the scrub.
        // Touch: a vertical swipe only while fullscreen (outside it keeps scrolling the page).
        // Volume key (1.4.7, volume.drag_require_ctrl): when on, the volume
        // button only drags the volume if Ctrl is held at the press (volume only, like a separate
        // button); without it the press behaves as if the volume drag were off. Touch is not affected.
        // Volume button (1.4.6, volume.drag_button "left" | "right"): when it is the scrub button,
        // one press does both and the axis decides (above). When they differ, the volume button's
        // drag is volume only (starts after DRAG_THRESHOLD px in any direction, only vertical
        // movement counts) and the scrub button's drag is scrub only (a mostly-vertical drag with it
        // does nothing but is still a drag: no play toggle / context menu after it). A right-button drag blocks the context menu that follows
        // (Windows opens it on release); a right click that didn't move past the threshold keeps it.
        // Cursor (1.4.1): it is hidden ONLY while the LEFT mouse button is held during a drag
        // in fullscreen; outside fullscreen and with the right button the drag uses pointer
        // capture with a visible cursor. Pointer Lock is only used for a horizontal scrub
        // (left button, fullscreen): the volume drag never locks, it reads clientY under
        // pointer capture, because Chrome on Windows reports unreliable movementY / buttons
        // under Pointer Lock (a jump of up to half the screen when the cursor is re-centred
        // as the lock starts, buttons = 0 while the button is held), which slammed the volume
        // to 0 % / 100 % or ended the drag at once. The screen gives far more than 0..100 %.
        const VOL = V.modules.volume;
        const DRAG_THRESHOLD = 4, CONTROLS_PX = 40;
        let drag = null, swallowClickUntil = 0, swallowClickOn = null, swallowMenuUntil = 0;
        const dragButton = () => String(CFG.drag_button || "left").toLowerCase() === "right" ? 2 : 0;
        const volModifier = () => (VOL && VOL.config.drag_require_ctrl === true ? "ctrl" : "");   // 1.4.7: Ctrl only for now
        const volButton = () => { const b = VOL && VOL.config.drag_button; return b ? (String(b).toLowerCase() === "right" ? 2 : 0) : dragButton(); };   // unset: the scrub button
        function dragUnit(e) {
            const jm = jumpModifier();
            if (jm && e[MODIFIERS[jm]]) return { frames: 0, jumps: 1 };
            if (e.shiftKey) return { frames: Math.max(1, Math.round(CFG.shift_frames)), jumps: 0 };
            return { frames: 1, jumps: 0 };
        }
        function onDragDown(e) {
            if (drag) endDrag("stale", false);                          // a release we never saw: start clean
            swallowClickUntil = 0; swallowMenuUntil = 0;                // a new press: an expected click/menu never came (pointer lock)
            const scrubOn = CFG.enabled !== false && CFG.drag_scrub !== false, volOn = !!(VOL && VOL.dragOn());
            if (!scrubOn && !volOn) return;
            if (!e.isPrimary || (e.pointerType === "pen" && e.pressure === 0)) return;
            const touch = e.pointerType === "touch";                         // a finger does both (axis decides)
            const button = e.button;
            if (!touch && button !== 0 && button !== 2) return;
            const same = touch || dragButton() === volButton();
            // Ctrl for the volume (1.4.7, volume.drag_require_ctrl): when on, the volume button changes the volume
            // only when that key is held at the press (then volume only); without it, as if the volume drag were off
            const vm = volModifier(), modVol = !touch && !!vm && !!e[MODIFIERS[vm]];
            let scrub = scrubOn && (touch || button === dragButton()), vol = volOn && (touch || button === volButton());
            if (vol && vm && !touch && !modVol) vol = false;
            // 1.4.13: zoomed + Ctrl on the scrub button swaps pan <-> scrub (frame_step.zoom_drag); with the
            // volume on the same button + drag_require_ctrl: axis lock, vertical = volume, horizontal = the swap
            const ZM = V.modules.zoom, t0 = e.target;
            const zctrl = !touch && e.ctrlKey && scrubOn && button === dragButton() && !!ZM && t0 instanceof HTMLVideoElement && ZM.level(t0) > 1;
            if (zctrl) scrub = true;
            if (vol && modVol && !zctrl) scrub = false;
            if (!scrub && !vol) return;
            const volOnly = vol && ((modVol && !zctrl) || (!scrub && !same));            // volume only: any direction starts it
            const v = e.target;
            if (!(v instanceof HTMLVideoElement) || !core.eligible(v, core.fsElement())) return;
            const jm = jumpModifier();
            const ok = m => (modVol && vol && vm === m) || jm === m;
            if ((e.altKey && !ok("alt")) || (e.metaKey && !ok("meta")) || (e.ctrlKey && !ok("ctrl") && !zctrl)) return;
            if (v.controls) {                                            // native control bar / progress bar
                const r = v.getBoundingClientRect();
                if (e.clientY > r.bottom - CONTROLS_PX) return;
            }
            drag = { v, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, lock: null, active: false, done: 0, type: e.pointerType, button,
                     scrub, vol, volOnly, modVol: modVol && vol, zctrl, split: !same && volOn, axis: null, prevDy: 0, level: 0, lockMoves: 0 };
        }
        // Hidden cursor while scrubbing (drag_hide_cursor): class on <html> (covers every
        // element, also inside a fullscreen container), on the capturing video and on the
        // fullscreen element. Every way a drag can end goes through endDrag(), which always
        // removes the classes: pointerup / pointercancel / lostpointercapture / Escape /
        // window blur / tab hidden / fullscreen change / pointer lock lost / a move with no
        // button pressed (missed release).
        const cursorCss = document.createElement("style");
        // Chrome's native controls hide the cursor over a playing video when they fade out
        // (inline cursor:none on the controls, also in fullscreen): keep it visible; the
        // cursor only disappears while we scrub / change the volume (classes below).
        cursorCss.textContent = "video::-webkit-media-controls{cursor:auto!important}" +
            "html.vidosser-scrubbing,html.vidosser-scrubbing *,.vidosser-scrub-el,.vidosser-scrub-el *," +
            "html.vidosser-scrubbing video::-webkit-media-controls{cursor:none!important}";
        document.head.appendChild(cursorCss);
        let hiddenOn = [];
        function hideCursor(v) {
            showCursor();
            hiddenOn = [document.documentElement, v, core.fsElement()].filter(Boolean);
            hiddenOn.forEach((el, k) => el.classList.add(k ? "vidosser-scrub-el" : "vidosser-scrubbing"));
        }
        function showCursor() {
            for (const el of hiddenOn) el.classList.remove("vidosser-scrubbing", "vidosser-scrub-el");
            hiddenOn = [];
            document.documentElement.classList.remove("vidosser-scrubbing");
            document.querySelectorAll(".vidosser-scrub-el").forEach(el => el.classList.remove("vidosser-scrub-el"));
        }
        // Pointer Lock (drag_pointer_lock, default on; horizontal scrub, left button, fullscreen
        // only - see above): the cursor disappears, can't hit the
        // screen edge and movementX keeps flowing (Chrome shows its "press Esc" banner). If
        // the lock is refused, the drag continues with pointer capture + hidden cursor.
        const SPIKE_PX = 60;                     // first moves around the lock start: bigger = the cursor re-centring, not the hand
        function startLock(d) {
            d.lock = "pending"; d.lockMoves = 0;
            d.lockBase = d.dx; d.mv = 0;          // Chrome freezes clientX/Y as soon as the lock is requested: count movementX/Y from here
            d.lockBaseY = d.dy; d.mvY = 0;
            const fail = () => { if (drag === d && d.lock === "pending") { d.lock = "failed"; capture(d); } };
            try {
                const r = d.v.requestPointerLock();
                if (r && typeof r.then === "function") r.catch(fail);
            } catch (err) { fail(); }
            setTimeout(fail, 1000);                                       // no answer: treat as refused
        }
        function capture(d) {        // (touch already has an implicit capture on the video: keep it)
            try { if (!d.v.hasPointerCapture(d.id)) d.v.setPointerCapture(d.id); } catch (err) { /* pointer already gone */ }
        }
        document.addEventListener("pointerlockchange", () => {
            if (!drag) return;
            if (document.pointerLockElement === drag.v) { if (drag.lock === "pending") { drag.lock = "on"; drag.lockMoves = 0; } }
            else if (drag.lock === "on") endDrag("lock lost");            // Esc / focus loss ended the lock
        });
        document.addEventListener("pointerlockerror", () => { if (drag && drag.lock === "pending") { drag.lock = "failed"; capture(drag); } });

        function onDragMove(e) {
            if (!drag || e.pointerId !== drag.id) return;
            const locked = drag.lock === "on" || drag.lock === "pending";
            // release was missed (not under Pointer Lock: Chrome on Windows reports buttons = 0 there while the button is held)
            if (drag.active && !locked && e.buttons === 0 && e.pointerType === "mouse") { endDrag("no button"); return; }
            if (locked) {
                let mx = e.movementX || 0, my = e.movementY || 0;
                if (drag.lockMoves < 3 && Math.max(Math.abs(mx), Math.abs(my)) > SPIKE_PX) { mx = 0; my = 0; }   // cursor re-centred as the lock starts
                drag.lockMoves++;
                drag.mv += mx; drag.dx = drag.lockBase + drag.mv;
                drag.mvY += my; drag.dy = drag.lockBaseY + drag.mvY;
            } else { drag.dx = e.clientX - drag.x0; drag.dy = e.clientY - drag.y0; }
            const dx = drag.dx, dy = drag.dy;
            if (!drag.active) {
                const adx = Math.abs(dx), ady = Math.abs(dy);
                if (Math.max(adx, ady) < DRAG_THRESHOLD) return;          // not decided yet: still a click
                const Z = V.modules.zoom;
                const wantPan = (String(CFG.zoom_drag || "pan").toLowerCase() !== "scrub") !== !!drag.zctrl;   // Ctrl swaps
                if (drag.scrub && Z && Z.level(drag.v) > 1 && wantPan && (drag.zctrl || !drag.modVol) && !(drag.modVol && ady > adx)) {   // 1.4.11: zoomed -> the scrub button pans
                    drag.axis = "pan"; drag.active = true; drag.px = 0; drag.py = 0;
                    capture(drag);
                }
            }
            if (drag.axis === "pan") {
                e.preventDefault();
                const ddx = (locked ? drag.dx : e.clientX - drag.x0) - drag.px, ddy = (locked ? drag.dy : e.clientY - drag.y0) - drag.py;
                drag.px += ddx; drag.py += ddy;
                if (ddx || ddy) V.modules.zoom.pan(drag.v, ddx, ddy);
                return;
            }
            if (!drag.active) {
                const adx = Math.abs(dx), ady = Math.abs(dy);
                const axis = drag.volOnly || ady > adx ? "y" : "x";         // dominant direction, locked from now on
                const fsTouch = e.pointerType !== "touch" || !!core.fsElement();   // touch outside fullscreen: vertical = page scroll
                // separate buttons: a vertical drag with the scrub button is still a drag (does nothing,
                // swallows the click / context menu that ends it), like a horizontal one with the volume button
                const dead = axis === "y" && !drag.vol && drag.scrub && drag.split;
                if (!dead && (axis === "y" ? !(drag.vol && fsTouch) : !drag.scrub)) { drag = null; return; }   // not ours
                drag.axis = dead ? "none" : axis;
                drag.active = true;
                // hidden cursor / Pointer Lock: only a held LEFT mouse button, only in fullscreen
                const fs = core.fsElement();
                drag.hide = !dead && e.pointerType === "mouse" && drag.button === 0 && !!(fs && (fs === drag.v || fs.contains(drag.v)));
                if (drag.hide && axis === "x" && CFG.drag_pointer_lock !== false && drag.v.requestPointerLock) startLock(drag);
                else capture(drag);
                if (drag.hide && CFG.drag_hide_cursor !== false) hideCursor(drag.v);
                if (dead) { /* nothing to do */ }
                else if (axis === "x") { if (!drag.v.paused) drag.v.pause(); }
                else drag.level = VOL.level(drag.v);                      // muted counts as 0 %: raising starts from silence
            }
            e.preventDefault();
            if (drag.axis === "none") return;
            if (drag.axis === "y") {
                const ppp = Math.max(0.1, Number(VOL.config.drag_pixels_per_percent) || 2);
                const step = (dy - drag.prevDy) / ppp;
                drag.prevDy = dy;
                if (!step) return;
                drag.level = Math.max(0, Math.min(100, drag.level + (VOL.config.drag_invert ? step : -step)));   // screen y grows downwards
                VOL.set(drag.v, drag.level);
                return;
            }
            const ppf = Math.max(1, Number(CFG.drag_pixels_per_frame) || 8);
            let want = Math.trunc((CFG.drag_invert ? -dx : dx) / ppf);
            const n = want - drag.done;
            if (!n) return;
            drag.done = want;
            const u = drag.zctrl ? { frames: 1, jumps: 0 } : dragUnit(e);   // Ctrl swap to scrub: plain frames
            queueSteps(drag.v, n * u.frames, n * u.jumps);
        }
        function endDrag(reason, swallow = true) {
            const d = drag;
            drag = null;
            showCursor();                                                 // always, whatever state we are in
            if (!d) return;
            if (d.active) core.dragEndedAt = performance.now();           // a quick click after a scrub is not a double-click
            if (d.active && swallow) {
                if (d.button === 2) swallowMenuUntil = performance.now() + 600;   // no context menu after a right drag
                else { swallowClickUntil = performance.now() + 400; swallowClickOn = d.v; }   // the click that follows must not toggle play
            }
            try { if (d.v.hasPointerCapture && d.v.hasPointerCapture(d.id)) d.v.releasePointerCapture(d.id); } catch (err) { /* ignore */ }
            if (d.lock && document.pointerLockElement === d.v) { try { document.exitPointerLock(); } catch (err) { /* ignore */ } }
        }
        function onDragEnd(e) {
            if (!drag || e.pointerId !== drag.id) return;
            endDrag(e.type);
        }
        function swallowClick(e) {
            if (!swallowClickUntil) return;
            const late = performance.now() > swallowClickUntil, on = swallowClickOn;
            swallowClickUntil = 0; swallowClickOn = null;
            // only the click that ends the drag (on the video / its player); with pointer lock there may be none
            const block = on && (on.closest(".block") || on.parentElement || on);
            if (late || !(e.target instanceof Node) || !(e.target === on || block.contains(e.target))) return;
            if (e.target instanceof Element && e.target.closest(".thumbnail-item")) return;   // 1.4.10: a gallery thumbnail click is never the end of a drag
            e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
        }
        const blockWhileDragging = e => { if (drag && drag.active) e.preventDefault(); };
        function onContextMenu(e) {
            const recent = swallowMenuUntil && performance.now() <= swallowMenuUntil;
            if ((drag && drag.active && drag.button === 2) || recent) {
                swallowMenuUntil = 0;
                e.preventDefault(); e.stopPropagation();
            }
        }
        window.addEventListener("contextmenu", onContextMenu, true);
        window.addEventListener("pointerdown", onDragDown, true);
        window.addEventListener("pointermove", onDragMove, { capture: true, passive: false });
        window.addEventListener("pointerup", onDragEnd, true);
        window.addEventListener("pointercancel", e => { if (drag && e.pointerId === drag.id) endDrag("pointercancel", false); }, true);
        window.addEventListener("lostpointercapture", e => {
            if (!drag || e.pointerId !== drag.id || !drag.active || drag.lock === "pending" || drag.lock === "on") return;
            try { if (drag.v.hasPointerCapture(e.pointerId)) return; } catch (err) { /* ignore */ }   // capture moved to the video (implicit -> ours)
            endDrag("lostpointercapture");
        }, true);
        window.addEventListener("keydown", e => {
            if (e.key !== "Escape" || !drag) return;
            const active = drag.active;
            endDrag("escape");
            if (active) { e.preventDefault(); e.stopPropagation(); }   // ends the scrub only (e.g. Gradio's gallery would close its preview)
        }, true);
        window.addEventListener("blur", () => endDrag("blur", false));
        document.addEventListener("visibilitychange", () => { if (document.hidden) endDrag("hidden", false); });
        document.addEventListener("fullscreenchange", () => { if (drag && drag.active) endDrag("fullscreenchange", false); });
        // backup release under Pointer Lock (pointerup normally ends the drag first)
        window.addEventListener("mouseup", e => { if (drag && drag.type === "mouse" && e.button === drag.button && drag.lock) endDrag("mouseup"); }, true);
        window.addEventListener("click", swallowClick, true);
        // modifier + press for the volume (1.4.7): no text selection / Shift-click extension / Ctrl-click
        // behaviour from the browser
        window.addEventListener("mousedown", e => { if (drag && drag.modVol && !drag.active && e.button === drag.button) e.preventDefault(); }, true);
        window.addEventListener("selectstart", blockWhileDragging, true);
        window.addEventListener("dragstart", blockWhileDragging, true);
        // touch: let vertical panning scroll the page, horizontal moves reach the scrubber;
        // while fullscreen (nothing to scroll) vertical moves reach the volume drag too
        const touchCss = document.createElement("style");
        touchCss.textContent = "video.vidosser-drag-scrub{touch-action:pan-y pinch-zoom}" +
            ":fullscreen video.vidosser-drag-volume,video.vidosser-drag-volume:fullscreen{touch-action:pinch-zoom}";
        document.head.appendChild(touchCss);
        function markVideos() {
            const on = CFG.enabled !== false && CFG.drag_scrub !== false, vol = !!(VOL && VOL.dragOn());
            document.querySelectorAll("video").forEach(v => { v.classList.toggle("vidosser-drag-scrub", on); v.classList.toggle("vidosser-drag-volume", vol); });
        }
        let markQueued = false;
        new MutationObserver(() => {
            if (markQueued) return;
            markQueued = true;
            requestAnimationFrame(() => { markQueued = false; markVideos(); });
        }).observe(document.documentElement, { childList: true, subtree: true });
        markVideos();

        return {
            config: CFG,
            onSettings: markVideos,
            dragging: () => !!(drag && drag.active),
            cursorHidden: () => hiddenOn.length > 0 || document.documentElement.classList.contains("vidosser-scrubbing"),
            dragLock: () => drag ? drag.lock : null,
            dragAxis: () => (drag && drag.active ? drag.axis : null),
            clearSwallow: () => { swallowClickUntil = 0; swallowClickOn = null; },
            info: v => { const i = core.getInfo(v), s = stepState(v); return { fps: i.fps, source: i.fpsSource, frames: i.frames, target: s.target }; },
            step: (v, n) => queueSteps(v, n | 0, 0),
            jump: (v, n) => queueSteps(v, 0, n | 0),
            setSpeed: (v, notches) => setSpeed(v, notches | 0),
            speedOf: v => snapSpeed(v && v.playbackRate),
            target: () => core.videoForKeyboard(),
        };
    })(core, V.config.frame_step = Object.assign({
        enabled: true,
        wheel_enabled: true,
        wheel_fullscreen_only: true,  // wheel steps only while a video (or its container) is fullscreen
        wheel_jump_modifier: "ctrl",  // modifier + wheel key: ctrl | alt | shift | meta | none
        zoom_edge_speed: 1400,        // edge pan px/s at full depth (1.4.16)
        zoom_edge_pan: false,         // zoomed: scroll while the pointer is near an edge (1.4.14)
        zoom_drag: "pan",             // zoomed: scrub-button drag "pan" | "scrub" (1.4.12)
        wheel_action: "frames",       // plain wheel: "frames" | "zoom" (1.4.11)
        wheel_mod_action: "jump",     // what the modifier + wheel does: "jump" (short jump) | "speed" (±0.25 playbackRate)
        speed_remember: true,         // keep the last playbackRate for later videos (also after reload)
        shift_frames: 10,
        invert_direction: false,
        drag_scrub: true,             // left-button drag on a video = scrub frames
        drag_pixels_per_frame: 8,
        drag_invert: false,           // false: drag right = forward
        drag_button: "left",          // "left" | "right"
        drag_pointer_lock: true,      // Pointer Lock while scrubbing, left button, fullscreen only (Chrome shows its "press Esc" banner)
        drag_hide_cursor: true,       // hide the cursor while the left button is held during a drag, fullscreen only
        wrap: true,                   // past the last / first frame continues at the other end (drag, wheel, keys, jumps)
        jump_mode: "seconds",     // "seconds" | "frames"
        jump_seconds: 0.5,
        jump_frames: 8,
    }, SETTINGS.frame_step || {}));

    // =======================================================================
    // MODULE save_frame - save the displayed frame (action "save_frame_as")
    // =======================================================================
    V.modules.save_frame = (function (core, CFG) {
        let lastHandle = null;                 // last file chosen in the save dialog (startIn)
        const ext = () => (String(CFG.format).toLowerCase() === "jpg" ? "jpg" : "png");
        const mime = () => (ext() === "jpg" ? "image/jpeg" : "image/png");

        function b64ToBlob(b64, type) {
            const bin = atob(b64), bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new Blob([bytes], { type });
        }

        function stemFromUrl(url) {
            try {
                const u = decodeURIComponent(url.split("?")[0]);
                return (u.split(/[\\/=]/).pop() || "video").replace(/\.[^.]+$/, "") || "video";
            } catch (_) { return "video"; }
        }

        // Fallback when the backend is unavailable (e.g. blob: URLs): canvas capture
        // of the frame on screen at full video resolution.
        async function canvasCapture(video) {
            const c = document.createElement("canvas");
            c.width = video.videoWidth; c.height = video.videoHeight;
            c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
            const quality = Math.min(1, Math.max(0.01, Number(CFG.jpg_quality) / 100));
            const blob = await new Promise(res => c.toBlob(res, mime(), quality));
            if (!blob) throw new Error(i18n("canvas export failed", "no se pudo exportar la imagen"));
            return blob;
        }

        function download(blob, name) {
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob); a.download = name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        }

        // Result feedback: toast (+ white flash) when the DOM can be seen, shutter / error
        // sound (save_frame.sound) - the only feedback possible in native <video> fullscreen.
        function feedback(video, kind, text) {
            if (CFG.toast !== false) core.toast(text, kind, CFG.toast_ms);
            if (kind === "ok" && CFG.flash !== false) core.flash(video);
            if (CFG.sound !== false && kind !== "info") core.sound(kind, Number(CFG.sound_volume) / 100);
        }

        let busy = false;
        async function saveFrameAs(video) {
            if (CFG.enabled === false || busy) return;
            core.beforeUserAction(video, "save_frame_as");               // boomerang reverse: save the frame on screen
            busy = true;
            try {
                if (!video.paused) video.pause();
                await core.settled(video);                              // exact frame on screen
                const info = await core.ensureFps(video);
                const t = video.currentTime;
                const mode = String(CFG.mode).toLowerCase() === "direct" ? "direct" : "ask";
                core.showOverlay(video, i18n("Saving frame...", "Guardando frame..."));
                let res;
                try { res = await core.bridge({ action: "save_frame", url: video.currentSrc, time: t, frame: Math.floor(t * info.fps + 1e-6), mode }); }
                catch (err) { res = { ok: false, error: err.message, bridgeMissing: !!err.bridgeMissing }; }
                if (mode === "direct") {
                    core.showOverlay(video, res.ok ? `${i18n("Saved", "Guardado")}: ${res.path}` : `${i18n("Save failed", "Error al guardar")}: ${res.error}`);
                    if (res.ok) feedback(video, "ok", `${i18n("Frame saved", "Fotograma guardado")} (frame ${res.frame}): ${res.path}`);
                    else feedback(video, "error", `${i18n("Save failed", "Error al guardar")}: ${res.error}`);
                    return res;
                }
                let blob, name, frame;
                if (res.ok) { blob = b64ToBlob(res.data, res.mime); name = res.name; frame = res.frame; }
                else {
                    frame = Math.floor(t * info.fps + 1e-6);
                    name = `${stemFromUrl(video.currentSrc)}_frame${String(frame).padStart(5, "0")}.${ext()}`;
                    try { blob = await canvasCapture(video); }
                    catch (err) {
                        core.showOverlay(video, `${i18n("Save failed", "Error al guardar")}: ${res.error || err.message}`);
                        feedback(video, "error", `${i18n("Save failed", "Error al guardar")}: ${res.error || err.message}`);
                        return res;
                    }
                }
                if (typeof window.showSaveFilePicker === "function") {
                    const types = [ext() === "jpg" ? { description: "JPEG", accept: { "image/jpeg": [".jpg", ".jpeg"] } }
                                                   : { description: "PNG", accept: { "image/png": [".png"] } }];
                    const opts = { suggestedName: name, types, id: "vidosser-frames" };
                    if (lastHandle) opts.startIn = lastHandle;
                    try {
                        const handle = await window.showSaveFilePicker(opts);
                        const w = await handle.createWritable();
                        await w.write(blob); await w.close();
                        lastHandle = handle;
                        core.showOverlay(video, `${i18n("Saved frame", "Guardado frame")} ${frame}: ${handle.name}`);
                        feedback(video, "ok", `${i18n("Frame saved", "Fotograma guardado")} (frame ${frame}): ${handle.name}`);
                        return { ok: true, frame, name: handle.name, via: "picker" };
                    } catch (err) {
                        if (err && err.name === "AbortError") {
                            core.showOverlay(video, i18n("Cancelled", "Cancelado"));
                            feedback(video, "info", `${i18n("Not saved (cancelled)", "No guardado (cancelado)")}: frame ${frame}`);
                            return { ok: false, cancelled: true };
                        }
                        // no user activation left / API refused: fall back to a normal download
                    }
                }
                download(blob, name);
                core.showOverlay(video, `${i18n("Saved frame", "Guardado frame")} ${frame} (${i18n("download", "descarga")}): ${name}`);
                feedback(video, "ok", `${i18n("Frame downloaded", "Fotograma descargado")} (frame ${frame}): ${name}`);
                return { ok: true, frame, name, via: "download" };
            } finally { busy = false; }
        }

        core.registerAction("save_frame_as", v => { saveFrameAs(v); });

        // --------------------------------------- middle click (wheel click) = save
        // mousedown (button 1) over a target video: preventDefault (no Windows/Chrome
        // autoscroll, no Linux paste, no focus change) and remember the press. The save
        // runs once, on mouseup; the following auxclick is swallowed (auxclick only
        // saves if mouseup never reached us). mousedown grants transient user activation
        // (~5 s), so the save-as dialog of "ask" mode can open afterwards.
        // Middle clicks anywhere else (links, buttons, gallery thumbnails...) are untouched.
        const INTERACTIVE = 'a[href], button, input, textarea, select, label, summary, [role="button"], [role="link"], ' +
                            '[role="tab"], [contenteditable=""], [contenteditable="true"], .thumbnail-item';
        let press = null, swallowAuxUntil = 0;
        const block = e => { e.preventDefault(); e.stopPropagation(); };
        const setPress = p => { press = p; core.middlePress = p ? p.video : null; };

        function middleTarget(e) {
            if (CFG.enabled === false || !CFG.middle_click_save) return null;
            if (e.button !== 1 || e.ctrlKey || e.altKey || e.metaKey) return null;
            const video = core.videoForPointerEvent(e);
            if (!video) return null;
            // interactive element on top of / around the click that is not just a wrapper of the video itself
            for (const n of (e.composedPath ? e.composedPath() : [])) {
                if (n === video || !(n instanceof Element)) break;
                if (n.matches(INTERACTIVE) && !n.contains(video)) return null;
            }
            return video;
        }

        function onMouseDown(e) {
            if (e.button !== 1) return;
            setPress(null);
            const video = middleTarget(e);
            if (!video) return;
            block(e);
            core.touch(video);
            setPress({ video });
        }
        function onMouseUp(e) {
            if (e.button !== 1 || !press) return;
            block(e);
            const video = press.video;
            setPress(null);
            swallowAuxUntil = performance.now() + 1000;
            saveFrameAs(video);
        }
        function onAuxClick(e) {
            if (e.button !== 1) return;
            if (press) { const video = press.video; setPress(null); block(e); saveFrameAs(video); return; }
            if (performance.now() < swallowAuxUntil) { swallowAuxUntil = 0; block(e); }
        }
        window.addEventListener("mousedown", onMouseDown, true);
        window.addEventListener("mouseup", onMouseUp, true);
        window.addEventListener("auxclick", onAuxClick, true);
        // a press whose release we never saw (released outside the window...) must not linger
        window.addEventListener("pointermove", e => { if (press && !(e.buttons & 4)) setPress(null); }, { capture: true, passive: true });
        window.addEventListener("blur", () => setPress(null));

        return { config: CFG, saveFrameAs };
    })(core, V.config.save_frame = Object.assign({
        enabled: true,
        format: "png",            // "png" | "jpg"
        jpg_quality: 95,
        mode: "ask",              // "ask" (save-as dialog) | "direct" (server-side, into folder)
        folder: "",               // direct mode folder ("" = <WanGP outputs>/frames)
        middle_click_save: true,  // middle mouse button on a video = save frame
        toast: true,              // prominent "Fotograma guardado" toast
        toast_ms: 2500,
        flash: true,              // white flash over the video on save
        sound: true,              // shutter / error sound (only feedback in native <video> fullscreen)
        sound_volume: 60,         // 1..100
    }, SETTINGS.save_frame || {}));

    // =======================================================================
    // MODULE container_fs - video fullscreen on a container instead of the native
    // <video> fullscreen, so overlays / toasts can be drawn (general.container_fullscreen)
    // =======================================================================
    // A natively fullscreen <video> cannot have anything drawn above it. Swapping after
    // the fact is impossible (Chrome: the fullscreen request has consumed the user
    // activation -> "Permissions check failed"), so the request is intercepted BEFORE it
    // happens, inside the same user gesture:
    //   * double-click on a video with native controls: the 2nd mousedown (detail 2) is
    //     cancelled (Chrome's controls then do not go native) and the container goes
    //     fullscreen; double-click again exits.
    //   * page-initiated video.requestFullscreen() (e.g. the gr.Video player's
    //     fullscreen icon) is redirected to the container.
    // Not interceptable: the fullscreen button inside the browser's native control bar
    // (it stays native fullscreen; save feedback is then the shutter sound).
    V.modules.container_fs = (function (core, GEN) {
        const CLS = "vidosser-fs-container";
        const nativeRequest = Element.prototype.requestFullscreen;
        const style = document.createElement("style");
        style.textContent =
            `.${CLS}:fullscreen{background:#000!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;` +
            `display:flex!important;flex-direction:column!important;align-items:stretch!important;justify-content:center!important;margin:0!important;}` +
            `.${CLS}:fullscreen>*:not(.controls){flex:1 1 auto!important;min-height:0!important;width:100%!important;max-height:none!important;` +
            `display:flex!important;align-items:center!important;justify-content:center!important;}` +
            `.${CLS}:fullscreen video{width:100%!important;height:100%!important;max-width:100vw!important;max-height:100vh!important;object-fit:contain!important;}`;
        (document.head || document.documentElement).appendChild(style);

        function containerFor(video) {
            const gallery = video.closest(".gallery-container");
            if (gallery) return gallery;                          // Gradio's own gallery fullscreen layout
            let a = video.parentElement;
            for (let i = 0; a && i < 3; i++, a = a.parentElement) {
                if (a.querySelector('.controls, [aria-label="full-screen"]')) return a;   // player root (video + controls)
                if (a.classList.contains("block")) break;
            }
            return video.parentElement;
        }
        const enabled = video => GEN.container_fullscreen !== false && video instanceof HTMLVideoElement &&
                                 !video.closest(".thumbnail-item") && core.eligible(video, null);

        function enter(video) {
            const c = containerFor(video);
            if (!c) { ownNativeAt = performance.now(); return nativeRequest.call(video); }
            if (!c.classList.contains("gallery-container")) c.classList.add(CLS);
            core.touch(video);
            return nativeRequest.call(c);
        }

        // page-initiated requests on a <video> -> container
        const ownRequest = function (options) {
            if (enabled(this)) return enter(this);
            ownNativeAt = performance.now(); return nativeRequest.call(this, options);
        };
        Object.defineProperty(HTMLVideoElement.prototype, "requestFullscreen", { value: ownRequest, configurable: true, writable: true });

        // Double-click on a video: in fullscreen (our container, Gradio's gallery fullscreen or
        // native <video>) -> exit; outside fullscreen -> container fullscreen (if enabled;
        // otherwise the browser default). Handled on the 2nd mousedown (detail 2), still inside
        // the user gesture; the native controls' own toggle is cancelled there. The two single
        // clicks of a double-click toggle play twice: the play state from before the
        // double-click is restored afterwards. A "double-click" made of the release of a
        // drag-scrub and a quick click is ignored.
        let swallowDblUntil = 0, firstPress = null, restoreTimer = 0;
        let ownNativeAt = -1e9;
        function restorePlay() {
            clearTimeout(restoreTimer);
            const p = firstPress; firstPress = null;
            if (!p || !p.v.isConnected) return;
            if (p.v.paused !== p.paused) { if (p.paused) p.v.pause(); else p.v.play().catch(() => {}); }
        }
        window.addEventListener("mousedown", e => {
            if (e.button !== 0) return;
            const v = e.target;
            if (!(v instanceof HTMLVideoElement) || !core.eligible(v, core.fsElement())) return;
            if (e.detail === 1) { firstPress = { v, paused: v.paused, t: performance.now() }; return; }
            if (e.detail !== 2) return;
            const fs = core.fsElement();
            const inFs = !!(fs && (fs === v || fs.contains(v)));
            const afterDrag = performance.now() - (core.dragEndedAt || 0) < 700;
            if (!inFs && !afterDrag && !enabled(v)) return;               // container fullscreen off: browser default
            e.preventDefault(); e.stopPropagation();
            swallowDblUntil = performance.now() + 1000;
            if (afterDrag) { firstPress = null; return; }                 // release of a scrub + click: not a double-click
            if (inFs) document.exitFullscreen().catch(() => {});
            else enter(v).catch(() => {});
            if (firstPress && firstPress.v === v) { clearTimeout(restoreTimer); restoreTimer = setTimeout(restorePlay, 600); }
        }, true);
        window.addEventListener("dblclick", e => {
            if (performance.now() < swallowDblUntil && e.target instanceof HTMLVideoElement) {
                e.preventDefault(); e.stopPropagation();
                if (firstPress) setTimeout(restorePlay, 30);              // after the 2nd click's own toggle
                return;
            }
            // 1.4.10: the 2nd press never reached the mousedown handler (swallowed elsewhere): the
            // double-click still goes to the container (dblclick is a user gesture too)
            const v = e.target;
            if (e.button !== 0 || !(v instanceof HTMLVideoElement) || core.fsElement() || !enabled(v)) return;
            if (performance.now() - (core.dragEndedAt || 0) < 700) return;
            e.preventDefault(); e.stopPropagation();
            enter(v).catch(() => {});
        }, true);
        document.addEventListener("fullscreenchange", () => {
            const fs = core.fsElement();
            for (const el of document.querySelectorAll("." + CLS)) if (el !== fs) el.classList.remove(CLS);
        });

        // 1.4.10: Chrome's own <video> fullscreen sometimes won a double-click (no gallery thumbnails,
        // no Vidosser bars) and cannot be moved to the container afterwards (Chrome refuses a new
        // fullscreen request without a fresh click). So Chrome's own fullscreen is turned off on the
        // videos Vidosser takes to the container (controlsList="nofullscreen": no fullscreen button in
        // the native bar, and no double-click fullscreen); Vidosser's double-click / Gradio's button
        // do it on the container. Restored when container_fullscreen is turned off.
        const NOFS = "vidosserNofs";
        function guard() {
            for (const v of document.querySelectorAll("video")) {
                if (!v.controlsList) continue;
                const want = enabled(v);
                if (want && !v.dataset[NOFS] && !v.controlsList.contains("nofullscreen")) { v.controlsList.add("nofullscreen"); v.dataset[NOFS] = "1"; }
                else if (!want && v.dataset[NOFS]) { v.controlsList.remove("nofullscreen"); delete v.dataset[NOFS]; }
            }
        }
        let gq = false;
        const scheduleGuard = () => { if (gq) return; gq = true; requestAnimationFrame(() => { gq = false; guard(); }); };
        new MutationObserver(scheduleGuard).observe(document.documentElement, { childList: true, subtree: true });
        window.addEventListener("loadedmetadata", scheduleGuard, true);
        window.addEventListener("pointerover", e => { if (e.target instanceof HTMLVideoElement) guard(); }, { capture: true, passive: true });
        scheduleGuard();
        const nativeOwn = function (...a) { ownNativeAt = performance.now(); return nativeRequest.apply(this, a); };
        return { config: GEN, containerFor, enter, nativeRequest: nativeOwn, guard, onSettings: guard };
    })(core, V.config.general);

    // =======================================================================
    // MODULE controls - hide the video control bars (general.hide_controls)
    // =======================================================================
    // "fullscreen" (default): while a video is fullscreen (container or native) its native
    // controls attribute is removed and Gradio's own player bar (.controls) is hidden;
    // restored on exit. "always": native controls removed everywhere (Gradio's bar below
    // the gr.Video player, which does not cover the picture, is only hidden in fullscreen).
    // Without native controls, a click on the video and the Space bar play / pause (the
    // drag-scrub click swallowing still applies), the whole picture is draggable, and a
    // thin non-interactive 3 px progress line is drawn at the picture's bottom edge
    // (show_thin_progress; not possible in native fullscreen, where nothing can be drawn).
    V.modules.controls = (function (core, GEN) {
        const FLAG = "vidosserControls", HIDECLS = "vidosser-hide-controls";
        const style = document.createElement("style");
        // Chrome shows its own controls on a natively fullscreen <video> even without the
        // controls attribute: hide those shadow parts too on the videos we manage.
        style.textContent = `.${HIDECLS} .controls{display:none!important}` +
            `video.vidosser-nocontrols::-webkit-media-controls,video.vidosser-nocontrols::-webkit-media-controls-enclosure,` +
            `video.vidosser-nocontrols::-webkit-media-controls-panel,video.vidosser-nocontrols::-webkit-media-controls-overlay-enclosure{display:none!important}`;
        (document.head || document.documentElement).appendChild(style);
        const mode = () => { const m = String(GEN.hide_controls || "fullscreen").toLowerCase(); return m === "off" || m === "always" ? m : "fullscreen"; };
        const inFs = v => { const fs = core.fsElement(); return !!(fs && (fs === v || fs.contains(v))); };
        const hiddenByUs = v => !!(v && v.dataset && v.dataset[FLAG]);
        let applying = false;

        function apply() {
            applying = true;
            try {
                const m = mode(), fs = core.fsElement();
                for (const v of document.querySelectorAll("video")) {
                    if (v.closest(".thumbnail-item")) continue;
                    const hide = m === "always" || (m === "fullscreen" && inFs(v));
                    if (hide && v.controls) { v.dataset[FLAG] = "1"; v.controls = false; }
                    else if (!hide && hiddenByUs(v)) { delete v.dataset[FLAG]; v.controls = true; }
                    v.classList.toggle("vidosser-nocontrols", hiddenByUs(v));
                }
                // Gradio player bars inside the fullscreen element
                document.querySelectorAll("." + HIDECLS).forEach(el => { if (el !== fs || m === "off") el.classList.remove(HIDECLS); });
                if (fs && m !== "off" && !(fs instanceof HTMLVideoElement)) fs.classList.add(HIDECLS);
            } finally { applying = false; }
            drawAll();
        }
        let queued = false;
        const schedule = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; apply(); }); };
        new MutationObserver(muts => {
            if (applying) return;
            for (const mu of muts) {
                if (mu.type === "childList" || (mu.type === "attributes" && mu.target instanceof HTMLVideoElement)) { schedule(); return; }
            }
        }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["controls"] });
        document.addEventListener("fullscreenchange", apply);
        document.addEventListener("webkitfullscreenchange", apply);

        // play / pause without native controls (bubble phase: the drag-scrub click swallowing runs first)
        const toggle = v => { if (v.paused) v.play().catch(() => {}); else v.pause(); core.touch(v); };
        window.addEventListener("click", e => {
            const v = e.target;
            if (e.button !== 0 || !(v instanceof HTMLVideoElement) || e.defaultPrevented) return;
            if (hiddenByUs(v)) { toggle(v); return; }
            // 1.4.10: with controlsList="nofullscreen" (container fullscreen on) Chrome no longer plays /
            // pauses on a click on the picture: do it here (not on the native control bar at the bottom)
            if (v.controls && v.dataset.vidosserNofs) {
                const r = v.getBoundingClientRect();
                if (e.clientY <= r.bottom - 48) toggle(v);
            }
        });
        window.addEventListener("keydown", e => {
            if (e.key !== " " || e.ctrlKey || e.altKey || e.metaKey || e.repeat || core.typingOrModal(e)) return;
            const v = core.videoForKeyboard();
            if (!v || !(hiddenByUs(v) || inFs(v))) return;
            e.preventDefault(); e.stopPropagation();
            toggle(v);
        }, true);

        // thin progress line
        const bars = new Map();
        function pictureRect(v) {
            const r = v.getBoundingClientRect();
            let x = r.left, y = r.top, w = r.width, h = r.height;
            if (v.videoWidth && v.videoHeight) {
                const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
                w = v.videoWidth * k; h = v.videoHeight * k; x += (r.width - w) / 2; y += (r.height - h) / 2;
            }
            return { x, y, w, h };
        }
        const wants = v => GEN.show_thin_progress !== false && mode() !== "off" && v.isConnected && core.isVisible(v) &&
                           core.fsElement() !== v && (hiddenByUs(v) || (inFs(v) && !v.controls));
        function draw(v) {
            let bar = bars.get(v);
            if (!wants(v)) { if (bar) { bar.remove(); bars.delete(v); } return; }
            if (!bar) {
                bar = document.createElement("div");
                bar.className = "vidosser-thin-progress";
                bar.style.cssText = "position:fixed;height:3px;z-index:2147483644;pointer-events:none;background:rgba(255,255,255,.18);";
                bar.innerHTML = '<div class="vidosser-thin-fill" style="position:absolute;left:0;top:0;bottom:0;width:0;background:rgba(255,255,255,.85);"></div>';
                bars.set(v, bar);
            }
            const host = core.fsElement() || document.body;
            if (bar.parentNode !== host) host.appendChild(bar);
            const p = pictureRect(v), d = v.duration;
            Object.assign(bar.style, { left: Math.round(p.x) + "px", top: Math.round(p.y + p.h - 3) + "px", width: Math.round(p.w) + "px" });
            bar.firstChild.style.width = (Number.isFinite(d) && d > 0 ? Math.min(100, v.currentTime / d * 100) : 0) + "%";
        }
        function drawAll() {
            for (const v of bars.keys()) if (!v.isConnected) { bars.get(v).remove(); bars.delete(v); }
            document.querySelectorAll("video").forEach(v => { if (bars.has(v) || hiddenByUs(v) || inFs(v)) draw(v); });
        }
        let raf = 0;
        const loop = () => { raf = 0; drawAll(); if (bars.size) raf = requestAnimationFrame(loop); };
        const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };
        for (const t of ["timeupdate", "seeked", "play", "loadedmetadata"]) document.addEventListener(t, kick, true);
        window.addEventListener("scroll", kick, true);
        window.addEventListener("resize", kick);
        apply();
        return { config: GEN, apply, onSettings: apply, hidden: hiddenByUs };
    })(core, V.config.general);

    // =======================================================================
    // MODULE loop - loop all videos, per-video loop toggle (L), A-B segment loop (I / O / U)
    // =======================================================================
    V.modules.loop = (function (core, CFG) {
        // ---------------------------------------------------------- loop all / toggle
        const origLoop = new WeakMap();          // loop attribute before we touched the element
        const override = new Map();              // src -> loop forced by the toggle key
        const bOverride = new Map();             // src -> boomerang forced by the toggle_boomerang key (B)
        // Per-video state (L / B overrides, A-B segments) is keyed by the FILE NAME, not the full URL:
        // WanGP's gallery can serve the same video under a different URL after a refresh (Gradio
        // cache / temp copy / query string), which made an L "loop off" get lost (1.4.9).
        const rawSrc = v => v.currentSrc || v.src || "";
        const srcOf = v => {
            const u = rawSrc(v);
            if (!u) return "";
            let p = u.split("#")[0].split("?")[0];
            try { p = decodeURIComponent(p); } catch (_) { /* keep */ }
            return p.split(/[\\/=]/).pop() || u;
        };

        // Whether the video should loop (loop_all / L / its own attribute). With boomerang on, the
        // element's own `loop` attribute is kept OFF so the end of the video is seen ("ended") and
        // playback can turn round there; the logical loop state stays in loopWanted().
        function loopWanted(v) {
            if (!origLoop.has(v)) origLoop.set(v, v.loop);
            const src = srcOf(v);
            return override.has(src) ? override.get(src) : (CFG.enabled !== false && CFG.loop_all ? true : origLoop.get(v));
        }
        function boomerangOn(v) {
            if (CFG.enabled === false) return false;
            const src = srcOf(v);
            return bOverride.has(src) ? bOverride.get(src) : String(CFG.mode || "normal").toLowerCase() === "boomerang";
        }
        function applyLoop(v) {
            if (!(v instanceof HTMLVideoElement)) return;
            const want = !!loopWanted(v) && !boomerangOn(v);
            if (v.loop !== want) v.loop = want;
        }
        const applyAll = () => document.querySelectorAll("video").forEach(applyLoop);
        new MutationObserver(ms => {
            for (const m of ms) for (const n of m.addedNodes) {
                if (n instanceof HTMLVideoElement) applyLoop(n);
                else if (n.querySelectorAll) n.querySelectorAll("video").forEach(applyLoop);
            }
        }).observe(document.documentElement, { childList: true, subtree: true });
        document.addEventListener("loadedmetadata", e => applyLoop(e.target), true);   // src swapped in place
        // re-assert the element's `loop` whenever playback starts / runs (1.4.9): anything else that
        // rewrites it (a player re-render, an element reused for another file) can't keep a loop
        // the user turned off, or drop one that is on
        for (const ev of ["play", "playing", "timeupdate", "seeked"]) document.addEventListener(ev, e => applyLoop(e.target), true);
        applyAll();

        core.registerAction("toggle_loop", v => {
            if (CFG.enabled === false) return;
            // 1.4.9: with an A-B segment (or half of one), L turns the loop off completely: the segment
            // is cleared and this video stops looping (Boomerang too); L again = loop on
            if (segOf(v)) {
                segments.delete(srcOf(v));
                clearTimeout(timers.get(v)); timers.delete(v);
                override.set(srcOf(v), false);
                applyLoop(v); drawBar(v);
                core.toast(i18n("Loop cleared", "Bucle borrado") + " · " + i18n("loop off (this video)", "bucle desactivado (este vídeo)"), "info", 1800);
                core.showOverlay(v, i18n("Loop cleared", "Bucle borrado"));
                return;
            }
            const on = !loopWanted(v);
            override.set(srcOf(v), on);
            applyLoop(v);
            core.toast(on ? i18n("Loop on (this video)", "Bucle activado (este vídeo)") : i18n("Loop off (this video)", "Bucle desactivado (este vídeo)"), "info", 1800);
            core.showOverlay(v, on ? i18n("Loop: on", "Bucle: sí") : i18n("Loop: off", "Bucle: no"));
        });

        // ------------------------------------------------------------- A-B segment
        const segments = new Map();              // src -> { in, out } (frames), kept while the page is open
        const segOf = v => segments.get(srcOf(v));
        const ready = s => s && s.in !== null && s.out !== null;

        // rVFC mediaTime / currentTime are rounded to microseconds, so 41/24 s can read as
        // 40.99999 frames: use a tolerance of 1/1000 frame.
        const frameAt = (t, fps) => Math.floor(t * fps + 1e-3);
        async function currentFrame(v) {
            if (v.paused) await core.settled(v);
            const info = await core.ensureFps(v);
            const last = core.lastFrameOf(v, info);
            const f = frameAt(v.currentTime, info.fps);
            return { f: Math.max(0, Number.isFinite(last) ? Math.min(last, f) : f), fps: info.fps };
        }
        async function mark(v, which) {
            if (CFG.enabled === false) return;
            const { f } = await currentFrame(v);
            const src = srcOf(v);
            const s = segments.get(src) || { in: null, out: null };
            const other = which === "in" ? "out" : "in", wasComplete = ready(s);
            s[which] = f;
            let swapped = false, fresh = false;
            if (ready(s) && s.out < s.in) {
                // completing a segment in reverse order (O before I) -> swap; moving one end of an
                // existing segment past the other end -> start a new segment from this mark
                if (wasComplete) { s[other] = null; fresh = true; }
                else { [s.in, s.out] = [s.out, s.in]; swapped = true; }
            }
            segments.set(src, s);
            const label = which === "in" ? `${i18n("Loop start", "Inicio de bucle")}: frame ${f}` : `${i18n("Loop end", "Final de bucle")}: frame ${f}`;
            const tail = ready(s) ? `  ·  ${i18n("loop", "bucle")} ${s.in}–${s.out}${swapped ? i18n(" (swapped)", " (intercambiados)") : ""}`
                : fresh ? `  ·  ${other === "out" ? i18n("new segment (end missing)", "nuevo segmento (falta el final)")
                                                  : i18n("new segment (start missing)", "nuevo segmento (falta el inicio)")}` : "";
            core.toast(label + tail, "info", 2200);
            core.showOverlay(v, label);
            watch(v); drawBar(v);
        }
        core.registerAction("mark_in", v => mark(v, "in"));
        core.registerAction("mark_out", v => mark(v, "out"));
        core.registerAction("clear_segment", v => {
            if (CFG.enabled === false) return;
            segments.delete(srcOf(v));
            clearTimeout(timers.get(v)); timers.delete(v);
            core.toast(i18n("Loop cleared", "Bucle borrado"), "info", 1800);
            core.showOverlay(v, i18n("Loop cleared", "Bucle borrado"));
            drawBar(v);
        });

        // Playback enforcement (frame accurate): on every presented frame inside [in, out]
        // the moment frame out+1 would appear is known (rVFC expectedDisplayTime + the
        // remaining frame durations), so a single timer is re-armed to seek back to `in`
        // a safety margin before it. A seek freezes the current picture until `in` is
        // decoded, so `out` stays on screen and out+1 is never shown. Overshoot (frame > out,
        // e.g. a late timer) or a frame before `in` jumps to `in` at once.
        const timers = new WeakMap(), watching = new WeakSet();
        function seekIn(v, s, fps) {
            clearTimeout(timers.get(v)); timers.delete(v);
            core.seekTo(v, s.in / fps + 0.001);
        }
        function check(v, mediaTime, displayAt) {
            const s = segOf(v), info = core.getInfo(v);
            if (!ready(s) || !info.fps || v.paused) return;
            const fps = info.fps, f = frameAt(mediaTime, fps);
            if (f > s.out && boomerangOn(v)) {                          // boomerang: turn round at `out`
                if (!v.seeking && !core.seekPending(v)) startReverse(v, s.out, 0.5);
                return;
            }
            if (f > s.out || f < s.in) { seekIn(v, s, fps); return; }
            const rate = v.playbackRate || 1, fd = 1000 / fps / rate;
            const outEnds = (displayAt || performance.now()) + ((s.out + 1) / fps - mediaTime) * 1000 / rate;
            // Boomerang pauses (no freezing seek): a late timer under load let `out + 1` flash. Turn round
            // 0.7 frame before `out` ends (`out` is already on screen); startReverse shows `out` exactly.
            const margin = boomerangOn(v) ? 0.7 * fd : Math.min(0.45 * fd, 28);
            clearTimeout(timers.get(v));
            timers.set(v, setTimeout(() => {
                timers.delete(v);
                const s2 = segOf(v);
                if (!ready(s2) || v.paused) return;
                if (boomerangOn(v)) startReverse(v, s2.out, 0.5);        // `out` shown: play it backwards from here
                else seekIn(v, s2, fps);
            }, Math.max(0, outEnds - margin - performance.now())));
        }
        function watch(v) {
            if (watching.has(v)) return;
            watching.add(v);
            const rvfc = typeof v.requestVideoFrameCallback === "function";
            const tick = (now, meta) => {
                if (!v.isConnected) { watching.delete(v); return; }
                const hasMeta = meta && typeof meta.mediaTime === "number";
                check(v, hasMeta ? meta.mediaTime : v.currentTime, hasMeta ? meta.expectedDisplayTime : 0);
                if (rvfc) v.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
            };
            if (rvfc) v.requestVideoFrameCallback(tick); else requestAnimationFrame(tick);
            v.addEventListener("pause", () => { clearTimeout(timers.get(v)); timers.delete(v); });
            // A seek of a PAUSED video onto the last frame (a frame step / scrub / wrap through the end)
            // makes Chrome land on `duration` and fire "ended": that is not playback reaching the end,
            // so it must not jump to `in` and start playing (1.4.3: scrubbing through the end with
            // frame_step.wrap would be cut). Any play() clears the flag.
            let seekWhilePaused = false;
            v.addEventListener("seeking", () => { seekWhilePaused = v.paused; });
            v.addEventListener("play", () => {
                seekWhilePaused = false;
                const s = segOf(v), info = core.getInfo(v);
                if (!ready(s) || !info.fps) return;
                const f = frameAt(v.currentTime, info.fps);
                if (f < s.in || f > s.out) seekIn(v, s, info.fps);   // play from outside the segment -> start at `in`
                else check(v, v.currentTime, performance.now());     // paused on `out`: no rVFC for that frame, arm the wrap now
            });
            v.addEventListener("ended", () => {                    // `out` = last frame: loop instead of stopping
                if (seekWhilePaused || boomerangOn(v)) return;      // boomerang: the module-level "ended" handler turns round
                const s = segOf(v), info = core.getInfo(v);
                if (ready(s) && info.fps) { seekIn(v, s, info.fps); v.play().catch(() => {}); }
            });
        }
        document.addEventListener("play", e => { if (e.target instanceof HTMLVideoElement && segOf(e.target)) watch(e.target); }, true);

        // ------------------------------------------------------ boomerang (ping-pong)
        // loop.mode "boomerang" (or B for one video): at the end (last frame, or `out` of an A-B
        // segment) playback turns round and goes BACKWARDS to the start (frame 0, or `in`), then
        // forwards again, and so on. Only while the video loops (loop_all / L) or has an A-B segment.
        // Chrome can't play backwards (negative playbackRate is not supported), so reverse is emulated
        // on a PAUSED video (a paused video plays no audio: reverse is silent, muted / volume untouched),
        // driven by a requestAnimationFrame clock that moves a position backwards at the current
        // playbackRate (the 1.4.4 speed, read live). Two ways to put the frame under it on screen:
        //  * frame cache (smooth): while a boomerang video plays, every presented frame is copied into
        //    an ImageBitmap (rVFC + createImageBitmap, at most 1280 px and ~256 MB per video, other idle
        //    videos' caches are freed). Reverse draws those frames on a canvas laid exactly over the
        //    picture, on time, like normal playback. The paused video follows underneath with a
        //    background seek at most 4 times a second (progress bar, cache holes).
        //  * exact seeks (fallback: frame not cached yet, native <video> fullscreen where nothing can be
        //    drawn above the video, picture partly off screen): each frame is a seek, the next one only
        //    after the previous has finished (no pile-up), so a slow decoder skips frames but keeps the
        //    speed. Backwards seeks decode from the previous keyframe, so this is choppier on long-GOP /
        //    high resolution videos; the frames it shows are cached for the next round.
        // Interaction: any seek that is not ours (frame step, wheel, Q/W, scrub, progress bar) ends reverse
        // and leaves the video paused there (play = forwards from there). As the video is technically
        // paused while reversing, play / Space / click on it means "pause" for the user: reverse stops on
        // the current frame; play again = continue backwards. Before a key action / pointer press / save
        // the element is first moved to the frame on screen, so what reads currentTime sees that frame.
        const rev = new WeakMap();               // video -> running reverse state
        const pausedRev = new WeakSet();         // paused by the user while reversing (play = backwards again)
        const endPark = new WeakSet();           // paused on the last frame by a seek (Chrome fired "ended")
        const ownPlay = new WeakSet();           // play() issued by the bounce at the start
        const seekPaused = new WeakMap();        // last seek happened while paused
        const ownTarget = new WeakMap();         // time of our latest reverse seek (also after reverse stopped)
        // Chrome: a seek of a paused video into the LAST frame is followed by a second, internal seek to
        // `duration` (+ "ended"). Such a seek is not the user's.
        const atEnd = v => Number.isFinite(v.duration) && v.currentTime >= v.duration - 1e-3;
        // Gradio's video player (bind:currentTime) writes its last known time back into the element right
        // after a pause: a seek within ±2 frames shortly after one of OUR pauses is not the user's.
        const ourPause = new WeakMap();
        function pauseOurs(v) {
            const fps = core.getInfo(v).fps || 30;
            ourPause.set(v, { t: performance.now(), f: frameAt(v.currentTime, fps), fps });
            if (!v.paused) v.pause();
        }
        function echoOfOurPause(v) {
            const op = ourPause.get(v);
            return !!op && performance.now() - op.t < 400 && Math.abs(frameAt(v.currentTime, op.fps) - op.f) <= 2;
        }
        const boomerangActive = v => boomerangOn(v) && (ready(segOf(v)) || !!loopWanted(v));
        const boundOf = v => { const s = segOf(v); return ready(s) ? s.in : 0; };
        const reversing = v => { const st = rev.get(v); return !!(st && st.running); };

        // ---- frame cache
        const CACHE_BUDGET = 256 * 1024 * 1024, CACHE_MAX_SIDE = 1280;
        const caches = new Map();                // video -> { src, w, h, frames: Map(frame -> ImageBitmap), busy }
        function freeCache(v) {
            const c = caches.get(v);
            if (!c) return;
            caches.delete(v);
            for (const bm of c.frames.values()) { try { bm.close(); } catch (_) { /* gone */ } }
            c.frames.clear();
        }
        function cacheOf(v, create) {
            let c = caches.get(v);
            const src = rawSrc(v);
            if (c && c.src !== src) { freeCache(v); c = null; }
            if (c || !create) return c || null;
            const info = core.getInfo(v), last = core.lastFrameOf(v, info);
            if (!info.fps || !Number.isFinite(last) || !v.videoWidth || !v.videoHeight || typeof createImageBitmap !== "function") return null;
            for (const other of [...caches.keys()]) if (!other.isConnected || (other.paused && !reversing(other))) freeCache(other);
            const vw = v.videoWidth, vh = v.videoHeight;
            const k = Math.min(1, CACHE_MAX_SIDE / Math.max(vw, vh), Math.sqrt(CACHE_BUDGET / ((last + 1) * vw * vh * 4)));
            c = { src, w: Math.max(2, Math.round(vw * k)), h: Math.max(2, Math.round(vh * k)), frames: new Map(), busy: new Set() };
            caches.set(v, c);
            return c;
        }
        function capture(v, f) {
            const c = cacheOf(v, true);
            if (!c || c.frames.has(f) || c.busy.has(f)) return;
            c.busy.add(f);
            createImageBitmap(v, { resizeWidth: c.w, resizeHeight: c.h, resizeQuality: "medium" }).then(bm => {
                c.busy.delete(f);
                if (caches.get(v) === c && c.src === rawSrc(v) && !c.frames.has(f)) c.frames.set(f, bm); else bm.close();
            }, () => c.busy.delete(f));
        }
        const capturing = new WeakSet();
        function startCapture(v) {
            if (capturing.has(v) || typeof v.requestVideoFrameCallback !== "function") return;
            capturing.add(v);
            const cb = (now, meta) => {
                if (!v.isConnected || !boomerangActive(v)) { capturing.delete(v); if (!v.isConnected || !boomerangOn(v)) freeCache(v); return; }
                const fps = core.getInfo(v).fps;
                if (fps && meta && typeof meta.mediaTime === "number") capture(v, frameAt(meta.mediaTime, fps));
                v.requestVideoFrameCallback(cb);
            };
            v.requestVideoFrameCallback(cb);
        }
        document.addEventListener("play", e => { if (e.target instanceof HTMLVideoElement && boomerangActive(e.target)) startCapture(e.target); }, true);

        // ---- canvas laid over the picture
        const canvases = new WeakMap(), lastDrawn = new WeakMap();
        function pictureRectOf(v) {
            const r = v.getBoundingClientRect();
            let x = r.left, y = r.top, w = r.width, h = r.height;
            if (v.videoWidth && v.videoHeight) {
                const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
                w = v.videoWidth * k; h = v.videoHeight * k; x += (r.width - w) / 2; y += (r.height - h) / 2;
            }
            return { x, y, w, h, r };
        }
        function canvasUsable(v) {
            const fs = core.fsElement();
            if (fs === v || (fs && !fs.contains(v)) || !core.isVisible(v)) return false;   // native fullscreen: nothing can be drawn above
            const r = v.getBoundingClientRect();
            return r.width > 0 && r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
        }
        function draw(v, st, f) {
            const c = caches.get(v), bm = c && c.frames.get(f);
            if (!bm) return false;
            let cv = canvases.get(v);
            if (!cv) {
                cv = document.createElement("canvas");
                cv.className = "vidosser-reverse";
                cv.style.cssText = "position:fixed;z-index:2147483643;pointer-events:none;display:none;";
                canvases.set(v, cv);
            }
            const host = core.fsElement() || document.body;
            if (cv.parentNode !== host) host.appendChild(cv);
            if (cv.width !== c.w || cv.height !== c.h) { cv.width = c.w; cv.height = c.h; }
            const p = pictureRectOf(v);
            Object.assign(cv.style, { left: p.x + "px", top: p.y + "px", width: p.w + "px", height: p.h + "px", display: "block" });
            const zc = V.modules.zoom && V.modules.zoom.clipRect(v);     // 1.4.11: zoomed -> only inside the video box
            cv.style.clipPath = zc ? `inset(${Math.max(0, zc.top - p.y)}px ${Math.max(0, p.x + p.w - zc.right)}px ${Math.max(0, p.y + p.h - zc.bottom)}px ${Math.max(0, zc.left - p.x)}px)` : "";
            cv.getContext("2d").drawImage(bm, 0, 0, c.w, c.h);
            lastDrawn.set(v, f);
            st.canvas = true; st.drawn++;
            return true;
        }
        function hideCanvas(v) { const cv = canvases.get(v); if (cv) cv.style.display = "none"; }
        // keep the canvas until the video itself shows the right frame (end of the pending seek), then remove it
        function releaseCanvas(v) {
            const cv = canvases.get(v);
            if (!cv || cv.style.display === "none") return;
            if (!v.seeking && !core.seekPending(v)) { hideCanvas(v); return; }
            let done = false;
            const fin = () => { if (done) return; done = true; v.removeEventListener("seeked", onSeeked); if (!reversing(v)) hideCanvas(v); };
            const onSeeked = () => setTimeout(() => { if (!v.seeking && !core.seekPending(v)) fin(); }, 0);
            v.addEventListener("seeked", onSeeked);
            setTimeout(fin, 1500);
        }

        // ---- reverse clock
        function seekOwn(v, st, f, now) {
            st.vf = f; st.seeks++; st.seekAt = now;
            const t = (f + 0.4) / st.fps;                                // 0.4: our seeks are told apart from frame steps (0.5)
            ownTarget.set(v, t);
            core.seekTo(v, t);
        }
        // how: "release" (default: canvas stays until the next seek ends), "sync" (first move the video to the
        // frame on screen), "now" (hide the canvas at once)
        function stopReverse(v, how) {
            const st = rev.get(v);
            if (!st) return null;
            st.running = false; cancelAnimationFrame(st.raf); rev.delete(v);
            if (how === "sync" && st.canvas && st.vf !== st.shown) seekOwn(v, st, st.shown, performance.now());
            if (how === "now") hideCanvas(v); else if (how !== "keep") releaseCanvas(v);
            return st;
        }
        function playForward(v) {
            ownPlay.add(v);
            const p = v.play();
            if (p && p.catch) p.catch(() => ownPlay.delete(v));
        }
        function topFrame(v, info) {
            const last = core.lastFrameOf(v, info);
            const f = frameAt(v.currentTime, info.fps);
            return Number.isFinite(last) ? Math.min(last, f) : Math.max(0, f - (v.ended ? 1 : 0));
        }
        // fromFrame is on screen; hold = fraction of a frame it stays before the next one down
        function startReverse(v, fromFrame, hold) {
            const info = core.getInfo(v);
            if (!info.fps) return;
            stopReverse(v, "keep"); pausedRev.delete(v); endPark.delete(v);
            clearTimeout(timers.get(v)); timers.delete(v);
            if (!v.paused) pauseOurs(v);
            const fps = info.fps, now = performance.now(), last = core.lastFrameOf(v, info);
            const cur = frameAt(v.currentTime, fps);
            const st = { running: true, fps, pos: (fromFrame + Math.min(0.999, Math.max(0.001, hold))) / fps, shown: fromFrame,
                         vf: Number.isFinite(last) ? Math.min(cur, last) : cur, seekAt: 0, prev: now, t0: now, raf: 0,
                         seeks: 0, drawn: 0, bounce: false, canvas: false };
            rev.set(v, st);
            startCapture(v);
            // never seek INTO the last frame (Chrome snaps it to `duration` and fires "ended"): from the end, go
            // straight to the frame below; otherwise make sure `fromFrame` is on screen
            if (fromFrame === last && (cur >= last || atEnd(v))) st.vf = last;
            else if (fromFrame === last) { st.pos = fromFrame / fps; st.shown = fromFrame - 1; if (canvasUsable(v)) draw(v, st, fromFrame - 1); seekOwn(v, st, fromFrame - 1, now); }
            else if (cur !== fromFrame) { st.shown = fromFrame; if (canvasUsable(v)) draw(v, st, fromFrame); seekOwn(v, st, fromFrame, now); }
            st.raf = requestAnimationFrame(t => tick(v, st, t));
        }
        // One step of the reverse clock; returns false once reverse is over. Called on every animation
        // frame and also straight from "seeked" (the next seek goes out without waiting for a frame).
        function step(v, st, now) {
            if (!st.running || rev.get(v) !== st) return false;
            if (!v.isConnected) { stopReverse(v, "now"); return false; }
            if (!boomerangActive(v)) { stopReverse(v, "sync"); playForward(v); return false; }   // mode / B / L / segment changed
            const dt = Math.min(250, Math.max(0, now - st.prev));     // capped: a hidden tab doesn't jump on return
            st.prev = now;
            st.pos -= dt / 1000 * (Number(v.playbackRate) || 1);
            const bound = boundOf(v);
            const raw = Math.floor(st.pos * st.fps + 1e-6);
            if (st.pos * st.fps <= bound + 1e-6) st.bounce = true;     // the start frame has had its full duration
            const f = Math.min(st.shown, Math.max(bound, raw));      // never upwards, never below the start
            const idle = !v.seeking && !core.seekPending(v) && v.readyState >= 2;
            const c = caches.get(v);
            const cached = !!(c && c.src === rawSrc(v) && c.frames.has(f)) && canvasUsable(v);
            // 1. the picture
            if (cached) { if (f !== st.shown || !st.canvas) { draw(v, st, f); st.shown = f; } }
            else if (st.canvas && (!canvasUsable(v) || (idle && st.vf === f))) { hideCanvas(v); st.canvas = false; st.shown = st.vf; }
            // 2. the (hidden or visible) video itself
            if (idle && st.vf !== f && !(cached && f !== bound && now - st.seekAt < 250)) {
                seekOwn(v, st, f, now);
                if (!st.canvas) st.shown = f;
            }
            // 3. start reached, on screen and in the video: forwards again
            if (st.bounce && st.shown === bound && st.vf === bound && idle) { stopReverse(v, "now"); playForward(v); return false; }
            return true;
        }
        function tick(v, st, now) {
            if (step(v, st, now)) st.raf = requestAnimationFrame(t => tick(v, st, t));
        }
        document.addEventListener("seeked", e => {
            const v = e.target, st = v instanceof HTMLVideoElement && rev.get(v);
            // after the core queue's own "seeked" handler (registered earlier on the element) has run
            if (st && st.running) setTimeout(() => { if (step(v, st, performance.now()) === false) cancelAnimationFrame(st.raf); }, 0);
        }, true);
        // Before a key action / step / save / pointer press on a reversing video: put the element on the frame
        // that is on screen (currentTime updates at once), so the action reads that frame. Steps end reverse
        // (direction resets to forwards); save and A-B marks pause it (play = backwards again).
        core.onUserAction((v, kind) => {
            const st = rev.get(v);
            if (!st || !st.running) return;
            if (st.vf !== st.shown || v.seeking || core.seekPending(v)) {
                st.vf = st.shown; st.seekAt = performance.now();
                const t = (st.shown + 0.4) / st.fps;
                ownTarget.set(v, t);
                core.seekNow(v, t);
            }
            if (/^(step|next_frame|prev_frame|jump_forward|jump_back)$/.test(kind)) stopReverse(v);
            else if (/^(save_frame_as|mark_in|mark_out)$/.test(kind)) { stopReverse(v); pausedRev.add(v); }
        });
        window.addEventListener("pointerdown", e => {
            const v = core.videoForPointerEvent ? core.videoForPointerEvent(e) : null;
            if (v && reversing(v)) core.beforeUserAction(v, "pointer");
        }, { capture: true, passive: true });

        document.addEventListener("seeking", e => {
            const v = e.target;
            if (!(v instanceof HTMLVideoElement)) return;
            if (atEnd(v) && v.paused) return;                           // Chrome's own snap to `duration` (see atEnd)
            seekPaused.set(v, v.paused);
            const t = ownTarget.get(v);
            if (t !== undefined && Math.abs(v.currentTime - t) < 1e-4) return;   // one of our reverse seeks
            if (v.paused && echoOfOurPause(v)) return;                 // the player re-applying its time after our pause
            if (rev.has(v)) stopReverse(v);                             // the user took over: stay paused there
            if (v.paused) { pausedRev.delete(v); endPark.delete(v); }
        }, true);
        document.addEventListener("play", e => {
            const v = e.target;
            if (!(v instanceof HTMLVideoElement)) return;
            seekPaused.delete(v);
            if (ownPlay.has(v)) { ownPlay.delete(v); return; }
            if (reversing(v)) {                                         // play / Space / click while reversing = pause
                pauseOurs(v); stopReverse(v, "sync"); pausedRev.add(v);
                core.showOverlay(v, i18n("Paused (Boomerang, backwards)", "Pausa (Boomerang, hacia atrás)"));
                return;
            }
            const info = core.getInfo(v);
            if (pausedRev.has(v)) {
                pausedRev.delete(v);
                if (boomerangActive(v) && info.fps) {                   // continue backwards from this frame
                    pauseOurs(v); startReverse(v, topFrame(v, info), 0.5);
                    core.showOverlay(v, i18n("Boomerang: backwards", "Boomerang: hacia atrás"));
                    return;
                }
            }
            if (endPark.has(v)) {                                       // stepped onto the last frame, then play: backwards
                endPark.delete(v);
                if (boomerangActive(v) && !ready(segOf(v)) && info.fps) {
                    const last = core.lastFrameOf(v, info);
                    pauseOurs(v);
                    if (Number.isFinite(last)) startReverse(v, last, 0.5);  // play() already went to 0: shows last - 1 at once
                }
            }
        }, true);
        document.addEventListener("ended", e => {
            const v = e.target;
            if (!(v instanceof HTMLVideoElement) || !boomerangOn(v)) return;
            if (seekPaused.get(v)) { if (boomerangActive(v)) endPark.add(v); return; }   // a paused seek landed on the end
            if (!boomerangActive(v)) return;
            const info = core.getInfo(v);
            if (!info.fps) return;
            const s = segOf(v);
            startReverse(v, ready(s) ? s.out : topFrame(v, info), 0.02);
        }, true);
        const resetVideo = e => {
            const v = e.target;
            if (!(v instanceof HTMLVideoElement)) return;
            stopReverse(v, "now"); pausedRev.delete(v); endPark.delete(v); freeCache(v);
        };
        document.addEventListener("emptied", resetVideo, true);
        document.addEventListener("loadstart", resetVideo, true);

        core.registerAction("toggle_boomerang", v => {
            if (CFG.enabled === false) return;
            const on = !boomerangOn(v);
            bOverride.set(srcOf(v), on);
            applyLoop(v);
            if (!on) {
                pausedRev.delete(v); endPark.delete(v);
                if (reversing(v)) { stopReverse(v, "sync"); playForward(v); }
                freeCache(v);
            } else if (!v.paused) startCapture(v);
            const msg = on ? i18n("Boomerang on (this video)", "Boomerang activado (este vídeo)")
                           : i18n("Boomerang off (this video)", "Boomerang desactivado (este vídeo)");
            const note = on && !boomerangActive(v) ? i18n(" · the loop of this video is off", " · el bucle de este vídeo está desactivado") : "";
            core.toast(msg + note, "info", 2000);
            core.showOverlay(v, "Boomerang: " + (on ? i18n("on", "sí") : i18n("off", "no")));
        });

        // ---------------------------------------------------------- segment marker bar
        // Thin bar on the bottom edge of the video picture: whole timeline faint, the A-B
        // segment highlighted (a single tick while only one end is set).
        const bars = new Map();                  // video -> element
        function drawBar(v) {
            const s = segOf(v);
            let bar = bars.get(v);
            const fs = core.fsElement();
            if (!s || fs === v || !v.isConnected || !core.isVisible(v)) { if (bar) bar.style.display = "none"; return; }
            const info = core.getInfo(v), last = core.lastFrameOf(v, info);
            if (!info.fps || !Number.isFinite(last)) { if (bar) bar.style.display = "none"; return; }
            if (!bar) {
                bar = document.createElement("div");
                bar.className = "vidosser-loop-bar";
                bar.style.cssText = "position:fixed;height:3px;z-index:2147483645;pointer-events:none;background:rgba(255,255,255,.15);";
                bar.innerHTML = '<div class="vidosser-loop-seg" style="position:absolute;top:0;bottom:0;background:#ffb000;"></div>';
                bars.set(v, bar);
            }
            const host = fs || document.body;
            if (bar.parentNode !== host) host.appendChild(bar);
            const r = v.getBoundingClientRect();
            let x = r.left, y = r.top, w = r.width, h = r.height;
            if (v.videoWidth && v.videoHeight) {
                const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
                w = v.videoWidth * k; h = v.videoHeight * k; x += (r.width - w) / 2; y += (r.height - h) / 2;
            }
            const total = last + 1;
            const a = s.in !== null ? s.in : s.out, b = s.out !== null ? s.out : s.in;
            const seg = bar.firstChild;
            seg.style.left = (a / total * 100) + "%";
            seg.style.width = Math.max(0.6, (b + 1 - a) / total * 100) + "%";
            seg.dataset.in = s.in === null ? "" : s.in; seg.dataset.out = s.out === null ? "" : s.out;
            Object.assign(bar.style, { display: "block", left: Math.round(x) + "px", top: Math.ceil(y) + "px", width: Math.round(w) + "px" });   // thin line on the picture's top edge
        }
        const redrawAll = () => { for (const v of [...bars.keys()]) { if (!v.isConnected) { bars.get(v).remove(); bars.delete(v); } else drawBar(v); } };
        window.addEventListener("scroll", redrawAll, { capture: true, passive: true });
        window.addEventListener("resize", redrawAll);
        document.addEventListener("fullscreenchange", () => setTimeout(redrawAll, 50));
        document.addEventListener("loadedmetadata", e => { if (bars.has(e.target)) drawBar(e.target); }, true);
        setInterval(redrawAll, 500);

        return {
            config: CFG, segments,
            segment: v => { const s = segOf(v); return s ? { in: s.in, out: s.out } : null; },
            boomerang: {
                on: boomerangOn, active: boomerangActive, reversing,
                pausedBackwards: v => pausedRev.has(v),
                stats: v => { const st = rev.get(v); return st ? { seeks: st.seeks, drawn: st.drawn, canvas: st.canvas, ms: performance.now() - st.t0, shown: st.shown } : null; },
                cached: v => { const c = caches.get(v); return c ? { frames: c.frames.size, w: c.w, h: c.h } : null; },
                freeCache,
                canvasFrame: v => { const cv = canvases.get(v); return cv && cv.style.display !== "none" ? lastDrawn.get(v) : null; },
                start: (v, from) => startReverse(v, from, 0.5),
            },
            loopWanted,
            onSettings: () => {
                applyAll();
                document.querySelectorAll("video").forEach(v => { if (!boomerangOn(v)) { pausedRev.delete(v); endPark.delete(v); freeCache(v); } });
            },
        };
    })(core, V.config.loop = Object.assign({
        enabled: true,
        loop_all: true,           // every <video> plays in loop
        mode: "normal",           // "normal" | "boomerang" (end -> backwards -> start -> forwards; also between A and B)
    }, SETTINGS.loop || {}));

    // =======================================================================
    // MODULE new_video - in fullscreen, keep watching the current video when WanGP adds a
    // newly generated one to the output gallery (new_video.no_autojump_fullscreen)
    // =======================================================================
    // When a generation ends, WanGP (refresh_gallery / finalize_generation) sends the gallery
    // a new value with selected_index = the new last item if the selected item was the last
    // one. Gradio's Gallery keeps the same preview <video> element and only sets its "src"
    // attribute (Svelte: if (!src_url_equal(video.src, url)) video.setAttribute("src", url)).
    // While that video is fullscreen (Vidosser's container fullscreen, Gradio's gallery
    // fullscreen or the native <video> fullscreen), this module refuses that src change, so
    // the picture, position, play state, fullscreen, volume and A-B loop stay exactly as they
    // were (no reload at all). Right after Gradio's update it clicks the thumbnail of the
    // video still on screen, so Gradio and WanGP select it again (Gradio then finds the same
    // src and does not touch the element; WanGP's select_media stores the choice, so later
    // refreshes keep it too). The new video is in the gallery as usual.
    // Allowed as usual: changes the user makes (trusted click on a thumbnail, arrow keys in
    // the gallery), anything outside fullscreen, a gallery with nothing loaded yet, and a
    // switch away from a video that is no longer in the gallery (deleted / out of the list).
    // On leaving fullscreen (jump_on_fullscreen_exit) the newest video is selected, which is
    // what WanGP would have shown, so outside fullscreen WanGP keeps following new videos.
    V.modules.new_video = (function (core, CFG) {
        const mediaSrc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
        const nativeSetAttribute = Element.prototype.setAttribute;
        let userNavUntil = 0, blocked = null;                          // blocked = { v, src: watched, news: Set of refused srcs }
        const abs = u => { try { return new URL(String(u), document.baseURI).href; } catch (_) { return String(u || ""); } };
        const isPreview = v => v instanceof HTMLVideoElement && !v.closest(".thumbnail-item") && !!v.closest(".gallery-container .preview");
        const inFs = v => { const fs = core.fsElement(); return !!(fs && (fs === v || fs.contains(v))); };
        const active = () => CFG.enabled !== false && CFG.no_autojump_fullscreen !== false;
        const thumbs = v => { const g = v.closest(".gallery-container"); return g ? [...g.querySelectorAll(".preview .thumbnails .thumbnail-item")] : []; };
        function thumbFor(v, src) {
            for (const t of thumbs(v)) {
                const tv = t.querySelector("video"), img = t.querySelector("img");
                const u = tv ? (tv.getAttribute("src") || tv.src) : img ? (img.getAttribute("src") || img.src) : "";
                if (u && abs(u) === src) return t;
            }
            return null;
        }
        // No "our own navigation" grace period here: WanGP sends the same gallery update twice in
        // quick succession (refresh_gallery, then the end of the generation), both must be refused.
        function select(thumb) {
            const fsm = V.modules.frame_step;
            if (fsm && fsm.clearSwallow) fsm.clearSwallow();            // a click swallowed after a scrub must not be this one
            thumb.click();
        }
        function notify(n) {
            if (CFG.notify === false) return;
            const text = n > 1 ? i18n(`${n} new videos ready (you're still watching this one)`, `${n} vídeos nuevos listos (sigues viendo este)`)
                              : i18n("New video ready (you're still watching this one)", "Nuevo vídeo listo (sigues viendo este)");
            core.toast(text, "info", 2200);
        }
        // true = let Gradio set the new src now
        function allowSrc(v, value) {
            if (!active() || !isPreview(v) || !inFs(v)) return true;
            const now = performance.now();
            if (now < userNavUntil) return true;                          // the user's own navigation
            const cur = v.currentSrc || v.src;
            if (!cur || v.readyState < 1 || value == null || value === "" || abs(value) === abs(cur)) return true;
            // Refuse for now; once Gradio's update is complete (the thumbnails show the new
            // list), select the video still on screen again, or apply the change if it is gone.
            const keep = abs(cur), next = String(value);
            queueMicrotask(() => setTimeout(() => {
                const t = v.isConnected && thumbFor(v, keep);
                if (t) {
                    if (!blocked || blocked.v !== v || blocked.src !== keep) blocked = { v, src: keep, news: new Set() };
                    const fresh = !blocked.news.has(abs(next));
                    blocked.news.add(abs(next));
                    select(t);
                    if (fresh) notify(blocked.news.size);                // WanGP may resend the same update: count each new video once
                } else if (v.isConnected && abs(v.currentSrc || v.src) === keep) {
                    nativeSetAttribute.call(v, "src", next);              // the watched video left the gallery
                }
            }, 0));
            return false;
        }
        Object.defineProperty(HTMLVideoElement.prototype, "setAttribute", {
            configurable: true, writable: true,
            value: function (name, value) {
                if (String(name).toLowerCase() === "src" && !allowSrc(this, value)) return;
                return nativeSetAttribute.call(this, name, value);
            },
        });
        if (mediaSrc && mediaSrc.set) {
            Object.defineProperty(HTMLVideoElement.prototype, "src", {
                configurable: true, enumerable: mediaSrc.enumerable,
                get() { return mediaSrc.get.call(this); },
                set(value) { if (allowSrc(this, value)) mediaSrc.set.call(this, value); },
            });
        }
        // The user's own gallery navigation is always allowed (capture phase: before Gradio).
        window.addEventListener("click", e => {
            if (e.isTrusted && e.target instanceof Element && e.target.closest(".gallery-container .thumbnail-item")) {
                userNavUntil = performance.now() + 1500; blocked = null;
            }
        }, true);
        window.addEventListener("keydown", e => {
            if (!e.isTrusted || !["ArrowLeft", "ArrowRight", "Escape"].includes(e.key)) return;
            const t = e.composedPath ? e.composedPath()[0] : e.target;
            if (t instanceof Element && t.closest(".gallery-container") && !core.typingOrModal(e)) {
                userNavUntil = performance.now() + 1500; blocked = null;
            }
        }, true);
        // 1.4.10: keys.prev_video / keys.next_video (E / R): select the adjacent thumbnail of the gallery,
        // also in the container fullscreen (it stays); an explicit user action, so never blocked. Stops
        // at the ends. In fullscreen it also ends any pending "new video" state (the user chose).
        function step(v, dir) {
            const all = thumbs(v);
            if (!all.length) { core.toast(i18n("No gallery for this video", "Este vídeo no está en una galería"), "info", 1500); return; }
            let i = all.findIndex(t => t.classList.contains("selected"));
            if (i < 0) i = all.findIndex(t => t === thumbFor(v, abs(v.currentSrc || v.src)));
            const j = i + dir;
            if (i >= 0 && (j < 0 || j >= all.length)) {
                const msg = dir < 0 ? i18n("First video", "Primer vídeo") : i18n("Last video", "Último vídeo");
                core.toast(msg, "info", 1200); core.showOverlay(v, msg); return;
            }
            const t = all[Math.max(0, Math.min(all.length - 1, j))];
            userNavUntil = performance.now() + 1500; blocked = null;
            const fsm = V.modules.frame_step;
            if (fsm && fsm.clearSwallow) fsm.clearSwallow();
            t.click();
            const n = all.indexOf(t) + 1;
            setTimeout(() => core.showOverlay(v, `${dir < 0 ? i18n("Previous video", "Vídeo anterior") : i18n("Next video", "Vídeo siguiente")} · ${n}/${all.length}`), 150);
        }
        core.registerAction("prev_video", v => step(v, -1));
        core.registerAction("next_video", v => step(v, 1));
        function onFullscreenChange() {
            if (core.fsElement() || !blocked) return;
            const b = blocked; blocked = null;
            if (CFG.jump_on_fullscreen_exit === false || !b.v.isConnected || abs(b.v.currentSrc || b.v.src) !== b.src) return;
            const all = thumbs(b.v), last = all[all.length - 1];
            if (last && !last.classList.contains("selected")) setTimeout(() => select(last), 0);
        }
        document.addEventListener("fullscreenchange", onFullscreenChange);
        document.addEventListener("webkitfullscreenchange", onFullscreenChange);
        return { config: CFG, pending: () => (blocked ? { src: blocked.src, count: blocked.news.size } : null) };
    })(core, V.config.new_video = Object.assign({
        enabled: true,
        no_autojump_fullscreen: true,   // in fullscreen, a new video does not replace the one being watched
        jump_on_fullscreen_exit: true,  // on leaving fullscreen, show the newest video (what WanGP would have done)
        notify: true,                   // "Nuevo vídeo listo" message (not possible in native <video> fullscreen)
    }, SETTINGS.new_video || {}));

    // =======================================================================
    // Add future modules here:  V.modules.<name> = (function (core, CFG) { ... })(core, V.config.<name> = {...});
    // =======================================================================

    // Live settings: called on page load (fresh settings.json) and after "Save".
    V.applySettings = function (raw) {
        let next; try { next = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (_) { return false; }
        if (!next || typeof next !== "object") return false;
        for (const [section, values] of Object.entries(next)) {
            if (V.config[section] && values && typeof values === "object") Object.assign(V.config[section], values);
        }
        V.settings = next;
        for (const m of Object.values(V.modules)) if (m && typeof m.onSettings === "function") { try { m.onSettings(); } catch (_) {} }
        return true;
    };
    // Settings saved after the server started are published in a hidden textbox of the
    // Vidosser tab. It first holds the start-up value, then Gradio refreshes it on page
    // load: watch it for a minute and apply every new value.
    (function pickUpFreshSettings(tries, last) {
        const el = document.querySelector("#vidosser_settings_json textarea, #vidosser_settings_json input");
        const value = el ? el.value : "";
        if (value && value !== last) V.applySettings(value);
        if (tries > 0) setTimeout(() => pickUpFreshSettings(tries - 1, value || last), 500);
    })(120, "");

    // The settings tab is built in English. For a Spanish browser, write the language into the
    // hidden #vidosser_lang textbox and click #vidosser_lang_btn: the server answers with the
    // Spanish labels / infos / choices (and the textbox makes saves / checks answer in Spanish).
    // Retried until the server confirms (V.i18nApplied) - the tab may mount after this script.
    V.i18nApplied = function (l) { if (l === LANG) V.i18nDone = true; };
    (function localizeTab(tries) {
        if (LANG === "en" || V.i18nDone) return;
        const box = document.querySelector("#vidosser_lang textarea, #vidosser_lang input");
        let btn = document.querySelector("#vidosser_lang_btn");
        if (btn && !btn.matches("button")) btn = btn.querySelector("button");
        let wait = 500;
        // Don't swap the labels / choices under the user's hands (an open dropdown would lose its list).
        const ae = document.activeElement;
        const busy = ae && ae !== document.body && ae.closest && ae.closest('[id^="vidosser_"]');
        if (box && btn && document.readyState === "complete" && !busy) {
            // Gradio only sends what its own state holds: during start-up a value written into
            // the textarea can be dropped, and re-writing the same value is then not seen as a
            // change. Clear it first, so every attempt is a real change.
            box.value = "";
            box.dispatchEvent(new Event("input", { bubbles: true }));
            box.value = LANG;
            box.dispatchEvent(new Event("input", { bubbles: true }));
            setTimeout(() => btn.click(), 60);
            wait = 1500;                                           // retry if the server has not confirmed by then
        }
        if (tries > 0) setTimeout(() => localizeTab(tries - 1), wait);
    })(240);

    window.vidosser = V;                       // debug / scripting hook
    // =======================================================================
    // MODULE zoom (1.4.11) - frame_step.wheel_action "zoom": the plain wheel zooms the video at the
    // cursor (CSS transform on the <video>, origin top-left, ×1.25 per notch, 1× .. max(8×, 4 screen
    // px per video px)); while zoomed the scrub button pans (frame_step drag); the picture always
    // covers the video box (clamped). Reset to 1× on a new src, on leaving fullscreen, with
    // keys.reset_zoom (Z) and when zooming out to 1×. Not in native <video> fullscreen (nothing can
    // be transformed there). The Boomerang canvas follows the transform (it is laid over the
    // video's on-screen rect) and is clipped to the video box.
    // =======================================================================
    V.modules.zoom = (function (core, FS) {
        const st = new Map();                      // video -> { s, tx, ty, clip: {el, overflow} }
        const STEP = 1.25;
        const level = v => (st.get(v) || { s: 1 }).s;
        const possible = v => !!v && core.fsElement() !== v;
        function maxZoom(v) {
            const w = v.offsetWidth, h = v.offsetHeight;
            if (!w || !v.videoWidth) return 8;
            const k = Math.min(w / v.videoWidth, h / v.videoHeight);   // screen px per video px at 1×
            return Math.max(8, 4 / k);
        }
        function apply(v, z) {
            if (!z || z.s <= 1.0001) {
                v.style.transform = ""; v.style.transformOrigin = "";
                if (z && z.clip) z.clip.el.style.overflow = z.clip.overflow;
                st.delete(v); return;
            }
            const w = v.offsetWidth, h = v.offsetHeight;
            z.tx = Math.min(0, Math.max(w - w * z.s, z.tx));
            z.ty = Math.min(0, Math.max(h - h * z.s, z.ty));
            if (!z.clip && v.parentElement) { z.clip = { el: v.parentElement, overflow: v.parentElement.style.overflow }; v.parentElement.style.overflow = "hidden"; }
            v.style.transformOrigin = "0 0";
            v.style.transform = `translate(${z.tx}px, ${z.ty}px) scale(${z.s})`;
        }
        function show(v) { core.showOverlay(v, `Zoom ${level(v).toFixed(1)}×`); }
        function wheel(v, notches, cx, cy) {
            if (!possible(v)) return;
            const z = st.get(v) || { s: 1, tx: 0, ty: 0 };
            const r = v.getBoundingClientRect();
            const L0 = r.left - z.tx, T0 = r.top - z.ty;                  // untransformed box
            const u = (cx - L0 - z.tx) / z.s, w = (cy - T0 - z.ty) / z.s;   // point under the cursor, element units
            const s1 = Math.max(1, Math.min(maxZoom(v), z.s * Math.pow(STEP, notches)));
            z.tx = cx - L0 - u * s1; z.ty = cy - T0 - w * s1; z.s = s1;
            st.set(v, z); apply(v, z); core.touch(v); show(v);
            if (s1 <= 1.0001) reset(v, true);
        }
        function pan(v, dx, dy) {
            const z = st.get(v); if (!z) return;
            z.tx += dx; z.ty += dy; apply(v, z);
        }
        function reset(v, quiet) {
            const z = st.get(v);
            if (!z && !quiet) return;
            apply(v, z ? Object.assign(z, { s: 1 }) : null);
            if (!quiet) core.showOverlay(v, "Zoom 1×");
        }
        function resetAll() { for (const v of [...st.keys()]) reset(v, true); }
        // clip rect for overlays drawn above the video (Boomerang canvas)
        function clipRect(v) { const z = st.get(v); return z && z.clip ? z.clip.el.getBoundingClientRect() : null; }
        for (const t of ["loadstart", "emptied"]) window.addEventListener(t, e => { if (st.has(e.target)) reset(e.target, true); }, true);
        document.addEventListener("fullscreenchange", () => {
            const fs = core.fsElement();
            for (const v of [...st.keys()]) if (!fs || !(fs === v || fs.contains(v)) || fs === v) reset(v, true);
        });
        window.addEventListener("resize", () => { for (const [v, z] of st) apply(v, z); });
        core.registerAction("reset_zoom", v => reset(v, false));

        // 1.4.14 edge pan (frame_step.zoom_edge_pan): while zoomed, the pointer inside an edge band of
        // the video box (12 %, min 40 px) scrolls the picture toward that side, speed proportional to
        // the depth into the band (corners: diagonal); clamped by apply(). Only over the video box.
        let ptr = null, raf = 0, lastT = 0;
        const EDGE_SPEED = 1400;                                       // px / s at the very edge
        function box(v) {                                              // untransformed video box on screen
            const z = st.get(v), r = v.getBoundingClientRect();
            const L = r.left - (z ? z.tx : 0), T = r.top - (z ? z.ty : 0);
            return { L, T, R: L + v.offsetWidth, B: T + v.offsetHeight, w: v.offsetWidth, h: v.offsetHeight };
        }
        function edgeVec(v, x, y) {
            const b = box(v);
            // 1.4.15: outside the box (past an edge) the depth saturates -> full speed toward the side(s) left
            const bx = Math.max(40, b.w * 0.12), by = Math.max(40, b.h * 0.12);
            const f = (d, band) => d < band ? Math.min(1, (band - d) / band) : 0;
            return { x: f(x - b.L, bx) - f(b.R - x, bx), y: f(y - b.T, by) - f(b.B - y, by) };   // +1 = toward left / top
        }
        function tick(now) {
            raf = 0;
            if (FS.zoom_edge_pan !== true || !ptr) return;
            const v = ptr.v, z = st.get(v);
            if (!z || !v.isConnected || document.hidden) return;
            const fs = core.fsElement();
            if (fs && !(fs === v || fs.contains(v))) return;
            const e = edgeVec(v, ptr.x, ptr.y);
            if (!e || (!e.x && !e.y)) return;
            const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016); lastT = now;
            const tx0 = z.tx, ty0 = z.ty;
            const sp = Math.min(4000, Math.max(200, Number(FS.zoom_edge_speed) || EDGE_SPEED));
            pan(v, e.x * sp * dt, e.y * sp * dt);
            if (z.tx === tx0 && z.ty === ty0 && dt > 0.001) return;    // picture at its edge: stop (next move re-arms)
            raf = requestAnimationFrame(tick);
        }
        // 1.4.15: once started over a zoomed video, panning continues while the pointer is outside the box
        // (anywhere in the page / fullscreen element), except over thumbnails or interactive controls, so
        // clicks there stay usable (we never block clicks: only pointermove is observed).
        const INTERACTIVE = "button, a, input, select, textarea, label, [role=button], [role=tab], [role=slider], [contenteditable], .thumbnail-item, .thumbnails";
        document.addEventListener("pointermove", e => {
            if (FS.zoom_edge_pan !== true || e.pointerType === "touch") { ptr = null; return; }
            const t = e.target;
            let v = t instanceof HTMLVideoElement && st.has(t) ? t : null;
            if (!v && ptr && ptr.v.isConnected && st.has(ptr.v)) {
                const fs = core.fsElement();
                const el = t instanceof Element ? t : null;
                if (el && (!fs || fs.contains(el))) v = ptr.v;     // 1.4.16: also over thumbnails / buttons (clicks untouched)
            }
            if (!v || core.typingOrModal(e)) { ptr = null; return; }
            ptr = { v, x: e.clientX, y: e.clientY };
            if (!raf) { lastT = 0; raf = requestAnimationFrame(tick); }
        }, { capture: true, passive: true });
        document.addEventListener("mouseout", e => { if (!e.relatedTarget) ptr = null; });   // left the window
        window.addEventListener("blur", () => { ptr = null; });
        return { level, possible, wheel, pan, reset, resetAll, clipRect };
    })(core, V.config.frame_step);

    // =======================================================================
    // MODULE info - video info panel (keys.toggle_info, default P): file, resolution, fps,
    // duration, current frame / time, speed, volume, loop state, file size. Updated live
    // (4x per second) until P is pressed again or Esc. Drawn at the top right of the picture,
    // inside the fullscreen element when there is one; in native <video> fullscreen it is
    // shown as the subtitle cue (one block of lines). File size: one HEAD request, cached.
    // =======================================================================
    V.modules.info = (function (core) {
        let shown = null, panel = null, timer = 0, lastText = "";
        const sizes = new Map();                  // src -> bytes | null (unknown) | "pending"
        const fmtTime = t => {
            if (!Number.isFinite(t)) return "?";
            const m = Math.floor(t / 60), sec = t - m * 60;
            return (m ? m + ":" + (sec < 10 ? "0" : "") + sec.toFixed(2) : sec.toFixed(2) + " s");
        };
        const fmtSize = b => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : b >= 1024 ? Math.round(b / 1024) + " KB" : b + " B";
        const srcOf = v => v.currentSrc || v.src || "";
        function fileName(v) {
            const u = srcOf(v);
            if (!u) return "?";
            try { return decodeURIComponent(u.split("?")[0]).split(/[\\/=]/).pop() || "?"; } catch (_) { return u.split(/[\\/=]/).pop() || "?"; }
        }
        function size(v) {
            const u = srcOf(v);
            if (!u || u.startsWith("blob:") || u.startsWith("data:")) return null;
            if (sizes.has(u)) { const b = sizes.get(u); return typeof b === "number" ? b : null; }
            sizes.set(u, "pending");
            fetch(u, { method: "HEAD" }).then(r => {
                const n = Number(r.headers.get("content-length"));
                sizes.set(u, r.ok && n > 0 ? n : null);
            }).catch(() => sizes.set(u, null));
            return null;
        }
        function text(v) {
            const info = core.getInfo(v), fps = info.fps;
            const src = info.fpsSource === "mp4" ? "" : info.fpsSource === "playback" ? i18n(" (measured)", " (medido)") :
                info.fpsSource === "default" ? i18n(" (default, not detected)", " (por defecto, no detectado)") : "";
            const last = fps ? core.lastFrameOf(v, info) : NaN;
            const frames = Number.isFinite(last) ? last + 1 : (fps && Number.isFinite(v.duration) ? Math.round(v.duration * fps) : NaN);
            const cur = fps ? Math.floor(v.currentTime * fps + 1e-3) : NaN;
            const curF = Number.isFinite(cur) ? (Number.isFinite(last) ? Math.min(cur, last) : cur) : NaN;
            const L = V.modules.loop, seg = L && L.segment ? L.segment(v) : null;
            const looping = L && L.loopWanted ? !!L.loopWanted(v) : v.loop;
            const boom = L && L.boomerang && L.boomerang.on(v);
            let loop = !looping && !(seg && seg.in !== undefined && seg.out !== undefined) ? i18n("off", "no") : boom ? "Boomerang" : i18n("normal", "normal");
            if (seg && Number.isFinite(seg.in) && Number.isFinite(seg.out)) loop += ` · A-B ${seg.in}–${seg.out}`;
            else if (seg && Number.isFinite(seg.in)) loop += ` · A ${seg.in}`;
            if (L && L.boomerang && L.boomerang.reversing(v)) loop += i18n(" (backwards)", " (hacia atrás)");
            const b = size(v);
            const lines = [
                fileName(v),
                `${i18n("Resolution", "Resolución")}: ${v.videoWidth || "?"}×${v.videoHeight || "?"}`,
                `FPS: ${fps ? Math.round(fps * 1000) / 1000 : "?"}${src}`,
                `${i18n("Duration", "Duración")}: ${fmtTime(v.duration)} · ${Number.isFinite(frames) ? frames : "?"} ${i18n("frames", "fotogramas")}`,
                `${i18n("Frame", "Fotograma")}: ${Number.isFinite(curF) ? curF : "?"}${Number.isFinite(last) ? " / " + last : ""} · ${fmtTime(v.currentTime)}`,
                `${i18n("Speed", "Velocidad")}: ${(v.playbackRate || 1).toFixed(2)}×${v.paused ? i18n(" (paused)", " (en pausa)") : ""}`,
                `Zoom: ${(V.modules.zoom ? V.modules.zoom.level(v) : 1).toFixed(1)}×`,
                `${i18n("Volume", "Volumen")}: ${v.muted ? i18n("muted", "silenciado") : Math.round(v.volume * 100) + " %"}`,
                `${i18n("Loop", "Bucle")}: ${loop}`,
            ];
            if (b) lines.push(`${i18n("File size", "Tamaño")}: ${fmtSize(b)}`);
            return lines.join("\n");
        }
        function place(v) {
            const fs = core.fsElement(), host = fs || document.body;
            if (!panel) {
                panel = document.createElement("div");
                panel.className = "vidosser-info";
                panel.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;background:rgba(0,0,0,.72);color:#fff;" +
                    "font:600 13px/1.4 ui-monospace,Consolas,monospace;padding:6px 10px;border-radius:6px;white-space:pre;max-width:60vw;overflow:hidden;";
            }
            if (panel.parentNode !== host) host.appendChild(panel);
            const r = v.getBoundingClientRect();
            let x = r.left, y = r.top, w = r.width;
            if (v.videoWidth && v.videoHeight) {
                const k = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
                x += (r.width - v.videoWidth * k) / 2; y += (r.height - v.videoHeight * k) / 2; w = v.videoWidth * k;
            }
            panel.style.display = "block";
            panel.style.top = Math.round(y + 8) + "px";
            panel.style.left = Math.round(x + w - 8 - panel.offsetWidth) + "px";
        }
        function update() {
            const v = shown;
            if (!v) return;
            if (!v.isConnected) { hide(); return; }
            const t = text(v);
            if (core.fsElement() === v) {                                // native fullscreen: subtitle cue
                if (panel) panel.style.display = "none";
                const tr = [...v.textTracks].find(x => x.label === "Vidosser");
                const cur = tr && tr.cues && tr.cues.length ? tr.cues[tr.cues.length - 1].text : "";
                if (t !== lastText || cur !== t || (tr && tr.mode !== "showing")) { core.nativeOsd(v, t, true); lastText = t; }   // (a short overlay may have replaced it)
                return;
            }
            if (lastText) { core.clearOsd(v); lastText = ""; }
            if (!panel || panel.textContent !== t) { place(v); panel.textContent = t; }
            place(v);
        }
        function show(v) {
            if (shown && shown !== v) core.clearOsd(shown);
            shown = v; lastText = "";
            core.ensureFps(v);
            update();
            clearInterval(timer);
            timer = setInterval(update, 250);
        }
        function hide() {
            clearInterval(timer); timer = 0;
            if (shown) core.clearOsd(shown);
            shown = null; lastText = "";
            if (panel) panel.style.display = "none";
        }
        core.registerAction("toggle_info", v => { if (shown === v) hide(); else show(v); });
        // Esc closes the panel only (Gradio's gallery would also close its preview)
        window.addEventListener("keydown", e => { if (e.key === "Escape" && shown) { hide(); e.preventDefault(); e.stopPropagation(); } }, true);
        document.addEventListener("fullscreenchange", () => { if (shown) { lastText = ""; setTimeout(update, 50); } });
        return { shown: () => shown, text: v => text(v), show, hide };
    })(core);

    console.log(`[Vidosser] v${VERSION} loaded - modules: ${Object.keys(V.modules).filter(k => V.modules[k]).join(", ")}`);
})();
