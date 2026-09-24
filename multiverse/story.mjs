/**
 * Manhua Multiverse V0: original-fiction narrative engine, no AI calls.
 * Saves store decisions, while replay derives facts and chronology.
 */
export const SCENES = Object.freeze({
  station: {chapter:"PROLOGUE / 00",title:"The thirteenth platform",location:"Seoul · one minute before midnight",tone:"station",
    text:"Every night, Station Thirteen appears for exactly sixty seconds. Tonight the clocks stop, but Seoul keeps moving. A courier clutches a silver key. An archivist calls your name from an empty train.",
    line:"Some tomorrows aren't lost. They're hidden."},
  archive: {chapter:"CHAPTER / 01",title:"The room of erased mornings",location:"Beneath the last train",tone:"archive",
    text:"Sori leads you through a library of discarded futures. Your own name appears in a ledger of tomorrows that never happened. She asks you to read it before the clock strikes again.",
    line:"A memory is evidence. It isn't always the truth."},
  tunnel: {chapter:"CHAPTER / 01",title:"The courier's shortcut",location:"Between two unfinished moments",tone:"tunnel",
    text:"Jae runs through a tunnel painted with constellations. His silver key hums near a locked gate. He can carry it to the clock, but asks whether you trust him with what it opens.",
    line:"I deliver choices. You decide what they cost."},
  tower: {chapter:"CHAPTER / 02",title:"The clock above the city",location:"One minute borrowed from everyone",tone:"tower",
    text:"The city hangs below a clock with no hands. Every timeline bends toward this room. Sori wants to repair its record. Jae wants the lost travellers free. What you discovered determines which endings are possible.",
    line:"The ending remembers every shortcut."},
  city: {chapter:"ENDING / THE CITY REMEMBERS",title:"A tomorrow worth keeping",location:"Seoul · 00:01",tone:"city",
    text:"You restore the clock using the key and evidence from your journey. The city's missing minute returns. No one remembers Station Thirteen except those who chose to enter it.",
    line:"What is remembered can still be changed."},
  pact: {chapter:"ENDING / THE COURIER'S PACT",title:"The name you leave behind",location:"The far side of tomorrow",tone:"pact",
    text:"You turn the key once and give the clock one of your memories. Lost travellers go free, but a precious detail of this night vanishes from your mind. Jae promises to remember it for you.",
    line:"We cannot keep everything. We can keep each other."},
  freedom: {chapter:"ENDING / NO MORE CLOCKS",title:"A sky without timetables",location:"Every possible tomorrow",tone:"freedom",
    text:"You break the clock. Every suppressed possibility opens at once. Station Thirteen dissolves into a thousand roads. Nobody knows which future is safest—and that uncertainty belongs to everyone.",
    line:"An unwritten future is still a future."}
});
export const CHARACTERS = Object.freeze({
  sori:{name:"Sori",role:"THE ARCHIVIST",hangul:"소리",description:"She remembers abandoned futures but mistrusts easy explanations."},
  jae:{name:"Jae",role:"THE COURIER",hangul:"재",description:"He delivers impossible choices and hides what the clock once took from him."}
});
export const CHOICES = Object.freeze({
  station:[
    {id:"follow_sori",label:"Follow Sori onto the empty train",detail:"Ask why your name appears in the archive.",to:"archive",effects:{trustSori:true}},
    {id:"follow_jae",label:"Run with Jae into the tunnel",detail:"Learn what the silver key unlocks.",to:"tunnel",effects:{trustJae:true}}
  ],
  archive:[
    {id:"read_ledger",label:"Read the erased ledger",detail:"Carry evidence into the final decision.",to:"tower",effects:{ledger:true,key:true}},
    {id:"burn_ledger",label:"Destroy the ledger",detail:"Keep the key, reject its written futures.",to:"tower",effects:{ledgerBurned:true,key:true}}
  ],
  tunnel:[
    {id:"keep_key",label:"Take the key and hear Jae's secret",detail:"Keep a way to reach the clock.",to:"tower",effects:{key:true,secretShared:true}},
    {id:"leave_key",label:"Leave the silver key behind",detail:"Protect your freedom, lose the shortcut.",to:"tower",effects:{keyLeft:true}}
  ],
  tower:[
    {id:"restore",label:"Restore the missing minute",detail:"Requires the key and credible evidence.",to:"city",requires:["key",{any:["ledger","secretShared"]}],effects:{restored:true}},
    {id:"trade",label:"Trade a memory to free the travellers",detail:"Requires the silver key.",to:"pact",requires:["key"],effects:{tradedMemory:true}},
    {id:"shatter",label:"Shatter the clock",detail:"Open the future without knowing its cost.",to:"freedom",effects:{shattered:true}}
  ],
  city:[],pact:[],freedom:[]
});
export const QUESTIONS = Object.freeze([
  {id:"motive",label:"Why are you doing this?"},
  {id:"trust",label:"Do you trust me?"},
  {id:"past",label:"What happened before?"},
  {id:"future",label:"What happens now?"}
]);
function assertWorld(state){
  if(!state || state.version!==1 || !Array.isArray(state.branches) ||
     state.branches.length<1 || state.branches.length>24 ||
     !Number.isSafeInteger(state.nextId) ||
     !state.branches.some(b=>b.id===state.active))throw Error("Invalid multiverse save.");
}
function allowed(req=[],facts){
  return req.every(item=>typeof item==="string"?Boolean(facts[item]):
    Boolean(item&&Array.isArray(item.any)&&item.any.some(key=>Boolean(facts[key]))));
}
export function freshWorld(){
  return {version:1,active:"branch-1",nextId:2,branches:[{id:"branch-1",name:"Original timeline",events:[]}]};
}
export function readBranch(state,id=state.active){
  assertWorld(state);
  const branch=state.branches.find(b=>b.id===id);
  if(!branch || !Array.isArray(branch.events) || branch.events.length>4 ||
     typeof branch.name!=="string")throw Error("Invalid timeline.");
  let scene="station";
  const facts={};
  const steps=[{scene,choice:null,facts:{}}];
  for(const event of branch.events){
    const choice=CHOICES[scene]?.find(c=>c.id===event);
    if(!choice || !allowed(choice.requires,facts))
      throw Error("Causally impossible timeline.");
    Object.assign(facts,choice.effects||{});
    scene=choice.to;
    steps.push({scene,choice:choice.id,facts:{...facts}});
  }
  return {branch,scene,facts,steps,finished:CHOICES[scene].length===0};
}
export function getChoices(state){
  const {scene,facts}=readBranch(state);
  return CHOICES[scene].map(c=>({...c,available:allowed(c.requires,facts),
    reason:allowed(c.requires,facts)?"":c.id==="restore"?
      "Requires the key and the ledger or Jae's secret.":c.id==="trade"?
      "You left the silver key behind.":"This timeline lacks the required evidence."}));
}
export function choose(state,choiceId){
  const {branch}=readBranch(state);
  const choice=getChoices(state).find(c=>c.id===choiceId);
  if(!choice || !choice.available || branch.events.length>=4)
    throw Error("That choice is not available in this timeline.");
  return {...state,branches:state.branches.map(b=>b.id===state.active?
    {...b,events:[...b.events,choice.id]}:b)};
}
export function fork(state,stepIndex){
  const {branch,steps}=readBranch(state);
  if(!Number.isInteger(stepIndex)||stepIndex<0||stepIndex>=steps.length||
     state.branches.length>=24)throw Error("Cannot fork that moment.");
  const id="branch-"+state.nextId;
  const name="Timeline "+String(state.nextId).padStart(2,"0")+" · "+SCENES[steps[stepIndex].scene].title;
  return {version:1,active:id,nextId:state.nextId+1,branches:[
    ...state.branches,{id,name,events:branch.events.slice(0,stepIndex)}]};
}
export function switchBranch(state,id){readBranch(state,id);return {...state,active:id};}
export function loadWorld(json){
  try{
    const state=JSON.parse(json);assertWorld(state);
    const ids=new Set();
    for(const branch of state.branches){
      if(typeof branch.id!=="string"||ids.has(branch.id))throw Error("Duplicate timeline.");
      ids.add(branch.id);readBranch(state,branch.id);
    }
    return state;
  }catch{return freshWorld();}
}
/** These are authored, context-sensitive lines. They are NOT generated by an LLM. */
export function characterReply(state,characterId,topic){
  const {scene,facts,finished}=readBranch(state);
  if(!CHARACTERS[characterId])throw Error("Unknown character.");
  const answers={
    sori:{
      motive:facts.ledgerBurned?
        "You burned the ledger. I wanted its evidence saved, but I won't rewrite your choice.":
        facts.ledger?"You read the ledger. Now you know why I wanted our erased mornings witnessed.":
        "I keep the histories the clock deletes. Memory is evidence, not a command to obey it.",
      trust:facts.trustSori?
        "You chose to follow me. I remember that, even if you choose another ending.":
        "You didn't follow me at the station. I can still tell you what the archive protects.",
      past:"The clock erased one minute from this city. I catalogued what disappeared, not every reason why.",
      future:finished?
        "Our path ended at "+SCENES[scene].title+". Fork an earlier moment for another answer.":
        facts.key?"The key changes what you can do. Evidence changes what you can justify.":
        "Without the key, repairing the clock may be impossible. You still have another choice."
    },
    jae:{
      motive:facts.secretShared?"I told you my secret because you chose to carry the key with me.":
        "I deliver choices to people who were never offered one. That is why the key matters.",
      trust:facts.trustJae?"You ran into the tunnel with me. I remember the risk you took.":
        "You chose the train instead. I won't rewrite our first meeting to make myself look better.",
      past:facts.keyLeft?"We left the key in the tunnel. I can't put it back in your pocket.":
        "The clock once took a memory from me. I know what that bargain costs.",
      future:finished?"You reached "+SCENES[scene].title+". A different ending requires another timeline.":
        facts.key?"The key opens the clock, but you decide whether anything should be traded.":
        "Without the key, you can still refuse the clock's rules entirely."
    }
  };
  if(!Object.hasOwn(answers[characterId],topic))throw Error("Unknown question.");
  return {character:characterId,topic,text:answers[characterId][topic],scripted:true,scene,branchId:state.active};
}
