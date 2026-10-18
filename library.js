// Skriptbibliothek: mehrere Skripte, Ordner und gespeicherte Versionen.
// Gratis gibt es ein Skript; weitere Skripte, Ordner und Versionen gehören zu Pro.
import { toWords } from './align.js';
import { load, save } from './storage.js';
import { isPro, onPlanChange, openUpgrade } from './plan.js';
import { askText, askConfirm } from './dialogs.js';
import { t } from './i18n.js';

const MAX_VERSIONS = 20;
const NO_FOLDER = '';
const $ = (id) => document.getElementById(id);
const stamp = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const wordCount = (text) => toWords(text.replace(/\[[^\]\n]*\]/g, ' ')).length;

let data = load('vp.library', null);
let showText = () => {};
let onSaved = () => {};
let editing = null;

const persist = () => save('vp.library', data);
const current = () => data.scripts.find((script) => script.id === data.currentId);

function addScript(title, text = '') {
  const script = { id: newId(), title, folder: NO_FOLDER, text, updated: Date.now(), versions: [] };
  data.scripts.push(script);
  data.currentId = script.id;
  persist();
  return script;
}

// onShow(text) wird aufgerufen, wenn ein anderes Skript ins Textfeld geladen werden soll.
// onSave(script) meldet, unter welchem Namen und Ordner gespeichert wurde.
export function initLibrary(onShow, onSave) {
  showText = onShow;
  onSaved = onSave;
  if (!data || !data.scripts?.length) {
    data = { folders: [], scripts: [], currentId: null };
    addScript(t('Mein Skript'), load('vp.script', ''));
  }
  if (!current()) data.currentId = data.scripts[0].id;
  render();
  showText(current().text);
}

// Wendet eine Umformung auf die Texte aller Skripte an, etwa nach dem Umbenennen von Sprechern.
export function transformAllScripts(change) {
  for (const script of data.scripts) script.text = change(script.text);
  persist();
}

export const currentTitle = () => current().title;

export function saveText(text) {
  const script = current();
  script.text = text;
  script.updated = Date.now();
  persist();
}

// Legt den aktuellen Stand als Version ab, sofern er sich von der letzten unterscheidet.
export function snapshot() {
  const script = current();
  if (!isPro() || !script.text.trim() || script.versions[0]?.text === script.text) return false;
  script.versions.unshift({ time: Date.now(), text: script.text });
  script.versions.length = Math.min(script.versions.length, MAX_VERSIONS);
  persist();
  return true;
}

function select(id) {
  if (id === data.currentId) return;
  data.currentId = id;
  persist();
  render();
  showText(current().text);
}

/* ---------- Liste ---------- */

function scriptRow(script) {
  const row = document.createElement('div');
  row.className = 'lib-script' + (script.id === data.currentId ? ' active' : '');
  row.draggable = true;
  row.dataset.script = script.id;
  row.dataset.folder = script.folder;

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'lib-open';
  open.dataset.open = script.id;
  open.textContent = script.title;
  open.title = `${wordCount(script.text)} Wörter, geändert ${stamp.format(script.updated)}`;

  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = 'lib-more';
  manage.dataset.manage = script.id;
  manage.textContent = '⋯';
  manage.title = 'Umbenennen, in Ordner ablegen, Historie, löschen';
  manage.setAttribute('aria-label', `${script.title} verwalten`);

  row.append(open, manage);
  return row;
}

function render() {
  const list = $('libraryList');
  list.textContent = '';
  const byFolder = (folder) =>
    data.scripts.filter((script) => script.folder === folder).sort((a, b) => a.title.localeCompare(b.title, 'de'));

  for (const script of byFolder(NO_FOLDER)) list.append(scriptRow(script));

  for (const folder of [...data.folders].sort((a, b) => a.localeCompare(b, 'de'))) {
    const head = document.createElement('div');
    head.className = 'lib-folder';
    head.dataset.folder = folder;
    const name = document.createElement('span');
    name.textContent = folder;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lib-more';
    remove.dataset.removeFolder = folder;
    remove.textContent = '×';
    remove.title = 'Ordner auflösen (Skripte bleiben erhalten)';
    remove.setAttribute('aria-label', `Ordner ${folder} auflösen`);
    head.append(name, remove);
    list.append(head);

    const scripts = byFolder(folder);
    for (const script of scripts) list.append(scriptRow(script));
    if (!scripts.length) {
      const empty = document.createElement('p');
      empty.className = 'lib-empty';
      empty.dataset.folder = folder;
      empty.textContent = 'leer – Skript hierher ziehen';
      list.append(empty);
    }
  }
}

/* ---------- Aktionen ---------- */

async function createScript() {
  if (!isPro()) {
    openUpgrade('Mehrere Skripte gehören zur Pro-Version. Gratis ist ein Skript enthalten.');
    return;
  }
  const title = await askText('Name des neuen Skripts:', t('Neues Skript'));
  if (!title) return;
  addScript(title);
  render();
  showText('');
}

async function createFolder() {
  if (!isPro()) {
    openUpgrade('Ordner gehören zur Pro-Version.');
    return;
  }
  const name = await askText('Name des neuen Ordners:');
  if (!name || data.folders.includes(name)) return;
  data.folders.push(name);
  persist();
  render();
}

async function removeFolder(folder) {
  const confirmed = await askConfirm(`Ordner „${folder}" auflösen? Die Skripte darin bleiben erhalten.`, 'Auflösen');
  if (!confirmed) return;
  data.folders = data.folders.filter((name) => name !== folder);
  for (const script of data.scripts) if (script.folder === folder) script.folder = NO_FOLDER;
  persist();
  render();
}

function renderVersions(script) {
  const list = $('versionList');
  list.textContent = '';
  $('clearHistory').hidden = !script.versions.length;
  if (!script.versions.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = isPro()
      ? 'Die Historie ist leer. Beim Öffnen des Prompters wird automatisch ein Eintrag angelegt.'
      : 'Die Historie gehört zur Pro-Version.';
    list.append(empty);
    return;
  }
  script.versions.forEach((version, index) => {
    const row = document.createElement('div');
    row.className = 'version';
    const label = document.createElement('span');
    label.textContent = `${stamp.format(version.time)} · ${wordCount(version.text)} Wörter`;
    const restore = document.createElement('button');
    restore.type = 'submit';
    restore.value = 'restore:' + index;
    restore.textContent = 'Wiederherstellen';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'lib-more';
    remove.dataset.removeVersion = index;
    remove.textContent = '×';
    remove.title = 'Diesen Eintrag löschen';
    remove.setAttribute('aria-label', `Eintrag vom ${stamp.format(version.time)} löschen`);
    row.append(label, restore, remove);
    list.append(row);
  });
}

const NEW_FOLDER = '__neuer_ordner__';

function fillFolders(folders, selected) {
  folders.textContent = '';
  folders.append(new Option('Kein Ordner', NO_FOLDER));
  for (const folder of [...data.folders].sort((a, b) => a.localeCompare(b, 'de'))) {
    folders.append(new Option(folder, folder));
  }
  folders.append(new Option('+ Neuer Ordner …', NEW_FOLDER));
  folders.value = selected;
}

// Legt ein Skript in einem Ordner ab (oder mit NO_FOLDER wieder heraus).
function moveScript(id, folder) {
  const script = data.scripts.find((item) => item.id === id);
  if (!script || script.folder === folder) return;
  script.folder = folder;
  persist();
  render();
}

function manageScript(id) {
  editing = data.scripts.find((script) => script.id === id);
  $('scriptTitle').value = editing.title;
  fillFolders($('scriptFolder'), editing.folder);
  renderVersions(editing);
  $('scriptDialog').showModal();
}

async function finishManage(action) {
  const script = editing;
  editing = null;
  if (!script) return;

  script.title = $('scriptTitle').value.trim() || script.title;
  const folder = $('scriptFolder').value;
  if (folder !== NEW_FOLDER) script.folder = folder;

  if (action === 'snapshot') {
    if (!isPro()) {
      openUpgrade('Versionen gehören zur Pro-Version.');
    } else {
      select(script.id);
      snapshot();
    }
  } else if (action.startsWith('restore:')) {
    const version = script.versions[Number(action.slice(8))];
    select(script.id);
    // Den jetzigen Stand sichern, bevor die alte Version ihn ersetzt.
    snapshot();
    script.text = version.text;
    script.updated = Date.now();
    showText(script.text);
  } else if (action === 'delete') {
    const confirmed = await askConfirm(`Skript „${script.title}" mit allen Versionen endgültig löschen?`, 'Löschen');
    if (confirmed) {
      data.scripts = data.scripts.filter((item) => item !== script);
      if (!data.scripts.length) addScript(t('Mein Skript'));
      if (!current()) data.currentId = data.scripts[0].id;
      showText(current().text);
    }
  }
  persist();
  render();
}

$('newScript').addEventListener('click', createScript);
$('newFolder').addEventListener('click', createFolder);
$('history').addEventListener('click', () => {
  if (!isPro()) openUpgrade('Die Historie mit gespeicherten Versionen gehört zur Pro-Version.');
  else manageScript(data.currentId);
});
// Das Formular wird selbst ausgewertet: Die Eingabetaste bedeutet „Fertig" und nicht den
// ersten Knopf im Formular, und die Antwort liegt sofort vor.
$('scriptDialog').querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('scriptDialog').close();
  finishManage(event.submitter?.value || 'save');
});
$('scriptTitle').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  $('scriptDialog').close();
  finishManage('save');
});
$('libraryList').addEventListener('click', (event) => {
  const { open, manage, removeFolder: folder } = event.target.dataset;
  if (open) select(open);
  else if (manage) manageScript(manage);
  else if (folder) removeFolder(folder);
});
// Neuer Ordner direkt aus der Auswahl in einem Dialog.
async function pickNewFolder(folders, previous) {
  if (folders.value !== NEW_FOLDER) return;
  if (!isPro()) {
    fillFolders(folders, previous);
    openUpgrade('Ordner gehören zur Pro-Version.');
    return;
  }
  const name = await askText('Name des neuen Ordners:');
  if (name && !data.folders.includes(name)) {
    data.folders.push(name);
    persist();
    render();
  }
  fillFolders(folders, name || previous);
}
$('scriptFolder').addEventListener('change', () => pickNewFolder($('scriptFolder'), editing?.folder ?? NO_FOLDER));
$('saveFolder').addEventListener('change', async () => {
  await pickNewFolder($('saveFolder'), current().folder);
  markSaveTarget();
});

/* ---------- Skript speichern unter ---------- */

// Legt den Text des offenen Skripts unter einem Namen in der Bibliothek ab. Gibt es dort
// schon ein Skript mit diesem Namen im selben Ordner, wird es überschrieben.
export function openSaveAs() {
  if (!isPro()) {
    openUpgrade('„Skript speichern unter" gehört zur Pro-Version. Gratis ist ein Skript enthalten.');
    return;
  }
  $('saveTitle').value = current().title;
  fillFolders($('saveFolder'), current().folder);
  fillSaveTargets();
  $('saveDialog').showModal();
  $('saveTitle').select();
}

// Aufklappmenü mit den vorhandenen Skripten als Speicherziele, nach Ordnern gruppiert.
function fillSaveTargets() {
  const menu = $('saveTargets');
  menu.textContent = '';
  menu.append(new Option('Neues Skript anlegen', ''));

  const group = (label, folder) => {
    const scripts = data.scripts
      .filter((script) => script.folder === folder)
      .sort((a, b) => a.title.localeCompare(b.title, 'de'));
    if (!scripts.length) return;
    const box = document.createElement('optgroup');
    box.label = label;
    for (const script of scripts) box.append(new Option(script.title, script.id));
    menu.append(box);
  };
  group('Ohne Ordner', NO_FOLDER);
  for (const folder of [...data.folders].sort((a, b) => a.localeCompare(b, 'de'))) group(folder, folder);
  markSaveTarget();
}

// Stellt das Menü auf das Skript, das zu Name und Ordner im Formular passt.
function markSaveTarget() {
  const title = $('saveTitle').value.trim();
  const folder = $('saveFolder').value;
  const match = data.scripts.find((script) => script.title === title && script.folder === folder);
  $('saveTargets').value = match ? match.id : '';
  if (!match) $('saveHint').textContent = 'Es wird ein neues Skript mit diesem Namen angelegt.';
  else if (match === current()) $('saveHint').textContent = 'Das ist das geöffnete Skript. Es ist bereits gespeichert.';
  else $('saveHint').textContent = 'Dieses Skript wird überschrieben. Sein alter Stand bleibt in der Historie.';
}

$('saveTargets').addEventListener('change', () => {
  const script = data.scripts.find((entry) => entry.id === $('saveTargets').value);
  if (script) {
    $('saveTitle').value = script.title;
    $('saveFolder').value = script.folder;
  } else {
    $('saveTitle').value = '';
    $('saveTitle').focus();
  }
  markSaveTarget();
});
$('saveTitle').addEventListener('input', markSaveTarget);

function saveAs() {
  const source = current();
  const title = $('saveTitle').value.trim();
  const picked = $('saveFolder').value;
  const folder = picked === NEW_FOLDER ? NO_FOLDER : picked;
  if (!title) return null;

  let target = data.scripts.find((script) => script.title === title && script.folder === folder);
  if (target === source) return target;
  if (target) {
    // Den bisherigen Stand des überschriebenen Skripts in dessen Historie sichern.
    if (target.text.trim() && target.versions[0]?.text !== target.text) {
      target.versions.unshift({ time: Date.now(), text: target.text });
      target.versions.length = Math.min(target.versions.length, MAX_VERSIONS);
    }
    target.text = source.text;
    target.updated = Date.now();
    data.currentId = target.id;
  } else {
    target = addScript(title, source.text);
    target.folder = folder;
  }
  persist();
  render();
  showText(target.text);
  return target;
}

$('saveDialog').querySelector('form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('saveDialog').close();
  const saved = saveAs();
  if (saved) onSaved(saved);
});
$('saveCancel').addEventListener('click', () => $('saveDialog').close());

// Einzelne Einträge der Historie löschen; der Dialog bleibt dabei offen.
$('versionList').addEventListener('click', (event) => {
  const index = event.target.dataset.removeVersion;
  if (index === undefined || !editing) return;
  editing.versions.splice(Number(index), 1);
  persist();
  renderVersions(editing);
});
$('clearHistory').addEventListener('click', async () => {
  if (!editing) return;
  const script = editing;
  const confirmed = await askConfirm(
    `Die gesamte Historie von „${script.title}" löschen? Der aktuelle Text bleibt erhalten.`,
    'Historie löschen'
  );
  if (!confirmed) return;
  script.versions = [];
  persist();
  renderVersions(script);
});

// Skripte per Ziehen in einen Ordner ablegen.
const list = $('libraryList');
const dropFolder = (event) => event.target.closest('[data-folder]')?.dataset.folder ?? NO_FOLDER;
const clearDrop = () => {
  list.classList.remove('drop');
  list.querySelectorAll('.drop').forEach((node) => node.classList.remove('drop'));
};
list.addEventListener('dragstart', (event) => {
  const row = event.target.closest('[data-script]');
  if (!row) return;
  event.dataTransfer.setData('text/plain', row.dataset.script);
  event.dataTransfer.effectAllowed = 'move';
});
list.addEventListener('dragover', (event) => {
  event.preventDefault();
  clearDrop();
  const folder = dropFolder(event);
  const head = [...list.querySelectorAll('.lib-folder')].find((node) => node.dataset.folder === folder);
  (head ?? list).classList.add('drop');
});
list.addEventListener('dragleave', (event) => {
  if (!list.contains(event.relatedTarget)) clearDrop();
});
list.addEventListener('dragend', clearDrop);
list.addEventListener('drop', (event) => {
  event.preventDefault();
  const folder = dropFolder(event);
  clearDrop();
  moveScript(event.dataTransfer.getData('text/plain'), folder);
});

onPlanChange(render);
