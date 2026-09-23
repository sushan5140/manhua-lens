// Verify Sun-Hi / Hyunsu routing, existing default and error clarity.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let stored = {};
let azureConfigured = true;
const reqs = [];
const played = [];
const spoken = [];
const env = vm.createContext({
  console: { warn() {}, error() {}, log() {} },
  URLSearchParams, AbortSignal, setTimeout, clearTimeout,
  btoa: (value) => Buffer.from(value, "binary").toString("base64"),
  fetch: async (url, opts) => {
    const body = JSON.parse(opts.body);
    reqs.push({ url, body });
    if (url.endsWith("/azure-tts") && !azureConfigured) {
      return { ok: false, status: 503, json: async () => ({ detail: "Azure voice is not configured." }) };
    }
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
      getVoices: async () => [{ lang: "ko-KR", voiceName: "Heami" }, { lang: "ja-JP", voiceName: "Japanese" }],
      stop() {},
      speak: async (text, options) => {
        spoken.push({ text, lang: options.lang, rate: options.rate });
        options.onEvent({ type: "end" });
      }
    }
  }
});
vm.runInContext(await fs.readFile(path.join(root, "background.js"), "utf8"), env);
const speak = (text, lang) => vm.runInContext(`handleBestSpeak(${JSON.stringify(text)}, ${JSON.stringify(lang)})`, env);

// No unexpected provider switch for existing users.
let result = await speak("안녕하세요", "ko");
assert.equal(result.voice, "openvoice");
assert.ok(reqs.at(-1).url.endsWith("/tts"));

stored = { koreanVoice: "sunhi", speechRate: 0.9 };
result = await speak("왜 이제 왔어\n한참 기다렸잖아", "ko");
assert.equal(result.voice, "sunhi");
assert.equal(reqs.at(-1).body.voice, "sunhi");
assert.equal(reqs.at(-1).body.text, "왜 이제 왔어, 한참 기다렸잖아");
assert.ok(reqs.at(-1).url.endsWith("/azure-tts"));
assert.equal(played.at(-1).playbackRate, 0.9);

stored = { koreanVoice: "hyunsu", speechRate: 1.25 };
result = await speak("좋은 아침이에요", "ko");
assert.equal(result.voice, "hyunsu");
assert.equal(reqs.at(-1).body.voice, "hyunsu");
assert.equal(played.at(-1).playbackRate, 1.25);

azureConfigured = false;
await assert.rejects(speak("안녕하세요", "ko"), /Azure voice is not configured/);
azureConfigured = true;

const requestCount = reqs.length;
stored = { koreanVoice: "device", speechRate: 0.75 };
result = await speak("안녕하세요", "ko");
assert.equal(result.voice, "device");
assert.equal(reqs.length, requestCount);
assert.equal(spoken.at(-1).rate, 0.75);

stored = { koreanVoice: "sunhi", speechRate: 1 };
result = await speak("こんにちは", "ja");
assert.equal(result.voice, "device");
assert.equal(spoken.at(-1).lang, "ja-JP");

console.log("Azure voice selection tests passed.");
