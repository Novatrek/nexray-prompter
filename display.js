// Zweitanzeige: zeigt denselben Prompter auf einem weiteren Monitor und folgt dem Hauptfenster.
import { load, save } from './storage.js';
import { setUiLang } from './i18n.js';
import { DEFAULT_NAMES, showSpeakers } from './speakers.js';
import { showSchedule } from './schedule.js';

const TOP_OFFSET = 12;
const LINE_HEIGHT = 1.45;
const HIDE_BAR_AFTER = 2500;

const $ = (id) => document.getElementById(id);
const stage = $('stage');
const text = $('text');
const marker = $('marker');
const channel = new BroadcastChannel('voiceprompter-display');

let settings = { size: 56, width: 80, line: 0, speakers: DEFAULT_NAMES, me: 0 };
// Jede Anzeige hat eine Nummer (aus dem Fensternamen) und merkt sich darunter Spiegelung und Rolle.
const number = Number(/vp-display-(\d+)/.exec(window.name)?.[1]) || 1;
const key = (name) => `vp.display.${number}.${name}`;
const FOLLOW_MAIN = -1;
let mirror = load(key('mirror'), load('vp.display.mirror', false));
let flip = load(key('flip'), false);
// Rolle dieser Anzeige: wie im Hauptfenster, alle gleich hell oder ein bestimmter Sprecher.
let role = load(key('role'), FOLLOW_MAIN);
let spans = [];
let pos = 0;
let last = null;

const lineStep = () => settings.size * LINE_HEIGHT;
const readOffset = () => (settings.line === 0 ? TOP_OFFSET : (text.clientHeight * settings.line) / 100);

function layout() {
  const offset = readOffset();
  text.style.fontSize = settings.size + 'px';
  text.style.maxWidth = settings.width + '%';
  text.style.paddingTop = offset + lineStep() + 'px';
  text.classList.toggle('mirror', mirror);
  text.classList.toggle('flip', flip);
  marker.hidden = settings.line === 0;
  // Senkrecht gespiegelt liegt die Lesezeile von unten gemessen.
  marker.style.top = (flip ? text.clientHeight - offset : offset) + 'px';
  $('displayMirror').classList.toggle('on', mirror);
  $('displayFlip').classList.toggle('on', flip);
  if (last) follow(last);
}

// Die Zeilen brechen hier anders um als im Hauptfenster. Deshalb richtet sich die Anzeige
// nach dem Wort an der Lesezeile und nicht nach der Scrollhöhe in Pixeln.
function follow(frame) {
  last = frame;
  if (frame.pos !== pos) {
    const from = Math.min(pos, frame.pos);
    const to = Math.min(spans.length, Math.max(pos, frame.pos));
    for (let i = from; i < to; i++) spans[i].classList.toggle('spoken', i < frame.pos);
    spans[pos]?.classList.remove('now');
    pos = frame.pos;
    if (frame.showNow) spans[pos]?.classList.add('now');
  }
  stage.classList.toggle('paused', frame.paused);
  showSchedule($('schedule'), frame.schedule ?? null);
  showSpeakers(stage, $('speakerBadge'), {
    current: frame.current, next: frame.next, names: settings.speakers, me: ownRole(),
  });
  const anchor = spans[Math.min(frame.index, spans.length - 1)];
  if (anchor) text.scrollTop = anchor.offsetTop + frame.offset * lineStep() - readOffset();
}

channel.onmessage = ({ data }) => {
  if (data.type === 'render') {
    text.innerHTML = data.html;
    spans = [...text.querySelectorAll('.w')];
    pos = spans.findIndex((span) => !span.classList.contains('spoken'));
    if (pos < 0) pos = spans.length;
    settings = data.settings;
    fillRoles();
    last = null;
    $('idle').hidden = true;
    layout();
  } else if (data.type === 'settings') {
    settings = data.settings;
    fillRoles();
    layout();
  } else if (data.type === 'frame') {
    follow(data);
  } else if (data.type === 'idle') {
    text.textContent = '';
    spans = [];
    last = null;
    stage.classList.remove('paused');
    showSchedule($('schedule'), null);
    showSpeakers(stage, $('speakerBadge'), { current: 0, next: 0, names: settings.speakers, me: 0 });
    $('idle').hidden = false;
  } else if (data.type === 'lang') {
    setUiLang(data.lang);
  } else if (data.type === 'close') {
    window.close();
  }
};
channel.postMessage({ type: 'hello', id: number });

const ownRole = () => (role === FOLLOW_MAIN ? settings.me : role);

// Auswahl der Rolle mit den aktuellen Sprechernamen füllen.
function fillRoles() {
  const menu = $('displayRole');
  menu.textContent = '';
  menu.append(new Option('Wie Hauptfenster', FOLLOW_MAIN), new Option('Alle', 0));
  settings.speakers.forEach((name, index) => menu.append(new Option(name, index + 1)));
  if (role > settings.speakers.length) role = FOLLOW_MAIN;
  menu.value = role;
  stage.dataset.me = ownRole() || '';
}
$('displayRole').addEventListener('change', () => {
  role = Number($('displayRole').value);
  save(key('role'), role);
  stage.dataset.me = ownRole() || '';
  if (last) follow(last);
});

$('displayMirror').addEventListener('click', () => {
  mirror = !mirror;
  save(key('mirror'), mirror);
  layout();
});
$('displayFlip').addEventListener('click', () => {
  flip = !flip;
  save(key('flip'), flip);
  layout();
});
// In der Desktop-App schaltet das Programmfenster selbst auf Vollbild; im Browser die Seite.
const desktop = window.vpDesktop?.window;
function toggleFullscreen() {
  if (desktop?.toggleFullscreen) desktop.toggleFullscreen();
  else if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}
function leaveFullscreen() {
  if (desktop?.leaveFullscreen) desktop.leaveFullscreen();
  else if (document.fullscreenElement) document.exitFullscreen();
}
$('displayFull').addEventListener('click', toggleFullscreen);
$('displayClose').addEventListener('click', () => window.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') leaveFullscreen();
  else if (event.key === 'F11') {
    event.preventDefault();
    toggleFullscreen();
  }
});
/* ---------- Schweben (nur Desktop-App) ---------- */

if (desktop?.setFloating) {
  const bar = $('displayBar');
  const float = { on: false, opacity: 80, protect: true, ...load('vp.display.float', {}), on: false };
  let through = false;
  let overControls = false;

  const applyFloat = () => {
    $('displayFloat').classList.toggle('on', float.on);
    $('displayFloat').textContent = float.on ? 'Schweben: an' : 'Schweben';
    $('displayFloatOptions').hidden = !float.on;
    $('displayOpacity').value = float.opacity;
    $('displayProtect').checked = float.protect;
    desktop.setFloating(float.on);
    desktop.setOpacity(float.on ? float.opacity / 100 : 1);
    desktop.setProtected(float.on && float.protect);
    save('vp.display.float', { opacity: float.opacity, protect: float.protect });
  };
  const setOverControls = (over) => {
    if (!through || over === overControls) return;
    overControls = over;
    desktop.setHover(over);
  };

  $('displayFloatBox').hidden = false;
  $('displayFloat').addEventListener('click', () => {
    float.on = !float.on;
    applyFloat();
  });
  $('displayOpacity').addEventListener('input', () => {
    float.opacity = Number($('displayOpacity').value);
    applyFloat();
  });
  $('displayProtect').addEventListener('change', () => {
    float.protect = $('displayProtect').checked;
    applyFloat();
  });
  $('displayThrough').addEventListener('click', () => desktop.setClickThrough(!through));
  // Klicks gehen nur durch den Text; über der Leiste nimmt das Fenster sie wieder an.
  bar.addEventListener('mousemove', () => setOverControls(true));
  bar.addEventListener('mouseleave', () => setOverControls(false));
  window.vpDesktop.onClickThrough((on) => {
    through = on;
    overControls = false;
    $('displayThrough').textContent = on ? 'Klicks durchlassen: an' : 'Klicks durchlassen';
    $('displayThrough').classList.toggle('on', on);
  });
}

// Dem Hauptfenster melden, dass die Zweitanzeige geschlossen wurde.
window.addEventListener('pagehide', () => channel.postMessage({ type: 'bye', id: number }));
window.addEventListener('resize', layout);

// Die Knöpfe erscheinen nur, solange die Maus bewegt wird.
let hideTimer = 0;
document.addEventListener('mousemove', () => {
  document.body.classList.add('controls');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => document.body.classList.remove('controls'), HIDE_BAR_AFTER);
});

fillRoles();
layout();
