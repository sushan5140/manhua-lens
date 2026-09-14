"""Loopback-only, Python-standard-library playback. No ML packages required."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from voice_assets import read_cached, normalize_text


class CacheHandler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def permitted(self):
        origin = self.headers.get("Origin", "")
        return not origin or origin.startswith("chrome-extension://")

    def reply(self, status, data, content_type="application/json"):
        self.send_response(status)
        origin = self.headers.get("Origin", "")
        if origin.startswith("chrome-extension://"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.reply(204 if self.permitted() else 403, b"")

    def do_GET(self):
        if not self.permitted():
            return self.reply(403, b'{}')
        if self.path != "/health":
            return self.reply(404, b'{}')
        count = sum(1 for _ in (self.server.assets / "cache").glob("*.wav"))
        self.reply(200, json.dumps({"ok": True, "mode": "cache", "phrases": count}).encode())

    def do_POST(self):
        if not self.permitted():
            return self.reply(403, b'{}')
        if self.path != "/tts":
            return self.reply(404, b'{}')
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 8192:
                return self.reply(413, b'{"detail":"Invalid request size"}')
            self.connection.settimeout(5)
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("Expected a JSON object")
            text = normalize_text(payload.get("text"))
        except (ValueError, OSError):
            return self.reply(400, b'{"detail":"Invalid text request"}')
        try:
            audio = read_cached(self.server.assets, text)
        except (ValueError, OSError):
            return self.reply(503, b'{"detail":"Cached audio unavailable"}')
        if audio is None:
            return self.reply(404, b'{"detail":"Phrase not prepared; use device Korean TTS"}')
        self.reply(200, audio, "audio/wav")


def make_server(assets, port=8765):
    server = ThreadingHTTPServer(("127.0.0.1", port), CacheHandler)
    server.assets = Path(assets)
    return server


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, default=Path(__file__).parent / "private")
    args = parser.parse_args()
    print("Private phrase playback: http://127.0.0.1:8765/health (Ctrl+C to stop)")
    print("Unprepared phrases fall back to the device voice.")
    with make_server(args.assets) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
