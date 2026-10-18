// Eigene Eingabe- und Rückfragedialoge. Die eingebauten Fenster des Browsers
// (prompt, confirm) gibt es in der Desktop-App nicht.

const $ = (id) => document.getElementById(id);
const dialog = $('ask');
const form = dialog.querySelector('form');
const input = $('askInput');
let settle = null;

function finish(confirmed) {
  if (dialog.open) dialog.close();
  settle?.(confirmed);
  settle = null;
}

// Das Formular wird selbst ausgewertet, damit die Antwort sofort vorliegt und
// die Eingabetaste immer „OK" bedeutet.
form.addEventListener('submit', (event) => {
  event.preventDefault();
  finish(true);
});
$('askCancel').addEventListener('click', () => finish(false));
// Schließen mit Esc. Das Ereignis kommt verzögert; ist inzwischen eine neue Frage offen, gilt es nicht ihr.
dialog.addEventListener('close', () => {
  if (!dialog.open) finish(false);
});

function open({ label, value = null, okLabel = 'OK' }) {
  finish(false);
  $('askLabel').textContent = label;
  $('askOk').textContent = okLabel;
  input.hidden = value === null;
  input.value = value ?? '';
  dialog.showModal();
  if (value !== null) input.select();
  return new Promise((resolve) => {
    settle = resolve;
  });
}

// Liefert den eingegebenen Text oder null bei Abbruch und leerer Eingabe.
export async function askText(label, value = '') {
  const confirmed = await open({ label, value });
  const text = input.value.trim();
  return confirmed && text ? text : null;
}

export function askConfirm(label, okLabel = 'OK') {
  return open({ label, okLabel });
}
