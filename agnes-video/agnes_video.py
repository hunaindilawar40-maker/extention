#!/usr/bin/env python3
"""
agnes_video.py — generate a video with the Agnes AI text-to-video API.

Examples
--------
  # plain text-to-video, 5s, 720P (default model = agnes-video-2.5-flash)
  python3 agnes_video.py --prompt "A fox trots through a misty bamboo grove at dawn"

  # better quality, 8 seconds, 1080P
  python3 agnes_video.py --model agnes-video-2.5 --size 1080P --seconds 8 \
      --prompt "Drone shot over a neon-lit Kuala Lumpur street after rain"

  # animate between two stills
  python3 agnes_video.py --mode keyframe \
      --first-frame https://example.com/a.jpg --last-frame https://example.com/b.jpg \
      --prompt "The camera pushes in as the day turns to night"

  # see exactly what would be sent, without spending a request
  python3 agnes_video.py --dry-run --prompt "test"
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import agnes_api as api  # noqa: E402


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Create an Agnes AI video from a text prompt.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument("--prompt", "-p", help="What the video should show.")
    p.add_argument("--prompt-file", help="Read the prompt from a text file instead.")
    p.add_argument("--model", default=api.DEFAULT_MODEL, help=f"Model id (default: {api.DEFAULT_MODEL}).")
    p.add_argument("--mode", default="text", choices=["text", "keyframe", "reference"])
    p.add_argument("--seconds", "-s", default="5", help="4–12 (default 5).")
    p.add_argument("--size", default="720P", help="720P | 1080P | 1K | 2K.")
    p.add_argument("--aspect-ratio", default="16:9", help="16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 21:9.")
    p.add_argument("--seed", type=int, help="Repeat a seed for similar results.")
    p.add_argument("--first-frame", help="Image URL used as the first frame (keyframe mode).")
    p.add_argument("--last-frame", help="Image URL used as the last frame (keyframe mode).")
    p.add_argument("--image", action="append", default=[], help="Reference image URL (repeatable).")
    p.add_argument("--audio", action="append", default=[], help="Reference audio URL (repeatable).")
    p.add_argument("--video", action="append", default=[], dest="video_ref",
                   help="Reference video URL (repeatable).")
    p.add_argument("--out", "-o", help="Output .mp4 path.")
    p.add_argument("--out-dir", default="output", help="Folder for generated videos (default: output).")
    p.add_argument("--key", help="API key (overrides AGNES_API_KEY / .env).")
    p.add_argument("--base-url", help="Override the API base URL.")
    p.add_argument("--poll-interval", type=float, default=10.0, help="Seconds between status checks.")
    p.add_argument("--timeout", type=float, default=900.0, help="Give up after this many seconds.")
    p.add_argument("--no-download", action="store_true", help="Print the URL but don't save the file.")
    p.add_argument("--json", action="store_true", help="Print raw task JSON at the end.")
    p.add_argument("--dry-run", action="store_true", help="Print the request body and exit.")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    api.load_dotenv(pathlib.Path(__file__).resolve().parent / ".env")

    if args.base_url:
        os.environ["AGNES_BASE_URL"] = args.base_url

    prompt = args.prompt
    if args.prompt_file:
        prompt = pathlib.Path(args.prompt_file).read_text(encoding="utf-8")
    if not prompt and not sys.stdin.isatty():
        prompt = sys.stdin.read()
    if not prompt:
        print("error: pass --prompt, --prompt-file, or pipe the prompt on stdin.", file=sys.stderr)
        return 2

    try:
        payload = api.build_payload(
            prompt=prompt,
            model=args.model,
            mode=args.mode,
            seconds=args.seconds,
            size=args.size,
            aspect_ratio=args.aspect_ratio,
            seed=args.seed,
            first_frame=args.first_frame,
            last_frame=args.last_frame,
            images=args.image,
            audios=args.audio,
            videos=args.video_ref,
        )
    except api.AgnesError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.dry_run:
        print(json.dumps(payload, indent=2))
        return 0

    key = api.resolve_api_key(args.key)

    print(f"→ creating task  ({payload['model']}, {payload['seconds']}s, "
          f"{payload['size']}, {payload['aspect_ratio']}, mode={payload['mode']})")
    try:
        task = api.create_task(payload, key)
    except api.AgnesError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    video_id, model_name = api.task_ids(task)
    print(f"  video_id: {video_id}")

    started = time.time()

    def on_update(info: dict) -> None:
        pct = f"{info['progress']:.0f}%" if info["progress"] else ""
        elapsed = int(time.time() - started)
        print(f"  status: {info['status']:<10} {pct:>4}  ({elapsed}s)", flush=True)

    try:
        result = api.wait_for_video(
            video_id, model_name, key,
            poll_interval=args.poll_interval, timeout=args.timeout, on_update=on_update,
        )
    except api.AgnesError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    url = result["video_url"]
    if not url:
        print("error: task completed but no video_url was returned.", file=sys.stderr)
        if args.json:
            print(json.dumps(result.get("raw", {}), indent=2))
        return 1

    print(f"✓ done in {int(time.time() - started)}s")
    print(f"  url: {url}")

    if not args.no_download:
        if args.out:
            dest = pathlib.Path(args.out)
        else:
            stem = "agnes-" + _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            dest = pathlib.Path(args.out_dir) / f"{stem}.mp4"
        try:
            saved = api.download(url, dest, key)
            size_mb = saved.stat().st_size / 1e6
            print(f"  saved: {saved.resolve()}  ({size_mb:.1f} MB)")
        except api.AgnesError as exc:
            print(f"warning: could not save the file locally ({exc}); open the URL above.",
                  file=sys.stderr)

    if args.json:
        print(json.dumps(result.get("raw", {}), indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        raise SystemExit(130)
