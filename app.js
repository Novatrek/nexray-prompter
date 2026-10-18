import { normalize, toWords, findPosition } from './align.js';
import { ACCEPT, readScriptFile } from './import.js';
import { load, save } from './storage.js';
import { LANGS, onUiLang, setUiLang, t, uiLang } from './i18n.js';
import { COLORS, colorWord, isQuote, quoteWord, sectionWord } from './tags.js';
import { SAMPLES } from './translations.js';
import { startLocalSpeech } from './speech.js';
import { askText } from './dialogs.js';
import { initCamera, stopCamera } from './camera.js';
import { clock, parseSection, sectionState, showSchedule } from './schedule.js';
import { currentTitle, initLibrary, openSaveAs, saveText, snapshot, transformAllScripts } from './library.js';
import {
  DEFAULT_NAMES, SPEAKER_COUNT, renameSpeakerTags, showSpeakers, speakerNumber, speakersAt,
} from './speakers.js';
import { FREE_VOICE_SECONDS, isPro, onPlanChange, openUpgrade } from './plan.js';
import {
  beginSession, fillerVocabulary, finishSession, markReady, noteAdvance, noteAudio, noteHeard, noteWords,
} from './coach.js';

const $ = (id) => document.getElementById(id);
const el = {
  editor: $('editor'), prompter: $('prompter'), script: $('script'), file: $('file'),
  sample: $('sample'), count: $('count'), open: $('open'), support: $('support'),
  text: $('text'), back: $('back'), toggle: $('toggle'), restart: $('restart'),
  mode: $('mode'), lang: $('lang'), size: $('size'), width: $('width'),
  speed: $('speed'), speedLabel: $('speedLabel'), speedValue: $('speedValue'),
  follow: $('follow'), followValue: $('followValue'), followLabel: $('followLabel'), mirror: $('mirror'), flip: $('flip'), status: $('status'),
  mic: $('mic'), level: $('level'), fileNote: $('fileNote'),
  stage: $('stage'), line: $('line'), linePos: $('linePos'), marker: $('marker'), tools: $('tools'), cue: $('cue'), cueMenu: $('cueMenu'), undo: $('undo'), redo: $('redo'),
  bar: $('bar'), second: $('second'), secondMore: $('secondMore'),
  highlight: $('scriptHighlight'), uiLang: $('uiLang'), quote: $('quote'), schedule: $('schedule'),
  speaker: $('speaker'), speakerMenu: $('speakerMenu'), speakerBadge: $('speakerBadge'),
  me: $('me'), meLabel: $('meLabel'), floatBox: $('floatBox'), floatOptions: $('floatOptions'), float: $('float'),
  opacity: $('opacity'), protect: $('protect'), through: $('through'),
  timer: $('timer'), target: $('target'), timerLocked: $('timerLocked'),
};

const SAMPLE = `Guten Tag und herzlich willkommen. Schön, dass Sie heute dabei sind.

In den nächsten Minuten zeige ich Ihnen, wie dieser Teleprompter funktioniert. Sie sprechen ganz normal, und der Text läuft in Ihrem Tempo mit.

Wenn Sie eine Pause machen, bleibt der Text stehen. Wenn Sie schneller werden, zieht er nach. Sie müssen nichts anklicken und nichts einstellen.

Probieren Sie es aus: Lesen Sie diesen Absatz einmal langsam und einmal zügig vor. Überspringen Sie ruhig einen Satz. Der Prompter findet die Stelle wieder.

Vielen Dank fürs Ausprobieren und viel Erfolg bei Ihrer nächsten Aufnahme.`;

const DEFAULTS = {
  mode: 'voice', lang: 'de-DE', size: 56, width: 80, speed: 5, mirror: false, flip: false, mic: '', line: 0, follow: 3,
  float: false, opacity: 80, protect: true,
  speakers: DEFAULT_NAMES, me: 0,
  target: 0,
};
const TOP_OFFSET = 12;
const MIDDLE_LINE = 35;
const LINE_HEIGHT = 1.45;
// Wie zügig der Text im Stimm-Modus der Lesestelle folgt, Stufe 1 (ruhig) bis 5 (direkt).
const FOLLOW_RATES = [1.5, 2.5, 3.5, 5.5, 9];
const DEFAULT_WPM = 130;
const TAG = /\[[^\]\n]*\]/g;
const CUES = [
  'Pause', 'Frage stellen', 'Witz erzählen', 'Person hinzufügen',
  'Lächeln', 'Blick in die Kamera', 'Langsamer sprechen', 'Betonen',
  'Tief durchatmen', 'Schluck trinken', 'Folie wechseln', 'Bildschirm teilen',
  'Beispiel erzählen', 'Publikum ansprechen', 'Geste', 'Video einspielen',
  'Zusammenfassen', 'Applaus abwarten',
];
const CUSTOM_CUE = 'Eigene …';
// Übliche Anführungszeichen der Sprachen, die sich für die Spracherkennung wählen lassen.
const QUOTE_MARKS = {
  de: ['„', '“'], en: ['“', '”'], fr: ['«\u00a0', '\u00a0»'], es: ['«', '»'], it: ['«', '»'],
};
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
// Die Desktop-App erkennt Sprache auf dem Gerät. Im Browser lässt sich das mit ?engine=local testen.
const LOCAL_SPEECH =
  Boolean(window.vpDesktop) || new URLSearchParams(location.search).get('engine') === 'local';
const voiceSupported = LOCAL_SPEECH || Boolean(Recognition);
// Auf Handys und Tablets kann nur ein Programmteil gleichzeitig das Mikrofon nutzen. Öffnet die
// Seite es selbst (für Pegel und Geräteauswahl), bekommt die Spracherkennung des Browsers keinen
// Ton mehr. Dort überlässt der Prompter das Mikrofon deshalb ganz der Erkennung.
const MOBILE =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const MIC_FOR_RECOGNITION_ONLY = MOBILE && !LOCAL_SPEECH;

const settings = { ...DEFAULTS, ...load('vp.settings', {}) };
// Ältere Einstellungen speicherten das Tempo in Pixeln statt als Stufe 1 bis 10.
if (settings.speed > 10 || settings.speed < 1) settings.speed = DEFAULTS.speed;
// Gespeicherte Namen behalten und auf die aktuelle Sprecherzahl auffüllen.
if (!Array.isArray(settings.speakers)) settings.speakers = [];
settings.speakers = DEFAULT_NAMES.map((fallback, index) => settings.speakers[index] || fallback);
// Früher gab es nur „oben" oder „Mitte"; jetzt ist die Lesezeile frei einstellbar (Prozent der Höhe).
if (settings.top === false) settings.line = MIDDLE_LINE;
delete settings.top;
if (!(settings.follow >= 1 && settings.follow <= 5)) settings.follow = DEFAULTS.follow;
let words = [];
let spans = [];
let pos = 0;
let running = false;
let recognition = null;
let stream = null;
let audioContext = null;
let analyser = null;
let levelData = null;
let voiceData = null;
let useTrack = true;
let scrollTarget = 0;
let lastFrame = 0;
let elapsed = 0;
let freeVoiceUsed = 0;
let shownSecond = -1;
let browsing = false;
let userPaused = false;
let vocabulary = [];
// Für jedes Wort die Nummer des Sprechers (0 = keiner zugeordnet).
let speakerOf = [];
// Abschnitte des Skripts mit Startwort, Titel und geplanter Dauer in Sekunden.
let sections = [];
let sectionIndex = -1;
let sectionStarted = 0;
let stopLocalSpeech = null;
let resumeTop = null;
let lastManualScroll = -Infinity;

/* ---------- Editor ---------- */

// Das Textfeld selbst kann keine Farben zeigen. Deshalb liegt darunter eine Kopie des Textes,
// in der die Markierungen eingefärbt sind; die Schrift des Textfelds ist durchsichtig.
function tagClass(inner) {
  const name = inner.trim().toLowerCase();
  const number = speakerNumber(name, settings.speakers);
  if (number) return `tag tag-speaker sp-${number}`;
  if (parseSection(inner)) return 'tag tag-section';
  const color = COLORS[name.replace(/^\//, '')];
  return color ? `tag ${color}` : 'tag';
}

function updateHighlight() {
  const text = el.script.value;
  const parts = [];
  let color = '';
  // Text zwischen [rot] und [/rot] erscheint schon im Skript in dieser Farbe.
  const addText = (piece) => {
    if (!piece) return;
    if (!color) {
      parts.push(piece);
      return;
    }
    const mark = document.createElement('span');
    mark.className = `mark ${color}`;
    mark.textContent = piece;
    parts.push(mark);
  };
  let last = 0;
  for (const match of text.matchAll(/\[([^\]\n]*)\]/g)) {
    addText(text.slice(last, match.index));
    const name = match[1].trim().toLowerCase();
    if (COLORS[name]) color = COLORS[name];
    else if (name.startsWith('/') && !isQuote(name.slice(1))) color = '';
    const tag = document.createElement('span');
    tag.className = tagClass(match[1]);
    tag.textContent = match[0];
    parts.push(tag);
    last = match.index + match[0].length;
  }
  addText(text.slice(last));
  // Ein Zeilenumbruch am Ende braucht ein Zeichen dahinter, sonst fehlt der Kopie die letzte Zeile.
  parts.push('\u200b');
  el.highlight.replaceChildren(...parts);
  el.highlight.scrollTop = el.script.scrollTop;
}

function updateCount() {
  updateHighlight();
  const n = toWords(el.script.value.replace(TAG, ' ')).length;
  el.count.textContent = n ? `${n} Wörter, ca. ${Math.max(1, Math.round(n / DEFAULT_WPM))} Min.` : '';
}

// Setzt Markierungen um die Auswahl im Textfeld.
function wrapSelection(before, after = '') {
  const { selectionStart: start, selectionEnd: end, value, scrollTop } = el.script;
  el.script.value = value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end);
  el.script.focus({ preventScroll: true });
  el.script.setSelectionRange(start + before.length, end + before.length);
  // Das Ersetzen des Textes setzt die Scrollposition zurück; die Ansicht soll stehen bleiben.
  el.script.scrollTop = scrollTop;
  el.script.dispatchEvent(new Event('input'));
}

function toggleCueMenu(open) {
  el.cueMenu.hidden = !open;
  el.cue.setAttribute('aria-expanded', String(open));
}

fillSpeakers();

for (const label of [...CUES, CUSTOM_CUE]) {
  const item = document.createElement('button');
  item.type = 'button';
  if (label === CUSTOM_CUE) item.dataset.custom = '1';
  item.textContent = label;
  el.cueMenu.append(item);
}
/* ---------- Sprecher ---------- */

function toggleSpeakerMenu(open) {
  el.speakerMenu.hidden = !open;
  el.speaker.setAttribute('aria-expanded', String(open));
}

// Baut das Menü im Skript-Fenster und die Rollenauswahl im Prompter aus den Namen auf.
function fillSpeakers() {
  el.speakerMenu.textContent = '';
  el.me.textContent = '';
  el.me.append(new Option('Alle', 0));
  settings.speakers.forEach((name, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `speaker-item sp-${index + 1}`;
    item.dataset.speaker = index + 1;
    item.textContent = name;
    el.speakerMenu.append(item);
    el.me.append(new Option(name, index + 1));
  });
  const rename = document.createElement('button');
  rename.type = 'button';
  rename.textContent = 'Namen ändern …';
  el.speakerMenu.append(rename);
  el.me.value = settings.me;
}

// Im Skript steht der Name des Sprechers. Nach einer Umbenennung (und für die alte Kurzform
// [S1]) werden die Markierungen in allen Skripten auf die aktuellen Namen umgeschrieben.
function showSpeakerNames(oldNames = settings.speakers) {
  const rewrite = (text) => renameSpeakerTags(text, oldNames, settings.speakers);
  transformAllScripts(rewrite);
  const updated = rewrite(el.script.value);
  if (updated !== el.script.value) replaceScript(updated);
}

function openSpeakerNames() {
  settings.speakers.forEach((name, index) => {
    $('speakerName' + (index + 1)).value = name;
  });
  $('speakerDialog').showModal();
}

$('speakerDialog').querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('speakerDialog').close();
  const oldNames = settings.speakers;
  // Eckige Klammern würden die Markierung zerstören, deshalb werden sie aus Namen entfernt.
  settings.speakers = DEFAULT_NAMES.map(
    (fallback, index) => $('speakerName' + (index + 1)).value.replace(/[[\]]/g, '').trim() || fallback
  );
  save('vp.settings', settings);
  fillSpeakers();
  showSpeakerNames(oldNames);
  updateHighlight();
});
$('speakerCancel').addEventListener('click', () => $('speakerDialog').close());

/* ---------- Abschnitte mit Zeitplan ---------- */

$('sectionDialog').querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('sectionDialog').close();
  const title = $('sectionTitle').value.replace(/[[\]|]/g, '').trim() || t('Abschnitt');
  const seconds = (Number($('sectionMinutes').value) || 0) * 60 + (Number($('sectionSeconds').value) || 0);
  const time = seconds > 0 ? ` | ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '';
  wrapSelection(`[${sectionWord(uiLang())}: ${title}${time}] `);
});
$('sectionCancel').addEventListener('click', () => $('sectionDialog').close());

document.addEventListener('click', (event) => {
  if (event.target.closest('.menu-wrap')) return;
  toggleCueMenu(false);
  toggleSpeakerMenu(false);
});

// Tauscht den ganzen Skripttext aus, ohne dass die Ansicht ans Ende springt.
function replaceScript(text) {
  const { scrollTop } = el.script;
  el.script.value = text;
  el.script.scrollTop = scrollTop;
  el.script.dispatchEvent(new Event('input'));
}

// Entfernt alle Markierungen und lässt den reinen Sprechtext übrig.
function cleanScript() {
  const before = el.script.value;
  const cleaned = before
    .replace(TAG, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '');
  if (cleaned === before) {
    el.fileNote.textContent = 'Das Skript enthält keine Markierungen.';
    el.fileNote.hidden = false;
    return;
  }
  replaceScript(cleaned);

  const undo = document.createElement('button');
  undo.type = 'button';
  undo.textContent = 'Rückgängig';
  undo.addEventListener('click', () => {
    replaceScript(before);
  });
  el.fileNote.textContent = 'Alle Markierungen wurden entfernt. ';
  el.fileNote.append(undo);
  el.fileNote.hidden = false;
}

el.tools.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button === el.undo || button === el.redo) {
    stepHistory(button === el.undo ? -1 : 1);
    return;
  }
  if (button.id === 'clean') {
    cleanScript();
    return;
  }
  if (!isPro()) {
    openUpgrade('Farbakzente, Zitate und Regieanweisungen gehören zur Pro-Version.');
  } else if (button.id === 'section') {
    $('sectionTitle').value = '';
    $('sectionMinutes').value = '';
    $('sectionSeconds').value = '';
    $('sectionDialog').showModal();
  } else if (button === el.speaker) {
    toggleSpeakerMenu(el.speakerMenu.hidden);
  } else if (el.speakerMenu.contains(button)) {
    toggleSpeakerMenu(false);
    if (button.dataset.speaker) wrapSelection(`[${settings.speakers[button.dataset.speaker - 1]}] `);
    else openSpeakerNames();
  } else if (button === el.cue) {
    toggleCueMenu(el.cueMenu.hidden);
  } else if (el.cueMenu.contains(button)) {
    toggleCueMenu(false);
    const { selectionStart, selectionEnd } = el.script;
    const custom = button.dataset.custom === '1';
    const pick = custom ? askText('Eigene Regieanweisung:') : Promise.resolve(button.textContent);
    pick.then((text) => {
      const clean = (text || '').replace(/[[\]]/g, '').trim();
      if (!clean) return;
      // Der Dialog nimmt dem Textfeld die Auswahl; vor dem Einfügen wiederherstellen.
      el.script.setSelectionRange(selectionStart, selectionEnd);
      wrapSelection(`[${clean}] `);
    });
  } else {
    const word = button === el.quote ? quoteWord(uiLang()) : colorWord(COLORS[button.dataset.color], uiLang());
    wrapSelection(`[${word}]`, `[/${word}]`);
  }
});


// Eigener Verlauf für Rückgängig und Wiederholen: Knöpfe und Importe ändern den Text
// per Programm, und dabei geht der eingebaute Verlauf des Browsers verloren.
const HISTORY_LIMIT = 200;
const TYPING_PAUSE = 700;
let versions = [''];
let historyIndex = 0;
let lastRecord = 0;
let lastWasTyping = false;

function showHistoryButtons() {
  el.undo.disabled = historyIndex === 0;
  el.redo.disabled = historyIndex === versions.length - 1;
}

// Tippen wird zu einem Schritt zusammengefasst, bis eine kurze Pause entsteht.
function recordHistory(typing) {
  const value = el.script.value;
  if (value === versions[historyIndex]) return;
  const now = performance.now();
  if (typing && lastWasTyping && historyIndex > 0 && now - lastRecord < TYPING_PAUSE) {
    versions[historyIndex] = value;
  } else {
    versions.length = historyIndex + 1;
    versions.push(value);
    if (versions.length > HISTORY_LIMIT) versions.shift();
    historyIndex = versions.length - 1;
  }
  lastRecord = now;
  lastWasTyping = typing;
  showHistoryButtons();
}

function stepHistory(direction) {
  const next = historyIndex + direction;
  if (next < 0 || next >= versions.length) return;
  historyIndex = next;
  lastWasTyping = false;
  const { scrollTop } = el.script;
  el.script.value = versions[historyIndex];
  el.script.scrollTop = scrollTop;
  el.fileNote.hidden = true;
  saveText(el.script.value);
  updateCount();
  showHistoryButtons();
}

// Lädt ein Skript aus der Bibliothek ins Textfeld und beginnt einen neuen Verlauf.
initLibrary((text) => {
  el.script.value = text;
  el.script.scrollTop = 0;
  versions = [text];
  historyIndex = 0;
  lastWasTyping = false;
  el.fileNote.hidden = true;
  updateCount();
  showHistoryButtons();
}, (script) => {
  const place = script.folder ? ` im Ordner „${script.folder}"` : '';
  el.fileNote.textContent = `Gespeichert als „${script.title}"${place}.`;
  el.fileNote.hidden = false;
});
$('saveAs').addEventListener('click', openSaveAs);
// Wortlaut des Skripts ohne Markierungen, mit Sprechernamen und Abschnittstiteln als eigene Zeilen.
function plainScript() {
  return el.script.value
    .replace(/\[([^\]\n]*)\]/g, (tag, inner) => {
      const number = speakerNumber(inner, settings.speakers);
      if (number) return `\n\n${settings.speakers[number - 1]}:\n`;
      const section = parseSection(inner);
      return section ? `\n\n${section.title}\n` : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

initCamera(setStatus, () => settings.mic, () => ({ title: currentTitle(), text: plainScript() }));

// Im Browser (Tablet) lässt sich der Prompter als App auf den Startbildschirm legen und startet
// dann auch ohne Internet. Das Programmfenster braucht das nicht.
if ('serviceWorker' in navigator && !window.vpDesktop && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // Ohne gültiges Zertifikat (Test im Heimnetz) läuft die Seite einfach ohne Offline-Speicher.
  });
}

/* ---------- Menüsprache ---------- */

// Zur Menüsprache passende Sprache der Stimmerkennung
const SPEECH_FOR_UI = { de: 'de-DE', en: 'en-US', fr: 'fr-FR', es: 'es-ES', it: 'it-IT' };

for (const [code, name] of Object.entries(LANGS)) el.uiLang.append(new Option(name, code));
el.uiLang.value = uiLang();
el.uiLang.addEventListener('change', () => setUiLang(el.uiLang.value));
onUiLang((lang) => {
  // Wer die Menüsprache wechselt, liest in aller Regel auch in dieser Sprache vor.
  settings.lang = SPEECH_FOR_UI[lang];
  save('vp.settings', settings);
  el.lang.value = settings.lang;
  displayChannel.postMessage({ type: 'lang', lang });
});
el.script.addEventListener('scroll', () => {
  el.highlight.scrollTop = el.script.scrollTop;
});
showSpeakerNames();
el.script.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  event.preventDefault();
  stepHistory(key === 'y' || event.shiftKey ? 1 : -1);
});

el.script.addEventListener('input', (event) => {
  recordHistory(event.isTrusted);
  el.fileNote.hidden = true;
  saveText(el.script.value);
  updateCount();
});
$('clear').addEventListener('click', () => {
  if (!el.script.value) return;
  el.script.value = '';
  el.script.dispatchEvent(new Event('input'));
  el.fileNote.textContent = 'Skript gelöscht. Mit dem Pfeil ↶ oder Strg+Z holst du es zurück.';
  el.fileNote.hidden = false;
  el.script.focus();
});
el.sample.addEventListener('click', () => {
  el.script.value = SAMPLES[uiLang()] || SAMPLE;
  el.script.dispatchEvent(new Event('input'));
});
async function importFile(file) {
  if (!file) return;
  el.fileNote.hidden = false;
  el.fileNote.textContent = `„${file.name}" wird gelesen …`;
  try {
    el.script.value = (await readScriptFile(file)).trim();
    el.script.dispatchEvent(new Event('input'));
    el.fileNote.hidden = true;
  } catch (error) {
    el.fileNote.textContent = error.message;
  }
}

el.file.accept = ACCEPT;
el.file.addEventListener('change', async () => {
  await importFile(el.file.files[0]);
  el.file.value = '';
});
el.script.addEventListener('dragover', (event) => event.preventDefault());
el.script.addEventListener('drop', (event) => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  event.preventDefault();
  importFile(file);
});

if (!voiceSupported) {
  el.support.hidden = false;
  el.support.textContent =
    'Dieser Browser bietet keine Spracherkennung. Das Mitlaufen per Stimme funktioniert in Chrome und Edge; festes Tempo geht überall.';
  settings.mode = 'auto';
}

/* ---------- Prompter ---------- */

function render() {
  const pro = isPro();
  let color = '';
  let quote = false;
  let quoteWords = [];
  // Setzt Anführungszeichen um ein Zitat, sofern im Skript nicht schon welche stehen.
  const [openMark, closeMark] = QUOTE_MARKS[settings.lang.slice(0, 2)] || QUOTE_MARKS.en;
  const marks = /["'„“”‚‘’«»]/;
  const closeQuote = () => {
    quote = false;
    const first = quoteWords[0];
    const last = quoteWords[quoteWords.length - 1];
    quoteWords = [];
    if (!first) return;
    if (!marks.test(first.textContent[0])) first.textContent = openMark + first.textContent;
    if (!marks.test(last.textContent.slice(-2))) last.textContent += closeMark;
  };
  // Ab einer Sprecher-Markierung gehört der Text diesem Sprecher, bis ein anderer folgt.
  let speaker = 0;
  const newParagraph = () => {
    const paragraph = document.createElement('p');
    if (speaker) paragraph.className = `sp sp-${speaker}`;
    return paragraph;
  };
  vocabulary = [];
  speakerOf = [];
  sections = [];
  sectionIndex = -1;
  words = [];
  spans = [];
  el.text.textContent = '';
  for (const block of el.script.value.split(/\n\s*\n/)) {
    if (!block.trim()) continue;
    let p = newParagraph();
    for (const token of block.match(/\[[^\]\n]*\]|[^\s[]+/g) || []) {
      if (token.startsWith('[')) {
        // [rot] … [/rot] färbt, alles andere in Klammern ist eine Regieanweisung.
        const name = token.slice(1, -1).trim().toLowerCase();
        const section = parseSection(token.slice(1, -1));
        if (section) {
          if (pro) {
            // Ein Abschnitt beginnt mit einer Überschrift und zählt seine eigene Zeit.
            if (p.childNodes.length) el.text.append(p);
            sections.push({ start: words.length, ...section });
            const head = document.createElement('div');
            head.className = 'section-head';
            head.textContent = section.target ? `${section.title} · ${clock(section.target)}` : section.title;
            el.text.append(head);
            p = newParagraph();
          }
        } else if (speakerNumber(name, settings.speakers)) {
          if (pro) {
            // Jeder Einsatz beginnt als eigener Absatz mit Namensschild.
            if (p.childNodes.length) el.text.append(p);
            speaker = speakerNumber(name, settings.speakers);
            p = newParagraph();
            const label = document.createElement('span');
            label.className = 'sp-label';
            label.textContent = settings.speakers[speaker - 1];
            p.append(label, ' ');
          }
        } else if (isQuote(name)) {
          quote = true;
          quoteWords = [];
          if (pro) {
            const label = document.createElement('span');
            label.className = 'cue';
            label.textContent = t('Zitat');
            p.append(label, ' ');
          }
        } else if (name.startsWith('/') && isQuote(name.slice(1))) {
          closeQuote();
        } else if (name.startsWith('/')) color = '';
        else if (COLORS[name]) color = COLORS[name];
        else if (pro && name) {
          const cue = document.createElement('span');
          cue.className = 'cue';
          cue.textContent = token.slice(1, -1).trim();
          p.append(cue, ' ');
        }
        continue;
      }
      const key = normalize(token);
      if (key) {
        const span = document.createElement('span');
        span.className = 'w';
        if (pro && color) span.classList.add(color);
        span.textContent = token;
        if (pro && quote) {
          span.classList.add('quote');
          quoteWords.push(span);
        }
        p.append(span, ' ');
        words.push(key);
        spans.push(span);
        speakerOf.push(speaker);
        // Die Erkennung auf dem Gerät kennt bei Wörtern mit Apostroph oder Bindestrich oft nur
        // die Einzelteile (l', eau). Deshalb gehen das ganze Wort und seine Teile ins Vokabular.
        const spoken = token.toLowerCase().replace(/[’`´]/g, "'").replace(/[^\p{L}\p{N}'-]/gu, '');
        vocabulary.push(spoken.replace(/['-]/g, ''));
        if (/['-]/.test(spoken)) {
          vocabulary.push(spoken, ...spoken.split(/(?<=')|-/).filter(Boolean));
        }
      } else {
        p.append(token + ' ');
      }
    }
    if (p.childNodes.length) el.text.append(p);
  }
  if (quote) closeQuote();
  el.meLabel.hidden = !speakerOf.some(Boolean);
  lastSpeakerKey = '';
}

function applySettings() {
  el.mode.value = settings.mode;
  el.lang.value = settings.lang;
  el.size.value = settings.size;
  el.width.value = settings.width;
  el.speed.value = settings.speed;
  el.speedValue.textContent = settings.speed;
  el.follow.value = settings.follow;
  el.followValue.textContent = settings.follow;
  el.mirror.checked = settings.mirror;
  el.flip.checked = settings.flip;
  el.target.value = settings.target || '';
  el.text.style.fontSize = settings.size + 'px';
  el.text.style.maxWidth = settings.width + '%';
  el.text.classList.toggle('mirror', settings.mirror);
  el.text.classList.toggle('flip', settings.flip);
  el.linePos.value = settings.line;
  el.line.textContent =
    settings.line === 0 ? 'Lesezeile: oben'
    : settings.line === MIDDLE_LINE ? 'Lesezeile: Mitte'
    : `Lesezeile: ${settings.line} %`;
  layoutLine();
  el.speedLabel.hidden = settings.mode !== 'auto';
  el.lang.parentElement.hidden = settings.mode !== 'voice';
  el.mic.parentElement.hidden = settings.mode !== 'voice' || MIC_FOR_RECOGNITION_ONLY;
  applyWindowMode();
  if (!el.prompter.hidden) displayChannel.postMessage({ type: 'settings', settings: displaySettings() });
  save('vp.settings', settings);
}

/* ---------- Zweitanzeige auf einem weiteren Monitor ---------- */

const displayChannel = new BroadcastChannel('voiceprompter-display');
let lastDisplayFrame = '';

const displaySettings = () => ({
  size: settings.size, width: settings.width, line: settings.line,
  speakers: settings.speakers, me: settings.me,
});

// Schickt den aufbereiteten Text an die Zweitanzeige (oder meldet, dass kein Prompter offen ist).
function sendDisplayText() {
  lastDisplayFrame = '';
  if (el.prompter.hidden) displayChannel.postMessage({ type: 'idle' });
  else displayChannel.postMessage({ type: 'render', html: el.text.innerHTML, settings: displaySettings() });
}

// Meldet laufend, welches Wort an der Lesezeile steht. Die Zweitanzeige richtet sich danach,
// weil ihre Zeilen je nach Fenstergröße anders umbrechen.
function sendDisplayFrame() {
  if (!spans.length) return;
  const line = el.text.scrollTop + readOffset();
  const index = visibleIndex();
  const frame = {
    type: 'frame',
    index,
    offset: Math.round(((line - spans[index].offsetTop) / lineStep()) * 100) / 100,
    pos,
    showNow: pos < spans.length,
    paused: userPaused,
    ...currentSpeakers(),
    schedule: roundedSchedule(),
  };
  const key = JSON.stringify(frame);
  if (key === lastDisplayFrame) return;
  lastDisplayFrame = key;
  displayChannel.postMessage(frame);
}

// Es können mehrere Anzeigen offen sein, etwa eine je Sprecher. Jede meldet sich mit ihrer Nummer.
const MAX_DISPLAYS = 6;
const displays = new Set();

function showDisplayState() {
  const count = displays.size;
  el.second.textContent =
    count === 0 ? 'Zweiter Monitor' : count === 1 ? 'Zweiter Monitor: an' : `Anzeigen: ${count} an`;
  el.second.classList.toggle('on', count > 0);
  el.secondMore.hidden = count === 0 || count >= MAX_DISPLAYS;
}

function openDisplay() {
  let number = 1;
  while (displays.has(number)) number++;
  if (number > MAX_DISPLAYS) return;
  window.open('display.html', `vp-display-${number}`, 'popup,width=1100,height=650');
}

displayChannel.onmessage = ({ data }) => {
  if (data.type === 'hello') {
    displays.add(data.id ?? 1);
    showDisplayState();
    sendDisplayText();
  } else if (data.type === 'bye') {
    displays.delete(data.id ?? 1);
    showDisplayState();
  }
};
window.addEventListener('pagehide', () => displayChannel.postMessage({ type: 'idle' }));

el.second.addEventListener('click', () => {
  if (!isPro()) {
    openUpgrade('Die Zweitanzeige auf einem weiteren Monitor gehört zur Pro-Version.');
    return;
  }
  if (displays.size) {
    displayChannel.postMessage({ type: 'close' });
    displays.clear();
    showDisplayState();
    return;
  }
  openDisplay();
});
el.secondMore.addEventListener('click', openDisplay);

/* ---------- Schwebefenster (nur Desktop-App) ---------- */

const desktopWindow = window.vpDesktop?.window;

// Das Fenster schwebt nur, solange der Prompter offen ist; das Skript-Fenster bleibt normal.
function applyWindowMode() {
  if (!desktopWindow) return;
  const active = settings.float && isPro();
  const floating = active && !el.prompter.hidden;
  el.floatBox.hidden = false;
  el.floatOptions.hidden = !active;
  el.float.classList.toggle('on', active);
  el.opacity.value = settings.opacity;
  el.protect.checked = settings.protect;
  desktopWindow.setFloating(floating);
  desktopWindow.setOpacity(floating ? settings.opacity / 100 : 1);
  desktopWindow.setProtected(floating && settings.protect);
  if (!floating) desktopWindow.setClickThrough(false);
}

if (desktopWindow) {
  el.float.addEventListener('click', () => {
    if (!isPro()) {
      openUpgrade('Das Schwebefenster gehört zur Pro-Version.');
      return;
    }
    settings.float = !settings.float;
    applySettings();
  });
  el.opacity.addEventListener('input', () => {
    settings.opacity = Number(el.opacity.value);
    applySettings();
  });
  el.protect.addEventListener('change', () => {
    settings.protect = el.protect.checked;
    applySettings();
  });
  let through = false;
  let overControls = false;
  const setOverControls = (over) => {
    if (!through || over === overControls) return;
    overControls = over;
    desktopWindow.setHover(over);
  };
  el.through.addEventListener('click', () => desktopWindow.setClickThrough(!through));
  // Klicks gehen nur durch den Textbereich. Über der Leiste nimmt das Fenster sie wieder an.
  el.bar.addEventListener('mousemove', () => setOverControls(true));
  el.bar.addEventListener('mouseleave', () => setOverControls(false));
  window.vpDesktop.onClickThrough((on) => {
    through = on;
    overControls = false;
    document.body.classList.toggle('through', on);
    el.through.textContent = on ? 'Klicks durchlassen: an' : 'Klicks durchlassen';
    el.through.classList.toggle('on', on);
    if (on) setStatus('Klicks gehen durch den Text. Die Leiste bleibt bedienbar; Strg+Umschalt+K schaltet ebenfalls um.', running);
    else setStatus(running ? 'Höre zu …' : 'Klicks werden wieder angenommen', running && settings.mode === 'voice');
  });
  window.vpDesktop.onToggleRun(() => {
    if (!el.prompter.hidden) running ? pause() : start();
  });
  onPlanChange(applyWindowMode);
}

function setStatus(message, live = false) {
  el.status.textContent = message;
  el.status.classList.toggle('live', live);
}

const readOffset = () =>
  settings.line === 0 ? TOP_OFFSET : (el.text.clientHeight * settings.line) / 100;
const lineStep = () => settings.size * LINE_HEIGHT;

// Trennlinie und Textanfang an die eingestellte Lesezeile setzen.
function layoutLine() {
  const offset = readOffset();
  el.marker.hidden = settings.line === 0;
  // Senkrecht gespiegelt liegt die Lesezeile von unten gemessen.
  el.marker.style.top = (settings.flip ? el.text.clientHeight - offset : offset) + 'px';
  el.text.style.paddingTop = offset + lineStep() + 'px';
}

// Erstes Wort an oder unter der Lesezeile im gerade sichtbaren Ausschnitt.
function visibleIndex() {
  const line = el.text.scrollTop + readOffset();
  let low = 0;
  let high = spans.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (spans[mid].offsetTop + spans[mid].offsetHeight < line) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Der Nutzer scrollt selbst: Mitlaufen anhalten, bis er eine Stelle wählt oder dort weiterspricht.
function browse() {
  // Bei festem Tempo gibt es keine Wortposition; dort merkt sich der Prompter die Scrollhöhe.
  const now = performance.now();
  if (now - lastManualScroll > 1500) resumeTop = el.text.scrollTop;
  lastManualScroll = now;
  if (settings.mode !== 'voice' || browsing) return;
  browsing = true;
  setStatus('Freies Scrollen – Wort anklicken, weitersprechen oder „Lesestelle"', running);
}

// Zurück zur zuletzt gelesenen Stelle.
function resume() {
  if (settings.mode === 'voice') {
    setPosition(pos);
    setStatus(running ? 'Höre zu …' : 'Zurück an der Lesestelle', running);
  } else if (resumeTop !== null) {
    el.text.scrollTop = resumeTop;
    lastManualScroll = -Infinity;
  }
}

function setPosition(next) {
  browsing = false;
  next = Math.max(0, Math.min(words.length, next));
  const from = Math.min(pos, next);
  const to = Math.max(pos, next);
  for (let i = from; i < to; i++) spans[i].classList.toggle('spoken', i < next);
  spans[pos]?.classList.remove('now');
  pos = next;
  const current = spans[Math.min(pos, spans.length - 1)];
  if (!current) return;
  if (pos < spans.length) current.classList.add('now');

  // Die Zeile gleitet mit jedem gesprochenen Wort ein Stück nach oben, statt am
  // Zeilenende einen ganzen Schritt zu springen. Am Zeilenende liegt sie an der Lesezeile.
  const index = spans.indexOf(current);
  const top = current.offsetTop;
  let first = index;
  let last = index;
  while (first > 0 && spans[first - 1].offsetTop === top) first--;
  while (last < spans.length - 1 && spans[last + 1].offsetTop === top) last++;
  const fromPrevious = first > 0 ? top - spans[first - 1].offsetTop : lineStep();
  const done = pos >= spans.length ? 1 : (index - first) / (last - first + 1);
  scrollTarget = top - readOffset() - (1 - done) * fromPrevious;
  updateSpeakers();
  updateSchedule();
  updateScrubber();
}

/* ---------- Seitenleiste zum schnellen Schieben, mit Prozentangabe ---------- */

const scrubber = $('scrubber');
const scrubTrack = $('scrubTrack');

// Wie weit der sichtbare Ausschnitt im Text steht: 0 % am Anfang, 100 % am Ende.
function scrollFraction() {
  const max = el.text.scrollHeight - el.text.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, el.text.scrollTop / max)) : 0;
}

function updateScrubber() {
  scrubber.hidden = el.text.scrollHeight <= el.text.clientHeight;
  const fraction = scrollFraction();
  scrubber.style.setProperty('--f', fraction);
  $('scrubPercent').textContent = `${Math.round(fraction * 100)} %`;
}

function scrubTo(event) {
  const box = scrubTrack.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
  // Wie Scrollen mit dem Mausrad: Mitlaufen pausiert, bis der Nutzer weiterspricht oder ein Wort wählt.
  browse();
  el.text.scrollTop = fraction * (el.text.scrollHeight - el.text.clientHeight);
}

scrubber.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  scrubber.setPointerCapture(event.pointerId);
  scrubber.classList.add('dragging');
  scrubTo(event);
});
scrubber.addEventListener('pointermove', (event) => {
  if (scrubber.hasPointerCapture(event.pointerId)) scrubTo(event);
});
scrubber.addEventListener('pointerup', () => scrubber.classList.remove('dragging'));
scrubber.addEventListener('pointercancel', () => scrubber.classList.remove('dragging'));
el.text.addEventListener('scroll', updateScrubber, { passive: true });

// Zeitplan: Wie lange läuft der aktuelle Abschnitt, und reicht die geplante Zeit voraussichtlich?
function scheduleInfo() {
  if (!sections.length) return null;
  const index = Math.min(settings.mode === 'voice' ? pos : visibleIndex(), words.length);
  let current = -1;
  sections.forEach((section, i) => {
    if (section.start <= index) current = i;
  });
  if (current < 0) return null;
  if (current !== sectionIndex) {
    sectionIndex = current;
    sectionStarted = elapsed;
  }
  const section = sections[current];
  const end = sections[current + 1]?.start ?? words.length;
  const used = elapsed - sectionStarted;
  // Erst nach einer Anlaufzeit ist das gemessene Sprechtempo verlässlich.
  const wpm = elapsed > 20 && index > 20 ? index / (elapsed / 60) : DEFAULT_WPM;
  const projected = used + (Math.max(0, end - index) / wpm) * 60;
  return {
    title: section.title,
    number: current + 1,
    count: sections.length,
    used,
    target: section.target,
    projected,
    state: sectionState(projected, section.target),
  };
}

// Für die Zweitanzeige auf ganze Sekunden gerundet, damit nicht jedes Bild eine Nachricht auslöst.
function roundedSchedule() {
  const info = scheduleInfo();
  if (!info) return null;
  return { ...info, used: Math.floor(info.used), projected: Math.round(info.projected) };
}

function updateSchedule() {
  showSchedule(el.schedule, scheduleInfo());
}

// Farbiger Rahmen und Schild für den Sprecher an der Lesestelle samt Ankündigung des nächsten.
let lastSpeakerKey = '';
function currentSpeakers() {
  const index = settings.mode === 'voice' ? pos : visibleIndex();
  return speakersAt(speakerOf, index);
}
function updateSpeakers() {
  const { current, next } = currentSpeakers();
  const key = `${current}-${next}-${settings.me}`;
  if (key === lastSpeakerKey) return;
  lastSpeakerKey = key;
  showSpeakers(el.stage, el.speakerBadge, { current, next, names: settings.speakers, me: settings.me });
}

// Stoppschilder links und rechts vom Text, solange der Nutzer selbst auf Pause gedrückt hat.
function showPaused(on) {
  userPaused = on;
  el.stage.classList.toggle('paused', on);
}

function pause() {
  stop();
  showPaused(true);
}

// Stufe 1 bis 10; an die Schriftgröße gekoppelt, damit das Lesetempo beim Zoomen gleich bleibt.
// Stufe 5 entspricht etwa normalem Sprechtempo.
const pixelsPerSecond = () => settings.speed * settings.size * 0.1;

function remainingSeconds() {
  if (settings.mode === 'auto') {
    const left = el.text.scrollHeight - el.text.clientHeight - el.text.scrollTop;
    return left / pixelsPerSecond();
  }
  // Erst nach einer Anlaufzeit ist das gemessene Sprechtempo verlässlich.
  const wpm = elapsed > 20 && pos > 20 ? pos / (elapsed / 60) : DEFAULT_WPM;
  return ((words.length - pos) / wpm) * 60;
}

function showTimer() {
  const rest = remainingSeconds();
  const goal = settings.target * 60;
  el.timer.textContent = `${clock(elapsed)} · Rest ca. ${clock(rest)}`;
  el.timer.classList.toggle('over', goal > 0 && elapsed + rest > goal * 1.05);
}

function tick(dt) {
  if (!running) return;
  elapsed += dt;
  if (settings.mode === 'voice' && !isPro()) {
    freeVoiceUsed += dt;
    if (freeVoiceUsed >= FREE_VOICE_SECONDS) {
      stop('Gratis-Zeit für diese Sitzung aufgebraucht');
      openUpgrade(`In der Gratisversion läuft der Text ${FREE_VOICE_SECONDS / 60} Minuten pro Sitzung per Stimme mit. Festes Tempo bleibt unbegrenzt.`);
    }
  }
  if (Math.floor(elapsed) !== shownSecond) {
    shownSecond = Math.floor(elapsed);
    showTimer();
    updateSchedule();
  }
}

function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  tick(dt);
  if (running && settings.mode === 'auto') {
    el.text.scrollTop += pixelsPerSecond() * dt;
    updateSpeakers();
  } else if (settings.mode === 'voice' && !browsing) {
    const diff = scrollTarget - el.text.scrollTop;
    if (Math.abs(diff) > 0.5) el.text.scrollTop += diff * Math.min(1, dt * FOLLOW_RATES[settings.follow - 1]);
  }
  if (analyser) {
    analyser.getByteTimeDomainData(levelData);
    let peak = 0;
    for (const value of levelData) peak = Math.max(peak, Math.abs(value - 128));
    el.level.style.width = Math.min(100, (peak / 128) * 250) + '%';
    if (running && settings.mode === 'voice') {
      analyser.getFloatTimeDomainData(voiceData);
      noteAudio(voiceData, audioContext.sampleRate, elapsed);
    }
  }
  if (!el.prompter.hidden) {
    sendDisplayFrame();
    requestAnimationFrame(frame);
  }
}

/* ---------- Spracherkennung ---------- */

// final: ein abgeschlossener Satz der Erkennung, sonst ein Zwischenstand.
// details: Wörter mit Erkennungssicherheit, nur bei der Erkennung auf dem Gerät.
function onHeard(transcript, final = false, details = []) {
  if (final) noteWords(details);
  // Manche Sprachmodelle liefern „l' eau" getrennt; im Skript ist es ein Wort.
  // Füllwörter zählt der Sprech-Coach; für die Lesestelle spielen sie keine Rolle.
  const heard = noteHeard(toWords(transcript.replace(/(\p{L}')\s+(?=\p{L})/gu, '$1')), final, pos);
  if (!heard.length) return;
  const from = pos;
  if (browsing) {
    const found = findPosition(words, visibleIndex(), heard, { search: true });
    if (found !== null) {
      setPosition(found);
      noteAdvance(from, found, heard, elapsed);
    }
    return;
  }
  setStatus(heard.slice(-5).join(' '), true);
  const next = findPosition(words, pos, heard);
  if (next !== null) {
    setPosition(next);
    noteAdvance(from, next, heard, elapsed);
  }
  if (pos >= words.length) {
    stop(finishSession() ? 'Ende erreicht – Auswertung bereit' : 'Ende erreicht');
    markReady();
  }
}

// Ein neuer Durchlauf für den Sprech-Coach, etwa beim Öffnen des Prompters oder nach „Anfang".
function beginCoaching() {
  finishSession();
  beginSession({
    words,
    texts: spans.map((span) => span.textContent),
    sections,
    lang: settings.lang,
    title: currentTitle(),
    script: plainScript(),
    local: LOCAL_SPEECH,
  });
}

const RECOGNITION_ERRORS = {
  'not-allowed': 'Mikrofon nicht freigegeben',
  'service-not-allowed': 'Spracherkennung im Browser gesperrt',
  network: 'Spracherkennung nicht erreichbar (Internet nötig)',
  'audio-capture': 'Kein Signal vom Mikrofon',
  'language-not-supported': 'Sprache wird nicht unterstützt',
};

function micErrorText(error) {
  if (error.message === 'insecure') return 'Mikrofon nur über https oder localhost';
  if (error.name === 'NotAllowedError') return 'Mikrofon nicht freigegeben (Browser oder Systemeinstellungen)';
  if (error.name === 'NotFoundError') return 'Kein Mikrofon gefunden';
  if (error.name === 'NotReadableError') return 'Mikrofon wird von einem anderen Programm belegt';
  return 'Mikrofonfehler: ' + error.name;
}

async function listMics() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  el.mic.textContent = '';
  el.mic.append(new Option('Systemstandard', ''));
  inputs.forEach((d, i) => el.mic.append(new Option(d.label || `Mikrofon ${i + 1}`, d.deviceId)));
  if (!inputs.some((d) => d.deviceId === settings.mic)) settings.mic = '';
  el.mic.value = settings.mic;
}

async function openMic() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure');
  // Ohne automatische Pegelanpassung, damit der Sprech-Coach echte Lautstärkeverläufe sieht.
  const request = (audio) => navigator.mediaDevices.getUserMedia({ audio: { autoGainControl: false, ...audio } });
  try {
    stream = await request(settings.mic ? { deviceId: { exact: settings.mic } } : {});
  } catch (error) {
    // Das gespeicherte Gerät ist nicht mehr angeschlossen.
    if (!settings.mic || error.name !== 'OverconstrainedError') throw error;
    settings.mic = '';
    stream = await request({});
  }
  audioContext = new AudioContext();
  analyser = audioContext.createAnalyser();
  // 2048 Werte reichen auch für die Tonhöhe tiefer Stimmen (Sprech-Coach).
  analyser.fftSize = 2048;
  levelData = new Uint8Array(analyser.fftSize);
  voiceData = new Float32Array(analyser.fftSize);
  audioContext.createMediaStreamSource(stream).connect(analyser);
  await listMics();
}

function closeMic() {
  stream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();
  stream = audioContext = analyser = null;
  el.level.style.width = '0';
}

function startRecognition() {
  // Neuere Browser nehmen das gewählte Mikrofon als Tonspur an, ältere nur den Systemstandard.
  const track = useTrack ? stream?.getAudioTracks()[0] : null;
  try {
    if (track) recognition.start(track);
    else recognition.start();
  } catch (error) {
    if (!track || error.name === 'InvalidStateError') return;
    useTrack = false;
    recognition.start();
  }
}

async function startListening() {
  setStatus('Mikrofon wird geöffnet …');
  if (!MIC_FOR_RECOGNITION_ONLY) {
    try {
      await openMic();
    } catch (error) {
      closeMic();
      stop(micErrorText(error));
      return;
    }
  }
  if (!running || settings.mode !== 'voice') {
    closeMic();
    return;
  }

  if (LOCAL_SPEECH) {
    try {
      stopLocalSpeech = await startLocalSpeech({
        lang: settings.lang,
        stream,
        audioContext,
        vocabulary: [...vocabulary, ...fillerVocabulary(settings.lang, words)],
        onText: onHeard,
        onStatus: setStatus,
      });
    } catch (error) {
      stop('Spracherkennung konnte nicht starten: ' + error.message);
      return;
    }
    if (!running || settings.mode !== 'voice') {
      stopListening();
      return;
    }
    setStatus('Höre zu …', true);
    return;
  }

  recognition = new Recognition();
  recognition.lang = settings.lang;
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onresult = (event) => {
    let transcript = '';
    let final = true;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript + ' ';
      final &&= event.results[i].isFinal;
    }
    onHeard(transcript, final);
  };
  recognition.onerror = (event) => {
    if (event.error === 'no-speech' || event.error === 'aborted') return;
    if (event.error === 'audio-capture' && useTrack) {
      useTrack = false;
      return;
    }
    stop(RECOGNITION_ERRORS[event.error] || 'Fehler der Spracherkennung: ' + event.error);
  };
  // Der Browser beendet die Erkennung nach Sprechpausen von selbst.
  recognition.onend = () => {
    if (running && settings.mode === 'voice') startRecognition();
  };
  startRecognition();
  setStatus('Höre zu …', true);
}

function stopListening() {
  stopLocalSpeech?.();
  stopLocalSpeech = null;
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
  closeMic();
}

function start() {
  if (running || !words.length) return;
  showPaused(false);
  if (settings.mode === 'voice' && !isPro() && freeVoiceUsed >= FREE_VOICE_SECONDS) {
    openUpgrade('Die Gratis-Zeit für diese Sitzung ist aufgebraucht.');
    return;
  }
  if (pos >= words.length) setPosition(0);
  running = true;
  el.toggle.textContent = 'Pause';
  if (settings.mode === 'voice') startListening();
  else setStatus('Läuft');
}

function stop(message = 'Pausiert') {
  running = false;
  el.toggle.textContent = 'Start';
  stopListening();
  setStatus(message);
}

/* ---------- Bedienung ---------- */

function openPrompter() {
  if (!el.script.value.trim()) {
    el.script.focus();
    return;
  }
  snapshot();
  el.editor.hidden = true;
  el.prompter.hidden = false;
  render();
  applySettings();
  listMics();
  pos = 0;
  setPosition(0);
  el.text.scrollTop = 0;
  scrollTarget = 0;
  elapsed = 0;
  sectionIndex = -1;
  showTimer();
  updateSchedule();
  sendDisplayText();
  beginCoaching();
  setStatus('Bereit – Leertaste zum Starten');
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

/* ---------- Reine Textansicht, etwa für ein Tablet unter einem Teleprompter-Glas ---------- */

let pureMode = false;
let wakeLock = null;
let pureHideTimer = 0;

// Zeigt nur noch den Text: ohne Leiste, bildschirmfüllend, und der Bildschirm bleibt an.
async function setPure(on) {
  if (on === pureMode) return;
  pureMode = on;
  document.body.classList.toggle('pure', on);
  if (on) {
    try {
      await document.documentElement.requestFullscreen?.();
    } catch { /* manche Tablets erlauben kein Vollbild; die Ansicht funktioniert auch so */ }
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch { /* ohne Bildschirmsperre-Schutz geht es ebenfalls */ }
    showPureExit();
  } else {
    if (document.fullscreenElement) document.exitFullscreen();
    wakeLock?.release();
    wakeLock = null;
  }
  layoutLine();
  setPosition(pos);
}

// Der Knopf zum Verlassen blendet sich nach kurzer Zeit aus und kommt bei Berührung wieder.
function showPureExit() {
  document.body.classList.add('pure-controls');
  clearTimeout(pureHideTimer);
  pureHideTimer = setTimeout(() => document.body.classList.remove('pure-controls'), 3000);
}

$('pure').addEventListener('click', () => setPure(true));
$('pureExit').addEventListener('click', (event) => {
  event.stopPropagation();
  setPure(false);
});
el.stage.addEventListener('pointermove', () => pureMode && showPureExit());
el.stage.addEventListener('pointerdown', () => pureMode && showPureExit());
document.addEventListener('fullscreenchange', () => {
  // Wer das Vollbild mit Esc oder einer Geste verlässt, bekommt die Leiste zurück.
  if (!document.fullscreenElement && pureMode) setPure(false);
});
// Nach dem Zurückkehren zur App hält das Tablet den Bildschirm wieder an.
document.addEventListener('visibilitychange', async () => {
  if (pureMode && document.visibilityState === 'visible') {
    try {
      wakeLock = await navigator.wakeLock?.request('screen');
    } catch { /* nicht verfügbar */ }
  }
});

function closePrompter() {
  stopCamera();
  setPure(false);
  showPaused(false);
  setTimeout(applyWindowMode);
  stop();
  finishSession();
  el.prompter.hidden = true;
  el.editor.hidden = false;
  sendDisplayText();
}

el.open.addEventListener('click', openPrompter);
el.back.addEventListener('click', closePrompter);
el.toggle.addEventListener('click', () => (running ? pause() : start()));
el.restart.addEventListener('click', () => {
  setPosition(0);
  el.text.scrollTop = 0;
  elapsed = 0;
  sectionIndex = -1;
  beginCoaching();
  showTimer();
  updateSchedule();
});
$('resume').addEventListener('click', resume);
el.me.addEventListener('change', () => {
  settings.me = Number(el.me.value);
  applySettings();
  updateSpeakers();
});
el.linePos.addEventListener('input', () => {
  settings.line = Number(el.linePos.value);
  applySettings();
  setPosition(pos);
});
// Auch wenn nur die Leiste unten umbricht, ändert sich die Höhe des Textbereichs; Lesezeile nachziehen.
new ResizeObserver(() => {
  if (el.prompter.hidden) return;
  layoutLine();
  setPosition(pos);
}).observe(el.text);
el.target.addEventListener('input', () => {
  settings.target = Math.max(0, Number(el.target.value) || 0);
  save('vp.settings', settings);
  showTimer();
});
el.timerLocked.addEventListener('click', () => {
  openUpgrade('Der Timer gehört zur Pro-Version.');
});

// Nach dem Wechsel der Version den Text mit oder ohne Pro-Funktionen neu aufbauen.
onPlanChange(() => {
  if (el.prompter.hidden) return;
  const keep = pos;
  render();
  pos = 0;
  setPosition(keep);
  sendDisplayText();
  showTimer();
});

el.mode.addEventListener('change', () => {
  if (el.mode.value === 'voice' && !voiceSupported) {
    el.mode.value = 'auto';
    setStatus('Stimme nur in Chrome und Edge');
    return;
  }
  stop();
  settings.mode = el.mode.value;
  applySettings();
});
el.lang.addEventListener('change', () => {
  stop();
  settings.lang = el.lang.value;
  applySettings();
});
el.mic.addEventListener('change', () => {
  settings.mic = el.mic.value;
  save('vp.settings', settings);
  useTrack = true;
  if (running && settings.mode === 'voice') {
    stopListening();
    startListening();
  }
});
for (const key of ['size', 'width', 'speed', 'follow']) {
  el[key].addEventListener('input', () => {
    settings[key] = Number(el[key].value);
    applySettings();
    setPosition(pos);
  });
}
el.line.addEventListener('click', () => {
  settings.line = settings.line < 20 ? MIDDLE_LINE : 0;
  applySettings();
  setPosition(pos);
});
el.flip.addEventListener('change', () => {
  settings.flip = el.flip.checked;
  applySettings();
});
el.mirror.addEventListener('change', () => {
  settings.mirror = el.mirror.checked;
  applySettings();
});

// Klick auf ein Wort setzt die Lesestelle dorthin.
el.text.addEventListener('click', (event) => {
  // In der reinen Textansicht startet und pausiert ein Tipper. Nach freiem Scrollen
  // setzt er wie gewohnt die Lesestelle auf das angetippte Wort.
  if (pureMode && !browsing) {
    running ? pause() : start();
    return;
  }
  const index = spans.indexOf(event.target);
  if (index < 0) return;
  setPosition(index);
  if (settings.mode === 'auto') el.text.scrollTop = scrollTarget;
  else setStatus(running ? 'Höre zu …' : 'Lesestelle gesetzt', running);
});
el.text.addEventListener('wheel', browse, { passive: true });
el.text.addEventListener('touchmove', browse, { passive: true });

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    toggleCueMenu(false);
    toggleSpeakerMenu(false);
  }
  if (el.prompter.hidden || event.target.matches('select, input')) return;
  if (document.querySelector('dialog[open]')) return;
  const step = el.text.clientHeight * 0.25;
  switch (event.key) {
    case ' ': event.preventDefault(); running ? pause() : start(); break;
    case 'Escape': pureMode ? setPure(false) : closePrompter(); break;
    case '+': case '-':
      if (settings.mode !== 'auto') return;
      settings.speed = Math.max(1, Math.min(10, settings.speed + (event.key === '+' ? 1 : -1)));
      applySettings();
      break;
    case 'Enter': if (event.target.matches('button')) return; resume(); break;
    case 'Home': setPosition(0); el.text.scrollTop = 0; break;
    case 'ArrowDown': browse(); el.text.scrollTop += step; break;
    case 'ArrowUp': browse(); el.text.scrollTop -= step; break;
    default: return;
  }
});

// Testzugang: speist Text ein, als käme er aus der Spracherkennung.
window.vpFeed = onHeard;
window.vpState = () => ({ pos, scrollTarget, browsing });
window.vpSendFrame = sendDisplayFrame;
window.vpPlainScript = plainScript;
