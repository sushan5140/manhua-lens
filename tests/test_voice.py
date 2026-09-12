import ast
import io
import json
import sys
import tempfile
import threading
import unicodedata
import unittest
import urllib.error
import urllib.request
import wave
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "voice_server"))
from voice_assets import cache_name, import_bundle, normalize_text, read_cached, validate_wav  # noqa: E402
from cache_server import make_server  # noqa: E402

TEXT = "안녕하세요. 오늘도 한국어 공부를 시작해 볼까요?"


def wav_bytes():
    data = io.BytesIO()
    with wave.open(data, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(24000)
        audio.writeframes(b"\0\0" * 2400)
    return data.getvalue()


class AssetsTests(unittest.TestCase):
    def test_normalization_and_validation(self):
        self.assertEqual(cache_name(TEXT), cache_name(" " + unicodedata.normalize("NFD", TEXT) + "\n"))
        self.assertNotEqual(cache_name(TEXT), cache_name(TEXT + "!"))
        for bad in [None, 42, {}, [], "", "  ", "가" * 401]:
            with self.assertRaises(ValueError):
                normalize_text(bad)

    def test_wav_validation(self):
        self.assertEqual(validate_wav(wav_bytes()), wav_bytes())
        for bad in [b"not audio", wav_bytes()[:-10]]:
            with self.assertRaises(ValueError):
                validate_wav(bad)

    def test_private_bundle_import_and_allowlist(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "private.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("manifest.json", json.dumps({"format": "manhua-lens-private-v1"}))
                bundle.writestr("cache/" + cache_name(TEXT), wav_bytes())
                bundle.writestr("target_se.pth", b"opaque-test-placeholder")
            import_bundle(archive, root / "assets")
            self.assertEqual(read_cached(root / "assets", TEXT), wav_bytes())
            for forbidden in ["../escaped.wav", "/absolute.wav", "reference.wav", "cache/arbitrary.wav"]:
                with zipfile.ZipFile(archive, "w") as bundle:
                    bundle.writestr("manifest.json", '{"format":"manhua-lens-private-v1"}')
                    bundle.writestr(forbidden, wav_bytes())
                with self.assertRaises(ValueError):
                    import_bundle(archive, root / "rejected")
                self.assertFalse((root / "rejected").exists())

    def test_notebook_is_clean_and_embedded_sources_match(self):
        notebook = json.loads((ROOT / "voice_server/kaggle_prepare.ipynb").read_text(encoding="utf-8"))
        embedded = None
        for cell in notebook["cells"]:
            if cell["cell_type"] != "code":
                continue
            self.assertEqual(cell["outputs"], [])
            self.assertIsNone(cell["execution_count"])
            tree = ast.parse("".join(cell["source"]))
            for node in tree.body:
                if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "PUBLIC_SOURCES" for t in node.targets):
                    embedded = ast.literal_eval(node.value)
        self.assertIsNotNone(embedded)
        for name, source in embedded.items():
            self.assertEqual(source, (ROOT / "voice_server" / name).read_text(encoding="utf-8-sig"))


class CacheHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.assets = Path(self.tmp.name)
        (self.assets / "cache").mkdir()
        (self.assets / "cache" / cache_name(TEXT)).write_bytes(wav_bytes())
        self.server = make_server(self.assets, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def request(self, path="/tts", payload=None, origin="chrome-extension://" + "a" * 32, raw=None):
        data = raw if raw is not None else json.dumps(payload or {"text": TEXT}).encode()
        req = urllib.request.Request(self.url + path, data=data,
                                     headers={"Content-Type": "application/json", "Origin": origin})
        try:
            return urllib.request.urlopen(req, timeout=3)
        except urllib.error.HTTPError as error:
            return error

    def test_cache_hit_and_health(self):
        with self.request() as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["Content-Type"], "audio/wav")
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(response.read(), wav_bytes())
        with urllib.request.urlopen(self.url + "/health") as response:
            self.assertEqual(json.load(response)["phrases"], 1)

    def test_miss_invalid_origin_and_corrupt_audio(self):
        for payload, status in [({"text": "없는 문장"}, 404), ({"text": 2}, 400), ({"text": " "}, 400), ({"text": "가" * 401}, 400)]:
            with self.request(payload=payload) as response:
                self.assertEqual(response.status, status)
        with self.request(origin="https://example.com") as response:
            self.assertEqual(response.status, 403)
        for raw in [b"[]", b"{", b"x" * 8193]:
            with self.request(raw=raw) as response:
                self.assertIn(response.status, [400, 413])
        (self.assets / "cache" / cache_name(TEXT)).write_bytes(b"broken")
        with self.request() as response:
            self.assertEqual(response.status, 503)


try:
    from fastapi.testclient import TestClient
    import server as live
except ImportError:
    TestClient = None


@unittest.skipIf(TestClient is None, "Install HTTP test dependencies for live API tests")
class LiveAPITests(unittest.TestCase):
    def test_live_and_fallback_contract(self):
        class FakeVoice:
            device = "test"

            def synthesize(self, text):
                if text == "실패":
                    raise RuntimeError("busy")
                return wav_bytes()

        live.app.state.voice = FakeVoice()
        with tempfile.TemporaryDirectory() as tmp, patch.object(live, "ASSETS", Path(tmp)):
            client = TestClient(live.app)  # Do not run model startup.
            self.assertEqual(client.get("/health").json()["mode"], "live")
            self.assertEqual(client.post("/tts", json={"text": TEXT}).content, wav_bytes())
            self.assertEqual(client.post("/tts", json={"text": "실패"}).status_code, 503)
            self.assertEqual(client.post("/tts", json={"text": " "}).status_code, 400)
            self.assertEqual(client.post("/tts", json={"text": 123}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
