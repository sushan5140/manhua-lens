import {
  SCENES, CHARACTERS, QUESTIONS, freshWorld, loadWorld, readBranch,
  getChoices, choose, fork, switchBranch, characterReply
} from "./story.mjs";

const SAVE_KEY = "manhua-multiverse-original-world-v1";
const $ = (id) => document.getElementById(id);
const symbols = {station:"十三",archive:"記",tunnel:"✦",tower:"時",city:"明",pact:"約",freedom:"∞"};
let world = freshWorld();
let character = "sori";

try {
  const saved = localStorage.getItem(SAVE_KEY);
  if (saved) world = loadWorld(saved);
} catch {
  $("save-status").textContent = "This browser could not load local progress.";
}

function setStatus(message) { $("save-status").textContent = message; }

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(world));
    setStatus("Your choices stay in this browser.");
  } catch {
    setStatus("Local saving is unavailable in this browser.");
  }
}

function makeButton(className, text, handler, disabled = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  b.disabled = disabled;
  b.addEventListener("click", handler);
  return b;
}

function renderChoices() {
  const choices = getChoices(world);
  const box = $("choices");
  box.replaceChildren();
  $("decision-title").textContent = choices.length ? "WHAT DO YOU DO?" : "THIS TIMELINE ENDS HERE";
  $("choice-count").textContent = String(choices.filter(c => c.available).length).padStart(2,"0") + " PATHS";
  choices.forEach((choice, index) => {
    const btn = makeButton("choice", "", () => {
      world = choose(world, choice.id);
      save();
      render();
    }, !choice.available);
    const count = document.createElement("span");
    count.className = "choice-num";
    count.textContent = String(index + 1).padStart(2,"0");
    const words = document.createElement("span");
    words.className = "choice-copy";
    const title = document.createElement("strong");
    title.textContent = choice.label;
    const sub = document.createElement("small");
    sub.textContent = choice.available ? choice.detail : choice.reason;
    words.append(title, sub);
    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = choice.available ? "↗" : "×";
    btn.append(count, words, arrow);
    box.append(btn);
  });
}

function renderTimeline() {
  const { steps } = readBranch(world);
  const select = $("branch-select");
  select.replaceChildren();
  for (const branch of world.branches) {
    const option = document.createElement("option");
    option.value = branch.id;
    option.textContent = branch.name;
    option.selected = world.active === branch.id;
    select.append(option);
  }
  $("branch-count").textContent = String(world.branches.length).padStart(2,"0") +
    (world.branches.length === 1 ? " WORLD" : " WORLDS");

  const panel = $("timeline");
  panel.replaceChildren();
  steps.forEach((step, index) => {
    const moment = document.createElement("div");
    moment.className = "moment" + (index === steps.length - 1 ? " current" : "");
    const heading = document.createElement("strong");
    heading.textContent = SCENES[step.scene].title;
    const caption = document.createElement("small");
    caption.textContent = index === 0 ? "The moment before your first choice." :
      "Decision " + index + " · " + CHOICE_LABEL(step.choice);
    const forkBtn = makeButton("fork-btn",
      index === steps.length - 1 ? "Duplicate this moment ↗" : "Fork here ↗",
      () => {
        world = fork(world,index);
        save();
        render();
      },world.branches.length >= 24);
    moment.append(heading,caption,forkBtn);
    panel.append(moment);
  });
}

function CHOICE_LABEL(id) {
  for (const decisions of Object.values({
    station: [{id:"follow_sori",label:"Followed Sori"},{id:"follow_jae",label:"Followed Jae"}],
    archive: [{id:"read_ledger",label:"Read the ledger"},{id:"burn_ledger",label:"Burned the ledger"}],
    tunnel: [{id:"keep_key",label:"Kept the key"},{id:"leave_key",label:"Left the key"}],
    tower: [{id:"restore",label:"Restored the clock"},{id:"trade",label:"Traded a memory"},{id:"shatter",label:"Shattered the clock"}]
  })) {
    const result = decisions.find(x => x.id === id);
    if (result) return result.label;
  }
  return "A choice was made";
}

function renderCharacter() {
  const ch = CHARACTERS[character];
  document.querySelectorAll("[data-character]").forEach(b => {
    const selected = b.dataset.character === character;
    b.classList.toggle("selected", selected);
    b.setAttribute("aria-pressed",String(selected));
  });
  $("character-bio").textContent = ch.description;
  const qbox = $("questions");
  qbox.replaceChildren();
  QUESTIONS.forEach(question => {
    qbox.append(makeButton("question", question.label, () => {
      const answer = characterReply(world, character, question.id);
      const reply = $("reply");
      reply.replaceChildren();
      const title = document.createElement("strong");
      title.textContent = ch.name + " · " + question.label;
      const quote = document.createElement("span");
      quote.textContent = "“" + answer.text + "”";
      reply.append(title, quote);
    }));
  });
  $("reply").textContent = "Choose a question to hear " + ch.name + "'s side of this timeline.";
}

function render() {
  const {scene,finished,steps} = readBranch(world);
  const chapter = SCENES[scene];
  $("scene-art").className = "scene-art " + chapter.tone;
  $("chapter").textContent = chapter.chapter;
  $("scene-number").textContent = String(steps.length).padStart(3,"0") +
    " — THE STOLEN TOMORROW";
  $("art-symbol").textContent = symbols[scene];
  $("scene-location").textContent = chapter.location.toUpperCase();
  $("scene-title").textContent = chapter.title;
  $("scene-text").textContent = chapter.text;
  $("scene-line").textContent = "“" + chapter.line + "”";
  $("ending-actions").hidden = !finished;
  renderChoices();
  renderTimeline();
  renderCharacter();
}

document.querySelectorAll("[data-character]").forEach(b => {
  b.addEventListener("click", () => {
    character = b.dataset.character;
    renderCharacter();
  });
});

$("branch-select").addEventListener("change",e => {
  world = switchBranch(world,e.target.value);
  save();
  render();
});

$("fork-ending").addEventListener("click", () => {
  const {steps} = readBranch(world);
  world = fork(world, Math.max(0,steps.length-2));
  save();
  render();
});

$("restart").addEventListener("click", () => {
  if (!window.confirm("Delete all your saved timelines and begin again?")) return;
  world = freshWorld();
  save();
  render();
});

render();
