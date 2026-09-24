# MANHUA MULTIVERSE — The Stolen Tomorrow

> This is the **interactive world build**, not the four-button visual demo. Type any action, speak freely to Sori or Jae, let it change inventory/evidence/relationships, fork before any action, and visit a different outcome without erasing the original.

The world is original fiction. No commercial manhwa panels or characters have been imported. Yumi's Cells, Tower of God and The Villainess Turns the Hourglass remain official outbound links while rights requests are pending.

## Windows: update the EXISTING preview branch and start the real story server

Stop the previous \`py -m http.server 8080\` terminal with Ctrl+C. From PowerShell:

\`\`\`powershell
$root = "C:\Users\DELL\Documents\Codex\2026-09-12\continue-work-on-the-manhua-lens\work\manhua-lens"
$preview = Join-Path (Split-Path $root) "manhua-multiverse-preview"
git -C $root fetch origin
git -C $preview switch --detach origin/feature/manhua-multiverse-foundation
cd $preview
py .\multiverse\server.py
\`\`\`

Open **http://localhost:8080/multiverse/** and press Ctrl+Shift+R.

**Important:** \`py -m http.server\` serves HTML but does **not** handle the new \`/api/act\` and \`/api/chat\` routes. You must launch \`py .\multiverse\server.py\`.

## Enable actual open-ended AI (not templates)

The default runs in **clearly labeled OFFLINE / PROCEDURAL** mode, where typed actions have real stateful consequences but the prose and conversation use authored logic. For generative responses to genuinely arbitrary player actions and freeform character dialogue, configure one provider:

\`\`\`powershell
Copy-Item .\multiverse\.env.example .\multiverse\.env
notepad .\multiverse\.env
\`\`\`

Paste your Groq key as \`GROQ_API_KEY=your_key_here\`, OR your OpenRouter key as \`OPENROUTER_API_KEY=your_key_here\` (leave the other blank). Close/restart the server. The header changes to **LIVE AI · GROQ** or **LIVE AI · OPENROUTER**.

You can instead run a local Ollama server and configure \`OLLAMA_BASE_URL=http://127.0.0.1:11434\` plus \`OLLAMA_MODEL=llama3.2\` with both cloud keys blank. A downloaded model and running Ollama are required.

- Do **not** paste keys into the browser, screenshots, chats, GitHub or your deployed frontend. \`multiverse/.env\` is gitignored and the local server explicitly refuses to serve it over HTTP.
- Each cloud-provider call receives the relevant recent text, events and state of the **active branch**. Do not type private information into story actions or chat if you do not want it sent to the configured AI provider.
- The model and network need to be available; a provider error stays visible and **does not** secretly switch to scripted mode or save a failed action.
- The product is designed for localhost. This server is not a secure public-hosting architecture; production requires auth, per-user storage, rate limits, proxy/IP hardening, streaming, provider billing controls and proper licenses.

## What is functional

**You decide.** Enter natural-language actions such as "I steal the key and run toward the tower," "I burn the ledger rather than use its evidence," or "I follow a stranger home instead." In LIVE AI mode the model generates a new scene, narrative and next-action suggestions. In OFFLINE mode the parser handles a meaningful subset and transparently indicates it is procedural.

**Talk to characters.** Type your own message in the adjacent panel. Character replies use the active timeline and a grounded system prompt, not a fixed list of four questions. Sori and Jae have independent displayed conversations within each timeline. Offline has explicitly procedural dialogue.

**Consequences persist.** The engine tracks items, evidence, trust, danger, world flags and a story journal. A restoration requires a silver key AND supporting evidence. A memory bargain needs the key. The backend checks the model's proposed changes and refuses impossible jumps rather than storing contradictory events.

**Multiverse actually branches.** The horizontal rail shows every action. Fork at an earlier moment or at the current moment, then act differently. The newly created world copies only prior events. Switch between named timelines in the dropdown, or press **Compare worlds** to inspect where two worlds diverge and how inventory, discoveries, relationships and endings differ. **Save** and **Open** export/import a JSON backup; a prior V1 save is automatically imported once while leaving the original V1 data untouched. Limit: 24 parallel timelines, 80 recorded events per timeline, and bounded input/context lengths to constrain latency and resource use.

**Visuals.** The original story currently has seven locally bundled, unique vector scene compositions and mapped location families; the title/image changes when your scene changes. This build does **not** claim unlimited AI-generated panels yet. Dynamic art generation and properly licensed commercial manga/manhwa imports are separate pipelines.

## Architecture

- \`server.py\` — Python standard-library HTTP server bound to 127.0.0.1; strict route allowlist prevents .env and other repository files from being exposed; POST \`/api/act\`, \`/api/chat\`; GET \`/api/health\`.
- \`engine.mjs\` — browser-owned dynamic branch envelope, per-branch dialogue logs, causal replay, localStorage, fork/switch.
- \`live.mjs\` — responsive reader, direct freeform action composer, character chat, journal, world facts, timeline UI; API keys never appear in its source.
- \`story.mjs\` and \`app.mjs\` — preserved original V0 scripted demo engine for regression only; not loaded by the new index.
- \`art/*.svg\` — original local scene art. Linked real-manhwa cards are **discovery-only**.
- Original Manhua Lens extension, its dictionary, Azure voice server and its \`main\` branch are unchanged.

## Tests

From repository root:

\`\`\`powershell
node --test tests/multiverse.test.mjs tests/multiverse-ui.test.mjs
py -m unittest discover -s tests -p "test_multiverse_server.py" -v
\`\`\`

CI runs both, tests localhost GET/POST requests, verifies causal restrictions and checks no extension files changed. Live provider calls are mocked in CI; actual Groq/OpenRouter/Ollama access is only verifiable after a local key/model has been configured. Do not mistake passing mocked tests for a successful live-provider demonstration.
