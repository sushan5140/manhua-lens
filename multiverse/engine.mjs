/**
 * Manhua Multiverse V2: client-side timeline envelope + deterministic replay.
 * The server validates the incoming world again; this file contains no AI keys.
 * The V1 save key is left intact for rollback.
 */
export const SAVE_KEY = "manhua-multiverse-world-v2";
export const CHARACTERS = Object.freeze({
  sori: { name: "Sori", title: "The Archivist", symbol: "소",
          bio: "Keeper of erased futures. Careful, observant, and reluctant to trust without evidence." },
  jae: { name: "Jae", title: "The Courier", symbol: "재",
          bio: "A courier through impossible routes. Witty and fiercely protective of a memory he lost." }
});
export const SCENE_ART = Object.freeze({
  station:"station",archive:"archive",tunnel:"tunnel",tower:"tower",city:"city",
  pact:"pact",freedom:"freedom",carriage:"station",bridge:"freedom",
  market:"city",rooftop:"tower",chamber:"archive"
});
export const OPENING = Object.freeze({
  scene:"station",title:"The Thirteenth Platform",
  narrative:"The last train is one minute late. On Platform Thirteen, Sori watches the station clock refuse to move. Jae conceals a silver key. You can ask either of them questions, intervene, or leave the platform. Nothing is predetermined beyond what your choices make true.",
  inventory:[],evidence:[],flags:[],trust:{sori:0,jae:0},threat:0,turn:0
});
export const OPENING_OPTIONS = Object.freeze([
  "Ask Jae to show you the silver key",
  "Follow Sori into the archive",
  "Search the platform for evidence",
  "Confront both about the missing minute"
]);
export function newWorld() {
  return {version:2,active:"thread-1",nextId:2,
    branches:[{id:"thread-1",name:"Original timeline",events:[]}]};
}
export function activeBranch(world) {
  return world.branches.find(b=>b.id===world.active) || world.branches[0];
}
export function replay(branch) {
  const state = structuredClone(OPENING);
  for (const event of branch.events) {
    if (event.type!=="action") continue;
    const c=event.changes || {};
    for(const item of c.remove_items||[])state.inventory=state.inventory.filter(x=>x!==item);
    for(const item of c.add_items||[])if(!state.inventory.includes(item))state.inventory.push(item);
    for(const item of c.add_evidence||[])if(!state.evidence.includes(item))state.evidence.push(item);
    for(const item of c.add_flags||[])if(!state.flags.includes(item))state.flags.push(item);
    for(const [who,delta] of Object.entries(c.trust||{}))
      if(who in state.trust)state.trust[who]=Math.max(-5,Math.min(5,state.trust[who]+delta));
    state.threat=Math.max(0,Math.min(10,state.threat+(c.threat||0)));
    state.scene=event.scene;state.title=event.title;state.narrative=event.narrative;state.turn++;
  }
  return state;
}
export function validateWorld(world) {
  if(!world||world.version!==2||!Array.isArray(world.branches)||
    world.branches.length<1||world.branches.length>24||
    !Number.isSafeInteger(world.nextId)||world.nextId<=1||
    !world.branches.some(b=>b.id===world.active))throw Error("Invalid save file");
  const ids=new Set();
  for(const b of world.branches){
    if(typeof b.id!=="string"||ids.has(b.id)||!Array.isArray(b.events)||
       b.events.length>80||typeof b.name!=="string")throw Error("Invalid timeline");
    ids.add(b.id);
    for(const e of b.events){
      if(!["action","chat"].includes(e.type)||typeof e.text!=="string")throw Error("Invalid event");
      if(e.type==="action"&&(typeof e.title!=="string"||typeof e.narrative!=="string"||
          !(e.scene in SCENE_ART)))throw Error("Invalid scene");
    }
  }
  return world;
}
export function loadWorld(raw) {
  try{return validateWorld(JSON.parse(raw));}catch{return newWorld();}
}
export function forkWorld(world,index) {
  validateWorld(world);
  const b=activeBranch(world);
  if(!Number.isInteger(index)||index<0||index>b.events.length||world.branches.length>=24)
    throw Error("Cannot create another timeline from here.");
  const id="thread-"+world.nextId;
  return {...world,active:id,nextId:world.nextId+1,
    branches:[...world.branches,{id,name:"Timeline "+String(world.nextId).padStart(2,"0"),
      events:structuredClone(b.events.slice(0,index))}]};
}
export function switchWorld(world,id) {
  if(!world.branches.some(b=>b.id===id))throw Error("Timeline not found.");
  return {...world,active:id};
}
export function lastOptions(world) {
  const last=[...activeBranch(world).events].reverse().find(e=>e.type==="action");
  return (last?.options?.length ? last.options : OPENING_OPTIONS).slice(0,5);
}
export function moments(world) {
  const steps=[{index:0,title:"The Thirteenth Platform",label:"Where your story begins",
    scene:"station",current:false}];
  activeBranch(world).events.forEach((e,i)=>{
    if(e.type==="action"){
      steps.push({index:i+1,title:e.title,label:e.text,scene:e.scene,current:false});
    }
  });
  steps.at(-1).current=true;
  return steps;
}
export function transcript(world) {
  return activeBranch(world).events.filter(e=>e.type==="chat").slice(-12);
}
export function lastEvent(world) {
  return [...activeBranch(world).events].reverse().find(e=>e.type==="action");
}
export function stateSummary(state) {
  return [
    {name:"LOCATION",value:state.scene.replace(/^./,x=>x.toUpperCase())},
    {name:"SILVER KEY",value:state.inventory.includes("silver key")?"In your possession":"Not held"},
    {name:"EVIDENCE",value:String(state.evidence.length)+" discovered"},
    {name:"RELATIONSHIP",value:"Sori "+state.trust.sori+" · Jae "+state.trust.jae}
  ];
}


/** One-way import of the previous V1 scripted-story save; original key remains untouched.
 * Only known original choices are mapped, no made-up or cross-branch events. */
export function migrateLegacy(raw) {
  let old;
  try {old=JSON.parse(raw);} catch {return newWorld();}
  if(!old||old.version!==1||!Array.isArray(old.branches)||old.branches.length<1||
    old.branches.length>24)return newWorld();
  const choices={
    follow_sori:{scene:"archive",text:"Follow Sori onto the empty train",title:"The room of erased mornings",
      narrative:"Sori leads you to the archive of erased futures.",changes:{trust:{sori:1}}},
    follow_jae:{scene:"tunnel",text:"Run with Jae into the tunnel",title:"The courier's shortcut",
      narrative:"You follow Jae through the service passage toward the clock.",changes:{trust:{jae:1}}},
    read_ledger:{scene:"tower",text:"Read the erased ledger",title:"The clock above the city",
      narrative:"You reach the tower with the silver key and an archive record of the missing minute.",
      changes:{add_items:["silver key","ledger page"],add_evidence:["ledger"]}},
    burn_ledger:{scene:"tower",text:"Burn the erased ledger",title:"The clock above the city",
      narrative:"You arrive at the tower with the silver key, having destroyed the ledger.",
      changes:{add_items:["silver key"]}},
    keep_key:{scene:"tower",text:"Take the silver key and hear Jae's secret",title:"The clock above the city",
      narrative:"Jae confides what the clock once took from him. You carry the key to the tower.",
      changes:{add_items:["silver key"],add_evidence:["jae_secret"]}},
    leave_key:{scene:"tower",text:"Leave the silver key in the tunnel",title:"The clock above the city",
      narrative:"You reach the tower without the silver key.",changes:{}},
    restore:{scene:"city",text:"Restore the missing minute",title:"A tomorrow worth keeping",
      narrative:"You restore the erased minute using the key and evidence from this timeline.",
      changes:{add_flags:["clock_restored"]}},
    trade:{scene:"pact",text:"Trade a memory to free the travellers",title:"The courier's pact",
      narrative:"You exchange one memory to release the lost travellers.",
      changes:{add_flags:["memory_traded"]}},
    shatter:{scene:"freedom",text:"Shatter the clock",title:"A sky without timetables",
      narrative:"You break the clock and open the futures that it held in place.",
      changes:{add_flags:["clock_broken"]}}
  };
  const migrated={version:2,active:"thread-1",nextId:Math.max(2,old.nextId||2),branches:[]};
  for(let i=0;i<old.branches.length;i++){
    const b=old.branches[i];
    if(!b||!Array.isArray(b.events)||b.events.length>6||
      b.events.some(id=>!choices[id]))return newWorld();
    const id="thread-"+(i+1);
    if(b.id===old.active)migrated.active=id;
    migrated.branches.push({id,name:i===0?"Original timeline (V1)":
      "Imported timeline "+(i+1),events:b.events.map(id=>({
        type:"action",...structuredClone(choices[id]),
        options:["Ask either character about the choice","Investigate what changed","Take another route"],
        mode:"imported"
      }))});
  }
  migrated.nextId=Math.max(migrated.nextId,migrated.branches.length+1);
  try{return validateWorld(migrated);}catch{return newWorld();}
}
