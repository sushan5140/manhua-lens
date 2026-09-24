import {
  SAVE_KEY, CHARACTERS, SCENE_ART, OPENING_OPTIONS, newWorld, loadWorld,
  activeBranch, replay, forkWorld, switchWorld, lastOptions, moments,
  transcript, lastEvent, stateSummary, validateWorld, migrateLegacy
} from "./engine.mjs";

const $ = id => document.getElementById(id);
let world = newWorld();
let activeCharacter = "sori";
let health = {live:false,mode:"disconnected"};
let busy = false;
let compareOpen = false;
let compareId = null;
try {
  const saved=localStorage.getItem(SAVE_KEY);
  if(saved)world=loadWorld(saved);
  else {
    const previous=localStorage.getItem("manhua-multiverse-original-world-v1");
    if(previous){
      world=migrateLegacy(previous);
      localStorage.setItem(SAVE_KEY,JSON.stringify(world));
      $("save-status").textContent="Your original V1 timelines were imported; the old save remains untouched.";
    }
  }
} catch {
  $("save-status").textContent="Your browser blocked local saving.";
}
function save() {
  try {
    localStorage.setItem(SAVE_KEY,JSON.stringify(world));
    $("save-status").textContent="Your story stays in this browser.";
  } catch {
    $("save-status").textContent="Local saving is blocked. Use the Save button for a manual JSON backup."
  }
}
function element(tag,className,text) {
  const e=document.createElement(tag);
  if(className)e.className=className;
  if(text!==undefined)e.textContent=text;
  return e;
}
function button(text,className,callback) {
  const e=element("button",className,text);
  e.type="button";
  e.addEventListener("click",callback);
  return e;
}
function error(id,message="") {
  const el=$(id);
  el.hidden=!message;
  el.textContent=message;
}
function setBusy(value) {
  busy=value;
  $("action-submit").disabled=value;
  $("chat-submit").disabled=value;
  $("action-input").disabled=value;
  $("chat-input").disabled=value;
  $("action-submit").firstChild.textContent=value?"Changing the world… ":"Make it happen ";
  $("chat-submit").textContent=value?"…":"↗";
  document.querySelectorAll(".choice").forEach(c=>c.disabled=value);
}
function scrollToScene() {
  const reduce=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  $("experience").scrollIntoView({block:"start",behavior:reduce?"auto":"smooth"});
}
function statusLine() {
  const badge=$("server-mode");
  badge.classList.toggle("live",health.live);
  badge.classList.toggle("disconnected",health.mode==="disconnected"||health.mode==="invalid-provider");
  if(health.live) {
    badge.lastChild.textContent=" LIVE AI · "+health.mode.toUpperCase();
    $("mode-disclaimer").textContent="Live model active ("+health.mode+"). New scenes and replies are generated using this timeline's events. The provider receives the text of the current branch only; your API key stays on your localhost server.";
  } else if(health.mode==="offline") {
    badge.lastChild.textContent=" OFFLINE · PROCEDURAL WORLD";
    $("mode-disclaimer").textContent="Offline procedural mode: freeform actions can change facts, inventory and timelines, but replies use authored templates. To enable genuine open-ended AI story and dialogue, set GROQ_API_KEY or OPENROUTER_API_KEY in multiverse/.env and restart the local server.";
  } else {
    badge.lastChild.textContent=" STORY SERVER NOT RUNNING";
    $("mode-disclaimer").textContent="Start the app using 'py multiverse/server.py' from the repository root. The generic 'py -m http.server' command cannot power AI actions and chat.";
  }
}
async function discoverMode() {
  try {
    const response=await fetch("/api/health",{cache:"no-store"});
    if(!response.ok)throw Error("The story server isn't responding.");
    const next=await response.json();
    if(next.app!=="Manhua Multiverse")throw Error("Wrong local server.");
    health=next;
  } catch {
    health={live:false,mode:"disconnected"};
  }
  statusLine();
}
async function post(path,data) {
  if(health.mode==="disconnected"||health.mode==="invalid-provider")
    throw Error("The story server is unavailable. Run 'py multiverse/server.py' in the repository root and refresh.");
  const response=await fetch(path,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(data),
    cache:"no-store"
  });
  let result;
  try {result=await response.json();}
  catch {throw Error("The server sent an unreadable response. Check its terminal.");}
  if(!response.ok)throw Error(result.error||"That action did not complete.");
  return result;
}
function paintWorld() {
  const branch=activeBranch(world);
  const state=replay(branch);
  const last=lastEvent(world);
  const image=$("scene-image");
  image.src="./art/"+(SCENE_ART[state.scene]||"station")+".svg";
  image.alt="Original illustrated world reference for "+state.title+".";
  $("scene-title").textContent=state.title;
  $("scene-text").textContent=state.narrative;
  $("scene-number").textContent="SCENE "+String(state.turn+1).padStart(2,"0")+
    " / THE STOLEN TOMORROW";
  $("scene-step").textContent=state.turn?"YOUR INTERVENTION "+String(state.turn).padStart(2,"0"):"BEFORE THE FIRST CHOICE";
  $("scene-location").textContent=("SEOUL · "+state.scene.replaceAll("_"," ")).toUpperCase();
  $("chapter").textContent=state.flags.includes("clock_restored")?"A RESTORED MORNING":
    state.flags.includes("clock_broken")?"A FUTURE UNBOUND":
    state.flags.includes("memory_traded")?"THE MEMORY BARGAIN":
    "YOUR UNWRITTEN CHAPTER";
  $("last-consequence").hidden=!last;
  if(last)$("last-consequence-text").textContent="You chose: "+last.text;
  $("total-worlds").textContent=String(world.branches.length).padStart(2,"0");
  $("branch-count").textContent=world.branches.length+
    (world.branches.length===1?" timeline":" timelines");
  renderTimeline();
  renderComparison();
  renderOptions();
  renderFacts(state);
  renderJournal();
  renderConversation();
}
function renderTimeline() {
  const select=$("branch-select");
  select.replaceChildren();
  for(const branch of world.branches) {
    const option=element("option","",branch.name);
    option.value=branch.id;
    option.selected=branch.id===world.active;
    select.append(option);
  }
  const root=$("timeline");
  root.replaceChildren();
  for(const moment of moments(world)) {
    const entry=element("div","moment"+(moment.current?" current":""));
    entry.append(element("span","moment-index",
                         "MOMENT "+String(moment.index).padStart(2,"0")),
                 element("strong","",moment.title),
                 element("small","",moment.label));
    const b=button("Branch here ↗","fork-btn",()=>{
      try{
        if(busy)return;
        world=forkWorld(world,moment.index);
        save();paintWorld();scrollToScene();
      }catch(e){error("action-error",e.message);}
    });
    b.disabled=world.branches.length>=24;
    b.setAttribute("aria-label","Create a timeline from "+moment.title);
    entry.append(b);
    root.append(entry);
  }
}

function renderComparison() {
  const root=$("comparison");
  root.hidden=!compareOpen;
  $("compare-toggle").setAttribute("aria-pressed",String(compareOpen));
  if(!compareOpen)return;
  const other=world.branches.filter(b=>b.id!==world.active);
  const select=$("compare-select");
  select.replaceChildren();
  const grid=$("comparison-grid");
  grid.replaceChildren();
  if(!other.length){
    grid.append(element("p","journal-empty",
      "Create another timeline using Branch here or Fork now. Then compare the two worlds and their consequences."));
    return;
  }
  if(!other.some(b=>b.id===compareId))compareId=other[0].id;
  for(const b of other){
    const opt=element("option","",b.name);
    opt.value=b.id;
    opt.selected=b.id===compareId;
    select.append(opt);
  }
  const ours=activeBranch(world);
  const theirs=world.branches.find(b=>b.id===compareId);
  const states=[replay(ours),replay(theirs)];
  const common=Math.min(ours.events.length,theirs.events.length);
  let divergence=0;
  while(divergence<common&&
        JSON.stringify(ours.events[divergence])===JSON.stringify(theirs.events[divergence]))
    divergence++;
  for(const [index,b] of [ours,theirs].entries()){
    const st=states[index];
    const card=element("article","comparison-card");
    const name=element("span","comparison-name",index===0?"CURRENT · "+b.name:"ALTERNATIVE · "+b.name);
    const title=element("strong","",st.title);
    const info=element("p","",[
      "Location: "+st.scene,
      "Key: "+(st.inventory.includes("silver key")?"held":"not held"),
      "Evidence: "+(st.evidence.join(", ")||"none"),
      "Sori: "+st.trust.sori+", Jae: "+st.trust.jae,
      "World flags: "+(st.flags.join(", ")||"none")
    ].join("\n"));
    card.append(name,title,info);
    if(index===1){
      const jump=button("Enter this timeline ↗","compare-jump",()=>{
        if(busy)return;
        world=switchWorld(world,b.id);
        save();paintWorld();scrollToScene();
      });
      card.append(jump);
    }
    grid.append(card);
  }
  grid.prepend(element("p","divergence",
    "These worlds share "+divergence+" event"+(divergence===1?"":"s")+
    " before their paths diverge."));
}

function renderOptions() {
  const root=$("choices");
  root.replaceChildren();
  const options=lastOptions(world);
  options.forEach(option=>{
    const b=button("↗ "+option,"choice",()=>{
      $("action-input").value=option;
      performAction(option);
    });
    b.disabled=busy;
    root.append(b);
  });
}
function renderFacts(state) {
  const root=$("facts");
  root.replaceChildren();
  for(const {name,value} of stateSummary(state)){
    const card=element("div","fact");
    card.append(element("span","fact-name",name),element("strong","fact-value",value));
    root.append(card);
  }
  const details=[
    {name:"ITEMS YOU CARRY",value:state.inventory.join(", ")||"None yet"},
    {name:"FACTS YOU DISCOVERED",value:state.evidence.join(", ")||"None yet"},
    {name:"WORLD CONDITION",value:state.flags.join(", ")||"Still unwritten"},
    {name:"IMMEDIATE THREAT",value:String(state.threat)+"/10"}
  ];
  for(const {name,value} of details){
    const card=element("div","fact");
    card.append(element("span","fact-name",name.replaceAll("_"," ")),
                element("strong","fact-value",value.replaceAll("_"," ")));
    root.append(card);
  }
}
function renderJournal() {
  const root=$("journal");root.replaceChildren();
  const actions=activeBranch(world).events.filter(e=>e.type==="action");
  if(!actions.length) {
    root.append(element("p","journal-empty",
      "Every action you take becomes part of this timeline. Your first moment is still unwritten."));
    return;
  }
  actions.slice(-12).forEach((event,i)=>{
    const card=element("div","journal-entry");
    const num=element("span","journal-num",String(actions.length-Math.min(actions.length,12)+i+1).padStart(2,"0"));
    const copy=element("div","");
    copy.append(element("strong","",event.title),element("span","",event.text));
    card.append(num,copy);
    root.append(card);
  });
  root.scrollTop=root.scrollHeight;
}
function renderConversation() {
  const character=CHARACTERS[activeCharacter];
  document.querySelectorAll("[data-character]").forEach(node=>{
    const active=node.dataset.character===activeCharacter;
    node.classList.toggle("selected",active);
    node.setAttribute("aria-pressed",String(active));
  });
  $("character-bio").textContent=character.bio;
  $("chat-input").placeholder="Speak to "+character.name+"… What do you want to know or tell them?";
  const root=$("chat-log");
  root.replaceChildren();
  const all=transcript(world).filter(e=>e.character===activeCharacter);
  if(!all.length) {
    const empty=element("div","chat-empty");
    empty.append(element("b","","Speak to "+character.name+"."),
      element("p","","Ask anything in your own words. They should remember what you say in this branch."));
    root.append(empty);
  } else {
    all.forEach(message=>{
      const human=element("div","chat-bubble user");
      human.append(element("small","","YOU"),document.createTextNode(message.text));
      const assistant=element("div","chat-bubble");
      assistant.append(element("small","",character.name.toUpperCase()),
        document.createTextNode(message.reply));
      root.append(human,assistant);
    });
  }
  root.scrollTop=root.scrollHeight;
}
async function performAction(raw) {
  const text=raw.trim();
  if(!text||busy)return;
  error("action-error");
  setBusy(true);
  try {
    const result=await post("/api/act",{world,text});
    world=validateWorld(result.world);
    $("action-input").value="";
    save();paintWorld();scrollToScene();
  } catch(e) {
    error("action-error",e.message);
  } finally {
    setBusy(false);
  }
}
async function performChat(raw) {
  const text=raw.trim();
  if(!text||busy)return;
  error("chat-error");
  setBusy(true);
  try {
    const character=activeCharacter;
    const result=await post("/api/chat",{world,character,text});
    world=validateWorld(result.world);
    $("chat-input").value="";
    save();paintWorld();
    $("chat-log").scrollTop=$("chat-log").scrollHeight;
  } catch(e) {
    error("chat-error",e.message);
  } finally {
    setBusy(false);
  }
}
$("action-form").addEventListener("submit",event=>{
  event.preventDefault();
  performAction($("action-input").value);
});
$("chat-form").addEventListener("submit",event=>{
  event.preventDefault();
  performChat($("chat-input").value);
});
for(const [id,handler] of [
  ["action-input",()=>performAction($("action-input").value)],
  ["chat-input",()=>performChat($("chat-input").value)]
]) {
  $(id).addEventListener("keydown",event=>{
    if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)){
      event.preventDefault();
      handler();
    }
  });
}
document.querySelectorAll("[data-character]").forEach(node=>{
  node.addEventListener("click",()=>{
    activeCharacter=node.dataset.character;
    renderConversation();
  });
});
$("branch-select").addEventListener("change",event=>{
  if(busy){event.target.value=world.active;return;}
  try{world=switchWorld(world,event.target.value);save();paintWorld();scrollToScene();}
  catch(e){error("action-error",e.message);}
});
$("fork-now").addEventListener("click",()=>{
  if(busy)return;
  try{
    world=forkWorld(world,activeBranch(world).events.length);
    save();paintWorld();scrollToScene();
  }catch(e){error("action-error",e.message);}
});
$("restart").addEventListener("click",()=>{
  if(busy)return;
  if(!window.confirm("Delete all saved V2 worlds and conversations? This cannot be undone."))return;
  world=newWorld();
  activeCharacter="sori";
  save();paintWorld();scrollToScene();
});
$("chat-context").addEventListener("click",()=>{
  window.alert("The currently selected character remembers conversations and story events from only this timeline. Fork a moment to create a version with a different past. Freeform AI requires a configured provider; offline replies are procedural and clearly labeled.");
});


$("compare-toggle").addEventListener("click",()=>{
  compareOpen=!compareOpen;
  renderComparison();
});
$("compare-select").addEventListener("change",event=>{
  compareId=event.target.value;
  renderComparison();
});

$("export-world").addEventListener("click",()=>{
  const payload=new Blob([JSON.stringify(world,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(payload);
  const link=document.createElement("a");
  link.href=url;
  link.download="manhua-multiverse-"+new Date().toISOString().slice(0,10)+".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
  $("save-status").textContent="Backup downloaded. Store it somewhere safe.";
});
$("import-world").addEventListener("click",()=>{
  if(!busy)$("world-file").click();
});
$("world-file").addEventListener("change",async event=>{
  const file=event.target.files?.[0];
  event.target.value="";
  if(!file||busy)return;
  try{
    if(file.size>512_000)throw Error("That story backup is too large.");
    const incoming=validateWorld(JSON.parse(await file.text()));
    if(!window.confirm("Replace this browser's current V2 timelines with the selected backup? Download a Save backup first if you need it."))return;
    world=incoming;
    save();
    paintWorld();
    scrollToScene();
  }catch(e){error("action-error","Could not open the story backup: "+e.message);}
});

paintWorld();
discoverMode();
