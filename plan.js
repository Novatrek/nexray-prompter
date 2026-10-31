// Gratis- und Pro-Version. Kauf über Polar, Freischaltung per Lizenzschlüssel.
// Nach der einmaligen Freischaltung läuft Pro ohne Internet weiter; ist Internet da, prüft das
// Programm die Lizenz gelegentlich im Hintergrund (etwa ob ein Abo gekündigt wurde).
import { load, save } from './storage.js';
import { LICENSE } from './license-config.js';

const PRICE_MONTH = 7.99;
const YEAR_DISCOUNT = 0.25;
export const FREE_VOICE_SECONDS = 5 * 60;

// Öffentliche Lizenz-Schnittstelle von Polar (ohne Zugangsschlüssel, für Programme beim Kunden gedacht).
const API = 'https://api.polar.sh/v1/customer-portal/license-keys/';
const DAY = 24 * 60 * 60 * 1000;
// Höchstens einmal am Tag im Hintergrund prüfen.
const CHECK_EVERY = DAY;
// So lange läuft Pro ohne erfolgreiche Prüfung weiter (etwas mehr als die bezahlte Laufzeit).
const OFFLINE_DAYS = { month: 45, year: 400 };

// Testbetrieb: Entwicklung, Selbsttest und der Browser-Test im Heimnetz. Nur dort gibt es den
// Knopf „Pro zum Testen freischalten“; im fertigen Programm nicht.
const host = location.hostname;
const TESTING = Boolean(window.vpDesktop?.testing)
  || ['localhost', '127.0.0.1'].includes(host)
  || /^(192\.168|10)\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)
  || (location.protocol === 'app:' && !window.vpDesktop);

const $ = (id) => document.getElementById(id);
const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const listeners = [];
let test = TESTING ? { plan: 'free', ...load('vp.plan', {}) } : { plan: 'free' };
let license = load('vp.license', null);

const licenseActive = () => Boolean(
  license && license.status === 'active'
  && Date.now() - license.checked < (OFFLINE_DAYS[license.billing] || OFFLINE_DAYS.month) * DAY,
);
export const isPro = () => licenseActive() || (TESTING && test.plan === 'pro');

export function onPlanChange(listener) {
  listeners.push(listener);
}

function changed() {
  showPlan();
  showLicense();
  listeners.forEach((listener) => listener());
}

function showPlan() {
  $('planFree').classList.toggle('active', !isPro());
  $('planPro').classList.toggle('active', isPro());
  document.body.classList.toggle('pro', isPro());
}

/* ---------- Polar ---------- */

const configured = () => Boolean(LICENSE.organizationId) && Object.keys(LICENSE.benefits).length > 0;

function deviceName() {
  const platform = window.vpDesktop?.platform;
  const system = platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'Mac' : 'Browser';
  return `NEXRAY Prompter · ${system}`;
}

// Wirft bei fehlender Internetverbindung.
async function call(action, params) {
  const response = await fetch(API + action, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ organization_id: LICENSE.organizationId, ...params }),
  });
  let data = {};
  try {
    data = await response.json();
  } catch { /* leere Antwort, z. B. 204 beim Abmelden */ }
  return { status: response.status, data };
}

// Polar antwortet mit 404 (Schlüssel unbekannt) oder 403 (gesperrt, abgelaufen, Gerätelimit).
function errorText(status, data = {}) {
  const detail = typeof data.detail === 'string' ? data.detail : '';
  if (status === 404) return 'Diesen Lizenzschlüssel gibt es nicht. Bitte prüfe die Eingabe.';
  if (/limit/i.test(detail)) return 'Dieser Schlüssel ist bereits auf der erlaubten Zahl von Geräten aktiv. Entferne ihn zuerst auf einem anderen Gerät.';
  if (/expired/i.test(detail)) return 'Diese Lizenz ist abgelaufen.';
  if (/revoked|disabled/i.test(detail) || status === 403) return 'Diese Lizenz wurde deaktiviert.';
  return detail ? `Freischaltung fehlgeschlagen: ${detail}` : 'Freischaltung fehlgeschlagen.';
}

const OFFLINE_TEXT = 'Keine Internetverbindung. Zum Freischalten wird einmal kurz Internet benötigt.';

export async function activate(rawKey) {
  const key = rawKey.trim();
  if (!key) return { ok: false, message: 'Bitte gib deinen Lizenzschlüssel ein.' };
  if (!configured()) return { ok: false, message: 'Der Verkauf startet in Kürze – Lizenzschlüssel werden noch nicht angenommen.' };
  let result;
  try {
    result = await call('activate', { key, label: deviceName() });
  } catch {
    return { ok: false, message: OFFLINE_TEXT };
  }
  const { status, data } = result;
  if (status !== 200 || !data.id) return { ok: false, message: errorText(status, data) };
  const benefit = LICENSE.benefits[data.license_key?.benefit_id];
  if (data.license_key?.organization_id !== LICENSE.organizationId || !benefit) {
    // Schlüssel eines anderen Produkts: das Gerät dort gleich wieder abmelden.
    call('deactivate', { key, activation_id: data.id }).catch(() => {});
    return { ok: false, message: 'Dieser Schlüssel gehört nicht zu NEXRAY Prompter.' };
  }
  license = {
    key,
    instance: data.id,
    plan: benefit.plan,
    billing: benefit.billing,
    status: data.license_key.status === 'granted' ? 'active' : data.license_key.status,
    checked: Date.now(),
    email: data.license_key.customer?.email || '',
  };
  save('vp.license', license);
  changed();
  return { ok: true, message: 'Pro ist freigeschaltet. Viel Erfolg!' };
}

// Prüft die Lizenz im Hintergrund. Ohne Internet bleibt alles, wie es ist.
async function recheck(force = false) {
  if (!license || (!force && Date.now() - license.checked < CHECK_EVERY)) return;
  let result;
  try {
    result = await call('validate', { key: license.key, activation_id: license.instance });
  } catch {
    return;
  }
  if (result.status >= 500 || result.status === 429) return;
  const wasActive = licenseActive();
  const { status, data } = result;
  if (status === 200 && data.status === 'granted') {
    license.status = 'active';
    license.checked = Date.now();
  } else {
    // 404: Schlüssel oder Gerät unbekannt; sonst gesperrt bzw. Abo beendet.
    license.status = status === 200 ? data.status || 'invalid' : 'invalid';
  }
  save('vp.license', license);
  changed();
  if (wasActive && !licenseActive()) {
    openUpgrade('Deine Pro-Lizenz ist nicht mehr aktiv. Du nutzt jetzt die Gratisversion; deine Skripte bleiben erhalten.');
  }
}

export async function removeLicense() {
  if (!license) return { ok: true };
  try {
    const { status, data } = await call('deactivate', { key: license.key, activation_id: license.instance });
    // 204 = abgemeldet. Ist der Schlüssel dort schon unbekannt (404), darf er hier trotzdem weg.
    if (status !== 204 && status !== 404) return { ok: false, message: errorText(status, data) };
  } catch {
    return { ok: false, message: 'Zum Entfernen wird kurz Internet benötigt, damit der Platz für ein anderes Gerät frei wird.' };
  }
  license = null;
  save('vp.license', null);
  changed();
  return { ok: true, message: 'Lizenz entfernt. Der Platz ist für ein anderes Gerät frei.' };
}

/* ---------- Dialog ---------- */

function billing() {
  return document.querySelector('input[name="billing"]:checked').value;
}

function showLicense() {
  const active = licenseActive();
  $('licenseActive').hidden = !license;
  $('licenseOffer').hidden = active;
  if (license) {
    $('licenseName').textContent = license.plan === 'business'
      ? 'Business ist auf diesem Gerät aktiv.'
      : 'Pro ist auf diesem Gerät aktiv.';
    $('licenseName').parentElement.classList.toggle('warn', !active);
    $('licenseChecked').textContent = active
      ? `Zuletzt geprüft: ${new Date(license.checked).toLocaleDateString()}`
      : 'Bitte verbinde dich einmal mit dem Internet, damit die Lizenz geprüft werden kann.';
    $('licenseEmail').textContent = license.email;
  }
  const link = LICENSE.buy[billing()];
  $('buyPro').disabled = !link;
  $('buyNote').hidden = Boolean(link);
  $('testUnlock').hidden = !TESTING || active;
}

export function openUpgrade(reason = '') {
  $('upgradeReason').textContent = reason;
  $('upgradeReason').hidden = !reason;
  $('licenseMsg').textContent = '';
  showLicense();
  if (!$('upgrade').open) $('upgrade').showModal();
  recheck(true);
}

const yearPrice = PRICE_MONTH * 12 * (1 - YEAR_DISCOUNT);
$('priceMonth').textContent = `${euro.format(PRICE_MONTH)} pro Monat`;
$('priceYear').textContent = `${euro.format(yearPrice)} pro Jahr`;
$('priceYearNote').textContent = `entspricht ${euro.format(yearPrice / 12)} pro Monat`;
$('saving').textContent = `${Math.round(YEAR_DISCOUNT * 100)} % sparen`;

$('planFree').addEventListener('click', () => {
  if (license) {
    openUpgrade();
  } else if (TESTING && test.plan === 'pro') {
    test = { plan: 'free' };
    save('vp.plan', test);
    changed();
  }
});
$('planPro').addEventListener('click', () => openUpgrade());
for (const radio of document.querySelectorAll('input[name="billing"]')) radio.addEventListener('change', showLicense);

$('buyPro').addEventListener('click', () => {
  const link = LICENSE.buy[billing()];
  if (link) window.open(link, '_blank', 'noopener');
});
$('licenseActivate').addEventListener('click', async () => {
  const button = $('licenseActivate');
  button.disabled = true;
  $('licenseMsg').textContent = 'Wird geprüft …';
  const result = await activate($('licenseKey').value);
  button.disabled = false;
  $('licenseMsg').textContent = result.message;
  $('licenseMsg').classList.toggle('error', !result.ok);
  if (result.ok) $('licenseKey').value = '';
});
$('licenseKey').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    $('licenseActivate').click();
  }
});
$('licenseRemove').addEventListener('click', async () => {
  $('licenseMsg').textContent = 'Wird entfernt …';
  const result = await removeLicense();
  $('licenseMsg').textContent = result.message;
  $('licenseMsg').classList.toggle('error', !result.ok);
});
$('upgrade').addEventListener('close', () => {
  if ($('upgrade').returnValue !== 'unlock' || !TESTING) return;
  test = { plan: 'pro', billing: billing() };
  save('vp.plan', test);
  changed();
});

showPlan();
// Beim Start und danach alle sechs Stunden still im Hintergrund prüfen.
setTimeout(() => recheck(), 5000);
setInterval(() => recheck(), 6 * 60 * 60 * 1000);

// Testzugang für den Selbsttest.
window.vpLicense = { activate, removeLicense, state: () => ({ license, active: licenseActive(), testing: TESTING }) };
