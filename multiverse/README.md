# Manhua Multiverse — The Stolen Tomorrow

**Status:** independent V1 reader UI and original-fiction prototype. **It is not live AI chat or an imported licensed manhwa.** All real-manhwa cards link to their official platforms while permissions are pending.

## Run the redesigned localhost preview

The work is on `feature/manhua-multiverse-foundation`, NOT `main`. If using the separate Windows worktree from our earlier chat:

```powershell
$root = "C:\Users\DELL\Documents\Codex\2026-09-12\continue-work-on-the-manhua-lens\work\manhua-lens"
$preview = Join-Path (Split-Path $root) "manhua-multiverse-preview"
git -C $root fetch origin
git -C $preview switch --detach origin/feature/manhua-multiverse-foundation
cd $preview
py -m http.server 8080
```

Open **http://localhost:8080/multiverse/**, and use **Ctrl+Shift+R** to discard the cached stylesheet. If the worktree does not yet exist, run `git -C $root worktree add --detach $preview origin/feature/manhua-multiverse-foundation` instead of the switch line.

## V1 reading experience

1. Start at the illustrated current scene, not a scattered landing page. Every story moment now has its own `art/<scene>.svg` illustration (seven original vector compositions).
2. Read a compact scene, then choose among the large `What happens next?` buttons directly beneath it.
3. **Ask them before you decide**: Sori and Jae's tabs, four actual questions, and a clearly visible response occupy a full-width dock immediately under the choices.
4. Use the compact timeline rail to fork any moment. The original timeline is not overwritten. The existing local-storage key stays compatible with V0 saves.
5. Use the rights-pending real-manhwa links only as discovery. No third-party comic images or characters were imported.

The app is dependency-free and entirely client-side. The illustrated story and dialogue are created for this demo; `characterReply` is *scripted* and constrained by the same replayed branch state as story decisions.

## Visual/interaction direction

- Reader-centric layout: chapter image → scene text → choice buttons → character questions + response; multiverse rail is secondary, rights-pending titles appear below the main reader.
- Soft warm-paper, charcoal, muted plum and dusty-rose palette with high-contrast functional controls.
- Responsive 1440/1024/768/375 layouts; mobile puts the reader before timeline.
- Native buttons/selects, clear focus rings, alt text, politely announced choices/replies, reduced-motion support, small press-feedback motion only.
- Illustration is an original graphic-vector prototype, not scanned or scraped manhwa art; the previous generated visual mockup was a design reference, not copied as licensed art.

## Run tests

```bash
node --test tests/multiverse.test.mjs tests/multiverse-ui.test.mjs
```

CI checks scene art exists, the story-before-chat-before-discovery DOM order, causal story paths, branch isolation, malicious/corrupt saves, non-playable licensed-title links, responsive CSS and root extension isolation. These are code checks, not a claim of manual cross-browser screenshot testing.

## Product boundary

No new extensions privileges, hosted API keys, sign-in, third-party image downloads, licensed character chat or Vercel deployments. `manifest.json`, `background.js`, `content.js`, existing dictionaries and `voice_server/` remain unchanged. This branch remains a draft PR until design and rights constraints have been reviewed.
