// Mehrere Sprecher: gemeinsame Anzeige für Hauptfenster und Zweitanzeige.

export const SPEAKER_COUNT = 6;
export const DEFAULT_NAMES = Array.from({ length: SPEAKER_COUNT }, (unused, index) => `Sprecher ${index + 1}`);
// Wie viele Wörter vorher ein Sprecherwechsel angekündigt wird.
export const ANNOUNCE_WORDS = 8;

// Liest aus einer Markierung die Sprechernummer; 0, wenn es keine ist. Im Skript steht der
// Name des Sprechers, etwa [Anna]. Die Kurzform [S1] bis [S6] wird weiterhin verstanden.
export function speakerNumber(tag, names) {
  const wanted = tag.trim().toLowerCase();
  const short = /^s([1-6])$/.exec(wanted);
  if (short) return Number(short[1]);
  return names.findIndex((name) => name.trim().toLowerCase() === wanted) + 1;
}

// Schreibt die Sprecher-Markierungen eines Textes auf die neuen Namen um.
export function renameSpeakerTags(text, oldNames, newNames) {
  return text.replace(/\[([^\]\n]*)\]/g, (tag, inner) => {
    const number = speakerNumber(inner, oldNames);
    return number ? `[${newNames[number - 1]}]` : tag;
  });
}

// Ermittelt, wer an der Stelle index spricht und wer in Kürze übernimmt.
export function speakersAt(speakerOf, index) {
  if (!speakerOf.length) return { current: 0, next: 0 };
  const at = Math.min(index, speakerOf.length - 1);
  const current = speakerOf[at];
  let next = 0;
  for (let i = at + 1; i <= at + ANNOUNCE_WORDS && i < speakerOf.length; i++) {
    if (speakerOf[i] && speakerOf[i] !== current) {
      next = speakerOf[i];
      break;
    }
  }
  return { current, next };
}

// Zeigt den farbigen Rahmen und das Schild „spricht jetzt / gleich".
export function showSpeakers(stage, badge, { current, next, names, me }) {
  stage.dataset.speaker = current || '';
  stage.dataset.me = me || '';
  badge.textContent = '';
  badge.hidden = !current && !next;
  const chip = (number, text, className) => {
    const item = document.createElement('span');
    item.className = `${className} sp-${number}`;
    item.textContent = text;
    badge.append(item);
  };
  if (current) chip(current, names[current - 1], 'speaker-now');
  if (next) chip(next, 'gleich: ' + names[next - 1], 'speaker-next');
}
