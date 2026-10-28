#!/usr/bin/env python3
"""
agnes_server.py — tiny local web UI + API proxy for Agnes AI video generation.

Why a server instead of calling the API straight from the browser?
  * no CORS problems,
  * your API key never has to be typed into a random web page's JS state,
  * the "Download" button always works because the mp4 is streamed through us.

Run:
    python3 agnes_server.py                 # http://localhost:8777
    python3 agnes_server.py --port 9000

Then open the URL it prints, paste your key, write a prompt, hit Generate.
The key can also come from AGNES_API_KEY or a .env file, in which case you
never have to type it at all.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import agnes_api as api  # noqa: E402

WEB_DIR = HERE / "web"

# Key pasted in the browser lives here, in memory only — never written to disk.
_RUNTIME_KEY: str | None = None
_KEY_LOCK = threading.Lock()

# Only URLs the API actually handed us may be proxied back out (no open proxy).
_SEEN_VIDEO_URLS: set[str] = set()
_SEEN_LOCK = threading.Lock()


def current_key() -> str | None:
    with _KEY_LOCK:
        return _RUNTIME_KEY or (os.environ.get("AGNES_API_KEY") or "").strip() or None


def set_key(key: str | None) -> None:
    global _RUNTIME_KEY
    with _KEY_LOCK:
        _RUNTIME_KEY = (key or "").strip() or None


def remember_url(url: str | None) -> None:
    if url:
        with _SEEN_LOCK:
            _SEEN_VIDEO_URLS.add(url)


def url_allowed(url: str) -> bool:
    with _SEEN_LOCK:
        return url in _SEEN_VIDEO_URLS


class Handler(BaseHTTPRequestHandler):
    server_version = "AgnesVideoUI/1.0"
    protocol_version = "HTTP/1.1"

    # ---------------------------------------------------------------- helpers
    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: pathlib.Path, content_type: str) -> None:
        if not path.is_file():
            self._send_json({"error": "not found"}, 404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValueError(f"invalid JSON body: {exc}") from exc

    def log_message(self, fmt: str, *args) -> None:  # quieter logs
        sys.stderr.write("  %s\n" % (fmt % args))

    # ------------------------------------------------------------------ routes
    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        route = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if route in ("/", "/index.html"):
            self._send_file(WEB_DIR / "index.html", "text/html; charset=utf-8")
        elif route == "/app.js":
            self._send_file(WEB_DIR / "app.js", "text/javascript; charset=utf-8")
        elif route == "/style.css":
            self._send_file(WEB_DIR / "style.css", "text/css; charset=utf-8")
        elif route == "/api/health":
            self._send_json({
                "ok": True,
                "key_configured": bool(current_key()),
                "base_url": api.base_url(),
                "model": api.DEFAULT_MODEL,
                "sizes": list(api.SUPPORTED_SIZES),
                "aspects": list(api.SUPPORTED_ASPECTS),
            })
        elif route == "/api/models":
            key = current_key()
            if not key:
                self._send_json({"error": "Add your API key first."}, 400)
                return
            try:
                self._send_json(api.list_models(key))
            except api.AgnesError as exc:
                self._send_json({"error": str(exc), "status": exc.status}, 502)
        elif route == "/api/tasks":
            self._poll(query)
        elif route == "/api/file":
            self._proxy_file(query)
        else:
            self._send_json({"error": "not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        route = urllib.parse.urlsplit(self.path).path
        try:
            body = self._read_json()
        except ValueError as exc:
            self._send_json({"error": str(exc)}, 400)
            return

        if route == "/api/key":
            self._save_key(body)
        elif route == "/api/tasks":
            self._create(body)
        else:
            self._send_json({"error": "not found"}, 404)

    # ------------------------------------------------------------- endpoints
    def _save_key(self, body: dict) -> None:
        key = (body.get("key") or "").strip()
        if not key:
            set_key(None)
            self._send_json({"ok": True, "key_configured": False})
            return
        try:
            models = api.list_models(key)
        except api.AgnesError as exc:
            self._send_json({"error": f"That key was rejected. {exc}"}, 400)
            return
        set_key(key)
        self._send_json({"ok": True, "key_configured": True, "models": models})

    def _create(self, body: dict) -> None:
        key = current_key()
        if not key:
            self._send_json({"error": "Add your API key first."}, 400)
            return
        try:
            payload = api.build_payload(
                prompt=body.get("prompt", ""),
                model=body.get("model") or api.DEFAULT_MODEL,
                mode=body.get("mode") or "text",
                seconds=str(body.get("seconds") or "5"),
                size=body.get("size") or "720P",
                aspect_ratio=body.get("aspect_ratio") or "16:9",
                seed=body.get("seed"),
                first_frame=body.get("first_frame") or None,
                last_frame=body.get("last_frame") or None,
                images=body.get("images") or [],
                audios=body.get("audios") or [],
                videos=body.get("videos") or [],
            )
        except api.AgnesError as exc:
            self._send_json({"error": str(exc)}, 400)
            return

        try:
            task = api.create_task(payload, key)
        except api.AgnesError as exc:
            self._send_json({"error": str(exc), "status": exc.status}, 502)
            return

        try:
            video_id, model_name = api.task_ids(task)
        except api.AgnesError as exc:
            self._send_json({"error": str(exc), "raw": task}, 502)
            return

        remember_url(api.snapshot(task)["video_url"])
        self._send_json({
            "ok": True,
            "video_id": video_id,
            "model_name": model_name,
            "sent": payload,
            "raw": task,
        })

    def _poll(self, query: dict) -> None:
        video_id = (query.get("video_id") or [""])[0].strip()
        model_name = (query.get("model_name") or [api.DEFAULT_MODEL])[0].strip()
        if not video_id:
            self._send_json({"error": "video_id is required"}, 400)
            return
        key = current_key()
        if not key:
            self._send_json({"error": "Add your API key first."}, 400)
            return
        try:
            task = api.get_task(video_id, model_name, key)
        except api.AgnesError as exc:
            self._send_json({"error": str(exc), "status": exc.status}, 502)
            return

        info = api.snapshot(task)
        remember_url(info["video_url"])
        self._send_json({
            "status": info["status"],
            "progress": info["progress"],
            "video_url": info["video_url"],
            "error": info["error"],
            "raw": task,
        })

    def _proxy_file(self, query: dict) -> None:
        """Stream a finished video through us so the browser can save it."""
        target = (query.get("url") or [""])[0]
        if not target or not url_allowed(target):
            self._send_json({"error": "unknown video url"}, 403)
            return
        name = re.sub(r'[^A-Za-z0-9_.-]', "_", target.split("?")[0].rsplit("/", 1)[-1] or "video.mp4")
        if not name.lower().endswith((".mp4", ".webm", ".mov")):
            name += ".mp4"

        headers = {"User-Agent": "agnes-video-ui/1.0"}
        key = current_key()
        if key:
            headers["Authorization"] = f"Bearer {key}"
        try:
            upstream = urllib.request.urlopen(
                urllib.request.Request(target, headers=headers), timeout=180
            )
        except (urllib.error.URLError, urllib.error.HTTPError) as exc:
            self._send_json({"error": f"could not fetch the video: {exc}"}, 502)
            return

        with upstream:
            length = upstream.headers.get("Content-Length")
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Content-Disposition", f'attachment; filename="{name}"')
            if length:
                self.send_header("Content-Length", str(length))
            else:
                self.send_header("Connection", "close")
            self.end_headers()
            try:
                while True:
                    chunk = upstream.read(262_144)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Local web UI for Agnes AI video generation.")
    parser.add_argument("--port", type=int, default=8777)
    parser.add_argument("--host", default="0.0.0.0")
    args = parser.parse_args()

    api.load_dotenv(HERE / ".env")

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    shown = "localhost" if args.host in ("0.0.0.0", "::") else args.host
    print("Agnes video studio")
    print(f"  → http://{shown}:{args.port}")
    print(f"  base url : {api.base_url()}")
    print(f"  api key  : {'from environment/.env' if current_key() else 'not set — paste it in the page'}")
    print("  Ctrl-C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
