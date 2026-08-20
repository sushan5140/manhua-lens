import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "content.js"), "utf8");

const exposed = {};

// A switchable chrome.storage.sync mock so storage-failure resilience
// (section 4 of the verification pass) can be exercised against the real
// getPrefs()/setPrefs() from content.js, not a re-implementation of them.
let storageMode = "normal"; // "normal" | "error" | "throw" | "never-callback"
const storageData = {};
const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  document: { addEventListener() {} },
  window: { addEventListener() {} },
  chrome: {
    runtime: {
      onMessage: { addListener() {} },
      get lastError() {
        return storageMode === "error" ? { message: "mock storage error" } : undefined;
      }
    },
    storage: {
      sync: {
        get(defaults, cb) {
          if (storageMode === "throw") throw new Error("mock chrome.storage.sync.get threw");
          if (storageMode === "never-callback") return;
          cb({ ...defaults, ...storageData });
        },
        set(values, cb) {
          if (storageMode === "throw") throw new Error("mock chrome.storage.sync.set threw");
          if (storageMode === "never-callback") return;
          Object.assign(storageData, values);
          if (cb) cb();
        }
      }
    }
  },
  __MHL_TEST_EXPOSE__: (internals) => Object.assign(exposed, internals)
});

vm.runInContext(source, context, { filename: "content.js" });

const {
  clampNumber,
  rotateDelta,
  rotatedBoundingBox,
  computeFitScale,
  fitSizeToViewport,
  hexToRgb,
  rgbToHex,
  darkenHex,
  hexToRgba,
  relativeLuminance,
  contrastRatio,
  pickAccentForeground,
  ensureLegibleAsBackground,
  isValidHexColor,
  normalizeAccent,
  normalizeWindowStyle,
  normalizeRotation,
  clampWindowGeometry,
  ACCENT_PRESETS,
  SHAPE_KEYS,
  MIN_WIDTH,
  MIN_HEIGHT,
  ROTATE_MAX,
  WCAG_AA_NORMAL_TEXT,
  ACCENT_FG_LIGHT,
  ACCENT_FG_DARK,
  getPrefs,
  setPrefs
} = exposed;

// ---------- clampNumber ----------

assert.equal(clampNumber(5, 0, 10), 5);
assert.equal(clampNumber(-5, 0, 10), 0);
assert.equal(clampNumber(50, 0, 10), 10);
assert.equal(clampNumber(NaN, 2, 10), 2, "NaN falls back to the minimum");

// ---------- rotateDelta ----------

{
  // At 0 degrees, screen-space and local-space deltas are identical.
  const d = rotateDelta(12, -7, 0);
  assert.ok(Math.abs(d.x - 12) < 1e-9 && Math.abs(d.y - (-7)) < 1e-9);
}
{
  // At 90 degrees the panel's local "width" axis now points straight down
  // on screen (CSS rotate() is clockwise), so a downward screen drag should
  // read back as pure local-width growth, not local-height growth.
  const d = rotateDelta(0, 10, 90);
  assert.ok(Math.abs(d.x - 10) < 1e-9, "local width should carry the full delta");
  assert.ok(Math.abs(d.y) < 1e-9, "local height should cancel out");
}

// ---------- rotatedBoundingBox ----------

{
  const box = rotatedBoundingBox(100, 50, 0);
  assert.equal(box.width, 100);
  assert.equal(box.height, 50);
}
{
  // A 100x50 box rotated 90 degrees occupies a 50x100 footprint.
  const box = rotatedBoundingBox(100, 50, 90);
  assert.ok(Math.abs(box.width - 50) < 1e-9);
  assert.ok(Math.abs(box.height - 100) < 1e-9);
}
{
  // Rotation always grows (or preserves) the on-screen footprint.
  const box = rotatedBoundingBox(300, 200, 30);
  assert.ok(box.width > 300 && box.height > 200);
}

// ---------- hex/color helpers ----------

// Compared field-by-field (rather than assert.deepEqual) because these
// plain objects are constructed inside the vm sandbox's separate realm.
{
  const rgb = hexToRgb("#2E5E99");
  assert.equal(rgb.r, 46);
  assert.equal(rgb.g, 94);
  assert.equal(rgb.b, 153);
}
{
  const rgb = hexToRgb("#fff");
  assert.equal(rgb.r, 255);
  assert.equal(rgb.g, 255);
  assert.equal(rgb.b, 255);
}
assert.equal(rgbToHex(46, 94, 153), "#2e5e99");
assert.equal(darkenHex("#ffffff", 0.5), "#808080");
assert.equal(hexToRgba("#2E5E99", 0.14), "rgba(46, 94, 153, 0.14)");
assert.ok(isValidHexColor("#2E5E99"));
assert.ok(isValidHexColor("#abc"));
assert.ok(isValidHexColor("#ABCDEF"));
assert.ok(!isValidHexColor("not-a-color"));
assert.ok(!isValidHexColor("2E5E99"));
assert.ok(!isValidHexColor("rgb(1,2,3)"));
assert.ok(!isValidHexColor(null));
assert.ok(!isValidHexColor(undefined));
assert.ok(!isValidHexColor(12345));

// ---------- WCAG relative luminance / contrast ----------
// An independent reference implementation (built straight from the WCAG
// spec formulas, not by re-using content.js's own code) cross-checks the
// exposed functions so a bug in content.js's implementation can't hide
// behind a test that just re-derives the same bug.

function refHexToRgb(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
}
function refChannel(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function refLuminance(hex) {
  const { r, g, b } = refHexToRgb(hex);
  return 0.2126 * refChannel(r) + 0.7152 * refChannel(g) + 0.0722 * refChannel(b);
}
function refContrast(hexA, hexB) {
  const l1 = refLuminance(hexA);
  const l2 = refLuminance(hexB);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// Canonical known values: pure white vs pure black is the maximum possible
// WCAG contrast ratio (21:1); a color against itself is always 1:1.
assert.ok(Math.abs(refContrast("#ffffff", "#000000") - 21) < 1e-6, "reference implementation sanity check");
assert.ok(Math.abs(relativeLuminance("#ffffff") - 1) < 1e-6);
assert.ok(Math.abs(relativeLuminance("#000000") - 0) < 1e-6);
assert.ok(Math.abs(contrastRatio("#ffffff", "#000000") - 21) < 1e-6, "content.js contrastRatio disagrees with the WCAG reference formula");
assert.ok(Math.abs(contrastRatio("#2E5E99", "#2E5E99") - 1) < 1e-6, "a color against itself must be 1:1");

// Cross-check content.js's exposed implementation against the independent
// reference for every curated accent stop plus a spread of arbitrary colors.
for (const hex of [
  "#2E5E99", "#0D2440", "#ffffff", "#000000", "#ff0000", "#00ff00", "#0000ff",
  "#ffff00", "#00ffff", "#123456", "#abcabc"
]) {
  assert.ok(
    Math.abs(relativeLuminance(hex) - refLuminance(hex)) < 1e-9,
    `relativeLuminance(${hex}) disagrees with the WCAG reference`
  );
}

// ---------- curated palette contrast (WCAG AA, 4.5:1) ----------

for (const [name, { light, dark }] of Object.entries(ACCENT_PRESETS)) {
  const fg = pickAccentForeground(light, dark);
  const ratioAgainstLight = contrastRatio(fg, light);
  const ratioAgainstDark = contrastRatio(fg, dark);
  assert.ok(
    ratioAgainstLight >= WCAG_AA_NORMAL_TEXT,
    `${name}: header fg vs light stop is only ${ratioAgainstLight.toFixed(2)}:1 (need ${WCAG_AA_NORMAL_TEXT}:1)`
  );
  assert.ok(
    ratioAgainstDark >= WCAG_AA_NORMAL_TEXT,
    `${name}: header fg vs dark stop is only ${ratioAgainstDark.toFixed(2)}:1 (need ${WCAG_AA_NORMAL_TEXT}:1)`
  );

  // Active-control text (e.g. the selected language in a dropdown) is
  // rendered as plain white directly on the light stop, with no gradient
  // to fall back on, so that combination is checked on its own too.
  const activeControlRatio = contrastRatio("#ffffff", light);
  assert.ok(
    activeControlRatio >= WCAG_AA_NORMAL_TEXT,
    `${name}: white active-control text on the light stop is only ${activeControlRatio.toFixed(2)}:1`
  );
}

// ---------- custom-color foreground selection ----------
// Mirrors applyAccent()'s actual pipeline for a non-preset color: clamp the
// picked color to a legible brightness first (a raw pick like pure white
// or bright yellow otherwise has no gradient stop dark enough for ANY
// foreground to read against — see the commit message for the WCAG math),
// derive the dark stop from that already-legible color, then pick fg.

const CUSTOM_COLOR_EDGE_CASES = [
  "#ffffff", // pure white
  "#fefefe", // near-white
  "#000000", // pure black
  "#000033", // very dark blue
  "#ffee00", // bright yellow
  "#ff0000", // saturated red
  "#00ff00", // saturated green
  "#00ffff"  // saturated cyan
];

for (const hex of CUSTOM_COLOR_EDGE_CASES) {
  const light = ensureLegibleAsBackground(hex, ACCENT_FG_LIGHT);
  const dark = darkenHex(light, 0.42);
  assert.ok(isValidHexColor(light), `${hex}: ensureLegibleAsBackground produced an invalid color (${light})`);
  assert.ok(isValidHexColor(dark), `${hex}: darkenHex produced an invalid color (${dark})`);

  const fg = pickAccentForeground(light, dark);
  assert.ok(fg === ACCENT_FG_LIGHT || fg === ACCENT_FG_DARK, `${hex}: picked an unexpected foreground (${fg})`);

  const ratio = Math.min(contrastRatio(fg, light), contrastRatio(fg, dark));
  assert.ok(ratio >= WCAG_AA_NORMAL_TEXT, `${hex}: best available foreground only reaches ${ratio.toFixed(2)}:1`);

  // Darkening a color that's already legible must be a no-op (idempotent),
  // so re-picking the same custom color twice can't keep darkening it.
  assert.equal(ensureLegibleAsBackground(light, ACCENT_FG_LIGHT), light, `${hex}: clamping is not idempotent`);
}

// A color that already passes must be returned completely unchanged.
assert.equal(ensureLegibleAsBackground("#0D2440", ACCENT_FG_LIGHT), "#0D2440");

// hexToRgb must never throw even on garbage input (defense in depth — the
// real code path is already guarded by normalizeAccent, but a corrupted
// stored preference could still reach these lower-level helpers directly).
for (const bad of ["not-a-color", "", "#", "#zzzzzz"]) {
  assert.doesNotThrow(() => hexToRgb(bad));
  assert.doesNotThrow(() => darkenHex(bad, 0.5));
}

// ---------- normalization ----------

assert.equal(normalizeAccent("purple"), "purple");
assert.equal(normalizeAccent("#336699"), "#336699");
assert.equal(normalizeAccent("not-a-real-accent"), "default");
assert.equal(normalizeAccent(undefined), "default");

// Malformed/invalid values reaching normalizeAccent programmatically (e.g.
// a corrupted stored preference) must never crash and must always fall
// back to a safe, known-good accent.
for (const bad of [null, 123, {}, [], "", "javascript:alert(1)", "#12", "#gggggg", "   ", "PURPLE"]) {
  assert.equal(normalizeAccent(bad), "default", `normalizeAccent(${JSON.stringify(bad)}) should fall back to "default"`);
}
assert.equal(normalizeAccent("#ABCDEF"), "#abcdef", "valid hex is preserved but lowercased");

assert.equal(normalizeWindowStyle("bubble"), "bubble");
assert.equal(normalizeWindowStyle("nonsense"), "classic");
assert.equal(Array.from(SHAPE_KEYS).join(","), "classic,soft,compact,square,bubble");

assert.equal(normalizeRotation(12.6), 13);
assert.equal(normalizeRotation(999), ROTATE_MAX);
assert.equal(normalizeRotation(-999), -ROTATE_MAX);
assert.equal(normalizeRotation("nope"), 0);

// ---------- clampWindowGeometry ----------

{
  // A window saved on a large monitor must clamp fully inside a smaller one.
  const saved = { x: 1800, y: 1000, width: 460, height: 500, rotation: 0 };
  const result = clampWindowGeometry(saved, 1024, 768);
  assert.ok(result.x + result.width <= 1024);
  assert.ok(result.y + result.height <= 768);
  assert.ok(result.width >= MIN_WIDTH);
  assert.ok(result.height >= MIN_HEIGHT);
}
{
  // Rotation enlarges the on-screen footprint, so clamping must account for
  // the rotated bounding box, not just the raw width/height.
  const result = clampWindowGeometry({ x: 900, y: 700, width: 400, height: 300, rotation: 45 }, 1024, 768);
  const box = rotatedBoundingBox(result.width, result.height, 45);
  assert.ok(result.x + box.width <= 1024 + 1e-6);
  assert.ok(result.y + box.height <= 768 + 1e-6);
}
{
  // Unset (never-moved) coordinates stay unset rather than being coerced to 0.
  const result = clampWindowGeometry({ x: null, y: null, width: null, height: null, rotation: 0 }, 1024, 768);
  assert.equal(result.x, null);
  assert.equal(result.y, null);
  assert.equal(result.width, null);
  assert.equal(result.height, null);
}
{
  // Width/height below the sensible minimum are raised, never left tiny.
  const result = clampWindowGeometry({ x: 10, y: 10, width: 10, height: 10, rotation: 0 }, 1024, 768);
  assert.equal(result.width, MIN_WIDTH);
  assert.equal(result.height, MIN_HEIGHT);
}
{
  // Regression: a panel whose *unrotated* width/height each individually
  // fit the viewport can still have a rotated bounding box taller/wider
  // than the viewport (rotation inflates the footprint). No x/y exists
  // that fits an over-sized box, so the size itself must shrink — found via
  // real-browser QA where a 340x581 panel rotated 10deg on a 1026x608
  // viewport produced a footprint 631px tall, hanging off the bottom
  // regardless of how "top" was clamped.
  const result = clampWindowGeometry({ x: 582, y: 8, width: 340, height: 581, rotation: 10 }, 1026, 608);
  const box = rotatedBoundingBox(result.width, result.height, 10);
  assert.ok(box.height <= 608 - 16 + 1e-6, `rotated footprint (${box.height.toFixed(1)}) must fit the 608px viewport`);
  assert.ok(result.y + box.height <= 608 + 1e-6);
  assert.ok(result.width >= MIN_WIDTH && result.height >= MIN_HEIGHT);
}

// ---------- computeFitScale ----------

assert.equal(computeFitScale(100, 100, 200, 200), 1, "a box that already fits is never enlarged");
assert.equal(computeFitScale(100, 100, 50, 200), 0.5, "constrained by the tighter axis (width)");
assert.equal(computeFitScale(100, 100, 200, 40), 0.4, "constrained by the tighter axis (height)");
assert.ok(Math.abs(computeFitScale(400, 300, 200, 300) - 0.5) < 1e-9);

// ---------- fitSizeToViewport ----------

{
  // Already fits: returned unchanged.
  const r = fitSizeToViewport(300, 200, 0, 1000, 1000);
  assert.equal(r.width, 300);
  assert.equal(r.height, 200);
}
{
  // Regression (found via real-browser QA, PID/window resize to 640x450):
  // a saved width below the CURRENT MIN_WIDTH (e.g. from an older version)
  // gets floored to MIN_WIDTH upstream in clampWindowGeometry before this
  // runs; combined with a tall saved height and a moderate rotation, a
  // plain uniform scale can't shrink width below its own floor, so height
  // must absorb the rest on its own. Both the floor and the fit must hold.
  const availW = 1010, availH = 592, rotation = 10;
  const r = fitSizeToViewport(MIN_WIDTH, 581, rotation, availW, availH);
  const box = rotatedBoundingBox(r.width, r.height, rotation);
  assert.equal(r.width, MIN_WIDTH, "width cannot shrink below its own floor");
  assert.ok(r.height >= MIN_HEIGHT);
  assert.ok(box.width <= availW + 1e-6, `box.width ${box.width.toFixed(1)} must fit ${availW}`);
  assert.ok(box.height <= availH + 1e-6, `box.height ${box.height.toFixed(1)} must fit ${availH}`);
}
{
  // Symmetric case: height pinned at its floor, width absorbs the rest.
  const availW = 900, availH = 250, rotation = 10;
  const r = fitSizeToViewport(1200, 180, rotation, availW, availH);
  const box = rotatedBoundingBox(r.width, r.height, rotation);
  assert.equal(r.height, MIN_HEIGHT);
  assert.ok(r.width >= MIN_WIDTH);
  assert.ok(box.width <= availW + 1e-6);
  assert.ok(box.height <= availH + 1e-6);
}
{
  // Never enlarges past the original size, even if there's room to.
  const r = fitSizeToViewport(300, 200, 0, 5000, 5000);
  assert.equal(r.width, 300);
  assert.equal(r.height, 200);
}

// ---------- storage failure safety ----------
// getPrefs()/setPrefs() must never throw or hang the caller, regardless of
// how chrome.storage.sync misbehaves — dragging/resizing/rotating/
// recoloring only ever call these to persist the *final* value, so a
// storage failure should degrade to "this session's change won't be
// remembered next time," never break the interaction itself.

{
  storageMode = "normal";
  const prefs = await getPrefs();
  assert.equal(prefs.windowAccent, "default", "sanity check: normal mode returns real defaults");
}
{
  storageMode = "error";
  const prefs = await getPrefs();
  assert.equal(prefs.windowAccent, "default", "getPrefs must fall back to defaults when lastError is set");
  await assert.doesNotReject(setPrefs({ windowAccent: "purple" }), "setPrefs must resolve, not reject, on a storage error");
}
{
  storageMode = "throw";
  await assert.doesNotReject(getPrefs(), "getPrefs must resolve, not reject/throw, if chrome.storage.sync.get throws synchronously");
  await assert.doesNotReject(setPrefs({ windowAccent: "purple" }), "setPrefs must resolve, not reject/throw, if chrome.storage.sync.set throws synchronously");
}
{
  // Simulates a storage callback that never fires at all (e.g. mid service
  // worker restart). getPrefs() has an internal ~1.5s safety timeout so the
  // panel can still render instead of waiting forever.
  storageMode = "never-callback";
  const start = Date.now();
  const prefs = await getPrefs();
  const elapsed = Date.now() - start;
  assert.equal(prefs.windowAccent, "default", "getPrefs must still resolve with defaults if storage never calls back");
  assert.ok(elapsed < 5000, `getPrefs took ${elapsed}ms to give up — safety timeout should cap this well under 5s`);
}
storageMode = "normal";

console.log("Floating window customization tests passed.");
