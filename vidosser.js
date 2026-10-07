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
//                       * wheel_jump_modifier (Ctrl) + wheel = one short jump per notch
//                       * next_frame / prev_frame (S / A), jump_forward / jump_back
//                         (W / Q: jump_seconds converted with the video fps, or jump_frames)
//   MODULE container_fs video fullscreen on a container (not native) so overlays/toasts show
//   MODULE loop         loop all videos, loop toggle (L), A-B segment loop (I / O, U = clear)
//   MODULE save_frame   save_frame_as (D, or middle click on the video): saves the displayed frame (PNG/JPG), extracted
//                       server-side from the source video (lossless, exact frame),
//                       either with a "save as" dialog or straight into a folder.
// Settings come from settings.json (injected below by plugin.py, refreshed on page
// load and after "Save" in the Vidosser tab): "general", "keys" + one section per module.
// ===========================================================================
(function () {
    "use strict";
    if (window.__vidosser) return;
    const SETTINGS = __VIDOSSER_SETTINGS__ || {};
    const VERSION = "__VIDOSSER_VERSION__";
    const V = window.__vidosser = { version: VERSION, settings: SETTINGS, core: null, modules: {} };

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
        function showOverlay(video, text) {
            if (!CFG.show_overlay) return;
            const fs = fsElement();
            if (fs === video) return;              // native <video> fullscreen: nothing can be drawn above it
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
                if (!el) { const err = new Error("Vidosser bridge not available"); err.bridgeMissing = true; reject(err); return; }
                const id = `${Date.now()}-${++seq}`;
                const timer = setTimeout(() => { pending.delete(id); reject(new Error("timeout")); }, timeoutMs);
                pending.set(id, { resolve, timer });
                el.req.value = JSON.stringify(Object.assign({}, payload, { id }));
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
                 videoForKeyboard, touch, typingOrModal, showOverlay, fpsLabel, settled, seekTo, seekPending,
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
        mark_in: "i",
        mark_out: "o",
        clear_segment: "u",
    }, SETTINGS.keys || {}));
    V.core = core;
    V.config = { general: core.CFG, keys: core.KEYS };

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
            const label = s.pendingJumps && !s.pending ? `jump ${s.pendingJumps > 0 ? "+" : "-"}${Math.abs(s.pendingJumps) * jump} fr` +
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
            const target = Math.max(0, Math.min(last, base + n));
            let t = (target + 0.5) / fps;                                // middle of the frame: no rounding ambiguity
            const dur = video.duration;
            if (Number.isFinite(dur) && dur > 0) t = Math.min(t, Math.max(0, dur - 0.001));
            core.seekTo(video, t);                                      // queued: latest target wins, nothing dropped
            s.target = target; s.targetFps = fps; s.lastSetTime = t;
            core.showOverlay(video, `Frame ${target}` + (Number.isFinite(last) ? ` / ${last}` : "") +
                `  ·  ${core.fpsLabel(info)}` + (label ? `  ·  ${label}` : ""));
        }

        function queueSteps(video, frames, jumps) {
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
        // (default Ctrl): 1 notch = 1 short jump (same amount as Q / W). The jump modifier
        // wins over the Shift multiplier when both are "shift". Any other Ctrl/Alt/Meta
        // combination is left to the browser (zoom...), and so is everything that does not
        // act on a video (no preventDefault -> Ctrl+wheel zoom keeps working elsewhere).
        function onWheel(e) {
            if (CFG.enabled === false || !CFG.wheel_enabled) return;
            // wheel_fullscreen_only: outside fullscreen the wheel is left completely alone (page scroll / zoom)
            if (CFG.wheel_fullscreen_only && !core.fsElement()) return;
            const jm = jumpModifier();
            const jump = !!jm && e[MODIFIERS[jm]];
            if (!jump && (e.ctrlKey || e.metaKey || e.altKey)) return;  // keep browser zoom etc.
            const video = core.videoForPointerEvent(e);
            if (!video) return;
            e.preventDefault();                                         // no page scroll / zoom over a video we act on
            e.stopPropagation();
            if (core.middlePress) return;   // wheel nudged while clicking it: don't move away from the frame being saved
            const pinch = jm === "ctrl" && e.ctrlKey && !ctrlDown && !e.metaKey;
            let notches = pinch ? countPinchNotches(e) : countNotches(e);
            if (!notches) return;
            if (CFG.invert_direction) notches = -notches;
            if (jump) queueSteps(video, 0, notches);
            else queueSteps(video, notches * (e.shiftKey ? Math.max(1, Math.round(CFG.shift_frames)) : 1), 0);
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
        const DRAG_THRESHOLD = 4, CONTROLS_PX = 40;
        let drag = null, swallowClickUntil = 0, swallowClickOn = null, swallowMenuUntil = 0;
        const dragButton = () => String(CFG.drag_button || "left").toLowerCase() === "right" ? 2 : 0;
        function dragUnit(e) {
            const jm = jumpModifier();
            if (jm && e[MODIFIERS[jm]]) return { frames: 0, jumps: 1 };
            if (e.shiftKey) return { frames: Math.max(1, Math.round(CFG.shift_frames)), jumps: 0 };
            return { frames: 1, jumps: 0 };
        }
        function onDragDown(e) {
            if (drag) endDrag("stale", false);                          // a release we never saw: start clean
            swallowClickUntil = 0; swallowMenuUntil = 0;                // a new press: an expected click/menu never came (pointer lock)
            if (CFG.enabled === false || CFG.drag_scrub === false) return;
            if (!e.isPrimary || (e.pointerType === "pen" && e.pressure === 0)) return;
            const button = e.pointerType === "touch" ? 0 : dragButton();     // a finger always scrubs
            if (e.button !== button) return;
            const v = e.target;
            if (!(v instanceof HTMLVideoElement) || !core.eligible(v, core.fsElement())) return;
            const jm = jumpModifier();
            if ((e.altKey && jm !== "alt") || (e.metaKey && jm !== "meta") || (e.ctrlKey && jm !== "ctrl")) return;
            if (v.controls) {                                            // native control bar / progress bar
                const r = v.getBoundingClientRect();
                if (e.clientY > r.bottom - CONTROLS_PX) return;
            }
            drag = { v, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, lock: null, active: false, done: 0, type: e.pointerType, button };
        }
        // Hidden cursor while scrubbing (drag_hide_cursor): class on <html> (covers every
        // element, also inside a fullscreen container), on the capturing video and on the
        // fullscreen element. Every way a drag can end goes through endDrag(), which always
        // removes the classes: pointerup / pointercancel / lostpointercapture / Escape /
        // window blur / tab hidden / fullscreen change / pointer lock lost / a move with no
        // button pressed (missed release).
        const cursorCss = document.createElement("style");
        cursorCss.textContent = "html.vidosser-scrubbing,html.vidosser-scrubbing *,.vidosser-scrub-el,.vidosser-scrub-el *{cursor:none!important}";
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
        // Pointer Lock (drag_pointer_lock, default on): the cursor disappears, can't hit the
        // screen edge and movementX keeps flowing (Chrome shows its "press Esc" banner). If
        // the lock is refused, the drag continues with pointer capture + hidden cursor.
        function startLock(d) {
            d.lock = "pending";
            d.lockBase = d.dx; d.mv = 0;          // Chrome freezes clientX as soon as the lock is requested: count movementX from here
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
            if (document.pointerLockElement === drag.v) { if (drag.lock === "pending") drag.lock = "on"; }
            else if (drag.lock === "on") endDrag("lock lost");            // Esc / focus loss ended the lock
        });
        document.addEventListener("pointerlockerror", () => { if (drag && drag.lock === "pending") { drag.lock = "failed"; capture(drag); } });

        function onDragMove(e) {
            if (!drag || e.pointerId !== drag.id) return;
            if (drag.active && e.buttons === 0 && e.pointerType === "mouse") { endDrag("no button"); return; }   // release was missed
            if (drag.lock === "on" || drag.lock === "pending") { drag.mv += e.movementX || 0; drag.dx = drag.lockBase + drag.mv; }
            else drag.dx = e.clientX - drag.x0;
            const dx = drag.dx, dy = e.clientY - drag.y0;
            if (!drag.active) {
                if (Math.abs(dy) >= DRAG_THRESHOLD && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }  // vertical: not ours
                if (Math.abs(dx) < DRAG_THRESHOLD) return;
                drag.active = true;
                if (CFG.drag_pointer_lock !== false && e.pointerType === "mouse" && drag.v.requestPointerLock) startLock(drag);
                else capture(drag);
                if (CFG.drag_hide_cursor !== false) hideCursor(drag.v);
                if (!drag.v.paused) drag.v.pause();
            }
            e.preventDefault();
            const ppf = Math.max(1, Number(CFG.drag_pixels_per_frame) || 8);
            let want = Math.trunc((CFG.drag_invert ? -dx : dx) / ppf);
            const n = want - drag.done;
            if (!n) return;
            drag.done = want;
            const u = dragUnit(e);
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
        window.addEventListener("click", swallowClick, true);
        window.addEventListener("selectstart", blockWhileDragging, true);
        window.addEventListener("dragstart", blockWhileDragging, true);
        // touch: let vertical panning scroll the page, horizontal moves reach the scrubber
        const touchCss = document.createElement("style");
        touchCss.textContent = "video.vidosser-drag-scrub{touch-action:pan-y pinch-zoom}";
        document.head.appendChild(touchCss);
        function markVideos() {
            const on = CFG.enabled !== false && CFG.drag_scrub !== false;
            document.querySelectorAll("video").forEach(v => v.classList.toggle("vidosser-drag-scrub", on));
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
            info: v => { const i = core.getInfo(v), s = stepState(v); return { fps: i.fps, source: i.fpsSource, frames: i.frames, target: s.target }; },
            step: (v, n) => queueSteps(v, n | 0, 0),
            jump: (v, n) => queueSteps(v, 0, n | 0),
            target: () => core.videoForKeyboard(),
        };
    })(core, V.config.frame_step = Object.assign({
        enabled: true,
        wheel_enabled: true,
        wheel_fullscreen_only: true,  // wheel steps only while a video (or its container) is fullscreen
        wheel_jump_modifier: "ctrl",  // modifier + wheel = one short jump per notch: ctrl | alt | shift | meta | none
        shift_frames: 10,
        invert_direction: false,
        drag_scrub: true,             // left-button drag on a video = scrub frames
        drag_pixels_per_frame: 8,
        drag_invert: false,           // false: drag right = forward
        drag_button: "left",          // "left" | "right"
        drag_pointer_lock: true,      // Pointer Lock while scrubbing (Chrome shows its "press Esc" banner)
        drag_hide_cursor: true,       // hide the cursor while scrubbing (fallback without pointer lock)
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
            if (!blob) throw new Error("canvas export failed");
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
            busy = true;
            try {
                if (!video.paused) video.pause();
                await core.settled(video);                              // exact frame on screen
                const info = await core.ensureFps(video);
                const t = video.currentTime;
                const mode = String(CFG.mode).toLowerCase() === "direct" ? "direct" : "ask";
                core.showOverlay(video, "Guardando frame...");
                let res;
                try { res = await core.bridge({ action: "save_frame", url: video.currentSrc, time: t, frame: Math.floor(t * info.fps + 1e-6), mode }); }
                catch (err) { res = { ok: false, error: err.message, bridgeMissing: !!err.bridgeMissing }; }
                if (mode === "direct") {
                    core.showOverlay(video, res.ok ? `Guardado: ${res.path}` : `Error al guardar: ${res.error}`);
                    if (res.ok) feedback(video, "ok", `Fotograma guardado (frame ${res.frame}): ${res.path}`);
                    else feedback(video, "error", `Error al guardar: ${res.error}`);
                    return res;
                }
                let blob, name, frame;
                if (res.ok) { blob = b64ToBlob(res.data, res.mime); name = res.name; frame = res.frame; }
                else {
                    frame = Math.floor(t * info.fps + 1e-6);
                    name = `${stemFromUrl(video.currentSrc)}_frame${String(frame).padStart(5, "0")}.${ext()}`;
                    try { blob = await canvasCapture(video); }
                    catch (err) {
                        core.showOverlay(video, `Error al guardar: ${res.error || err.message}`);
                        feedback(video, "error", `Error al guardar: ${res.error || err.message}`);
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
                        core.showOverlay(video, `Guardado frame ${frame}: ${handle.name}`);
                        feedback(video, "ok", `Fotograma guardado (frame ${frame}): ${handle.name}`);
                        return { ok: true, frame, name: handle.name, via: "picker" };
                    } catch (err) {
                        if (err && err.name === "AbortError") {
                            core.showOverlay(video, "Cancelado");
                            feedback(video, "info", `No guardado (cancelado): frame ${frame}`);
                            return { ok: false, cancelled: true };
                        }
                        // no user activation left / API refused: fall back to a normal download
                    }
                }
                download(blob, name);
                core.showOverlay(video, `Guardado frame ${frame} (descarga): ${name}`);
                feedback(video, "ok", `Fotograma descargado (frame ${frame}): ${name}`);
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
            if (!c) return nativeRequest.call(video);
            if (!c.classList.contains("gallery-container")) c.classList.add(CLS);
            core.touch(video);
            return nativeRequest.call(c);
        }

        // page-initiated requests on a <video> -> container
        const ownRequest = function (options) {
            return enabled(this) ? enter(this) : nativeRequest.call(this, options);
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
            }
        }, true);
        document.addEventListener("fullscreenchange", () => {
            const fs = core.fsElement();
            for (const el of document.querySelectorAll("." + CLS)) if (el !== fs) el.classList.remove(CLS);
        });
        return { config: GEN, containerFor, enter, nativeRequest };
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
            if (e.button !== 0 || !(v instanceof HTMLVideoElement) || !hiddenByUs(v) || e.defaultPrevented) return;
            toggle(v);
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
        const srcOf = v => v.currentSrc || v.src || "";

        function applyLoop(v) {
            if (!(v instanceof HTMLVideoElement)) return;
            if (!origLoop.has(v)) origLoop.set(v, v.loop);
            const src = srcOf(v);
            const want = override.has(src) ? override.get(src) : (CFG.enabled !== false && CFG.loop_all ? true : origLoop.get(v));
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
        applyAll();

        core.registerAction("toggle_loop", v => {
            if (CFG.enabled === false) return;
            const on = !v.loop;
            override.set(srcOf(v), on);
            applyLoop(v);
            core.toast(on ? "Bucle activado (este vídeo)" : "Bucle desactivado (este vídeo)", "info", 1800);
            core.showOverlay(v, on ? "Bucle: sí" : "Bucle: no");
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
            const label = which === "in" ? `Inicio de bucle: frame ${f}` : `Final de bucle: frame ${f}`;
            const tail = ready(s) ? `  ·  bucle ${s.in}–${s.out}${swapped ? " (intercambiados)" : ""}`
                : fresh ? `  ·  nuevo segmento (falta ${other === "out" ? "el final" : "el inicio"})` : "";
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
            core.toast("Bucle borrado", "info", 1800);
            core.showOverlay(v, "Bucle borrado");
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
            if (f > s.out || f < s.in) { seekIn(v, s, fps); return; }
            const rate = v.playbackRate || 1, fd = 1000 / fps / rate;
            const outEnds = (displayAt || performance.now()) + ((s.out + 1) / fps - mediaTime) * 1000 / rate;
            const margin = Math.min(0.45 * fd, 28);
            clearTimeout(timers.get(v));
            timers.set(v, setTimeout(() => {
                timers.delete(v);
                const s2 = segOf(v);
                if (ready(s2) && !v.paused) seekIn(v, s2, fps);
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
            v.addEventListener("play", () => {
                const s = segOf(v), info = core.getInfo(v);
                if (!ready(s) || !info.fps) return;
                const f = frameAt(v.currentTime, info.fps);
                if (f < s.in || f > s.out) seekIn(v, s, info.fps);   // play from outside the segment -> start at `in`
                else check(v, v.currentTime, performance.now());     // paused on `out`: no rVFC for that frame, arm the wrap now
            });
            v.addEventListener("ended", () => {                    // `out` = last frame: loop instead of stopping
                const s = segOf(v), info = core.getInfo(v);
                if (ready(s) && info.fps) { seekIn(v, s, info.fps); v.play().catch(() => {}); }
            });
        }
        document.addEventListener("play", e => { if (e.target instanceof HTMLVideoElement && segOf(e.target)) watch(e.target); }, true);

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
            onSettings: applyAll,
        };
    })(core, V.config.loop = Object.assign({
        enabled: true,
        loop_all: false,          // every <video> plays in loop
    }, SETTINGS.loop || {}));

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

    window.vidosser = V;                       // debug / scripting hook
    console.log(`[Vidosser] v${VERSION} loaded - modules: ${Object.keys(V.modules).filter(k => V.modules[k]).join(", ")}`);
})();
