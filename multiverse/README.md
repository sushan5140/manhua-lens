# Manhua Multiverse — The Stolen Tomorrow

**Status:** original-fiction, standalone, deterministic interactive STORY PROTOTYPE (V0). It is NOT yet live generative character chat, panel OCR, copyrighted-comic ingestion, AI-generated branches, or a research validation of narrative consistency.

Manhua Multiverse is the next concept adjacent to Manhua Lens: instead of only looking up Korean in a manhwa, readers could talk to characters, question decisions, and enter counterfactual scenes. The long-term technical challenge is **character identity + causal event consistency across branches**.

## Play the prototype

No dependencies or credentials. From the repository root:

\`\`\`bash
python -m http.server 8080
\`\`\`

Open http://localhost:8080/multiverse/ . Modern Edge, Chrome, Firefox and Safari support the JS module. You can also use \`npx serve .\` from the root; ordinary browsers generally block ES-module imports from \`file://\` so do not double-click the HTML directly.

## Implemented now

- A complete short, **original** fantasy story, *The Stolen Tomorrow*, with 3 possible endings.
- A warm responsive reading UI with two character panels and 4 authored questions each.
- Decisions tracked per-branch. Scripted character answers change when you follow Sori, follow Jae, read/burn the ledger, take/leave the silver key, or reach an ending.
- Causal checks: you cannot repair the clock without a key AND either the ledger or Jae's secret; you cannot trade a memory without the key.
- Fork from an earlier point and independently continue a second timeline; return to the original without losing it.
- Local-only browser storage; explicitly confirm before erasing all timelines.
- Node built-in tests for branch isolation, continuity, locked endings, invalid saves, and character memory.

\`\`\`bash
node --test tests/multiverse.test.mjs
\`\`\`

## Relationship to Manhua Lens

**Existing extension remains unchanged.** Manhua Lens is a Chrome/Edge Manifest V3 text-selection dictionary/translation/pronunciation assistant with Korean/Japanese/Chinese and other languages. The prototype lives in a separate \`multiverse/\` folder, with no host permissions, no extension privileges, no change to Azure voice wiring, no signup, and no backend API key.

Future permitted bridges:
1. Korean dialogue vocabulary cards via a tightly scoped interface to the extension's *existing dictionary data*, without exposing provider secrets.
2. Authorized imported creator material or user-authored original story panels, with provenance/permissions.
3. Server-authenticated LLM character chat, with role and event-state retrieval, a structured candidate-event validator, and human/author approval for canon changes.
4. Original artwork, Korean voice previews and panel-by-panel narrative visual parsing only after the rights/consent boundary is defined.

## AI & copyright honesty

The two characters are **not LLM-driven in V0**. Their replies are transparent, hand-authored and causally grounded in the current choice log. There is no use of scanned commercial comics, scraped webtoon images, impersonated real creators, or copyrighted fictional character dialogue. Future user uploads must have a rights/licensing policy and must be kept private by default.

## Why replay, not mutable "facts"

Each timeline stores only an ordered sequence of choice IDs. The engine recomputes facts, available actions, and character dialogue by replay. This avoids one branch accidentally inheriting another branch's knowledge and makes causal errors testable. Forking at step K copies only the first K events.

## Next build: V1

- Panel-based narrative renderer and a scene graph editor for original authors.
- Real LLM chat via server-side key, separate label from authored scene text, grounded on selected timeline summaries.
- Draft alternatives are *non-canon* until validated; no agent may silently rewrite prior choice events.
- Reproducible benchmark for character consistency, chronology, causal contradictions, memory leakage across branches, unsupported claims, user agency and latency.
- A separate Vercel project only when this branch's UI is accepted. No deployment or merge has been done by this PR.

## Repo impact

Files added: \`multiverse/\`, \`tests/multiverse.test.mjs\`, and an opt-in CI workflow. No change to root \`manifest.json\`, \`background.js\`, \`content.js\`, dictionary files, voice server, or extension settings.
