import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "content.js"), "utf8");

const exposed = {};
const context = vm.createContext({
  console,
  document: { addEventListener() {} },
  window: { addEventListener() {} },
  chrome: {
    runtime: { onMessage: { addListener() {} } }
  },
  __MHL_TEST_EXPOSE__: (internals) => Object.assign(exposed, internals)
});

vm.runInContext(source, context, { filename: "content.js" });

const {
  clampNumber,
  rotateDelta,
  rotatedBoundingBox,
  hexToRgb,
  rgbToHex,
  darkenHex,
  hexToRgba,
  perceivedBrightness,
  isValidHexColor,
  normalizeAccent,
  normalizeWindowStyle,
  normalizeRotation,
  clampWindowGeometry,
  ACCENT_PRESETS,
  SHAPE_KEYS,
  MIN_WIDTH,
  MIN_HEIGHT,
  ROTATE_MAX
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
assert.ok(perceivedBrightness("#ffffff") > perceivedBrightness("#000000"));
assert.ok(isValidHexColor("#2E5E99"));
assert.ok(isValidHexColor("#abc"));
assert.ok(!isValidHexColor("not-a-color"));
assert.ok(!isValidHexColor("2E5E99"));

// The whole curated palette must stay legible: white header text needs
// reasonable contrast against every preset's light AND dark gradient stop.
for (const [name, { light, dark }] of Object.entries(ACCENT_PRESETS)) {
  assert.ok(perceivedBrightness(light) <= 130, `${name} light stop too bright for white text`);
  assert.ok(perceivedBrightness(dark) <= 60, `${name} dark stop too bright for white text`);
}

// ---------- normalization ----------

assert.equal(normalizeAccent("purple"), "purple");
assert.equal(normalizeAccent("#336699"), "#336699");
assert.equal(normalizeAccent("not-a-real-accent"), "default");
assert.equal(normalizeAccent(undefined), "default");

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

console.log("Floating window customization tests passed.");
