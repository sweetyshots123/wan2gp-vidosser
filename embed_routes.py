"""Vidosser as a reusable module for other pages (1.4.24).

Routes added to WanGP's FastAPI app (behind WanGP's login check when auth is on):
  GET  /vidosser/vidosser.js   the exact script WanGP injects (build_js(): vidosser.js + settings.json),
                               rebuilt from the plugin folder on every request -> edits apply on page reload
  POST /vidosser/bridge        JSON body -> the same handler as the Vidosser tab bridge (save_frame, export_gif)
  GET  /vidosser/info          {"ok", "version", "settings"}

Use from any page served by WanGP:  <script src="/vidosser/vidosser.js"></script>
It enhances every <video> on the page (same features and settings as in WanGP); see README "Embedding"."""

import json

_installed = False
_plugin = None


def set_plugin(plugin) -> None:
    global _plugin
    _plugin = plugin


def mount(app, dependencies=None) -> None:
    from fastapi import APIRouter, Request
    from fastapi.responses import JSONResponse, Response
    from starlette.concurrency import run_in_threadpool
    from . import plugin as P

    r = APIRouter(dependencies=dependencies or [])
    nocache = {"Cache-Control": "no-cache"}

    @r.get("/vidosser/vidosser.js")
    async def script():
        js = 'window.__VIDOSSER_HTTP_BRIDGE = "/vidosser/bridge";\n' + P.build_js(quiet=True)
        return Response(js, media_type="application/javascript; charset=utf-8", headers=nocache)

    @r.get("/vidosser/info")
    async def info():
        return JSONResponse({"ok": True, "version": P.PLUGIN_VERSION, "settings": P.load_settings()}, headers=nocache)

    @r.post("/vidosser/bridge")
    async def bridge(request: Request):
        if _plugin is None:
            return JSONResponse({"ok": False, "error": "Vidosser not loaded"}, status_code=503)
        raw = (await request.body()).decode("utf-8", "replace")
        out = await run_in_threadpool(_plugin._bridge, raw)
        return Response(out, media_type="application/json")

    app.include_router(r)


def install() -> None:
    """Patch gradio's App.create_app (same pattern as WanGP's Deepy routes) so the routes exist on WanGP's app."""
    global _installed
    if _installed:
        return
    from gradio.routes import App
    original = App.create_app

    def create_app(*args, **kwargs):
        app = original(*args, **kwargs)
        deps = None
        try:
            from fastapi import Depends
            from gradio.routes import API_PREFIX
            try:
                from shared.utils.fastapi_routes import iter_app_routes
            except Exception:
                iter_app_routes = lambda a: a.routes
            check = next((rt.endpoint for rt in iter_app_routes(app) if getattr(rt, "path", None) == f"{API_PREFIX}/login_check"), None)
            deps = [Depends(check)] if check else None
        except Exception:
            deps = None
        try:
            mount(app, deps)
            print("[Vidosser] embeddable player: /vidosser/vidosser.js")
        except Exception as e:
            print(f"[Vidosser] embed routes not available: {e}")
        return app

    App.create_app = staticmethod(create_app)
    _installed = True
