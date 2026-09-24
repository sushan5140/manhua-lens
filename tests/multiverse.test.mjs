import test from "node:test";
import assert from "node:assert/strict";
import {
  SCENES, CHOICES, freshWorld, readBranch, getChoices, choose, fork,
  switchBranch, loadWorld, characterReply
} from "../multiverse/story.mjs";

test("first frame has two reachable choices and no invented evidence", () => {
  const world = freshWorld();
  assert.equal(readBranch(world).scene,"station");
  assert.deepEqual(getChoices(world).filter(c=>c.available).map(c=>c.id),
    ["follow_sori","follow_jae"]);
  assert.deepEqual(readBranch(world).facts,{});
});

test("archive ledger is a causal prerequisite for repairing the clock", () => {
  let world = choose(freshWorld(),"follow_sori");
  world = choose(world,"read_ledger");
  assert.equal(readBranch(world).scene,"tower");
  assert.equal(getChoices(world).find(c=>c.id==="restore").available,true);
  world = choose(world,"restore");
  assert.equal(readBranch(world).scene,"city");
  assert.equal(readBranch(world).finished,true);
  assert.equal(getChoices(world).length,0);
  assert.throws(()=>choose(world,"shatter"),/not available/);
});

test("leaving the key makes key-gated endings impossible", () => {
  let world=choose(choose(freshWorld(),"follow_jae"),"leave_key");
  const choices=getChoices(world);
  assert.equal(choices.find(c=>c.id==="restore").available,false);
  assert.equal(choices.find(c=>c.id==="trade").available,false);
  assert.equal(choices.find(c=>c.id==="shatter").available,true);
  assert.throws(()=>choose(world,"restore"),/not available/);
  world=choose(world,"shatter");
  assert.equal(readBranch(world).scene,"freedom");
});

test("burning ledger preserves key but disables evidence-based repair",()=>{
  let world=choose(choose(freshWorld(),"follow_sori"),"burn_ledger");
  assert.equal(readBranch(world).facts.ledgerBurned,true);
  assert.equal(getChoices(world).find(c=>c.id==="restore").available,false);
  assert.equal(getChoices(world).find(c=>c.id==="trade").available,true);
  world=choose(world,"trade");
  assert.equal(readBranch(world).scene,"pact");
});

test("sharing courier secret unlocks key-gated endings without ledger",()=>{
  let world=choose(choose(freshWorld(),"follow_jae"),"keep_key");
  assert.equal(getChoices(world).find(c=>c.id==="restore").available,true);
  assert.equal(readBranch(choose(world,"restore")).scene,"city");
});

test("fork at previous moment preserves original and creates counterfactual",()=>{
  let world=choose(choose(freshWorld(),"follow_sori"),"read_ledger");
  world=choose(world,"restore");
  const first=world.active;
  const original=readBranch(world);
  world=fork(world,1);
  assert.notEqual(world.active,first);
  assert.equal(readBranch(world).scene,"archive");
  assert.equal(readBranch(world,first).scene,"city");
  world=choose(world,"burn_ledger");
  world=choose(world,"trade");
  assert.equal(readBranch(world).scene,"pact");
  assert.equal(readBranch(world,first).scene,"city");
  world=switchBranch(world,first);
  assert.equal(readBranch(world).scene,"city");
  assert.deepEqual(readBranch(world).facts, original.facts);
});

test("different timelines give distinct and honest scripted replies",()=>{
  let world=freshWorld();
  assert.match(characterReply(world,"sori","trust").text,/didn't follow/);
  assert.equal(characterReply(world,"sori","trust").scripted,true);
  world=choose(world,"follow_sori");
  assert.match(characterReply(world,"sori","trust").text,/chose to follow/);
  const alt=fork(world,0);
  assert.match(characterReply(alt,"sori","trust").text,/didn't follow/);
  assert.throws(()=>characterReply(world,"unknown","trust"));
  assert.throws(()=>characterReply(world,"sori","invented"));
});

test("roundtrip loads state; tampering or impossible continuity resets save",()=>{
  let world=choose(choose(freshWorld(),"follow_jae"),"leave_key");
  world=fork(world,0);
  assert.deepEqual(loadWorld(JSON.stringify(world)),world);
  const fake=JSON.parse(JSON.stringify(world));
  fake.branches[0].events.push("restore");
  assert.deepEqual(loadWorld(JSON.stringify(fake)),freshWorld());
  assert.deepEqual(loadWorld("not JSON"),freshWorld());
  assert.deepEqual(loadWorld('{"version":1,"branches":[]}'),freshWorld());
});

test("every ending has a valid original-fiction path",()=>{
  const paths=[
    ["follow_sori","read_ledger","restore","city"],
    ["follow_jae","keep_key","trade","pact"],
    ["follow_jae","leave_key","shatter","freedom"]
  ];
  for(const path of paths){
    let world=freshWorld();
    for(const id of path.slice(0,-1))world=choose(world,id);
    assert.equal(readBranch(world).scene,path.at(-1));
    assert.ok(SCENES[path.at(-1)].line);
  }
});

test("choices do not mutate prior saves or another branch's facts",()=>{
  const initial=freshWorld();
  const first=choose(initial,"follow_sori");
  assert.deepEqual(initial,freshWorld());
  const second=choose(first,"read_ledger");
  assert.equal(readBranch(first).scene,"archive");
  assert.equal(readBranch(second).facts.ledger,true);
  assert.equal(readBranch(first).facts.ledger,undefined);
  assert.ok(Object.values(CHOICES).flat().every(c=>typeof c.label==="string"));
});
