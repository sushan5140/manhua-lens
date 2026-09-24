import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "multiverse");
const html = readFileSync(join(root, "index.html"), "utf8");
const js = readFileSync(join(root, "app.mjs"), "utf8");
const css = readFileSync(join(root, "style.css"), "utf8");
test("all shipped scene illustrations are original local assets", () => {
  for (const name of ["station","archive","tunnel","tower","city","pact","freedom"]) {
    const p = join(root,"art",name+".svg");
    assert.equal(existsSync(p),true,name+" illustration missing");
    const image = readFileSync(p,"utf8");
    assert.match(image,/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.match(image,/<\/svg>$/);
    assert.match(image,/THE STOLEN TOMORROW/);
  }
});
test("story and character controls render in one scroll flow", () => {
  const scene = html.indexOf('id="scene-image"');
  const choices = html.indexOf('id="choices"');
  const conversation = html.indexOf('id="conversation"');
  const worlds = html.indexOf('id="worlds"');
  assert.ok(scene>0 && choices>scene && conversation>choices && worlds>conversation);
  assert.match(html, /id="reply"/);
  assert.match(html, /id="branch-select"/);
  assert.match(html, /id="restart"/);
  assert.match(html, /aria-live="polite"/);
});
test("scene images and inline dialogue use replayed story state", () => {
  assert.match(js, /art\/".*info\.tone/);
  assert.match(js, /characterReply\(world,activeCharacter,activeQuestion\)/);
  assert.match(js, /localStorage\.setItem\(SAVE_KEY/);
  assert.match(js, /getChoices\(world\)/);
  assert.match(js, /fork\(world,index\)/);
});
test("real manhwa cards remain non-playable licensed-platform outbound links", () => {
  assert.match(html, /rights teams/);
  assert.match(html, /not imported or interactive here/);
  assert.match(html,/rel="noopener noreferrer"/);
  assert.doesNotMatch(js, /tapas\.io|webtoons\.com/);
});
test("responsive, readable, reduced-motion behavior exists", () => {
  assert.match(css, /@media\(max-width:810px\)/);
  assert.match(css, /@media\(max-width:570px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  assert.match(css, /:focus-visible/);
});


test("top horizontal timeline and side-by-side dialogue follow scene hierarchy", () => {
  const timeline = html.indexOf('id="timeline"');
  const duo = html.indexOf('class="reader-duo"');
  const scene = html.indexOf('class="scene-card"');
  const talk = html.indexOf('id="conversation"');
  assert.ok(timeline > 0 && timeline < duo && duo < scene && scene < talk);
  assert.match(css,/\.reader-duo\{display:grid;grid-template-columns:/);
  assert.match(css,/\.journey \.timeline\{display:flex;overflow-x:auto/);
  assert.match(css,/@media\(max-width:800px\)\{\.journey/);
});
test("Yumi cover is a clearly marked external reference, not imported story art", () => {
  assert.match(html,/class="official-cover"/);
  assert.match(html,/Original art © Donggeon Lee/);
  assert.match(html,/COVER REFERENCE ONLY/);
  assert.match(html,/not licensed for our product/);
  assert.match(js,/cover-error/);
  assert.doesNotMatch(html,/art\/yumi\.svg/);
});
