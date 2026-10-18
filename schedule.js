// Zeitplan je Abschnitt: Markierung lesen und die Ampel anzeigen (Hauptfenster und Zweitanzeige).
import { SECTION_PATTERN } from './tags.js';

// Nach dem Wort muss Schluss, ein Leerzeichen oder ein Doppelpunkt folgen, damit etwa
// [Abschnittsende] eine gewöhnliche Regieanweisung bleibt.
const SECTION = new RegExp(`^(${SECTION_PATTERN})(?=$|[\\s:|])\\s*:?\\s*(.*?)\\s*(?:\\|\\s*(\\d{1,3}):(\\d{2})\\s*)?$`, 'i');

// Liest eine Markierung wie [Abschnitt: Einleitung | 1:30], auch in den anderen Menüsprachen
// ([Section: …], [Sección: …], [Sezione: …]). Titel und Dauer sind freiwillig.
// Liefert null, wenn es keine Abschnitts-Markierung ist.
export function parseSection(inner) {
  const match = SECTION.exec(inner.trim());
  if (!match) return null;
  return {
    // Ohne Titel dient das Wort der Markierung selbst als Überschrift.
    title: match[2] || match[1][0].toUpperCase() + match[1].slice(1),
    target: match[3] === undefined ? 0 : Number(match[3]) * 60 + Number(match[4]),
  };
}

export const clock = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// Ampel: grün, solange der Abschnitt voraussichtlich in der Zeit bleibt; gelb bei knapper,
// rot bei deutlicher Überschreitung.
const WARN_FROM = 1.05;
const OVER_FROM = 1.2;

export function sectionState(projected, target) {
  if (!target) return 'none';
  if (projected <= target * WARN_FROM) return 'ok';
  return projected <= target * OVER_FROM ? 'warn' : 'over';
}

// info: { title, number, count, used, target, projected, state } oder null ohne Abschnitte.
export function showSchedule(box, info) {
  box.hidden = !info;
  box.textContent = '';
  if (!info) return;
  box.dataset.state = info.state;

  const lamp = document.createElement('span');
  lamp.className = 'lamp';
  const title = document.createElement('span');
  title.className = 'schedule-title';
  title.textContent = `${info.number}/${info.count} ${info.title}`;
  const time = document.createElement('span');
  time.className = 'schedule-time';
  time.textContent = info.target ? `${clock(info.used)} / ${clock(info.target)}` : clock(info.used);
  box.append(lamp, title, time);

  if (info.target && info.state !== 'ok') {
    const over = document.createElement('span');
    over.className = 'schedule-over';
    over.textContent = `voraussichtlich +${clock(info.projected - info.target)}`;
    box.append(over);
  }
}
