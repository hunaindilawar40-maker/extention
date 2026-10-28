"""Offline tests for agnes_api — no network, no API key needed.

    cd agnes-video && python3 -m unittest -v
"""

import unittest

import agnes_api as api


class PayloadTests(unittest.TestCase):
    def test_text_mode_minimal(self):
        p = api.build_payload("a cat on a beach")
        self.assertEqual(p["mode"], "text")
        self.assertEqual(p["seconds"], "5")
        self.assertEqual(p["model"], "agnes-video-2.5-flash")
        self.assertNotIn("seed", p)

    def test_flash_rejects_1080p(self):
        with self.assertRaises(api.AgnesError):
            api.build_payload("x", model="agnes-video-2.5-flash", size="1080P")

    def test_quality_model_allows_1080p(self):
        p = api.build_payload("x", model="agnes-video-2.5", size="1080P", seconds="8")
        self.assertEqual(p["size"], "1080P")
        self.assertEqual(p["seconds"], "8")

    def test_duration_bounds(self):
        with self.assertRaises(api.AgnesError):
            api.build_payload("x", seconds="3")
        with self.assertRaises(api.AgnesError):
            api.build_payload("x", seconds="13")

    def test_empty_prompt(self):
        with self.assertRaises(api.AgnesError):
            api.build_payload("   ")

    def test_keyframe_needs_a_frame(self):
        with self.assertRaises(api.AgnesError):
            api.build_payload("x", mode="keyframe")
        p = api.build_payload("x", mode="keyframe", first_frame="https://a/b.jpg")
        self.assertEqual(p["first_frame"], "https://a/b.jpg")

    def test_text_mode_never_sends_frames(self):
        p = api.build_payload("x", mode="text", images=["https://a/b.jpg"])
        self.assertNotIn("images", p)

    def test_reference_mode_keeps_references(self):
        p = api.build_payload("x", mode="reference", images=["https://a/1.jpg"],
                              audios=["https://a/2.mp3"])
        self.assertEqual(p["images"], ["https://a/1.jpg"])
        self.assertEqual(p["audios"], ["https://a/2.mp3"])

    def test_seed_passthrough(self):
        self.assertEqual(api.build_payload("x", seed=42)["seed"], 42)


class ResponseTests(unittest.TestCase):
    def test_task_ids_from_video_id(self):
        vid, model = api.task_ids({"id": "t1", "video_id": "video_9", "model": "agnes-video-2.5"})
        self.assertEqual(vid, "video_9")
        self.assertEqual(model, "agnes-video-2.5")

    def test_task_ids_fallback_to_id(self):
        vid, model = api.task_ids({"id": "task_abc"})
        self.assertEqual(vid, "task_abc")
        self.assertEqual(model, api.DEFAULT_MODEL)

    def test_task_ids_missing(self):
        with self.assertRaises(api.AgnesError):
            api.task_ids({"ok": True})

    def test_snapshot_flat(self):
        s = api.snapshot({"status": "completed", "progress": 100,
                          "video_url": "https://cdn/x.mp4"})
        self.assertTrue(api.looks_done(s["status"]))
        self.assertEqual(s["video_url"], "https://cdn/x.mp4")
        self.assertEqual(s["progress"], 100.0)

    def test_snapshot_nested_and_percent_string(self):
        s = api.snapshot({"data": {"task": {"status": "processing", "progress": "37%"}}})
        self.assertEqual(s["status"], "processing")
        self.assertEqual(s["progress"], 37.0)
        self.assertIsNone(s["video_url"])

    def test_snapshot_url_from_result_array(self):
        s = api.snapshot({"status": "succeeded",
                          "result": [{"url": "https://cdn/y.mp4"}]})
        self.assertEqual(s["video_url"], "https://cdn/y.mp4")

    def test_snapshot_failure(self):
        s = api.snapshot({"status": "failed", "error": "nsfw content"})
        self.assertTrue(api.looks_failed(s["status"]))
        self.assertEqual(s["error"], "nsfw content")

    def test_snapshot_ignores_non_url_values(self):
        s = api.snapshot({"status": "processing", "video": "not a url"})
        self.assertIsNone(s["video_url"])


if __name__ == "__main__":
    unittest.main()
