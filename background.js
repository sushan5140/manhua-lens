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
// The bundled dictionaries are frequency-ranked to the top ~25,000
// words per language, so honorifics and royalty/fantasy-genre
// vocabulary common in manhwa/manhua but rare in everyday text
// (황자님, 폐하, 영애, etc.) often aren't included. This small
// hand-maintained list fills the most common gaps; extend it over
// time as more misses turn up during real reading.

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

const DICTIONARY_LANGS = ["ja", "zh", "ko", "fr", "es"];
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
  const senses = dict[word];
  if (!senses || senses.length === 0) return null;

  // popup shows one primary sense inline plus a count of additional senses
  const primary = senses[0];
  const extra = senses.length - 1;
  const definition = extra > 0 ? `${primary.definition} (+${extra} more sense${extra > 1 ? "s" : ""})` : primary.definition;

  return {
    word,
    reading: primary.reading || "",
    pos: primary.pos || "",
    definition,
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
    handleSpeak(message.text, message.lang)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ error: true, message: err.message || String(err) }));
    return true;
  }
});

// ---------- pronunciation ----------
// Speech belongs in the extension service worker, not the webpage's
// content-script context. Using chrome.tts keeps it independent of the
// page's permissions and of whether window.speechSynthesis is exposed.

const BCP47 = { ko: "ko-KR", ja: "ja-JP", zh: "zh-CN", fr: "fr-FR", es: "es-ES", en: "en-US" };

async function handleSpeak(text, lang) {
  const cleanText = String(text || "").trim();
  if (!cleanText) throw new Error("There is no text to pronounce.");

  const targetLang = BCP47[lang] || "en-US";
  const voices = await chrome.tts.getVoices();
  const voice = voices.find((v) => v.lang === targetLang) || voices.find((v) => v.lang?.startsWith(`${lang}-`));

  if (voices.length > 0 && !voice) {
    const names = { ko: "Korean", ja: "Japanese", zh: "Chinese", fr: "French", es: "Spanish", en: "English" };
    throw new Error(`No ${names[lang] || lang} voice is installed on this device.`);
  }

  chrome.tts.stop();
  const options = { lang: targetLang };
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
      words: splitIntoWords(text, sourceLang).map((w) => ({
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

  const words = splitIntoWords(text, sourceLang);
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
// Real segmentation (especially for Chinese/Japanese, which don't use
// spaces) needs a full tokenizer/dictionary. Until that's wired in:
// - Korean gets rule-based particle splitting (see splitKorean below) —
//   this is a closed, well-defined grammar class so a hand-written rule
//   set is reliable without pulling in a model or server
// - Chinese/Japanese still fall back to per-character splitting
// - French/Spanish split on spaces

function splitIntoWords(text, sourceLang) {
  const cleaned = text.replace(/[.,!?"'「」『』“”…]/g, " ").trim();

  if (sourceLang === "ko") {
    return cleaned
      .split(/\s+/)
      .filter(Boolean)
      .flatMap(splitKorean)
      .slice(0, 8);
  }

  if (sourceLang === "zh" || sourceLang === "ja") {
    return cleaned
      .replace(/\s+/g, "")
      .split("")
      .filter(Boolean)
      .slice(0, 6); // cap so the popup doesn't get enormous on long selections
  }

  return cleaned.split(/\s+/).filter(Boolean).slice(0, 6);
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
