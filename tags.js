// Markierungen im Skript in allen Menüsprachen. Ein Skript bleibt lesbar, egal in welcher
// Sprache es geschrieben wurde: [rot], [red] und [rouge] bedeuten dasselbe.

const LANG_ORDER = ['de', 'en', 'fr', 'es', 'it'];

// Farbklasse -> Wort je Sprache (Reihenfolge wie LANG_ORDER)
const COLOR_WORDS = {
  'c-rot': ['rot', 'red', 'rouge', 'rojo', 'rosso'],
  'c-gelb': ['gelb', 'yellow', 'jaune', 'amarillo', 'giallo'],
  'c-gruen': ['grün', 'green', 'vert', 'verde', 'verde'],
  'c-blau': ['blau', 'blue', 'bleu', 'azul', 'blu'],
  'c-tuerkis': ['türkis', 'turquoise', 'turquoise', 'turquesa', 'turchese'],
  'c-violett': ['violett', 'violet', 'violet', 'violeta', 'viola'],
};
// Weitere Schreibweisen und die Farben, für die es keinen Knopf mehr gibt.
const COLOR_ALIASES = {
  gruen: 'c-gruen', tuerkis: 'c-tuerkis', purple: 'c-violett',
  rosa: 'c-rosa', hellgrün: 'c-hellgruen', hellgruen: 'c-hellgruen', pfirsich: 'c-pfirsich', indigo: 'c-indigo',
};
const QUOTE_WORDS = ['zitat', 'quote', 'citation', 'cita', 'citazione'];
const SECTION_WORDS = ['abschnitt', 'section', 'section', 'sección', 'sezione'];

const index = (lang) => Math.max(0, LANG_ORDER.indexOf(lang));

// Wort einer Markierung -> Farbklasse, für alle Sprachen
export const COLORS = { ...COLOR_ALIASES };
for (const [colorClass, words] of Object.entries(COLOR_WORDS)) {
  for (const word of words) COLORS[word] = colorClass;
}

export const colorWord = (colorClass, lang) => COLOR_WORDS[colorClass]?.[index(lang)] ?? colorClass;
export const isQuote = (name) => QUOTE_WORDS.includes(name);
export const quoteWord = (lang) => QUOTE_WORDS[index(lang)];
export const sectionWord = (lang) => {
  const word = SECTION_WORDS[index(lang)];
  return word[0].toUpperCase() + word.slice(1);
};
// Für die Erkennung einer Abschnitts-Markierung, auch ohne Akzent geschrieben.
export const SECTION_PATTERN = [...new Set([...SECTION_WORDS, 'seccion'])].join('|');
