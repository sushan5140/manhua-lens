import {
  SCENES, CHARACTERS, QUESTIONS, CHOICES, freshWorld, loadWorld, readBranch,
  getChoices, choose, fork, switchBranch, characterReply
} from "./story.mjs";

const SAVE_KEY = "manhua-multiverse-original-world-v1"; // keep every V0 timeline
const $ = id => document.getElementById(id);
let world = freshWorld();
let activeCharacter = "sori";
let activeQuestion = "motive";

try {
  const stored = localStorage.getItem(SAVE_KEY);
  if (stored) world = loadWorld(stored);
} catch {
  $("save-status").textContent = "Local saving is unavailable in this browser.";
}

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(world));
    $("save-status").textContent = "Your decisions are stored in this browser.";
  } catch {
    $("save-status").textContent = "Your browser blocked local saving.";
  }
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function btn(className, label, action, disabled = false) {
  const node = el("button", className, label);
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", action);
  return node;
}
function goToReader() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    $("experience").scrollIntoView({ behavior: "auto", block: "start" });
  } else {
    $("experience").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
function labelOf(choiceId) {
  for (const list of Object.values(CHOICES)) {
    const found = list.find(c => c.id === choiceId);
    if (found) return found.label;
  }
  return "An earlier choice";
}
function renderChoices() {
  const list = getChoices(world);
  const root = $("choices");
  root.replaceChildren();
  $("decision-title").textContent = list.length ? "What happens next?" : "You've reached an ending.";
  $("choice-count").textContent = String(list.filter(c => c.available).length).padStart(2, "0") +
    (list.length === 1 ? " PATH" : " PATHS");
  list.forEach((choice, index) => {
    const b = btn("choice", "", () => {
      world = choose(world, choice.id);
      activeQuestion = "motive";
      save();
      render();
      goToReader();
    }, !choice.available);
    const n = el("span", "choice-num", String(index + 1).padStart(2, "0"));
    const copy = el("span", "choice-copy");
    copy.append(el("strong", "", choice.label),
      el("small", "", choice.available ? choice.detail : choice.reason));
    const arrow = el("span", "arrow", choice.available ? "↗" : "×");
    arrow.setAttribute("aria-hidden", "true");
    b.append(n, copy, arrow);
    root.append(b);
  });
}
function renderTimeline() {
  const {steps, branch} = readBranch(world);
  const select = $("branch-select");
  select.replaceChildren();
  for (const b of world.branches) {
    const option = el("option", "", b.name);
    option.value = b.id;
    option.selected = b.id === world.active;
    select.append(option);
  }
  $("branch-count").textContent = String(world.branches.length).padStart(2,"0") +
    (world.branches.length === 1 ? " TIMELINE" : " TIMELINES");
  const root = $("timeline");
  root.replaceChildren();
  steps.forEach((step,index) => {
    const row = el("div","moment" + (index === steps.length - 1 ? " current" : ""));
    const subtitle = index === 0 ? "Where your story began" : labelOf(step.choice);
    row.append(el("strong","",SCENES[step.scene].title), el("small","",subtitle));
    const forkBtn = btn("fork-btn","Branch here ↗",() => {
      world = fork(world,index);
      activeQuestion = "motive";
      save();
      render();
      goToReader();
    },world.branches.length >= 24);
    forkBtn.setAttribute("aria-label","Create a new timeline from "+SCENES[step.scene].title);
    row.append(forkBtn);
    root.append(row);
  });
}
function showReply() {
  const answer = characterReply(world,activeCharacter,activeQuestion);
  const character = CHARACTERS[activeCharacter];
  $("reply-person").textContent = character.name.toUpperCase() + " · THEIR SIDE OF THE STORY";
  const root = $("reply");
  root.textContent = "“" + answer.text + "”";
  document.querySelectorAll("#questions .question").forEach(q => {
    const isActive = q.dataset.question === activeQuestion;
    q.classList.toggle("active",isActive);
    q.setAttribute("aria-pressed",String(isActive));
  });
}
function renderCharacters() {
  const character = CHARACTERS[activeCharacter];
  document.querySelectorAll("[data-character]").forEach(b => {
    const selected = b.dataset.character === activeCharacter;
    b.classList.toggle("selected",selected);
    b.setAttribute("aria-pressed",String(selected));
  });
  $("character-bio").textContent = character.description;
  const questions = $("questions");
  questions.replaceChildren();
  for (const q of QUESTIONS) {
    const node = btn("question",q.label,() => {
      activeQuestion = q.id;
      showReply();
    });
    node.dataset.question = q.id;
    questions.append(node);
  }
  showReply();
}
function render() {
  const { scene, finished, steps } = readBranch(world);
  const info = SCENES[scene];
  const sceneImage = $("scene-image");
  sceneImage.src = "./art/" + info.tone + ".svg";
  sceneImage.alt = "Original illustration for " + info.title + " in The Stolen Tomorrow.";
  $("chapter").textContent = info.chapter;
  $("scene-location").textContent = info.location.toUpperCase();
  $("scene-number").textContent = "SCENE " + String(steps.length).padStart(2,"0");
  $("scene-step").textContent = steps.length === 1 ? "YOUR FIRST CHOICE" : "YOUR JOURNEY · " + (steps.length - 1) + " DECISIONS";
  $("scene-title").textContent = info.title;
  $("scene-text").textContent = info.text;
  $("scene-line").textContent = "“" + info.line + "”";
  $("ending-actions").hidden = !finished;
  renderChoices();
  renderTimeline();
  renderCharacters();
}
document.querySelectorAll("[data-character]").forEach(node => {
  node.addEventListener("click",() => {
    activeCharacter = node.dataset.character;
    activeQuestion = "motive";
    renderCharacters();
  });
});
$("branch-select").addEventListener("change",event => {
  world = switchBranch(world,event.target.value);
  activeQuestion = "motive";
  save();
  render();
  goToReader();
});
$("fork-ending").addEventListener("click",() => {
  const { steps } = readBranch(world);
  world = fork(world,Math.max(0,steps.length - 2));
  activeQuestion = "motive";
  save();
  render();
  goToReader();
});
$("restart").addEventListener("click",() => {
  if (!window.confirm("Delete ALL your saved timelines and begin again?")) return;
  world = freshWorld();
  activeCharacter = "sori";
  activeQuestion = "motive";
  save();
  render();
  goToReader();
});
render();
