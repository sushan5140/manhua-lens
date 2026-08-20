# Translation Lens dictionary attribution

The JSON lexicons in this folder were converted from the data-only lexicon files distributed with [Translation Lens Windows v1.0.0](https://github.com/cristaecooks/translation-lens-windows/releases/tag/v1.0.0), published by Cristae Cooks on 18 August 2026. The conversion changed the serialization format from Python pickle to browser-readable JSON and normalized the fields used by Manhua Lens.

The adapted lexicons remain licensed under the [Creative Commons Attribution-ShareAlike 4.0 International license](https://creativecommons.org/licenses/by-sa/4.0/).

Upstream data sources named by Translation Lens:

- Chinese: [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict)
- Japanese: [JMdict/EDICT](https://www.edrdg.org/jmdict/j_jmdict.html), Electronic Dictionary Research and Development Group
- Korean: English Wiktionary data extracted by [kaikki.org](https://kaikki.org/)
- French, Spanish, Italian, German, Portuguese, Czech, Turkish, and Latin: Wiktionary-derived data distributed through [WikDict](https://www.wikdict.com/)

No executable code from the Windows release is included. The release's pickle files were inspected before conversion and loaded with a restricted data-only unpickler that rejects global objects and executable constructors.
