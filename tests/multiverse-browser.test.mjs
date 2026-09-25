import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdir} from "node:fs/promises";
import {chromium} from "playwright";

const ROOT = process.cwd();
const BASE = "http://127.0.0.1:8080";
async function serverReady() {
  for(let n=0;n<50;n++){
    try{
      const r=await fetch(BASE+"/api/health");
      if(r.ok){
        const j=await r.json();
        if(j.app==="Manhua Multiverse")return j;
      }
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw Error("Story server did not start");
}
test("real browser: freeform intervention, character memory, fork, compare, reload and mobile",{
  timeout:120000
}, async t=>{
  const server=spawn("python",["multiverse/server.py"],{
    cwd:ROOT,env:{...process.env,GROQ_API_KEY:"",OPENROUTER_API_KEY:"",
      OLLAMA_BASE_URL:"",PORT:"8080"},stdio:"pipe"
  });
  let browser;
  t.after(async()=>{
    if(browser)await browser.close();
    if(server.exitCode===null){
      server.kill("SIGTERM");
      await new Promise(resolve=>server.once("exit",resolve));
    }
  });
  const health=await serverReady();
  assert.equal(health.mode,"offline");
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  const r=await page.goto(BASE+"/multiverse/",{waitUntil:"domcontentloaded"});
  assert.equal(r.status(),200);
  await page.locator("#server-mode").filter({hasText:"OFFLINE"}).waitFor();
  assert.match(await page.locator("#scene-title").textContent(),/Thirteenth Platform/);
  assert.equal(await page.locator("#choices .choice").count(),4);
  const before=await page.locator("#scene-image").boundingBox();
  assert.ok(before.width>300,"scene illustration should be visible on desktop");

  // Real DOM submit, actual POST to Python, and state returned to UI.
  await page.locator("#action-input").fill("I ask Jae to show me the silver key");
  await page.locator("#action-submit").click();
  await page.locator("#scene-title").filter({hasText:"The key changes hands"}).waitFor();
  assert.match(await page.locator("#facts").textContent(),/In your possession/);
  await page.locator('[data-character="jae"]').click();
  await page.locator("#chat-input").fill("Where is the silver key?");
  await page.locator("#chat-submit").click();
  await page.locator(".chat-bubble").filter({hasText:"Jae:"}).waitFor();
  assert.ok((await page.locator(".chat-bubble").count())>=2);

  // Fork the initial moment. Alternate world must NOT inherit action or chat.
  await page.locator(".moment").first().locator(".fork-btn").click();
  await page.locator("#scene-title").filter({hasText:"The Thirteenth Platform"}).waitFor();
  assert.match(await page.locator("#branch-count").textContent(),/2 timelines/);
  assert.doesNotMatch(await page.locator("#facts").textContent(),/In your possession/);
  assert.equal(await page.locator(".chat-bubble").count(),0);
  await page.locator("#compare-toggle").click();
  await page.locator("#comparison-grid").filter({hasText:"Key: held"}).waitFor();
  assert.match(await page.locator("#comparison-grid").textContent(),/diverge/);

  // New actual intervention, independent state.
  await page.locator("#action-input").fill("Follow Sori into the archive");
  await page.locator("#action-submit").click();
  await page.locator("#scene-title").filter({hasText:"Sori's invitation"}).waitFor();
  assert.doesNotMatch(await page.locator("#facts").textContent(),/In your possession/);
  await page.locator("#branch-select").selectOption("thread-1");
  await page.locator("#scene-title").filter({hasText:"The key changes hands"}).waitFor();
  assert.match(await page.locator("#facts").textContent(),/In your possession/);
  assert.ok((await page.locator(".chat-bubble").count())>=2);

  // Local browser persistence.
  await page.reload({waitUntil:"domcontentloaded"});
  await page.locator("#scene-title").filter({hasText:"The key changes hands"}).waitFor();
  assert.match(await page.locator("#branch-count").textContent(),/2 timelines/);

  await mkdir("artifacts",{recursive:true});
  await page.screenshot({path:"artifacts/multiverse-desktop.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  const sizes=await page.evaluate(()=>{
    const scene=document.querySelector(".scene-card").getBoundingClientRect();
    const talk=document.querySelector(".conversation").getBoundingClientRect();
    return {sceneBottom:scene.bottom,talkTop:talk.top,
      pageWidth:document.documentElement.scrollWidth,viewport:innerWidth};
  });
  assert.ok(sizes.talkTop>=sizes.sceneBottom-1,"mobile dialogue must follow scene");
  assert.ok(sizes.pageWidth<=sizes.viewport+2,
    "mobile layout has unexpected horizontal overflow");
  await page.screenshot({path:"artifacts/multiverse-mobile.png",fullPage:true});
  assert.deepEqual(errors,[],"browser JavaScript errors");
});
