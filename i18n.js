// Menüsprache. Die Oberfläche ist auf Deutsch geschrieben; dieses Modul tauscht die sichtbaren
// Texte gegen die gewählte Sprache aus, sobald sie auf der Seite erscheinen. Der übrige Code
// arbeitet weiter mit den deutschen Texten.
import { load, save } from './storage.js';
import { ORDER, PATTERNS, TEXTS } from './translations.js';

export const LANGS = { de: 'Deutsch', en: 'English', fr: 'Français', es: 'Español', it: 'Italiano' };

// Bereiche mit Inhalten des Nutzers: Skript, Prompter-Text, Titel, Sprechernamen.
const SKIP = '#text, #script, #scriptHighlight, #uiLang, .lib-open, .lib-folder > span, .schedule-title, .sp-label, .speaker-now, .speaker-item, #savedName, #savedFolder, .coach-quote';
// Hinweistexte gelten nur im Prompter-Text als Nutzerinhalt; der Platzhalter des Skriptfelds wird übersetzt.
const SKIP_ATTRIBUTES = '#text, #scriptHighlight, #uiLang';
const ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'label'];

const browserLang = (navigator.language || 'de').slice(0, 2).toLowerCase();
let lang = load('vp.ui', null) || (LANGS[browserLang] ? browserLang : 'de');
if (!LANGS[lang]) lang = 'de';

const listeners = [];
const cache = new Map();
// Was ursprünglich (deutsch) an einer Stelle stand und was gerade dort angezeigt wird.
const textSource = new WeakMap();
const attrSource = new WeakMap();

export const uiLang = () => lang;
export const onUiLang = (listener) => listeners.push(listener);

function lookup(text) {
  const index = ORDER.indexOf(lang);
  const exact = TEXTS[text];
  if (exact) return exact[index];
  for (const pattern of PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    return pattern.to[index].replace(/\$(\d)/g, (unused, number) => {
      const part = match[Number(number)] ?? '';
      return pattern.nested ? t(part) : part;
    });
  }
  return text;
}

// Übersetzt einen deutschen Text der Oberfläche; unbekannte Texte bleiben unverändert.
export function t(text) {
  if (lang === 'de' || !text) return text;
  const key = lang + '\n' + text;
  if (!cache.has(key)) cache.set(key, lookup(text));
  return cache.get(key);
}

function show(source) {
  const key = source.trim();
  if (!key) return source;
  const translated = t(key);
  return translated === key ? source : source.replace(key, translated);
}

function translateText(node) {
  if (node.parentElement?.closest(SKIP)) return;
  const raw = node.nodeValue;
  const known = textSource.get(node);
  // Steht noch da, was dieses Modul hingeschrieben hat, gilt weiter der gemerkte deutsche Text.
  const source = known && known.shown === raw ? known.source : raw;
  const shown = show(source);
  textSource.set(node, { source, shown });
  if (shown !== raw) node.nodeValue = shown;
}

function translateAttributes(element) {
  if (element.closest(SKIP_ATTRIBUTES)) return;
  let known = attrSource.get(element);
  for (const name of ATTRIBUTES) {
    const raw = element.getAttribute(name);
    if (raw === null) continue;
    if (!known) attrSource.set(element, (known = {}));
    const source = known[name] && known[name].shown === raw ? known[name].source : raw;
    const shown = show(source);
    known[name] = { source, shown };
    if (shown !== raw) element.setAttribute(name, shown);
  }
}

function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateText(root);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttributes(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) translateText(node);
    else translateAttributes(node);
  }
}

export function setUiLang(next) {
  if (!LANGS[next] || next === lang) return;
  lang = next;
  save('vp.ui', lang);
  document.documentElement.lang = lang;
  translateTree(document.documentElement);
  listeners.forEach((listener) => listener(lang));
}

// Alles übersetzen, was schon da ist, und alles, was später hinzukommt oder sich ändert.
document.documentElement.lang = lang;
translateTree(document.documentElement);
new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'characterData') translateText(record.target);
    else if (record.type === 'attributes') translateAttributes(record.target);
    else record.addedNodes.forEach(translateTree);
  }
}).observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
  attributes: true,
  attributeFilter: ATTRIBUTES,
});
