// Manhua Lens — background service worker
// Handles the actual data lookups.
//
// Word-level lookups check the bundled offline dictionaries first
// (dictionaries/{lang}.json — real dictionary entries with multiple
// senses, part of speech, and readings). If a word isn't found there
// (rare words, proper nouns, compounds the dictionary doesn't cover),
// it falls back to Google Translate's free endpoint so something is
// always shown.
//
// Sentence-level translation always uses Google Translate — the
// offline dictionaries are word-level only.

const GT_ENDPOINT = "https://translate.googleapis.com/translate_a/single";

// ---------- manual supplement ----------
// Keep a small hand-maintained supplement for manhwa-specific honorifics
// and fantasy vocabulary that may still be absent from the broad lexicons.

const SUPPLEMENT = {
  ko: {
    "황자님": [{ reading: "hwangjanim", pos: "noun", definition: "prince (honorific)" }],
    "황녀님": [{ reading: "hwangnyeonim", pos: "noun", definition: "princess (honorific)" }],
    "폐하": [{ reading: "pyeha", pos: "noun", definition: "Your Majesty" }],
    "전하": [{ reading: "jeonha", pos: "noun", definition: "Your Highness" }],
    "영애": [{ reading: "yeongae", pos: "noun", definition: "young lady (noble daughter, honorific)" }],
    "공작님": [{ reading: "gongjaknim", pos: "noun", definition: "duke (honorific)" }],
    "영식": [{ reading: "yeongsik", pos: "noun", definition: "young master (noble son, honorific)" }]
  }
};

function supplementLookup(word, sourceLang) {
  const senses = SUPPLEMENT[sourceLang]?.[word];
  if (!senses) return null;
  const primary = senses[0];
  return { word, reading: primary.reading, pos: primary.pos, definition: primary.definition, allSenses: senses };
}

const DICTIONARY_LANGS = ["zh", "ja", "ko", "fr", "es", "it", "de", "pt", "cs", "tr", "la"];
const dictionaryCache = {}; // lang -> Promise<{word: [{reading,pos,definition}]}>

function loadDictionary(lang) {
  if (!DICTIONARY_LANGS.includes(lang)) return Promise.resolve(null);
  if (!dictionaryCache[lang]) {
    dictionaryCache[lang] = fetch(chrome.runtime.getURL(`dictionaries/${lang}.json`))
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${lang} dictionary: ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        console.error("Manhua Lens: dictionary load failed", lang, err);
        dictionaryCache[lang] = null; // allow retry on next lookup
        return null;
      });
  }
  return dictionaryCache[lang];
}

// looks a word up in the offline dictionary; returns null if not found
async function dictionaryLookup(word, sourceLang) {
  const dict = await loadDictionary(sourceLang);
  if (!dict) return null;
  const senses = dict[word] || dict[word.toLocaleLowerCase(sourceLang)];
  if (!senses || senses.length === 0) return null;

  const primary = senses[0];

  return {
    word,
    reading: primary.reading || "",
    pos: primary.pos || "",
    definition: primary.definition,
    allSenses: senses
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "MHL_LOOKUP") {
    handleLookup(message.text, message.sourceLang, message.targetLang)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: true, message: String(err) }));
    return true; // keep the message channel open for the async response
  }

  if (message.type === "MHL_SPEAK") {
    handleBestSpeak(message.text, message.lang)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) => sendResponse({ error: true, message: err.message || String(err) }));
    return true;
  }
});

// ---------- pronunciation ----------
// Speech belongs in the extension service worker, not the webpage's
// content-script context. Using chrome.tts keeps it independent of the
// page's permissions and of whether window.speechSynthesis is exposed.

const BCP47 = {
  ko: "ko-KR", ja: "ja-JP", zh: "zh-CN", fr: "fr-FR", es: "es-ES", it: "it-IT",
  de: "de-DE", pt: "pt-PT", cs: "cs-CZ", tr: "tr-TR", en: "en-US"
};

const LANGUAGE_NAMES = {
  ko: "Korean", ja: "Japanese", zh: "Chinese", fr: "French", es: "Spanish", it: "Italian",
  de: "German", pt: "Portuguese", cs: "Czech", tr: "Turkish", la: "Latin", en: "English"
};

const OPENVOICE_ENDPOINT = "http://127.0.0.1:8765/tts";
const AZURE_ENDPOINT = "http://127.0.0.1:8765/azure-tts";
const KOREAN_VOICE_IDS = ["auto", "melo", "device", "sunhi", "hyunsu"];
const OFFSCREEN_DOCUMENT = "offscreen.html";

// ---------- speech pacing ----------
// Every engine already speaks at a native conversational rate at 1.0
// (chrome.tts rate 1.0 is the voice's own default; the OpenVoice server
// synthesizes at MeloTTS's natural Korean pace). The rate is always
// passed explicitly and read fresh for each request, so it can never
// accumulate across replays, voices, or languages.
const SPEECH_RATES = [0.75, 0.9, 1, 1.1, 1.25];
const DEFAULT_SPEECH_RATE = 1;

function normalizeSpeechRate(value) {
  const rate = Number(value);
  return SPEECH_RATES.includes(rate) ? rate : DEFAULT_SPEECH_RATE;
}

async function getSpeechRate() {
  try {
    const prefs = await chrome.storage.sync.get({ speechRate: DEFAULT_SPEECH_RATE });
    return normalizeSpeechRate(prefs.speechRate);
  } catch {
    return DEFAULT_SPEECH_RATE;
  }
}

// Manhwa/manga dialogue is usually selected across speech bubbles or
// wrapped lines with no punctuation between them. Speech engines treat
// a bare line break as a space, so separate bubbles were read as one
// breathless run-on sentence. Give each line break a light clause pause
// and each blank-line break a sentence pause, using the punctuation each
// language's engine expects. Existing punctuation is left untouched.
const PAUSE_MARKS = {
  ja: { clause: "、", sentence: "。", joiner: "" },
  zh: { clause: "，", sentence: "。", joiner: "" },
  default: { clause: ",", sentence: ".", joiner: " " }
};
const TRAILING_CLOSERS = /[\s"'”’」』）)\]】》〉]+$/u;
const ENDS_WITH_PAUSE = /[.!?…,;:~\-—、。，！？；：～]$/u;

function prepareSpeechText(text, lang) {
  const marks = PAUSE_MARKS[lang] || PAUSE_MARKS.default;
  const endsWithPause = (line) => ENDS_WITH_PAUSE.test(line.replace(TRAILING_CLOSERS, ""));
  const withPause = (line, mark) => (endsWithPause(line) ? line : line + mark);

  const paragraphs = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t 　]*\n\s*/)
    .map((paragraph) => paragraph
      .split("\n")
      .map((line) => line.replace(/[ \t 　]+/g, " ").trim())
      .filter(Boolean))
    .filter((lines) => lines.length > 0);

  return paragraphs
    .map((lines, p) => lines
      .map((line, i) => {
        if (i < lines.length - 1) return withPause(line, marks.clause);
        return p < paragraphs.length - 1 ? withPause(line, marks.sentence) : line;
      })
      .join(marks.joiner))
    .join(marks.joiner);
}

async function handleBestSpeak(text, lang) {
  const cleanText = prepareSpeechText(text, lang);
  if (!cleanText) throw new Error("There is no text to pronounce.");
  const rate = await getSpeechRate();

  if (lang === "ko") {
    const prefs = await chrome.storage.sync.get({ koreanVoice: "auto" });
    const selected = KOREAN_VOICE_IDS.includes(prefs.koreanVoice) ? prefs.koreanVoice : "auto";

    if (selected === "sunhi" || selected === "hyunsu") {
      // Azure credentials stay server-side. Never request or store them in
      // the browser extension, which is publicly inspectable by design.
      const audioBase64 = await synthesizeAzureKorean(cleanText, selected);
      await playExtensionAudio(audioBase64, "audio/wav", rate);
      return { voice: selected, rate };
    }
    if (selected === "device") {
      await handleSpeak(cleanText, lang, rate);
      return { voice: "device", rate };
    }

    try {
      const audioBase64 = await synthesizeOpenVoiceKorean(cleanText);
      await playExtensionAudio(audioBase64, "audio/wav", rate);
      return { voice: "openvoice", rate };
    } catch (err) {
      console.warn("Manhua Lens: local OpenVoice unavailable; using device Korean voice.", err);
      await handleSpeak(cleanText, lang, rate);
      return { voice: "device", fallback: true, rate };
    }
  }

  await handleSpeak(cleanText, lang, rate);
  return { voice: "device", rate };
}

async function synthesizeAzureKorean(text, voice) {
  const response = await fetch(AZURE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice }),
    signal: AbortSignal.timeout(45000)
  }).catch(() => {
    throw new Error("Azure voice server is offline. Start voice_server/azure_server.py or the OpenVoice server on port 8765.");
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(typeof payload.detail === "string" ? payload.detail : `Azure voice request failed: ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function synthesizeOpenVoiceKorean(text) {
  const response = await fetch(OPENVOICE_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(45000)
  });

  if (!response.ok) {
    throw new Error(`OpenVoice request failed: ${response.status}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_DOCUMENT);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [url]
  });

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT,
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play locally generated Korean pronunciation independently of webpage CSP."
  });
}

async function playExtensionAudio(audioBase64, mimeType, rate = DEFAULT_SPEECH_RATE) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    type: "MHL_PLAY_AUDIO",
    audioBase64,
    mimeType,
    playbackRate: normalizeSpeechRate(rate)
  });

  if (!response?.ok) {
    throw new Error(response?.message || "Custom pronunciation playback failed.");
  }
}

async function handleSpeak(text, lang, rate = DEFAULT_SPEECH_RATE) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("There is no text to pronounce.");
  if (lang === "la") throw new Error("Latin pronunciation is not available through Windows speech voices.");

  const targetLang = BCP47[lang] || "en-US";
  const voices = await chrome.tts.getVoices();
  const voice = voices.find((v) => v.lang === targetLang) || voices.find((v) => v.lang?.startsWith(`${lang}-`));

  if (voices.length > 0 && !voice) {
    throw new Error(`No ${LANGUAGE_NAMES[lang] || lang} voice is installed on this device.`);
  }

  chrome.tts.stop();
  // rate 1.0 is the voice's own natural default; pitch is left to the voice.
  const options = { lang: targetLang, rate: normalizeSpeechRate(rate) };
  if (voice?.voiceName) options.voiceName = voice.voiceName;

  // chrome.tts.speak() resolves when speech is accepted, not when it has
  // finished. Keep the message channel open until the engine reports a
  // terminal event so the content script can keep its panel visible.
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (error) reject(error);
      else resolve();
    };

    options.onEvent = (event) => {
      if (event.type === "end" || event.type === "interrupted" || event.type === "cancelled") {
        finish();
      } else if (event.type === "error") {
        finish(new Error(event.errorMessage || "Pronunciation failed."));
      }
    };

    const timeoutId = setTimeout(() => finish(), 60000);
    chrome.tts.speak(cleanText, options).catch((err) => finish(err));
  });
}

async function handleLookup(text, sourceLang, targetLang) {
  if (sourceLang === targetLang) {
    // nothing to translate — just split words and show them plain
    return {
      sentenceTranslation: text,
      words: (await splitIntoWords(text, sourceLang)).map((w) => ({
        word: w,
        reading: "",
        pos: "",
        definition: "(same language selected)"
      }))
    };
  }

  // A temporary outage or block at the online translation endpoint should
  // not take down the bundled offline dictionaries too.
  const sentenceTranslation = await translate(text, sourceLang, targetLang).catch(
    () => "Translation unavailable — showing dictionary results below."
  );

  const words = await splitIntoWords(text, sourceLang);
  const wordResults = await Promise.all(
    words.map(async (word) => {
      const particleLabel = sourceLang === "ko" ? KOREAN_PARTICLE_LABELS[word] : undefined;

      if (particleLabel) {
        // grammar particles (을/를/은/는 etc.) don't translate meaningfully
        // word-by-word — label them instead of showing a garbled translation
        return { word, reading: "", pos: "particle", definition: particleLabel, source: "grammar" };
      }

      // 1a. manual supplement for common words the frequency dictionary misses
      const supplementHit = supplementLookup(word, sourceLang);
      if (supplementHit) {
        const definition =
          targetLang === "en" ? supplementHit.definition : await translate(supplementHit.definition, "en", targetLang);
        return { ...supplementHit, definition, source: "dictionary" };
      }

      // 1b. try the offline dictionary — real dictionary entries.
      // Dictionary definitions are always in English, so if the user
      // wants a different target language, translate just the
      // definition text (reading/pos/word stay as-is).
      const dictHit = await dictionaryLookup(word, sourceLang);
      if (dictHit) {
        const definition =
          targetLang === "en" ? dictHit.definition : await translate(dictHit.definition, "en", targetLang);
        return { ...dictHit, definition, source: "dictionary" };
      }

      // 2. fall back to Google Translate for words the dictionary doesn't cover
      const [translation, reading] = await Promise.all([
        translate(word, sourceLang, targetLang).catch(() => "(translation unavailable)"),
        getReading(word, sourceLang)
      ]);
      return {
        word,
        reading,
        pos: "",
        definition: translation,
        source: "translate"
      };
    })
  );

  return { sentenceTranslation, words: wordResults };
}

// ---------- translation ----------

async function translate(text, sourceLang, targetLang) {
  const params = new URLSearchParams({
    client: "gtx",
    sl: sourceLang,
    tl: targetLang,
    dt: "t",
    q: text
  });

  const res = await fetch(`${GT_ENDPOINT}?${params.toString()}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Translate request failed: ${res.status}`);
  const data = await res.json();

  // response shape: [[[translatedChunk, originalChunk, ...], ...], ...]
  return data[0].map((chunk) => chunk[0]).join("");
}

// ---------- word reading (romanization) ----------
// Google's endpoint also returns a "dt=rm" romanization field for CJK
// languages when available. We ask for it separately since it's only
// present in a different response slot.

async function getReading(word, sourceLang) {
  if (!["ko", "ja", "zh"].includes(sourceLang)) return "";

  const params = new URLSearchParams({
    client: "gtx",
    sl: sourceLang,
    tl: "en",
    dt: "rm", // romanization
    q: word
  });

  try {
    const res = await fetch(`${GT_ENDPOINT}?${params.toString()}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return "";
    const data = await res.json();
    // romanization appears at data[0][0][3] when present
    const rm = data?.[0]?.[0]?.[3];
    return rm || "";
  } catch {
    return "";
  }
}

// ---------- word splitting ----------
// Chinese and Japanese do not put spaces between words. Use the bundled
// lexicon for longest-match segmentation so compounds are looked up as
// words instead of being reduced to isolated characters.

async function splitIntoWords(text, sourceLang) {
  const cleaned = text.replace(/[\p{P}\p{S}]+/gu, " ").trim();

  if (sourceLang === "ko") {
    return cleaned
      .split(/\s+/)
      .filter(Boolean)
      .flatMap(splitKorean)
      .slice(0, 20);
  }

  if (sourceLang === "zh" || sourceLang === "ja") {
    const dict = await loadDictionary(sourceLang);
    return segmentCjk(cleaned, dict).slice(0, 20);
  }

  return (cleaned.match(/[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*/gu) || []).slice(0, 20);
}

function segmentCjk(text, dict) {
  const compact = text.replace(/\s+/g, "");
  if (!dict) return Array.from(compact);

  const words = [];
  let index = 0;
  while (index < compact.length) {
    const remaining = compact.length - index;
    let match = "";
    for (let length = Math.min(16, remaining); length > 0; length -= 1) {
      const candidate = compact.slice(index, index + length);
      if (dict[candidate]) {
        match = candidate;
        break;
      }
    }
    words.push(match || compact[index]);
    index += (match || compact[index]).length;
  }
  return words;
}

// ---------- Korean particle (조사) splitting ----------
// Korean glues grammar particles directly onto the word before them —
// e.g. "황자님을" = 황자님 (prince, the root noun) + 을 (object marker).
// Without splitting these apart, a dictionary/translate lookup on the
// whole glued string usually fails or returns nonsense. This checks
// each space-separated chunk against the closed set of common Korean
// particles and endings, longest match first, and splits off a
// trailing match so the root word gets looked up cleanly.
//
// This is NOT a full morphological analyzer (verb conjugation stems
// are much harder and need a real analyzer like Kiwi/KOMORAN/MeCab-ko)
// — but particle splitting alone fixes the most common breakage.

const KOREAN_PARTICLES = [
  // longer/compound particles first so they match before their substrings
  "께서는", "에서는", "으로는", "에게는", "한테는",
  "이라는", "라는",
  "이지만", "지만",
  "이에요", "예요",
  "습니다", "ㅂ니다",
  "으로", "에서", "에게", "한테", "부터", "까지", "마다", "처럼", "보다",
  "이나", "나",
  "은", "는", "이", "가", "을", "를", "의", "에", "도", "만", "요"
];

// plain-English gloss for each particle, shown instead of a translation
const KOREAN_PARTICLE_LABELS = {
  "께서는": "topic marker (honorific)",
  "에서는": "at/in — as topic",
  "으로는": "toward/by — as topic",
  "에게는": "to (a person) — as topic",
  "한테는": "to (a person, casual) — as topic",
  "이라는": "called / named",
  "라는": "called / named",
  "이지만": "but, although",
  "지만": "but, although",
  "이에요": "is/am/are (polite)",
  "예요": "is/am/are (polite)",
  "습니다": "formal sentence ending",
  "ㅂ니다": "formal sentence ending",
  "으로": "toward, by means of",
  "에서": "at, in, from",
  "에게": "to (a person)",
  "한테": "to (a person, casual)",
  "부터": "from, starting at",
  "까지": "until, up to",
  "마다": "every, each",
  "처럼": "like, as",
  "보다": "compared to, than",
  "이나": "or, at least",
  "나": "or, at least",
  "은": "topic marker",
  "는": "topic marker",
  "이": "subject marker",
  "가": "subject marker",
  "을": "object marker",
  "를": "object marker",
  "의": "possessive (of/'s)",
  "에": "at, in, to",
  "도": "also, too",
  "만": "only, just",
  "요": "polite sentence ending"
};

function splitKorean(chunk) {
  for (const particle of KOREAN_PARTICLES) {
    if (chunk.length > particle.length && chunk.endsWith(particle)) {
      const root = chunk.slice(0, chunk.length - particle.length);
      return [root, particle];
    }
  }
  return [chunk];
}
