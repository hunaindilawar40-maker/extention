# Agnes Studio — text → video

A tiny, dependency-free toolkit for the **Agnes AI** asynchronous video API
(`agnes-video-2.5-flash`, `agnes-video-2.5`, legacy `agnes-video-v2.0`).
Two ways to use it:

| | what | use it when |
|---|---|---|
| **Web UI** | `agnes_server.py` → a local page with prompt box, presets, live progress and a download button | you want to play with prompts |
| **CLI** | `agnes_video.py` → one command, saves an `.mp4` | scripting / batch jobs |

Both share `agnes_api.py` (pure Python standard library — nothing to `pip install`).

---

## 1. Get an API key

Sign in at <https://platform.agnes-ai.com>, create a key, then either

```bash
cd agnes-video
cp .env.example .env        # then paste the key into .env
```

or export it for the current shell:

```bash
export AGNES_API_KEY="your-key"
```

`.env` is git-ignored. The web UI can also take a key pasted into the page — it is
held in server memory only, never written to disk.

## 2. Run it

### Web UI

```bash
python3 agnes_server.py            # http://localhost:8777
python3 agnes_server.py --port 9000
```

Open the printed URL → paste the key once (or skip it if `.env` is set) → write a prompt →
**Generate video**. Progress polls every 6 s, then the clip plays inline with a
**Download mp4** button. Every clip you make this session is listed underneath with a
hover-scrubbing thumbnail.

The page never talks to Agnes directly: it calls `/api/*` on this local server, which
holds the key and streams the finished mp4 back for download. That dodges CORS and
keeps the key out of browser JavaScript.

### CLI

```bash
# defaults: agnes-video-2.5-flash, 5s, 720P, 16:9
python3 agnes_video.py --prompt "A fox trots through a misty bamboo grove at dawn"

# nicer quality, 8s
python3 agnes_video.py --model agnes-video-2.5 --size 1080P --seconds 8 \
    --prompt "Drone shot over a neon-lit street after rain, reflections, slow push-in"

# vertical for reels / shorts
python3 agnes_video.py --aspect-ratio 9:16 --seconds 6 --prompt "..."

# animate between two stills (first/last frame control)
python3 agnes_video.py --mode keyframe \
    --first-frame https://example.com/a.jpg \
    --last-frame  https://example.com/b.jpg \
    --prompt "The camera pushes in as day turns to night"

# image / audio / video references
python3 agnes_video.py --mode reference \
    --image https://example.com/logo.png --audio https://example.com/voice.mp3 \
    --prompt "<Picture 1> floats over <Audio 1> ambience, slow parallax"

# prompt from a file, custom output path, no download
python3 agnes_video.py --prompt-file ideas/lahore.txt --out out/lahore.mp4
python3 agnes_video.py -p "..." --no-download      # just print the URL
python3 agnes_video.py -p "..." --dry-run          # show the JSON body, spend nothing
```

Exit codes: `0` ok, `1` API/generation failure, `2` bad arguments.

## 3. What the API expects

```
POST {BASE}/v1/videos                → { video_id, id, model, status, progress, ... }
GET  {BASE}/agnesapi?video_id=<id>&model_name=<model>   → status / progress / video_url
```

`BASE` = `https://apihub.agnes-ai.com` (`AGNES_BASE_URL` overrides it, e.g. `https://apihub.agnes-ai.cn`).

| field | notes |
|---|---|
| `model` | `agnes-video-2.5-flash`, `agnes-video-2.5`, `agnes-video-v2.0` |
| `mode` | `text` (nothing else attached) · `keyframe` (needs `first_frame`/`last_frame`) · `reference` (needs `images`/`audios`/`videos`) |
| `seconds` | 4–12 for 2.5 models, string |
| `size` | `720P` `1080P` `1K` `2K` — **flash is locked to 720P** |
| `aspect_ratio` | `16:9` (default) `9:16` `1:1` `4:3` `3:4` `21:9` |
| `seed` | int, repeat it for similar output |
| `n` | only `1` supported |

Assembling a body with the wrong combination (e.g. 1080P on flash, or `images` in text
mode) is rejected locally by `build_payload()` before a request is spent.

Rate limit is ~16 requests/min; the client backs off on `429`.

## 4. The files

```
agnes-video/
├── agnes_api.py        # client: payload building, create/poll/download, response normalising
├── agnes_video.py      # CLI
├── agnes_server.py     # local web UI + proxy (http.server, no deps)
├── web/
│   ├── index.html      # the page
│   ├── style.css
│   └── app.js
├── test_agnes_api.py   # 17 offline tests (payload validation + response parsing)
└── .env.example
```

Run the tests (no network, no key):

```bash
cd agnes-video && python3 -m unittest -v
```

## 5. If something goes wrong

| symptom | cause |
|---|---|
| `HTTP 401` | key wrong / revoked — re-paste it |
| `HTTP 400 ... size` | flash only does 720P; use `agnes-video-2.5` for 1080P/2K |
| `HTTP 429` | ~16 req/min limit — wait a few seconds |
| `Could not reach apihub.agnes-ai.com` | sandbox/firewall blocks outbound HTTPS; run this on your own machine |
| Task completes but no URL | run with `--json` (CLI) to dump the raw response and see the actual field names |
| Video plays on the API URL but download fails | the mp4 is served from a CDN that may need the Bearer token; the local `/api/file` proxy forwards it — use the Download button rather than right-click-save |

Generation normally takes 40–120 s for a 5 s 720P clip. The CLI gives up after 15 min
(`--timeout`), and closing the browser tab stops polling but not the job on Agnes' side.
