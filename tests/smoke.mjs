import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "background.js"), "utf8");
const context = vm.createContext({
  console,
  URLSearchParams,
  AbortSignal,
  setTimeout,
  clearTimeout,
  chrome: {
    runtime: {
      getURL: (relative) => path.join(root, relative),
      onMessage: { addListener() {} }
    },
    tts: {}
  },
  fetch: async (filename) => ({
    ok: true,
    json: async () => JSON.parse(await fs.readFile(filename, "utf8"))
  })
});

vm.runInContext(source, context, { filename: "background.js" });

const chinese = await vm.runInContext('splitIntoWords("中国留学生", "zh")', context);
assert.equal(chinese.join(""), "中国留学生");
assert.ok(chinese.some((word) => word.length > 1), "Chinese should use dictionary words, not only characters");

const japanese = await vm.runInContext('splitIntoWords("私は学生です", "ja")', context);
assert.equal(japanese.join(""), "私は学生です");
assert.ok(japanese.some((word) => word.length > 1), "Japanese should use dictionary words, not only characters");

const german = await vm.runInContext('dictionaryLookup("Haus", "de")', context);
assert.ok(german?.definition, "German lookup should be case tolerant");

const korean = await vm.runInContext('splitIntoWords("황자님을 믿어요", "ko")', context);
assert.deepEqual([...korean], ["황자님", "을", "믿어", "요"]);

console.log("Manhua Lens smoke tests passed.");
