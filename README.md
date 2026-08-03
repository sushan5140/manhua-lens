# Manhua Lens

Manhua Lens is a Microsoft Edge/Chromium extension for reading Korean, Japanese, Chinese, French, and Spanish text directly on webpages. Highlight a phrase to open a compact panel with a translation, word-by-word dictionary results, readings, grammar labels, and pronunciation.

## Features

- Selection-based translation panel on regular webpages and embedded frames
- Offline word dictionaries for Korean, Japanese, Chinese, French, and Spanish
- Romanized readings and part-of-speech information where available
- Korean particle splitting and labels
- Sentence and individual-word pronunciation through the browser's text-to-speech API
- Resilient offline results when the online sentence-translation service is unavailable
- Built-in page activation check in the toolbar popup

## Install in Microsoft Edge

1. Download or clone this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this repository folder—the folder containing `manifest.json`.
6. Allow Manhua Lens to run on all sites and refresh any tabs that were already open.

If a page does not respond to text selection, open Manhua Lens from Edge's Extensions menu. The settings popup checks whether the extension is active and can activate it on the current page.

## Use

1. Choose the source and target languages from the toolbar popup.
2. Highlight text on an `http://` or `https://` webpage.
3. Use the speaker controls for the entire selection or an individual word.
4. Clear the selection or press the panel's close button when finished.

Edge does not allow content extensions to run on protected pages such as `edge://` URLs or the Edge Add-ons store.

## Project structure

- `manifest.json` — Manifest V3 extension configuration
- `content.js` / `content.css` — selection detection and translation panel
- `background.js` — dictionary lookup, translation, and text-to-speech
- `options.html` / `options.js` — language settings and page activation check
- `dictionaries/` — bundled offline dictionary data and source notes

Dictionary provenance and transformation notes are documented in [`dictionaries/SOURCES.md`](dictionaries/SOURCES.md).

## Current version

`0.2.4`

