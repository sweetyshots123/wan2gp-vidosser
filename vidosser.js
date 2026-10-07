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
//                       * next_frame / prev_frame (S / A), jump_forward / jump_back
//                         (W / Q: jump_seconds converted with the video fps, or jump_frames)
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
                 registerAction, bridge, bridgeResponse,
                 middlePress: null };                  // video under an ongoing middle-button press (save_frame)
    })(Object.assign({
        default_fps: 16,          // fallback when fps cannot be detected (Wan = 16, LTX = 24/25...)
        min_video_size: 100,      // ignore smaller videos (thumbnails), px
        show_overlay: true,
        overlay_ms: 1200,
    }, SETTINGS.general || {}), Object.assign({
        enabled: true,            // keyboard shortcuts on/off
        next_frame: "s",
        prev_frame: "a",
        jump_forward: "w",
        jump_back: "q",
        save_frame_as: "d",
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
        const acc = { tick: 0, px: 0, last: 0 };
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
            if (now - acc.last > 800) { acc.tick = 0; acc.px = 0; }          // forget stale fractions
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
                              : Math.floor(video.currentTime * fps + 1e-6); // resync (user played / scrubbed)
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
        function onWheel(e) {
            if (CFG.enabled === false || !CFG.wheel_enabled) return;
            // wheel_fullscreen_only: outside fullscreen the wheel is left completely alone (page scroll)
            if (CFG.wheel_fullscreen_only && !core.fsElement()) return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;            // keep browser zoom etc.
            const video = core.videoForPointerEvent(e);
            if (!video) return;
            e.preventDefault();                                         // never scroll the page over a video
            e.stopPropagation();
            if (core.middlePress) return;   // wheel nudged while clicking it: don't move away from the frame being saved
            let notches = countNotches(e);
            if (!notches) return;
            if (CFG.invert_direction) notches = -notches;
            queueSteps(video, notches * (e.shiftKey ? Math.max(1, Math.round(CFG.shift_frames)) : 1), 0);
        }

        // ------------------------------------------------------- keyboard
        core.registerAction("next_frame", v => { if (CFG.enabled !== false) queueSteps(v, 1, 0); });
        core.registerAction("prev_frame", v => { if (CFG.enabled !== false) queueSteps(v, -1, 0); });
        core.registerAction("jump_forward", v => { if (CFG.enabled !== false) queueSteps(v, 0, 1); });
        core.registerAction("jump_back", v => { if (CFG.enabled !== false) queueSteps(v, 0, -1); });

        window.addEventListener("wheel", onWheel, { capture: true, passive: false });

        return {
            config: CFG,
            info: v => { const i = core.getInfo(v), s = stepState(v); return { fps: i.fps, source: i.fpsSource, frames: i.frames, target: s.target }; },
            step: (v, n) => queueSteps(v, n | 0, 0),
            jump: (v, n) => queueSteps(v, 0, n | 0),
            target: () => core.videoForKeyboard(),
        };
    })(core, V.config.frame_step = Object.assign({
        enabled: true,
        wheel_enabled: true,
        wheel_fullscreen_only: true,  // wheel steps only while a video (or its container) is fullscreen
        shift_frames: 10,
        invert_direction: false,
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
                    return res;
                }
                let blob, name, frame;
                if (res.ok) { blob = b64ToBlob(res.data, res.mime); name = res.name; frame = res.frame; }
                else {
                    frame = Math.floor(t * info.fps + 1e-6);
                    name = `${stemFromUrl(video.currentSrc)}_frame${String(frame).padStart(5, "0")}.${ext()}`;
                    try { blob = await canvasCapture(video); }
                    catch (err) { core.showOverlay(video, `Error al guardar: ${res.error || err.message}`); return res; }
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
                        return { ok: true, frame, name: handle.name, via: "picker" };
                    } catch (err) {
                        if (err && err.name === "AbortError") { core.showOverlay(video, "Cancelado"); return { ok: false, cancelled: true }; }
                        // no user activation left / API refused: fall back to a normal download
                    }
                }
                download(blob, name);
                core.showOverlay(video, `Guardado frame ${frame} (descarga): ${name}`);
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
    }, SETTINGS.save_frame || {}));

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
