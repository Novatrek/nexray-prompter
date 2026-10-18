// Sprech-Coach: wertet einen Durchlauf mit Stimme aus – Tempo, Füllwörter, Pausen und
// ausgelassene Stellen. Alles wird auf dem Gerät berechnet. Nur wer die Auswertung selbst
// an ChatGPT übergibt, teilt sie.
import { normalize, similar } from './align.js';
import { load, save } from './storage.js';
import { t, uiLang } from './i18n.js';
import { clock } from './schedule.js';
import { isPro, openUpgrade } from './plan.js';

// Füllwörter, die die Sprachmodelle kennen. Echte Wörter wie „also" zählen bewusst nicht.
const FILLERS = {
  de: ['äh', 'ähm', 'äm', 'hm', 'hmm'],
  en: ['uh', 'um', 'uhm', 'erm', 'hmm'],
  fr: ['euh', 'heu', 'hum'],
  es: ['eh', 'ehm', 'mmm'],
  it: ['eh', 'ehm', 'ehh', 'mmm'],
};
const PAUSE_MIN = 3;
const SKIP_MIN = 4;
const MIN_WORDS = 20;
const MIN_SECONDS = 15;
const HISTORY_LIMIT = 100;
const SHOWN_HISTORY = 5;
const SCRIPT_LIMIT = 15000;
const AUDIO_STEP = 0.1;
const EXCERPT_LIMIT = 500;

const $ = (id) => document.getElementById(id);
const dialog = $('coach');
const body = $('coachBody');
let session = null;

// Füllwörter, die im Skript nicht vorkommen (Schlüssel → Schreibweise). Steht etwa „hm" im Text,
// ist es dort gewollt.
function fillerKeys(lang, words) {
  const inScript = new Set(words);
  return new Map((FILLERS[lang] || []).map((word) => [normalize(word), word]).filter(([key]) => !inScript.has(key)));
}

// Für die Spracherkennung auf dem Gerät: Sie erkennt nur Wörter, die man ihr vorher nennt.
export function fillerVocabulary(lang, words) {
  const keys = fillerKeys(lang.slice(0, 2), words);
  return (FILLERS[lang.slice(0, 2)] || []).filter((word) => keys.has(normalize(word)));
}

// words: Skriptwörter (normalisiert), texts: dieselben Wörter wie im Skript geschrieben.
export function beginSession({ words, texts, sections, lang, title, script, local }) {
  session = {
    id: Date.now(),
    words,
    texts,
    sections,
    title,
    script,
    local,
    lang: lang.slice(0, 2),
    fillers: fillerKeys(lang.slice(0, 2), words),
    reached: new Array(words.length).fill(null),
    heardFillers: [],
    gaps: [],
    repeats: 0,
    confidences: [],
    unknown: 0,
    recognized: 0,
    pending: 0,
    levels: [],
    lastAudio: -Infinity,
    firstAt: null,
    lastAt: null,
  };
  $('coachOpen').classList.remove('ready');
}

// Zählt Füllwörter (nur in fertigen Sätzen, damit Zwischenstände nicht doppelt zählen) und
// liefert die gehörten Wörter ohne Füllwörter für die Zuordnung zum Skript.
export function noteHeard(heard, final, pos) {
  if (!session) return heard;
  // Der letzte, noch nicht abgeschlossene Satz zählt für die Deutlichkeit mit; am Skriptende
  // stoppt die Erkennung, bevor er fertig gemeldet wird.
  session.pending = final ? 0 : heard.filter((word) => word !== 'unk' && !session.fillers.has(word)).length;
  if (final) {
    for (const key of heard) {
      if (session.fillers.has(key)) session.heardFillers.push({ word: session.fillers.get(key), at: pos });
    }
  }
  return heard.filter((word) => !session.fillers.has(word));
}

// Die Lesestelle ist per Stimme von from nach to gerückt.
export function noteAdvance(from, to, heard, at) {
  if (!session) return;
  // Ein Sprung zurück heißt: Der Sprecher hat neu angesetzt.
  if (to < from - 2) session.repeats++;
  if (to <= from) return;
  if (session.lastAt === null) session.firstAt = at;
  else if (at - session.lastAt >= PAUSE_MIN) session.gaps.push({ at: from, seconds: at - session.lastAt });
  session.lastAt = at;
  // Bei einem großen Sprung zählt ein Wort nur als gesprochen, wenn es auch zu hören war.
  // Die letzten Wörter vor der neuen Stelle hat die Zuordnung selbst bestätigt.
  for (let i = from; i < to; i++) {
    const heardIt = to - from <= 2 || i >= to - 3 || heard.some((word) => similar(word, session.words[i]));
    if (heardIt && session.reached[i] === null) session.reached[i] = at;
  }
}

function snippet(from, to) {
  const words = session.texts.slice(from, to);
  const text = words.slice(0, 14).join(' ');
  return words.length > 14 ? text + ' …' : text;
}

// Die Stelle einer Pause: die letzten Wörter davor, ein Pausenzeichen, die ersten danach.
function pauseSnippet(at) {
  const before = session.texts.slice(Math.max(0, at - 6), at).join(' ');
  const after = session.texts.slice(at, at + 5).join(' ');
  return `${at > 6 ? '… ' : ''}${before} ⏸ ${after} …`;
}

function tempoRating(wpm) {
  if (wpm < 95) return ['sehr ruhig', 'warn'];
  if (wpm < 115) return ['ruhig', 'ok'];
  if (wpm <= 150) return ['angenehm', 'ok'];
  if (wpm <= 170) return ['zügig', 'ok'];
  return ['sehr schnell', 'warn'];
}

export function summarize() {
  if (!session || session.firstAt === null) return null;
  const { reached, words } = session;
  const indices = reached.flatMap((at, i) => (at === null ? [] : [i]));
  const duration = session.lastAt - session.firstAt;
  if (indices.length < MIN_WORDS || duration < MIN_SECONDS) return null;
  const minutes = duration / 60;

  // Ausgelassen: längere Folgen nicht gehörter Wörter zwischen erstem und letztem gesprochenen Wort.
  const skipped = [];
  let run = null;
  for (let i = indices[0]; i <= indices[indices.length - 1] + 1; i++) {
    if (i <= indices[indices.length - 1] && reached[i] === null) {
      run ??= i;
    } else if (run !== null) {
      if (i - run >= SKIP_MIN) skipped.push({ from: run, to: i, text: snippet(run, i) });
      run = null;
    }
  }

  // Tempo am Anfang und am Ende (jeweils ein Drittel der Redezeit).
  const third = duration / 3;
  const partWpm = (from, to) =>
    indices.filter((i) => reached[i] >= from && reached[i] < to).length / (third / 60);
  const startWpm = Math.round(partWpm(session.firstAt, session.firstAt + third));
  const endWpm = Math.round(partWpm(session.lastAt - third, session.lastAt + 0.001));

  const fillerCounts = {};
  for (const { word } of session.heardFillers) fillerCounts[word] = (fillerCounts[word] || 0) + 1;

  const sectionRows = session.sections.flatMap((section, n) => {
    const end = session.sections[n + 1]?.start ?? words.length;
    const times = indices.filter((i) => i >= section.start && i < end).map((i) => reached[i]);
    if (!times.length) return [];
    const nextStart = indices.find((i) => i >= end);
    const finished = nextStart === undefined ? session.lastAt : reached[nextStart];
    return [{ title: section.title, target: section.target, used: finished - Math.min(...times) }];
  });

  const wpm = Math.round(indices.length / minutes);
  return {
    duration,
    spoken: indices.length,
    wpm,
    rating: tempoRating(wpm),
    startWpm,
    endWpm,
    local: session.local,
    fillers: session.heardFillers.length,
    fillerCounts,
    fillersPerMinute: session.heardFillers.length / minutes,
    gaps: session.gaps
      .slice()
      .sort((a, b) => b.seconds - a.seconds)
      .map((gap) => ({ seconds: Math.round(gap.seconds), text: pauseSnippet(gap.at) })),
    skipped,
    skippedWords: skipped.reduce((sum, part) => sum + part.to - part.from, 0),
    sections: sectionRows,
    repeats: session.repeats,
  };
}

// Auswertung samt Verständlichkeit (braucht die Hilfsfunktionen weiter unten).
function evaluate() {
  const result = summarize();
  if (result) result.clarity = clarity(result);
  return result;
}

/* ---------- Verlauf ---------- */

const history = () => load('vp.coach', []);

// Speichert die Kennzahlen des laufenden Durchlaufs (ein Durchlauf überschreibt seinen Eintrag).
export function finishSession() {
  const result = evaluate();
  if (!result) return null;
  const entry = {
    id: session.id,
    time: Date.now(),
    title: session.title,
    duration: Math.round(result.duration),
    wpm: result.wpm,
    fillers: result.local ? result.fillers : null,
    pauses: result.gaps.length,
    skipped: result.skippedWords,
    clarity: Math.round(result.clarity.overall * 10) / 10,
  };
  const list = history().filter((item) => item.id !== entry.id);
  list.push(entry);
  save('vp.coach', list.slice(-HISTORY_LIMIT));
  return result;
}

// Markiert den Knopf, sobald eine Auswertung vorliegt (etwa am Ende des Skripts).
export function markReady() {
  if (summarize()) $('coachOpen').classList.add('ready');
}

/* ---------- Anzeige ---------- */

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function tile(label, value, unit, chip) {
  const box = node('div', 'coach-tile');
  box.append(node('span', 'coach-label', label), node('strong', 'coach-value', value));
  if (unit) box.append(node('span', 'coach-unit', unit));
  if (chip) box.append(node('span', `coach-chip ${chip[1]}`, chip[0]));
  return box;
}

/* ---------- Sprachniveau (A1 bis C2) ---------- */

// Stufen des Gemeinsamen Europäischen Referenzrahmens. Keine Note: Jede Stufe hat ihr Publikum.
const LEVELS = [
  { code: 'A1', text: 'sehr einfache, kurze Sätze' },
  { code: 'A2', text: 'einfache Sätze, Alltagswörter' },
  { code: 'B1', text: 'klar und zusammenhängend' },
  { code: 'B2', text: 'flüssig, mit Argumenten' },
  { code: 'C1', text: 'anspruchsvoll, mit Stilmitteln' },
  { code: 'C2', text: 'sehr präzise und nuanciert' },
];
// Obergrenzen des Lesbarkeitsindex LIX je Stufe. Deutsche Texte haben durch zusammengesetzte
// Wörter mehr lange Wörter und liegen daher etwas höher.
const LIX_BANDS = { de: [15, 25, 38, 60, 80], other: [10, 15, 28, 48, 70] };
// range: passende Stufen (Index in LEVELS) für dieses Publikum.
const AUDIENCES = [
  { key: 'social', label: 'Breites Publikum, Social Media', en: 'a broad audience, social media', range: [2, 2] },
  { key: 'international', label: 'Internationales Publikum, Nicht-Muttersprachler', en: 'an international audience of non-native speakers', range: [1, 2] },
  { key: 'young', label: 'Kinder und Jugendliche', en: 'children and teenagers', range: [1, 2] },
  { key: 'business', label: 'Team, Kunden, Vertrieb', en: 'team, customers, sales', range: [2, 3] },
  { key: 'training', label: 'Webinar, Schulung, Erklärvideo', en: 'webinar, training, explainer video', range: [2, 3] },
  { key: 'expert', label: 'Fachvortrag, Konferenz', en: 'expert talk, conference', range: [3, 4] },
  { key: 'keynote', label: 'Keynote, Festrede', en: 'keynote, ceremonial speech', range: [4, 5] },
];

// Richtwert aus Satzlänge und Anteil langer Wörter (LIX). null bei zu kurzen Texten.
function scriptLevel(text, lang) {
  const sentences = text
    .split(/[.!?…;:]+|\n+/)
    .map((sentence) => sentence.match(/\p{L}[\p{L}'’-]*/gu) || [])
    .filter((words) => words.length);
  const words = sentences.flat();
  if (words.length < 30) return null;
  const long = words.filter((word) => word.replace(/['’-]/g, '').length > 6).length;
  const lix = words.length / sentences.length + (100 * long) / words.length;
  const index = (LIX_BANDS[lang] || LIX_BANDS.other).findIndex((limit) => lix < limit);
  return { index: index < 0 ? LEVELS.length - 1 : index, lix: Math.round(lix) };
}

function audience() {
  const key = load('vp.coachAudience', 'business');
  return AUDIENCES.find((item) => item.key === key) || AUDIENCES[3];
}

const levelRange = ([min, max]) => (min === max ? LEVELS[min].code : `${LEVELS[min].code}–${LEVELS[max].code}`);

function levelAdvice(level, target) {
  if (level.index > target.range[1]) return 'Für dieses Publikum etwas anspruchsvoll: Kürzere Sätze und einfachere Wörter machen es leichter verständlich.';
  if (level.index < target.range[0]) return 'Für dieses Publikum darfst du anspruchsvoller formulieren: mehr Struktur, Fachbegriffe und Stilmittel.';
  return 'Passt gut zu diesem Publikum und Anlass.';
}

function showLevel(container) {
  const level = session && scriptLevel(session.script, session.lang);
  if (!level) return;
  const target = audience();
  container.append(node('h3', '', 'Sprachniveau des Skripts'));
  const scale = node('div', 'coach-levels');
  LEVELS.forEach((item, i) => {
    let className = 'coach-level';
    if (i === level.index) className += ' current';
    if (i >= target.range[0] && i <= target.range[1]) className += ' target';
    const cell = node('div', className);
    cell.append(node('strong', '', item.code), node('span', '', item.text));
    scale.append(cell);
  });
  container.append(scale);

  const choice = node('label', 'coach-audience');
  const select = node('select');
  for (const item of AUDIENCES) select.append(new Option(item.label, item.key));
  select.value = target.key;
  select.addEventListener('change', () => {
    save('vp.coachAudience', select.value);
    render(evaluate());
  });
  choice.append(node('span', '', 'Publikum und Anlass'), select);
  container.append(choice);
  const advice = node('p', 'coach-line');
  advice.append(node('strong', '', `Empfohlen für dieses Publikum: ${levelRange(target.range)}`), ' ', node('span', '', levelAdvice(level, target)));
  container.append(advice, node('p', 'coach-line muted', 'Richtwert aus Satz- und Wortlänge – keine Note. Jede Stufe hat ihr Publikum.'));
}

const decimal = (value) => value.toLocaleString(uiLang(), { maximumFractionDigits: 1 });

/* ---------- Stimme: Deutlichkeit, Lautstärke, Melodie, Redefluss ---------- */

// Die Erkennung meldet zu jedem Wort, wie sicher sie es verstanden hat (0 bis 1).
export function noteWords(details) {
  if (!session) return;
  for (const { word, conf } of details) {
    if (word === '[unk]') session.unknown++;
    else if (!session.fillers.has(normalize(word))) {
      session.recognized++;
      if (typeof conf === 'number') session.confidences.push(conf);
    }
  }
}

// Alle 0,1 Sekunden Redezeit: Lautstärke (RMS) und Tonhöhe des Mikrofonsignals.
export function noteAudio(samples, sampleRate, at) {
  if (!session || at - session.lastAudio < AUDIO_STEP) return;
  session.lastAudio = at;
  let sum = 0;
  for (const value of samples) sum += value * value;
  const rms = Math.sqrt(sum / samples.length);
  session.levels.push({ at, rms, pitch: rms > 0.003 ? pitchOf(samples, sampleRate) : 0 });
}

// Tonhöhe per Autokorrelation (jeder zweite Wert genügt). Stimmen liegen etwa zwischen 70 und 400 Hz.
function pitchOf(samples, sampleRate) {
  const n = samples.length >> 1;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = samples[i * 2];
  const rate = sampleRate / 2;
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.min(n - 2, Math.ceil(rate / 70));
  let energy = 0;
  for (const value of x) energy += value * value;
  if (!energy) return 0;
  const corr = new Float32Array(maxLag + 1);
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    corr[lag] = (s / energy) * (n / (n - lag));
    if (corr[lag] > best) {
      best = corr[lag];
      bestLag = lag;
    }
  }
  if (best < 0.5) return 0;
  // Gegen Oktavfehler: Liegt bei der halben Verschiebung fast ebenso viel, gilt die höhere Tonlage.
  const half = Math.round(bestLag / 2);
  if (half >= minLag && corr[half] > best * 0.85) bestLag = half;
  return rate / bestLag;
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const spread = (values) => {
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
};
const clampScore = (value) => Math.max(1, Math.min(5, Math.round(value)));

// Fünf Bereiche der Verständlichkeit auf der Skala 1 bis 5 (Richtwerte, null ohne Messdaten).
function clarity(result) {
  const out = {};
  const { confidences, unknown, levels } = session;
  const recognized = session.recognized + session.pending;

  // Deutlich gesprochen heißt: Die Erkennung hat die gesprochenen Skriptwörter auch als solche
  // gehört, sicher und ohne viele unverständliche Stellen ([unk]).
  if (recognized >= 15) {
    const ratio = Math.min(1, recognized / result.spoken);
    const unknownShare = unknown / (unknown + recognized);
    // Etwas Spielraum: Namen und seltene Wörter kennt das Sprachmodell oft nicht.
    let score = ratio >= 0.9 ? 5 : ratio >= 0.8 ? 4 : ratio >= 0.7 ? 3 : ratio >= 0.55 ? 2 : 1;
    if (confidences.length && mean(confidences) < 0.9) score -= 1;
    if (unknownShare > 0.15) score -= 1;
    (out.measured ??= {}).recognized = Math.round(ratio * 100) / 100;
    out.articulation = { score: clampScore(score), note: score >= 4 ? 'sehr deutlich' : score === 3 ? 'meist deutlich' : 'teils undeutlich' };
  }

  const wpm = result.wpm;
  const tempo = wpm >= 115 && wpm <= 155 ? 5 : wpm >= 100 && wpm <= 170 ? 4 : wpm >= 90 && wpm <= 185 ? 3 : wpm >= 75 && wpm <= 200 ? 2 : 1;
  out.tempo = { score: tempo, note: result.rating[0] };

  // Gesprochen wird, wo das Signal deutlich über dem Grundrauschen liegt.
  const sorted = levels.map((l) => l.rms).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const voiced = levels.filter((l) => l.rms > Math.max(0.006, floor * 2.5));
  if (voiced.length >= 80) {
    // Je Sekunde zählt die kräftige Silbe (oberes Viertel), nicht das Ausklingen der Wörter.
    const db = (l) => 20 * Math.log10(l.rms);
    const seconds = new Map();
    for (const l of voiced) {
      const key = Math.floor(l.at);
      seconds.set(key, [...(seconds.get(key) || []), db(l)]);
    }
    const loud = [...seconds.values()]
      .filter((values) => values.length >= 3)
      .map((values) => values.sort((a, b) => a - b)[Math.floor(values.length * 0.75)]);
    const third = Math.max(1, Math.floor(loud.length / 3));
    const drop = loud.length >= 6 ? mean(loud.slice(0, third)) - mean(loud.slice(-third)) : 0;
    const swing = loud.length >= 6 ? spread(loud) : 0;
    let score = 5;
    if (drop > 4) score -= 1;
    if (drop > 6) score -= 1;
    if (drop > 9) score -= 1;
    if (swing > 5) score -= 1;
    if (swing > 7) score -= 1;
    out.volume = { score: clampScore(score), note: drop > 4 ? 'zum Ende leiser' : swing > 5 ? 'schwankt' : 'gleichmäßig' };
    out.measured = { ...out.measured, drop: Math.round(drop * 10) / 10, swing: Math.round(swing * 10) / 10 };

    const pitches = voiced.map((l) => l.pitch).filter(Boolean);
    if (pitches.length >= 40) {
      const median = pitches.slice().sort((a, b) => a - b)[pitches.length >> 1];
      const range = spread(pitches.map((p) => 12 * Math.log2(p / median)));
      out.measured.pitchRange = Math.round(range * 10) / 10;
      const score2 = range >= 3 ? 5 : range >= 2.2 ? 4 : range >= 1.5 ? 3 : range >= 0.9 ? 2 : 1;
      out.melody = { score: score2, note: score2 >= 4 ? 'lebendig' : score2 === 3 ? 'abwechslungsreich' : score2 === 2 ? 'eher gleichförmig' : 'monoton' };
    }
  }

  const minutes = result.duration / 60;
  const penalty = (result.local ? result.fillersPerMinute * 0.5 : 0) + result.gaps.length / minutes + session.repeats / minutes;
  out.flow = { score: clampScore(5 - penalty), note: penalty < 0.5 ? 'flüssig' : penalty < 1.5 ? 'meist flüssig' : 'stockend' };

  if (confidences.length) (out.measured ??= {}).confidence = Math.round(mean(confidences) * 100) / 100;
  const scores = CLARITY.filter((item) => out[item.key]).map((item) => out[item.key].score);
  out.overall = mean(scores);
  return out;
}

const CLARITY = [
  { key: 'articulation', label: 'Artikulation', hint: 'Wie sicher die Spracherkennung jedes Wort verstanden hat' },
  { key: 'tempo', label: 'Tempo', hint: 'Ideal sind etwa 115 bis 155 Wörter pro Minute' },
  { key: 'volume', label: 'Lautstärke', hint: 'Gleichmäßig bis zum letzten Satz?' },
  { key: 'melody', label: 'Stimmmelodie', hint: 'Betonung und Lebendigkeit der Stimme' },
  { key: 'flow', label: 'Redefluss', hint: 'Pausen, Füllwörter und Wiederholungen' },
];
const CHALLENGES = {
  articulation: 'Sprich den Zungenbrecher „Fischers Fritz fischt frische Fische" dreimal langsam und überdeutlich, dann dreimal schnell.',
  tempo: 'Lies den ersten Absatz mit einer stillen Pause nach jedem Punkt – zähl dabei innerlich bis zwei.',
  volume: 'Sprich deinen letzten Satz so, als säße die letzte Reihe zehn Meter entfernt – mit derselben Kraft wie den ersten.',
  melody: 'Markiere drei Schlüsselwörter und betone sie hörbar: einen Ton höher und etwas langsamer.',
  flow: 'Ersetze jedes „äh" durch ein kurzes Durchatmen. Lieber eine stille Sekunde als ein Füllwort.',
};

function headline(overall) {
  if (overall >= 4.5) return 'Klar, lebendig, souverän.';
  if (overall >= 3.5) return 'Gut verständlich – mit Luft nach oben.';
  if (overall >= 2.5) return 'Solide Basis – jetzt kommt der Feinschliff.';
  return 'Jeder Profi hat so angefangen – dranbleiben!';
}

function showClarity(container, result) {
  const parts = result.clarity;
  const card = node('div', 'coach-score');
  const ring = node('div', 'coach-ring');
  ring.style.setProperty('--score', parts.overall / 5);
  ring.append(node('strong', '', decimal(parts.overall)), node('span', '', 'von 5'));
  const side = node('div', 'coach-score-side');
  side.append(node('span', 'coach-label', 'Verständlichkeit'), node('strong', 'coach-headline', headline(parts.overall)));
  const bars = node('div', 'coach-bars');
  const measured = CLARITY.filter((item) => parts[item.key]);
  for (const item of measured) {
    const part = parts[item.key];
    const row = node('div', `coach-bar s${part.score}`);
    row.title = item.hint;
    const dots = node('span', 'coach-dots');
    for (let i = 1; i <= 5; i++) dots.append(node('i', i <= part.score ? 'on' : ''));
    row.append(node('span', 'coach-bar-label', item.label), dots, node('span', 'coach-bar-note', part.note));
    bars.append(row);
  }
  side.append(bars);
  card.append(ring, side);
  container.append(card);

  const best = measured.reduce((a, b) => (parts[b.key].score > parts[a.key].score ? b : a));
  const focus = measured.reduce((a, b) => (parts[b.key].score < parts[a.key].score ? b : a));
  const duo = node('div', 'coach-duo');
  const strength = node('div', 'coach-strength');
  strength.append(node('span', 'coach-label', 'Deine Stärke'), node('strong', '', best.label));
  const next = node('div', 'coach-focus');
  next.append(node('span', 'coach-label', 'Challenge für den nächsten Durchlauf'), node('strong', '', focus.label), node('p', '', CHALLENGES[focus.key]));
  duo.append(strength, next);
  container.append(duo, node('p', 'coach-line muted', 'Richtwerte aus Mikrofon und Spracherkennung – Mikrofon und Raum beeinflussen die Werte.'));
}


function tips(result) {
  const list = [];
  if (result.wpm > 165) list.push('Du sprichst recht schnell. Mach nach wichtigen Sätzen bewusst eine kurze Pause.');
  else if (result.wpm < 100) list.push('Dein Tempo ist sehr ruhig. Etwas mehr Schwung hält die Aufmerksamkeit.');
  else list.push('Dein Tempo liegt im angenehmen Bereich für Vorträge.');
  if (result.endWpm > result.startWpm * 1.15 && result.duration > 60) {
    list.push('Zum Ende hin bist du schneller geworden – ein typisches Zeichen von Anspannung. Atme vor dem Schluss einmal bewusst durch.');
  }
  if (result.local && result.fillersPerMinute > 3) {
    list.push('Viele Füllwörter: Ersetze „äh" durch eine kurze, stille Pause – das wirkt souveräner.');
  } else if (result.local && result.fillersPerMinute <= 1) {
    list.push('Kaum Füllwörter – sehr gut.');
  }
  if (result.skipped.length) {
    list.push('An den markierten Stellen bist du vom Skript abgewichen. Prüfe, ob der Text dort zu kompliziert formuliert ist.');
  }
  if (result.gaps.length) {
    list.push('An längeren Pausen bist du womöglich hängen geblieben. Lies diese Stellen vorab einmal laut.');
  }
  return list;
}

function showHistory(container) {
  const runs = history().filter((item) => item.title === session?.title).slice(-SHOWN_HISTORY).reverse();
  if (!runs.length) return;
  container.append(node('h3', '', 'Verlauf dieses Skripts'));
  const table = node('table', 'coach-table');
  const head = node('tr');
  for (const label of ['Datum', 'Redezeit', 'Tempo', 'Füllwörter', 'Pausen', 'Verständlichkeit']) head.append(node('th', '', label));
  table.append(head);
  for (const run of runs) {
    const row = node('tr', run.id === session.id ? 'current' : '');
    const date = new Date(run.time).toLocaleString(uiLang(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    for (const value of [date, clock(run.duration), String(run.wpm), run.fillers === null ? '–' : String(run.fillers), String(run.pauses), run.clarity ? decimal(run.clarity) : '–']) {
      row.append(node('td', '', value));
    }
    table.append(row);
  }
  container.append(table);
}

function render(result) {
  body.textContent = '';
  if (!result) {
    body.append(node('p', 'coach-empty', 'Noch keine Auswertung. Starte den Prompter im Modus „Stimme" und lies mindestens 20 Wörter – danach findest du hier Tempo, Füllwörter, Pausen und ausgelassene Stellen.'));
    if (isPro()) {
      showLevel(body);
      showHistory(body);
    }
    return;
  }

  const tiles = node('div', 'coach-tiles');
  tiles.append(
    tile('Redezeit', clock(result.duration), `${result.spoken} Wörter`),
    tile('Tempo', String(result.wpm), 'Wörter pro Minute', result.rating),
  );
  body.append(tiles);

  if (!isPro()) {
    const locked = node('div', 'coach-locked');
    const title = node('p', 'coach-locked-title');
    title.append(node('span', 'crown-icon'), node('span', '', 'Die vollständige Auswertung gehört zu Pro:'));
    const list = node('ul');
    for (const item of ['Verständlichkeit in fünf Bereichen (1–5)', 'Füllwörter', 'Pausen und Hänger', 'Ausgelassene Stellen', 'Abschnitte im Zeitplan', 'Sprachniveau (A1–C2) passend zum Publikum', 'Verlauf über alle Durchläufe', 'Übergabe an ChatGPT']) {
      list.append(node('li', '', item));
    }
    const button = node('button', 'primary', 'Pro ansehen');
    button.type = 'button';
    button.addEventListener('click', () => {
      dialog.close();
      openUpgrade('Die vollständige Auswertung gehört zur Pro-Version.');
    });
    locked.append(title, list, button);
    body.append(locked);
    return;
  }

  // Verständlichkeit als Karte ganz oben, die Kennzahlen darunter.
  const card = node('div');
  showClarity(card, result);
  body.prepend(...card.childNodes);

  tiles.append(
    result.local
      ? tile('Füllwörter', String(result.fillers), `${decimal(result.fillersPerMinute)} pro Minute`,
        result.fillersPerMinute > 3 ? ['häufig', 'warn'] : result.fillersPerMinute <= 1 ? ['selten', 'ok'] : ['mittel', 'ok'])
      : tile('Füllwörter', '–', 'nur in der Desktop-App'),
    tile('Längere Pausen', String(result.gaps.length), 'über 3 Sekunden', result.gaps.length > 3 ? ['oft', 'warn'] : null),
    tile('Ausgelassen', String(result.skippedWords), 'Wörter', result.skippedWords ? ['prüfen', 'warn'] : ['vollständig', 'ok']),
  );
  if (result.duration > 60) {
    body.append(node('p', 'coach-line muted', `Tempo am Anfang ${result.startWpm}, am Ende ${result.endWpm} Wörter pro Minute`));
  }
  const counts = Object.entries(result.fillerCounts);
  if (counts.length) {
    const line = node('p', 'coach-line muted');
    line.append(node('span', '', 'Gehört:'), ' ', node('span', 'coach-quote', counts.map(([word, n]) => `${word} ×${n}`).join(' · ')));
    body.append(line);
  }

  const spots = [
    ...result.skipped.map((part) => ({ kind: 'Ausgelassen', text: part.text })),
    ...result.gaps.slice(0, 5).map((gap) => ({ kind: 'Pause', extra: `${gap.seconds} Sek.`, text: gap.text })),
  ];
  if (spots.length) {
    body.append(node('h3', '', 'Stellen zum Üben'));
    const list = node('ul', 'coach-spots');
    for (const spot of spots) {
      const item = node('li');
      item.append(node('span', 'coach-chip warn', spot.kind));
      if (spot.extra) item.append(node('span', 'coach-extra', spot.extra));
      item.append(node('span', 'coach-quote', `„${spot.text}"`));
      list.append(item);
    }
    body.append(list);
  }

  if (result.sections.length) {
    body.append(node('h3', '', 'Abschnitte'));
    const table = node('table', 'coach-table');
    const head = node('tr');
    for (const label of ['Abschnitt', 'Ziel', 'Tatsächlich']) head.append(node('th', '', label));
    table.append(head);
    for (const section of result.sections) {
      const row = node('tr');
      const over = section.target && section.used > section.target * 1.05;
      row.append(
        node('td', 'coach-quote', section.title),
        node('td', '', section.target ? clock(section.target) : '–'),
        node('td', over ? 'over' : '', clock(section.used)),
      );
      table.append(row);
    }
    body.append(table);
  }

  body.append(node('h3', '', 'Hinweise'));
  const advice = node('ul', 'coach-tips');
  for (const tip of tips(result)) advice.append(node('li', '', tip));
  body.append(advice);

  showLevel(body);
  showHistory(body);
}


/* ---------- Übergabe an ChatGPT ---------- */

// Was ChatGPT liefern soll. Die Auswahl bleibt für das nächste Mal gespeichert.
// script: Für diesen Wunsch muss das ganze Skript mit, excerpt: dessen Anfang genügt.
const WISHES = [
  {
    key: 'creative', on: true, style: true, label: 'Kreativ und motivierend aufbereitet',
    de: 'Gestalte die Antwort kreativ und motivierend: eine knackige Überschrift, eine kleine Tabelle mit meinen Verständlichkeits-Werten als Emoji-Balken (🟩🟩🟩⬜⬜), meine „Superkraft", eine „Challenge für morgen" und zum Schluss einen passenden Zungenbrecher. Emojis sparsam, aber wirkungsvoll.',
    en: 'Make the answer creative and motivating: a punchy headline, a small table of my clarity scores as emoji bars (🟩🟩🟩⬜⬜), my "superpower", a "challenge for tomorrow" and a fitting tongue twister at the end. Use emojis sparingly but effectively.',
  },
  {
    key: 'feedback', on: true, label: 'Stärken und die wichtigsten Verbesserungen',
    de: 'Drei Stärken, die ich beibehalten soll, und die drei wichtigsten Verbesserungen.',
    en: 'Three strengths I should keep and the three most important improvements.',
  },
  {
    key: 'exercises', on: true, label: 'Konkrete Übungen',
    de: 'Zu jeder Verbesserung eine konkrete Übung, die höchstens fünf Minuten dauert.',
    en: 'For each improvement, one concrete exercise that takes no more than five minutes.',
  },
  {
    key: 'passages', on: true, label: 'Schwierige Stellen leichter formulieren',
    de: 'Für die ausgelassenen Stellen und die Stellen mit Pausen: je eine Formulierung, die sich leichter sprechen lässt.',
    en: 'For the skipped passages and the passages with pauses: a wording for each that is easier to speak.',
  },
  {
    key: 'progress', on: true, label: 'Fortschritt mit früheren Durchläufen vergleichen',
    de: 'Eine kurze Einschätzung meines Fortschritts im Vergleich zu den früheren Durchläufen (falls vorhanden).',
    en: 'A short assessment of my progress compared with the earlier runs (if any).',
  },
  {
    key: 'goal', on: true, label: 'Messbares Ziel für den nächsten Durchlauf',
    de: 'Ein messbares Ziel für meinen nächsten Durchlauf, etwa beim Tempo oder bei den Füllwörtern pro Minute.',
    en: 'One measurable goal for my next run, for example for pace or filler words per minute.',
  },
  {
    key: 'level', on: true, excerpt: true, label: 'Sprachniveau einschätzen und ans Publikum anpassen',
    de: 'Eine Einschätzung des Sprachniveaus (A1–C2) meines Skripts – nicht als Note, sondern als Empfehlung, welches Niveau für mein Publikum und meinen Anlass am besten wirkt –, mit zwei Beispielsätzen aus meinem Text auf dem passenden Niveau.',
    en: 'An assessment of the language level (CEFR A1–C2) of my script – not as a grade, but as a recommendation of which level works best for my audience and occasion – with two example sentences from my text rewritten at the right level.',
  },
  {
    key: 'rewrite', on: false, script: true, label: 'Ganzes Skript sprechfreundlicher umschreiben',
    de: 'Das ganze Skript in einer sprechfreundlicheren Fassung auf dem passenden Sprachniveau für mein Publikum: gleicher Inhalt, ungefähr gleiche Länge.',
    en: 'The whole script in a version that is easier to speak, at the right language level for my audience: same content, roughly the same length.',
  },
];
// Längere Links nimmt nicht jeder Weg zum Browser an; dann wird eingefügt statt übergeben.
const MAX_LINK = 6000;

function wishes() {
  const saved = load('vp.coachAsk', {});
  return WISHES.filter((wish) => saved[wish.key] ?? wish.on);
}

function showWishes() {
  const box = $('coachWishes');
  box.textContent = '';
  const chosen = new Set(wishes().map((wish) => wish.key));
  for (const wish of WISHES) {
    const label = node('label', 'check');
    const input = node('input');
    input.type = 'checkbox';
    input.checked = chosen.has(wish.key);
    input.addEventListener('change', () => {
      save('vp.coachAsk', { ...load('vp.coachAsk', {}), [wish.key]: input.checked });
    });
    label.append(input, ' ', node('span', '', wish.label));
    box.append(label);
  }
}

export function openReport() {
  $('coachCopied').hidden = true;
  const result = evaluate();
  render(result);
  $('coachAsk').hidden = !result || !isPro();
  if (result && isPro()) showWishes();
  $('coachAi').hidden = !result;
  dialog.showModal();
  // Der Browser springt sonst zum ersten Auswahlfeld mitten in der Auswertung.
  $('coachAi').focus({ preventScroll: true });
  dialog.scrollTop = 0;
}

// Die ersten Sätze des Skripts, höchstens etwa 500 Zeichen.
function excerpt(text) {
  if (text.length <= EXCERPT_LIMIT) return text;
  const cut = text.slice(0, EXCERPT_LIMIT);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > 200 ? cut.slice(0, end + 1) : cut) + ' …';
}

const LANGUAGE_NAMES = { en: 'English', fr: 'French', es: 'Spanish', it: 'Italian' };

// Die fertige Anfrage: Rolle, Messwerte, Stellen zum Üben und die gewählten Wünsche.
// Das ganze Skript geht nur mit, wenn ein Wunsch es braucht.
function aiPrompt(result, chosen) {
  const de = uiLang() === 'de';
  const runs = history().filter((item) => item.title === session.title && item.id !== session.id).slice(-3);
  const q = (text) => (de ? `„${text}"` : `"${text}"`);
  const fillerList = Object.entries(result.fillerCounts).map(([word, n]) => `${word} ×${n}`).join(', ');
  const perMinute = de ? decimal(result.fillersPerMinute) : result.fillersPerMinute.toFixed(1);
  const gaps = result.gaps.slice(0, 3).map((g) => `${q(g.text)} ${g.seconds} s`).join('; ');
  const skipped = result.skipped.slice(0, 3).map((s) => q(s.text)).join('; ');
  const sections = result.sections.map((s) => `${s.title} ${s.target ? clock(s.target) : '–'}/${clock(s.used)}`).join('; ');
  const earlier = runs.map((r) => `${r.wpm}/${r.fillers ?? '–'}/${r.pauses}`).join(', ');
  const level = scriptLevel(session.script, session.lang);
  const target = audience();
  const parts = result.clarity;
  const scoreList = (names) => CLARITY.filter((item) => parts[item.key])
    .map((item) => `${names[item.key]} ${parts[item.key].score}`).join(', ');
  const lines = de
    ? [
      'Du bist mein Sprechcoach. Ich habe gerade einen Text laut mit einem Teleprompter geübt. Messwerte:',
      `- Redezeit ${clock(result.duration)}, ${result.spoken} Wörter, Tempo ${result.wpm} Wörter/Min. (Anfang ${result.startWpm}, Ende ${result.endWpm})`,
      result.local ? `- Füllwörter: ${result.fillers}${fillerList ? ` (${fillerList})` : ''}, ${perMinute} pro Minute` : '- Füllwörter: nicht gemessen',
      `- Pausen über 3 Sek.: ${gaps || 'keine'}`,
      `- Ausgelassen: ${skipped || 'nichts'}`,
      ...(sections ? [`- Abschnitte (Ziel/tatsächlich): ${sections}`] : []),
      ...(earlier ? [`- Frühere Durchläufe (Tempo/Füllwörter/Pausen): ${earlier}`] : []),
      ...(level ? [`- Sprachniveau des Skripts (Richtwert nach LIX ${level.lix}): ${LEVELS[level.index].code}`] : []),
      `- Mein Publikum und Anlass: ${target.label} – dafür passt meist ${levelRange(target.range)}`,
      `- Verständlichkeit (Richtwerte 1–5, gemessen): ${scoreList({ articulation: 'Artikulation', tempo: 'Tempo', volume: `Lautstärke (${parts.volume?.note})`, melody: `Stimmmelodie (${parts.melody?.note})`, flow: 'Redefluss' })}; gesamt ${decimal(parts.overall)}`,
      ...(result.repeats ? [`- Neu angesetzt (Wiederholungen): ${result.repeats}`] : []),
    ]
    : [
      'You are my speaking coach. I just rehearsed a text out loud with a teleprompter. Measurements:',
      `- Speaking time ${clock(result.duration)}, ${result.spoken} words, pace ${result.wpm} wpm (start ${result.startWpm}, end ${result.endWpm})`,
      result.local ? `- Filler words: ${result.fillers}${fillerList ? ` (${fillerList})` : ''}, ${perMinute} per minute` : '- Filler words: not measured',
      `- Pauses over 3 s: ${gaps || 'none'}`,
      `- Skipped: ${skipped || 'nothing'}`,
      ...(sections ? [`- Sections (target/actual): ${sections}`] : []),
      ...(earlier ? [`- Earlier runs (pace/fillers/pauses): ${earlier}`] : []),
      ...(level ? [`- Language level of the script (estimate from LIX ${level.lix}): ${LEVELS[level.index].code}`] : []),
      `- My audience and occasion: ${target.en} – usually best at ${levelRange(target.range)}`,
      `- Clarity (measured estimates 1–5): ${scoreList({ articulation: 'articulation', tempo: 'pace', volume: 'volume', melody: 'vocal melody', flow: 'flow' })}; overall ${parts.overall.toFixed(1)}`,
      ...(result.repeats ? [`- Restarts (repetitions): ${result.repeats}`] : []),
    ];
  if (chosen.some((wish) => wish.script)) {
    lines.push('', de ? 'Das Skript:' : 'The script:', '"""', session.script.slice(0, SCRIPT_LIMIT), '"""');
  } else if (chosen.some((wish) => wish.excerpt)) {
    lines.push('', de ? 'Anfang des Skripts:' : 'Beginning of the script:', '"""', excerpt(session.script), '"""');
  }
  lines.push('', de ? 'Bitte liefere:' : 'Please give me:');
  const tasks = chosen.filter((wish) => !wish.style);
  tasks.forEach((wish, i) => lines.push(`${i + 1}. ${de ? wish.de : wish.en}`));
  const style = chosen.find((wish) => wish.style);
  if (style) lines.push('', de ? style.de : style.en);
  lines.push(de
    ? 'Antworte auf Deutsch, kurz und konkret.'
    : `Answer in ${LANGUAGE_NAMES[uiLang()] || 'English'}, briefly and concretely.`);
  return lines.join('\n');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch { /* Ohne Freigabe für die Zwischenablage geht es über ein unsichtbares Textfeld. */ }
  const area = node('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  dialog.append(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

// Ein Klick: Anfrage zusammenstellen, zur Sicherheit in die Zwischenablage legen und ChatGPT
// gleich mit der Anfrage öffnen. Ist sie zu lang für den Link, wird nur noch eingefügt.
$('coachAi').addEventListener('click', async () => {
  if (!isPro()) {
    dialog.close();
    openUpgrade('Die Übergabe an ChatGPT gehört zur Pro-Version.');
    return;
  }
  const result = evaluate();
  if (!result) return;
  const chosen = wishes();
  const prompt = aiPrompt(result, chosen.length ? chosen : WISHES.filter((wish) => wish.on));
  await copyText(prompt);
  const link = 'https://chatgpt.com/?' + new URLSearchParams({ q: prompt });
  const direct = link.length <= MAX_LINK;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  let message = 'ChatGPT öffnet sich mit deiner Auswertung. Falls sie nicht von selbst startet, drück dort nur die Eingabetaste.';
  if (!direct) {
    message = mac
      ? 'Die Anfrage ist zu lang für die direkte Übergabe. Sie ist kopiert: in ChatGPT mit ⌘+V einfügen und absenden.'
      : 'Die Anfrage ist zu lang für die direkte Übergabe. Sie ist kopiert: in ChatGPT mit Strg+V einfügen und absenden.';
  }
  $('coachCopied').textContent = message;
  $('coachCopied').hidden = false;
  window.open(direct ? link : 'https://chatgpt.com/', '_blank', 'noopener');
});
$('coachOpen').addEventListener('click', openReport);

// Testzugang für den Selbsttest.
window.vpCoach = {
  summarize,
  history,
  evaluate,
  aiPrompt: (all = false) => aiPrompt(evaluate(), all ? WISHES : wishes()),
  level: () => session && scriptLevel(session.script, session.lang),
};
