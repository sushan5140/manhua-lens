import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,existsSync} from "node:fs";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {
  newWorld,loadWorld,replay,forkWorld,switchWorld,moments,
  transcript,lastOptions,lastEvent,OPENING_OPTIONS
} from "../multiverse/engine.mjs";
const root=join(dirname(fileURLToPath(import.meta.url)),"..","multiverse");
const html=readFileSync(join(root,"index.html"),"utf8");
const js=readFileSync(join(root,"live.mjs"),"utf8");
const css=readFileSync(join(root,"style.css"),"utf8");
test("all seven local, original scene-illustration assets remain available",()=>{
  for(const name of ["station","archive","tunnel","tower","city","pact","freedom"]){
    const p=join(root,"art",name+".svg");
    assert.ok(existsSync(p),name+" missing");
    const image=readFileSync(p,"utf8");
    assert.match(image,/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.match(image,/<\/svg>$/);
  }
});
test("horizontal timeline, scene and character chat are a unified visible workspace",()=>{
  const timeline=html.indexOf('id="timeline"');
  const duo=html.indexOf('class="reader-duo"');
  const scene=html.indexOf('class="scene-card"');
  const talk=html.indexOf('id="conversation"');
  const worlds=html.indexOf('id="worlds"');
  assert.ok(timeline>0&&timeline<duo&&duo<scene&&scene<talk&&talk<worlds);
  for(const name of ["action-form","action-input","chat-form","chat-input","chat-log","branch-select","journal","facts","restart"]){
    assert.ok(html.includes('id="'+name+'"'),name+" missing");
  }
  assert.match(css,/\.reader-duo\{display:grid;grid-template-columns:/);
  assert.match(css,/\.timeline\{display:flex;align-items:stretch;overflow-x:auto/);
});
test("freeform messages and interventions really post to local backend",()=>{
  assert.match(js,/post\("\/api\/act",\{world,text\}\)/);
  assert.match(js,/post\("\/api\/chat",\{world,character,text\}\)/);
  assert.match(js,/performAction\(\$\("action-input"\)\.value\)/);
  assert.match(js,/performChat\(\$\("chat-input"\)\.value\)/);
  assert.match(js,/fetch\("\/api\/health"/);
  assert.match(js,/validateWorld\(result\.world\)/);
});
test("replay, fork and save isolation work on dynamic events, not 4 static choices",()=>{
  const w=newWorld();
  assert.deepEqual(lastOptions(w),OPENING_OPTIONS);
  w.branches[0].events.push({
    type:"action",text:"I take the key",title:"Key obtained",scene:"tunnel",
    narrative:"The key is yours.",changes:{add_items:["silver key"],trust:{jae:1}},
    options:["Ask Jae about the clock","Investigate Sori"]
  });
  w.branches[0].events.push({
    type:"chat",character:"jae",text:"Is this real?",reply:"It is real.",mode:"offline"
  });
  assert.equal(replay(w.branches[0]).scene,"tunnel");
  assert.equal(replay(w.branches[0]).turn,1);
  assert.equal(transcript(w).length,1);
  assert.equal(moments(w).at(-1).index,1);
  assert.equal(lastOptions(w)[0],"Ask Jae about the clock");
  assert.equal(lastEvent(w).title,"Key obtained");
  const fork=forkWorld(w,0);
  assert.equal(fork.branches[0].events.length,2);
  assert.equal(fork.branches[1].events.length,0);
  assert.equal(replay(fork.branches[1]).turn,0);
  assert.equal(replay(switchWorld(fork,"thread-1").branches[0]).turn,1);
  assert.deepEqual(loadWorld(JSON.stringify(fork)),fork);
  assert.deepEqual(loadWorld("{bad"),newWorld());
});
test("licensed titles remain secondary outbound discovery, never story data",()=>{
  assert.match(html,/Permission requested · Not playable/);
  assert.match(html,/only with permission/);
  assert.match(html,/rel="noopener noreferrer"/);
  assert.doesNotMatch(js,/webtoons\.com|tapas\.io/);
});
test("accessible and responsive with reduced motion + no exposed keys",()=>{
  assert.match(css,/@media\(max-width:820px\)/);
  assert.match(css,/@media\(max-width:560px\)/);
  assert.match(css,/prefers-reduced-motion:reduce/);
  assert.match(css,/:focus-visible/);
  assert.doesNotMatch(js,/GROQ_API_KEY|OPENROUTER_API_KEY.*=|sk-[A-Za-z0-9]{15}/);
  assert.ok(existsSync(join(root,".env.example")));
});
