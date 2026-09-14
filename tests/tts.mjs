import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
let spoken = [], requests = [], playback = [], behavior = 'ok';
const context = vm.createContext({
  console: { warn() {} }, AbortSignal, setTimeout, clearTimeout, URLSearchParams,
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  fetch: async (url, options) => {
    requests.push({url, options});
    if (behavior === 'offline') throw new TypeError('Failed to fetch');
    if (behavior === 'timeout') throw new DOMException('Timed out', 'TimeoutError');
    return { ok: behavior !== 'miss', status: behavior === 'miss' ? 404 : 200,
      arrayBuffer: async () => new Uint8Array([82, 73, 70, 70]).buffer };
  },
  chrome: {
    runtime: {
      getURL: (x) => x, onMessage: { addListener() {} },
      getContexts: async () => [{}],
      sendMessage: async (message) => {
        playback.push(message);
        return behavior === 'playback-error' ? {ok: false} : {ok: true};
      }
    },
    tts: {
      getVoices: async () => [{lang:'ko-KR',voiceName:'Korean'}, {lang:'ja-JP',voiceName:'Japanese'}],
      stop() {}, speak: async (text, options) => {
        spoken.push({text, lang: options.lang}); options.onEvent({type:'end'});
      }
    }
  }
});
vm.runInContext(source, context);
const run = (lang) => vm.runInContext(`handleBestSpeak("안녕하세요", "${lang}")`, context);
assert.equal((await run('ko')).voice, 'openvoice');
assert.equal(spoken.length, 0);
assert.equal(playback[0].type, 'MHL_PLAY_AUDIO');
assert.equal(requests[0].url, 'http://127.0.0.1:8765/tts');
for (behavior of ['miss', 'offline', 'timeout', 'playback-error']) {
  const result = await run('ko');
  assert.equal(result.voice, 'device');
  assert.equal(result.fallback, true);
  assert.equal(spoken.at(-1).lang, 'ko-KR');
}
const previousRequests = requests.length;
assert.equal((await run('ja')).voice, 'device');
assert.equal(spoken.at(-1).lang, 'ja-JP');
assert.equal(requests.length, previousRequests);
console.log('TTS custom playback, misses, offline/timeout fallback, playback failure, and non-Korean routing passed.');
