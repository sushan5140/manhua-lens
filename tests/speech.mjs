// Speech pacing checks: natural 1.0x default, no speed accumulation,
// language-appropriate pauses between lines/bubbles, fallback routing.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFile(path.join(root, file), "utf8");

// ---------- background.js ----------
let stored = {};
let serverOnline = true;
const spoken = [];
const played = [];
const requests = [];
const background = vm.createContext({
  console: { warn() {}, error() {}, log() {} },
  URLSearchParams, AbortSignal, setTimeout, clearTimeout,
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  fetch: async (url, options) => {
    requests.push(JSON.parse(options.body).text);
    if (!serverOnline) throw new TypeError("Failed to fetch");
    return { ok: true, arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer };
  },
  chrome: {
    storage: { sync: { get: async (defaults) => ({ ...defaults, ...stored }) } },
    runtime: {
      getURL: (x) => x,
      onMessage: { addListener() {} },
      getContexts: async () => [{}],
      sendMessage: async (message) => { played.push(message); return { ok: true }; }
    },
    tts: {
      getVoices: async () => [
        { lang: "ko-KR", voiceName: "Korean" },
        { lang: "ja-JP", voiceName: "Japanese" },
        { lang: "zh-CN", voiceName: "Chinese" }
      ],
      stop() {},
      speak: async (text, options) => {
        spoken.push({ text, lang: options.lang, rate: options.rate });
        options.onEvent({ type: "end" });
      }
    }
  }
});
vm.runInContext(await read("background.js"), background, { filename: "background.js" });
const call = (expr) => vm.runInContext(expr, background);
const prep = (text, lang) => call(`prepareSpeechText(${JSON.stringify(text)}, "${lang}")`);
const speak = (text, lang) => call(`handleBestSpeak(${JSON.stringify(text)}, "${lang}")`);

// Bubble text: bare line breaks become clause pauses; blank lines sentence pauses.
assert.equal(prep("왜 이제 왔어\n한참 기다렸잖아\n진짜 걱정했단 말이야", "ko"),
  "왜 이제 왔어, 한참 기다렸잖아, 진짜 걱정했단 말이야");
assert.equal(prep("뭐라고?!\n\n말도 안 돼", "ko"), "뭐라고?! 말도 안 돼");
assert.equal(prep("잠깐만요\n\n그게 무슨 뜻이에요?", "ko"), "잠깐만요. 그게 무슨 뜻이에요?");
assert.equal(prep("どうして\n来なかったの", "ja"), "どうして、来なかったの");
assert.equal(prep("「行こう」\n\nうん！", "ja"), "「行こう」。うん！");
assert.equal(prep("「行こう。」\n\nうん！", "ja"), "「行こう。」うん！");
assert.equal(prep("你怎么才来\n\n我等了很久", "zh"), "你怎么才来。我等了很久");
assert.equal(prep("真的吗？\n太好了！", "zh"), "真的吗？太好了！");
assert.equal(prep("Wait\nwhat", "fr"), "Wait, what");

// Existing punctuation, spacing inside a line, and single words stay as typed.
const korean = "잠깐만요, 그게 무슨 뜻이에요? 설마 저를 버리고 가시려는 건 아니죠?";
assert.equal(prep(korean, "ko"), korean);
assert.equal(prep("그게... 사실은... 나도 몰라", "ko"), "그게... 사실은... 나도 몰라");
assert.equal(prep("  황자님  ", "ko"), "황자님");
assert.equal(prep("  \n \n ", "ko"), "");

// Default: natural 1.0x on every engine, with no stored preference.
let result = await speak("안녕하세요.", "ko");
assert.equal(result.voice, "openvoice");
assert.equal(played.at(-1).playbackRate, 1);
await speak("私は学生です。", "ja");
assert.equal(spoken.at(-1).rate, 1);
assert.equal(spoken.at(-1).lang, "ja-JP");
await speak("我是学生。", "zh");
assert.equal(spoken.at(-1).rate, 1);

// Repeated playback and language switching never accumulate speed.
for (let i = 0; i < 5; i += 1) {
  await speak("왜 이제 왔어? 한참 기다렸잖아!", "ko");
  await speak("どうして来なかったの？", "ja");
  await speak("你怎么才来？", "zh");
}
assert.ok(played.every((m) => m.playbackRate === 1), "OpenVoice playback must stay at 1.0x");
assert.ok(spoken.every((s) => s.rate === 1), "Device voices must stay at 1.0x");

// The server receives the pause-prepared text.
await speak("왜 이제 왔어\n한참 기다렸잖아", "ko");
assert.equal(requests.at(-1), "왜 이제 왔어, 한참 기다렸잖아");

// A chosen speed is applied absolutely, identically for every language/engine.
stored = { speechRate: 0.9 };
await speak("안녕하세요.", "ko");
await speak("こんにちは。", "ja");
await speak("你好。", "zh");
assert.equal(played.at(-1).playbackRate, 0.9);
assert.equal(spoken.at(-1).rate, 0.9);
assert.equal(spoken.at(-2).rate, 0.9);

// OpenVoice offline -> device Korean voice keeps the same speed.
serverOnline = false;
result = await speak("안녕하세요.", "ko");
assert.equal(result.voice, "device");
assert.equal(result.fallback, true);
assert.equal(spoken.at(-1).lang, "ko-KR");
assert.equal(spoken.at(-1).rate, 0.9);
serverOnline = true;

// Corrupt or out-of-range stored speeds fall back to natural speech.
for (const bad of [1.75, 1.5, "fast", null, 0, -1]) {
  stored = { speechRate: bad };
  await speak("안녕하세요.", "ko");
  assert.equal(played.at(-1).playbackRate, 1, `stored ${bad} must play at 1.0x`);
}

// ---------- offscreen.js ----------
const audios = [];
class FakeAudio {
  constructor(url) {
    this.url = url;
    this.playbackRate = 1;
    this.defaultPlaybackRate = 1;
    this.listeners = {};
    audios.push(this);
  }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  pause() {}
  async play() { setTimeout(() => this.listeners.ended?.(), 0); }
}
let onPlay;
const offscreen = vm.createContext({
  atob: (b64) => Buffer.from(b64, "base64").toString("binary"),
  Blob: class {},
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  Audio: FakeAudio,
  Uint8Array, Promise, Number, setTimeout,
  chrome: { runtime: { onMessage: { addListener: (fn) => { onPlay = fn; } } } }
});
vm.runInContext(await read("offscreen.js"), offscreen, { filename: "offscreen.js" });
const playClip = (playbackRate) => new Promise((resolve) => {
  onPlay({ type: "MHL_PLAY_AUDIO", audioBase64: "UklGRg==", mimeType: "audio/wav", playbackRate }, {}, resolve);
});

for (const [requested, expected] of [[undefined, 1], [1, 1], [1, 1], [1.25, 1.25], [1, 1], [0.75, 0.75], [2, 1]]) {
  assert.equal((await playClip(requested)).ok, true);
  const audio = audios.at(-1);
  assert.equal(audio.playbackRate, expected);
  assert.equal(audio.defaultPlaybackRate, expected);
  assert.equal(audio.preservesPitch, true);
}
assert.equal(new Set(audios).size, audios.length, "each clip must use a fresh audio element");

console.log("Speech pacing tests passed.");
