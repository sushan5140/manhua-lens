# Dictionary sources and licenses

The five JSON files are separate derived datasets. Redistribution must preserve the attribution and share-alike terms of the source used for each file. No examples, audio, images, or machine-generated definitions are included.

## Japanese (`ja.json`)

- **Source:** EDRDG [JMdict/EDICT project](https://www.edrdg.org/wiki/JMdict-EDICT_Dictionary_Project), English-only `JMdict_e.gz` XML export.
- **Snapshot:** XML header `JMdict created: 2026-08-03`; downloaded 2026-08-04 from `https://www.edrdg.org/pub/Nihongo/JMdict_e.gz`.
- **License:** [Creative Commons Attribution-ShareAlike 4.0 International](https://www.edrdg.org/edrdg/licence.html). Copyright Electronic Dictionary Research and Development Group.
- **Filtering:** Candidate spellings/readings were retained when present in the top 80,000 Japanese `wordfreq` forms or marked by a JMdict priority tag (`news`, `ichi`, `spec`, `gai`, or `nf`). Proper nouns were excluded. Candidates were ranked by frequency plus JMdict priority and the first 25,000 distinct headwords were emitted. English glosses remain separate senses; duplicate senses were removed and a maximum of 12 senses was retained per headword.
- **Reading/POS:** JMdict kana readings were converted to Hepburn romaji with pykakasi 2.3.0. JMdict POS descriptions were normalized to the short English labels used by the common schema.

## Chinese (`zh.json`)

- **Source:** [CC-CEDICT](https://cc-cedict.org/wiki/), MDBG traditional/simplified UTF-8 release archive `cedict_1_0_ts_utf-8_mdbg.zip`.
- **Snapshot:** Archive header date `2026-08-03T03:48:14Z`, version 1.0, 124,750 source entries; downloaded 2026-08-04 from `https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.zip`.
- **License:** [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/), as stated in the downloaded archive and the current CC-CEDICT download page. Copyright CC-CEDICT contributors; published by MDBG.
- **Filtering:** Simplified and traditional spellings were considered independently when present in the top 100,000 Chinese `wordfreq` forms. Surname/proper-name entries were excluded. The 25,000 highest-ranked distinct headwords were emitted. Slash-separated CC-CEDICT definitions remain separate senses; duplicates were removed and senses were capped at 12 per headword.
- **Reading/POS:** CC-CEDICT numbered pinyin was converted deterministically to tone marks. CC-CEDICT does not provide a structured POS field, so POS is conservatively derived from explicit English definition markers (for example, `to ...`, `adjective`, `classifier`); unmarked lexical definitions default to `noun`. Definitions themselves are unchanged apart from whitespace cleanup and a 260-character safety cap.

## Korean (`ko.json`)

- **Source:** National Institute of Korean Language **Korean Basic Dictionary** (한국어기초사전) XML, obtained without signup from the [spellcheck-ko/korean-dict-nikl](https://github.com/spellcheck-ko/korean-dict-nikl) mirror, `krdict/001.xml` through `krdict/011.xml`.
- **Snapshot:** Dictionary XML creation date `2026/06/19 12:38:52`; mirror commit `42c0d01889f34536e9cf94fe57f62bd2055b1bde`.
- **License:** [Creative Commons Attribution-ShareAlike 2.0 Korea](https://creativecommons.org/licenses/by-sa/2.0/kr/), as documented by the mirror and the [NIKL Korean Basic Dictionary copyright policy](https://krdict.korean.go.kr/kor/kboardPolicy/copyRightTermsInfo). Copyright National Institute of Korean Language.
- **Filtering:** Only entries containing an English equivalent were eligible. Ranking combines the top 100,000 Korean `wordfreq` forms with the source's own beginner/intermediate/advanced vocabulary level; the first 25,000 distinct headwords were emitted. Equivalent lemmas supplied by the source form the concise English definitions. Duplicates were removed and senses were capped at 12.
- **Reading/POS:** Readings use the source-supplied pronunciation form when available, converted by a self-contained Revised Romanization mapping for precomposed Hangul; otherwise the written headword is romanized. Korean POS labels supplied by NIKL were mapped to short English labels.
- **Coverage note:** Korean coverage and English sense detail are lower than JMdict, CC-CEDICT, and the Wiktionary extracts. This learner dictionary is the best clearly licensed, no-signup Korean-English source located for this build. Source examples and all media were deliberately excluded because the mirror warns that quoted examples and media may have separate, non-redistributable rights.

## French (`fr.json`) and Spanish (`es.json`)

- **Source:** [kaikki.org machine-readable dictionaries](https://kaikki.org/dictionary/), postprocessed English Wiktionary/Wiktextract JSONL for [French](https://kaikki.org/dictionary/French/index.html) and [Spanish](https://kaikki.org/dictionary/Spanish/index.html).
- **Snapshot:** Language extracts generated 2026-07-25 from the English Wiktionary dump dated 2026-07-06, using Wiktextract commit `d9fa233` and wikitextprocessor commit `9e92f4b`, as recorded on the language download pages. Streamed 2026-08-04.
- **License:** Wiktionary entry text is dual-licensed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) and the [GNU Free Documentation License 1.1 or later](https://www.gnu.org/licenses/old-licenses/fdl-1.1.html), with no invariant sections, front-cover texts, or back-cover texts. See [Wiktionary:Copyrights](https://en.wiktionary.org/wiki/Wiktionary:Copyrights). The extraction was produced by Tatu Ylonen's [Wiktextract](https://github.com/tatuylonen/wiktextract).
- **Filtering:** Headwords had to occur in the top 100,000 `wordfreq` forms for the corresponding language. Proper names, characters, symbols, and punctuation were excluded; the 25,000 highest-ranked distinct headwords per language were emitted. Wiktionary glosses remain separate senses, duplicates were removed, and senses were capped at 12. Etymology, examples, links, categories, forms tables, and media were discarded. Readings are empty strings as required.

## Frequency ranking helper

`wordfreq` 3.1.1 was used only to rank and filter headwords; it supplied no definitions, readings, or POS values. The package is Apache-2.0 and its redistributed data includes CC BY-SA 4.0 material; see the [wordfreq project](https://github.com/rspeer/wordfreq). pykakasi 2.3.0 (GPL-3.0-or-later) was used as a build-time Japanese transliteration tool. The JSON outputs contain no helper-package code.
