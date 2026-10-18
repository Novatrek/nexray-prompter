// Zuordnung von gehörten Wörtern zur Position im Skript.

export function normalize(word) {
  return word
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function toWords(text) {
  return text.split(/\s+/).map(normalize).filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similar(a, b) {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (shorter >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  const tolerance = longer >= 8 ? 2 : longer >= 5 ? 1 : 0;
  return tolerance > 0 && levenshtein(a, b) <= tolerance;
}

const TAIL = 6;
const LOOK_BACK = 12;
const LOOK_AHEAD = 40;
const SEARCH_AHEAD = 120;

// Liefert die neue Position (Index des nächsten zu sprechenden Worts) oder null.
// Mit search sucht die Funktion im sichtbaren Bereich ab pos nach einem Wiedereinstieg
// und verlangt dafür mindestens drei passende Wörter.
export function findPosition(words, pos, heard, { search = false } = {}) {
  const tail = heard.slice(-TAIL);
  const last = tail.length - 1;
  if (last < 0) return null;

  const from = Math.max(0, pos - LOOK_BACK);
  const to = Math.min(words.length - 1, pos + (search ? SEARCH_AHEAD : LOOK_AHEAD));
  let best = null;

  for (let j = from; j <= to; j++) {
    if (!similar(tail[last], words[j])) continue;

    let matched = 1;
    let s = j - 1;
    for (let t = last - 1; t >= 0 && s >= 0; t--) {
      if (similar(tail[t], words[s])) {
        matched++;
        s--;
      } else if (s >= 1 && similar(tail[t], words[s - 1])) {
        // Ein Skriptwort wurde von der Erkennung verschluckt.
        matched++;
        s -= 2;
      }
    }

    const step = j + 1 - pos;
    let accepted;
    if (search) accepted = matched >= 3;
    else if (step > 0) accepted = matched >= 3 || (matched >= 2 && step <= 8) || step <= 2;
    else accepted = matched >= 4 && step < 0;
    if (!accepted) continue;

    const score = matched * 10 - Math.abs(step - 1) * 0.5;
    if (!best || score > best.score) best = { score, pos: j + 1 };
  }

  return best ? best.pos : null;
}
