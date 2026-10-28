"""
Shared client for the Agnes AI video API.

Docs: https://agnes-ai.com/en/docs/agnes-video-25  (and /agnes-video-25-flash)

Flow is asynchronous:
  1. POST {BASE}/v1/videos          -> creates a task, returns `video_id`
  2. GET  {BASE}/agnesapi?video_id=...&model_name=...  -> status / progress / video_url

Standard library only, so there is nothing to install.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_BASE_URL = "https://apihub.agnes-ai.com"
DEFAULT_MODEL = "agnes-video-2.5-flash"

# Model ids we know about, with the defaults each one accepts.
MODELS = {
    "agnes-video-2.5-flash": {"size": "720P", "max_seconds": "12"},
    "agnes-video-2.5": {"size": "720P", "max_seconds": "12"},
    "agnes-video-v2.0": {"size": "720P", "max_seconds": "5"},
}

SUPPORTED_SIZES = ("720P", "1080P", "1K", "2K")
SUPPORTED_ASPECTS = ("16:9", "9:16", "1:1", "4:3", "3:4", "21:9")


class AgnesError(RuntimeError):
    """Anything that went wrong while talking to the API."""

    def __init__(self, message: str, status: int | None = None, body: str | None = None):
        super().__init__(message)
        self.status = status
        self.body = body


# --------------------------------------------------------------------------- #
# config helpers
# --------------------------------------------------------------------------- #
def load_dotenv(path: str | os.PathLike = ".env") -> None:
    """Minimal .env loader (KEY=VALUE, # comments). Does not overwrite real env vars."""
    p = pathlib.Path(path)
    if not p.is_file():
        return
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def resolve_api_key(explicit: str | None = None) -> str:
    key = (explicit or os.environ.get("AGNES_API_KEY") or "").strip()
    if not key:
        raise AgnesError(
            "No API key found. Set AGNES_API_KEY, put it in agnes-video/.env, "
            "or pass --key."
        )
    return key


def base_url() -> str:
    return (os.environ.get("AGNES_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


# --------------------------------------------------------------------------- #
# http
# --------------------------------------------------------------------------- #
def _http(method: str, url: str, key: str | None, payload: dict | None = None,
          timeout: float = 90.0) -> tuple[int, bytes, dict]:
    data = None
    headers = {"Accept": "application/json", "User-Agent": "agnes-video-cli/1.0"}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if key:
        headers["Authorization"] = f"Bearer {key}"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as exc:
        body = exc.read()
        return exc.code, body, dict(exc.headers or {})
    except urllib.error.URLError as exc:
        raise AgnesError(
            f"Could not reach {urllib.parse.urlsplit(url).netloc}: {exc.reason}. "
            "Check your internet connection (and, if you are inside a locked-down "
            "sandbox, that outbound HTTPS is allowed)."
        ) from exc
    except TimeoutError as exc:
        raise AgnesError(f"Request to {url} timed out.") from exc


def _json_or_error(status: int, body: bytes, what: str) -> dict:
    text = body.decode("utf-8", "replace")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None

    if status >= 400 or parsed is None:
        snippet = text.strip()[:600] or "(empty response)"
        hint = ""
        if status == 401:
            hint = " — the API key looks wrong or has been revoked."
        elif status == 403:
            hint = " — key is valid but not allowed to use this model."
        elif status == 429:
            hint = " — rate limited (16 requests/minute). Retrying helps."
        elif status == 400:
            hint = " — one of the request fields was rejected."
        raise AgnesError(f"{what} failed: HTTP {status}{hint}\n{snippet}",
                         status=status, body=text)
    return parsed


# --------------------------------------------------------------------------- #
# payload
# --------------------------------------------------------------------------- #
def build_payload(
    prompt: str,
    model: str = DEFAULT_MODEL,
    mode: str = "text",
    seconds: str | int = "5",
    size: str = "720P",
    aspect_ratio: str = "16:9",
    seed: int | None = None,
    first_frame: str | None = None,
    last_frame: str | None = None,
    images: list[str] | None = None,
    audios: list[str] | None = None,
    videos: list[str] | None = None,
) -> dict:
    """Assemble (and lightly validate) a /v1/videos request body."""
    prompt = (prompt or "").strip()
    if not prompt:
        raise AgnesError("A prompt is required.")
    if mode not in ("text", "keyframe", "reference"):
        raise AgnesError(f"mode must be text, keyframe or reference (got {mode!r}).")

    images = [u for u in (images or []) if u]
    audios = [u for u in (audios or []) if u]
    videos = [u for u in (videos or []) if u]

    payload: dict = {
        "model": model,
        "prompt": prompt,
        "mode": mode,
        "seconds": str(seconds),
        "size": size,
        "aspect_ratio": aspect_ratio,
    }
    if seed is not None:
        payload["seed"] = int(seed)

    if model not in MODELS:
        print(f"! Unknown model {model!r} — sending it anyway.", file=sys.stderr)

    if model == "agnes-video-2.5-flash" and size != "720P":
        raise AgnesError("agnes-video-2.5-flash only supports size 720P.")
    if size not in SUPPORTED_SIZES:
        raise AgnesError(f"size must be one of {', '.join(SUPPORTED_SIZES)}.")
    try:
        secs = int(str(seconds))
    except ValueError as exc:
        raise AgnesError("seconds must be a whole number, e.g. 5.") from exc
    if model.startswith("agnes-video-2.5") and not 4 <= secs <= 12:
        raise AgnesError("agnes-video-2.5 supports 4–12 seconds.")

    if mode == "keyframe":
        if not (first_frame or last_frame):
            raise AgnesError("keyframe mode needs --first-frame and/or --last-frame.")
        if first_frame:
            payload["first_frame"] = first_frame
        if last_frame:
            payload["last_frame"] = last_frame
    elif mode == "reference":
        if not (images or audios or videos):
            raise AgnesError("reference mode needs at least one --image/--audio/--video.")
        if images:
            payload["images"] = images
        if audios:
            payload["audios"] = audios
        if videos:
            payload["videos"] = videos
    else:  # text
        for stray in ("first_frame", "last_frame"):
            if payload.get(stray):
                raise AgnesError(f"{stray} is not allowed in text mode; use --mode keyframe.")

    return payload


# --------------------------------------------------------------------------- #
# endpoints
# --------------------------------------------------------------------------- #
def create_task(payload: dict, key: str | None = None, retries: int = 3) -> dict:
    """POST /v1/videos and return the raw task JSON."""
    key = key or resolve_api_key()
    url = f"{base_url()}/v1/videos"
    last: AgnesError | None = None
    for attempt in range(retries):
        status, body, _ = _http("POST", url, key, payload)
        if status == 429 and attempt < retries - 1:
            last = AgnesError("rate limited", status=429, body=body.decode("utf-8", "replace"))
            time.sleep(2 ** (attempt + 1))
            continue
        return _json_or_error(status, body, "Creating the video task")
    raise last or AgnesError("Creating the video task failed.")


def get_task(video_id: str, model_name: str | None = DEFAULT_MODEL,
             key: str | None = None) -> dict:
    """GET /agnesapi for one task snapshot."""
    key = key or resolve_api_key()
    params = {"video_id": video_id}
    if model_name:
        params["model_name"] = model_name
    url = f"{base_url()}/agnesapi?{urllib.parse.urlencode(params)}"
    status, body, _ = _http("GET", url, key)
    if status in (400, 404) and model_name:
        # Some older deployments only accept video_id.
        url = f"{base_url()}/agnesapi?{urllib.parse.urlencode({'video_id': video_id})}"
        status, body, _ = _http("GET", url, key)
    return _json_or_error(status, body, "Checking the video task")


def list_models(key: str | None = None) -> dict:
    key = key or resolve_api_key()
    status, body, _ = _http("GET", f"{base_url()}/v1/models", key)
    return _json_or_error(status, body, "Listing models")


# --------------------------------------------------------------------------- #
# response inspection
# --------------------------------------------------------------------------- #
def find_first(obj, keys, max_depth: int = 6):
    """Find the first non-empty scalar for the highest-priority key in `keys`.

    Keys are tried in the order given (so "video_id" beats a generic "id"),
    and within each key the response tree is searched breadth-first.
    """
    for wanted in keys:
        wanted = wanted.lower()
        queue: list[tuple[object, int]] = [(obj, 0)]
        while queue:
            node, depth = queue.pop(0)
            if depth > max_depth:
                continue
            if isinstance(node, dict):
                for k, v in node.items():
                    if (k.lower() == wanted and isinstance(v, (str, int, float))
                            and str(v).strip()):
                        return v
                queue.extend((v, depth + 1) for v in node.values()
                             if isinstance(v, (dict, list)))
            elif isinstance(node, list):
                queue.extend((v, depth + 1) for v in node if isinstance(v, (dict, list)))
    return None


def task_ids(task: dict) -> tuple[str, str]:
    video_id = find_first(task, ["video_id", "videoId", "task_id", "taskId", "id"])
    model = find_first(task, ["model", "model_name"])
    if not video_id:
        raise AgnesError(f"The API did not return a video id: {json.dumps(task)[:500]}")
    return str(video_id), (str(model) if model else DEFAULT_MODEL)


def looks_done(status: str | None) -> bool:
    return (status or "").lower() in ("completed", "complete", "succeeded", "success", "done")


def looks_failed(status: str | None) -> bool:
    return (status or "").lower() in ("failed", "failure", "error", "cancelled", "canceled", "rejected")


def snapshot(task: dict) -> dict:
    """Normalise any shape of task response into status/progress/url/error."""
    status = find_first(task, ["status", "state", "task_status"])
    status = str(status).lower() if status else "unknown"

    progress = find_first(task, ["progress", "percent", "percentage"])
    try:
        progress = float(str(progress).rstrip("%"))
    except (TypeError, ValueError):
        progress = 100.0 if looks_done(status) else 0.0

    url = None
    for keys in (["video_url", "videoUrl", "download_url", "downloadUrl", "video"],
                 ["url", "file_url", "fileUrl", "output", "result_url"]):
        candidate = find_first(task, keys)
        if candidate and str(candidate).startswith("http"):
            url = str(candidate)
            break

    error = None
    if looks_failed(status):
        error = find_first(task, ["error", "fail_reason", "error_message", "reason", "message"])
        error = str(error) if error else "generation failed"

    return {"status": status, "progress": progress, "video_url": url, "error": error}


def wait_for_video(video_id: str, model_name: str = DEFAULT_MODEL, key: str | None = None,
                   poll_interval: float = 10.0, timeout: float = 900.0,
                   on_update=None) -> dict:
    """Poll /agnesapi until the job finishes. Returns the final normalised snapshot."""
    key = key or resolve_api_key()
    start = time.time()
    delay = max(2.0, poll_interval)

    while True:
        task = get_task(video_id, model_name, key)
        info = snapshot(task)
        if on_update:
            on_update(info)
        if looks_done(info["status"]) and (info["video_url"] or True):
            return {**info, "raw": task}
        if looks_failed(info["status"]):
            raise AgnesError(f"Generation failed: {info['error']}", body=json.dumps(task))
        if time.time() - start > timeout:
            raise AgnesError(
                f"Timed out after {int(timeout)}s waiting for {video_id} "
                f"(last status: {info['status']}, {info['progress']:.0f}%)."
            )
        time.sleep(delay)
        delay = min(delay * 1.25, max(poll_interval, 20.0))


# --------------------------------------------------------------------------- #
# download
# --------------------------------------------------------------------------- #
def download(url: str, dest: str | os.PathLike, key: str | None = None) -> pathlib.Path:
    dest = pathlib.Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    headers = {"User-Agent": "agnes-video-cli/1.0"}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=180) as resp, open(dest, "wb") as fh:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = resp.read(262_144)
                if not chunk:
                    break
                fh.write(chunk)
                done += len(chunk)
                if total and sys.stderr.isatty():
                    pct = done * 100 / total
                    sys.stderr.write(f"\r  downloading {pct:5.1f}%  ({done/1e6:.1f} MB)")
                    sys.stderr.flush()
    except urllib.error.HTTPError as exc:
        raise AgnesError(f"Download failed: HTTP {exc.code} for {url}") from exc
    except urllib.error.URLError as exc:
        raise AgnesError(f"Download failed: {exc.reason}") from exc
    if sys.stderr.isatty():
        sys.stderr.write("\n")
    return dest
