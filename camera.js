// Kamera im Prompter: eigenes Bild hinter dem Text und Aufnahme von Bild und Ton in eine Datei.
// Aufgezeichnet wird das reine Kamerabild; der Prompter-Text ist in der Aufnahme nicht zu sehen.
import { isPro, openUpgrade } from './plan.js';
import { clock } from './schedule.js';
import { t } from './i18n.js';
import { load, save } from './storage.js';

// Bevorzugt MP4, weil es überall abspielbar ist; sonst WebM.
const FORMATS = {
  video: [
    { type: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ending: 'mp4' },
    { type: 'video/webm;codecs=vp9,opus', ending: 'webm' },
    { type: 'video/webm', ending: 'webm' },
  ],
  // Nur Ton: M4A, sonst WebM
  audio: [
    { type: 'audio/mp4;codecs=mp4a.40.2', ending: 'm4a' },
    { type: 'audio/webm;codecs=opus', ending: 'webm' },
    { type: 'audio/webm', ending: 'webm' },
  ],
};

const $ = (id) => document.getElementById(id);
const video = $('camera');
const cameraButton = $('cameraToggle');
const recordButton = $('record');
const cameraSelect = $('cameraSelect');
const recBadge = $('recBadge');
const recordMode = $('recordMode');

let stream = null;
let recorder = null;
let recordedAudio = null;
let chunks = [];
let recordStart = 0;
let recordingVideo = false;
let recordTimer = 0;
let report = () => {};
let chosenMic = () => '';
let scriptInfo = () => ({ title: 'NEXRAY Prompter', text: '' });
let chosenCamera = '';

function errorText(error, device) {
  if (error.name === 'NotAllowedError') return `${device} nicht freigegeben (Browser oder Systemeinstellungen)`;
  if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
    return device === 'Kamera' ? 'Keine Kamera gefunden' : 'Kein Mikrofon gefunden';
  }
  if (error.name === 'NotReadableError') return `${device} wird von einem anderen Programm belegt`;
  return `${device}: ${error.name}`;
}

async function listCameras() {
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  cameraSelect.textContent = '';
  devices.forEach((device, index) => {
    cameraSelect.append(new Option(device.label || `Kamera ${index + 1}`, device.deviceId));
  });
  cameraSelect.value = stream?.getVideoTracks()[0]?.getSettings().deviceId ?? '';
  cameraSelect.hidden = devices.length < 2;
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    report('Kamera nur über https oder localhost');
    return false;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: chosenCamera ? { exact: chosenCamera } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    });
  } catch (error) {
    report(errorText(error, 'Kamera'));
    return false;
  }
  video.srcObject = stream;
  document.body.classList.add('camera-on');
  cameraButton.textContent = 'Kamera: an';
  cameraButton.classList.add('on');
  await listCameras();
  return true;
}

function stopCameraOnly() {
  // Eine reine Tonaufnahme läuft weiter, wenn nur die Kamera ausgeschaltet wird.
  if (recorder && recordingVideo) stopRecording();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  video.srcObject = null;
  document.body.classList.remove('camera-on');
  cameraButton.textContent = 'Kamera';
  cameraButton.classList.remove('on');
  cameraSelect.hidden = true;
}

async function startRecording() {
  const withVideo = recordMode.value === 'video';
  recordingVideo = withVideo;
  const format = FORMATS[recordMode.value].find((item) => MediaRecorder.isTypeSupported(item.type));
  if (!format || !navigator.mediaDevices?.getUserMedia) {
    report('Aufnahme wird von diesem Browser nicht unterstützt');
    return;
  }
  // Für eine Videoaufnahme wird die Kamera bei Bedarf selbst eingeschaltet.
  if (withVideo && !stream && !(await startCamera())) return;
  const tracks = withVideo ? [...stream.getVideoTracks()] : [];
  try {
    const mic = chosenMic();
    recordedAudio = await navigator.mediaDevices.getUserMedia({ audio: mic ? { deviceId: { exact: mic } } : true });
    tracks.push(...recordedAudio.getAudioTracks());
  } catch (error) {
    report(errorText(error, 'Mikrofon'));
    return;
  }

  chunks = [];
  recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: format.type });
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onstop = () => saveRecording(format);
  recorder.start(1000);
  recordStart = performance.now();
  recordButton.textContent = 'Aufnahme stoppen';
  recordMode.disabled = true;
  recordButton.classList.add('recording');
  recBadge.hidden = false;
  const tick = () => {
    recBadge.textContent = 'REC ' + clock((performance.now() - recordStart) / 1000);
  };
  tick();
  recordTimer = setInterval(tick, 500);
  report('Aufnahme läuft');
}

function stopRecording() {
  clearInterval(recordTimer);
  recorder?.stop();
  recorder = null;
  recordedAudio?.getTracks().forEach((track) => track.stop());
  recordedAudio = null;
  recordButton.textContent = 'Aufnahme';
  recordMode.disabled = false;
  recordButton.classList.remove('recording');
  recBadge.hidden = true;
}

function download(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

// Speichert die Aufnahme unter dem Namen des Skripts und legt den Wortlaut als Textdatei daneben.
// Im Programmfenster fragt vorher ein Speichern-Dialog nach Ordner und Name.
async function saveRecording(format) {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const { title, text } = scriptInfo();
  const recording = new Blob(chunks, { type: format.type.split(';')[0] });
  chunks = [];
  // Zeichen, die in Dateinamen nicht erlaubt sind, entfallen.
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'NEXRAY Prompter';
  let name = `${safeTitle}-${stamp}.${format.ending}`;

  let place = null;
  if (window.vpDesktop?.chooseRecording) {
    place = await window.vpDesktop.chooseRecording(name, t('Aufnahme speichern'));
    name = place.name;
  }
  const base = name.slice(0, name.lastIndexOf('.'));

  download(recording, name);
  if (text.trim()) {
    const head = `${title}\n${now.toLocaleString()}\n${name}\n\n`;
    // Das Kürzel am Anfang sorgt dafür, dass Umlaute auch im Windows-Editor stimmen.
    download(new Blob(['\ufeff' + head + text + '\n'], { type: 'text/plain;charset=utf-8' }), `${base}.txt`);
  }
  report(`Aufnahme gespeichert: ${name}`);
  showSaved(name, place);
}

// Hinweis nach dem Speichern mit Dateiname und Ordner; öffnet auf Wunsch den Ordner.
let savedTimer = 0;
let savedFolder = '';
function showSaved(name, place) {
  savedFolder = place?.folder ?? '';
  $('savedTitle').textContent = place?.canceled
    ? 'Speichern abgebrochen – die Aufnahme wurde zur Sicherheit trotzdem abgelegt'
    : 'Aufnahme gespeichert';
  $('savedName').textContent = name;
  $('savedFolder').textContent = savedFolder;
  $('savedFolder').hidden = !savedFolder;
  $('savedPlace').hidden = Boolean(place);
  $('savedOpen').hidden = !window.vpDesktop?.openRecordings;
  $('savedToast').hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    $('savedToast').hidden = true;
  }, 25000);
}

// Beendet Aufnahme und Kamera, etwa beim Schließen des Prompters.
export function stopCamera() {
  if (recorder) stopRecording();
  stopCameraOnly();
}

// onStatus(text) zeigt Meldungen im Prompter, micId() liefert das gewählte Mikrofon,
// script() Titel und Wortlaut des offenen Skripts für die Ablage.
export function initCamera(onStatus, micId, script) {
  report = onStatus;
  chosenMic = micId;
  scriptInfo = script;
  cameraButton.addEventListener('click', () => {
    if (!isPro()) openUpgrade('Kamera und Aufnahme gehören zur Pro-Version.');
    else if (stream) stopCameraOnly();
    else startCamera();
  });
  if (window.vpDesktop?.openRecordings) {
    $('recFolder').hidden = false;
    // „Aufnahmen" öffnet den zuletzt genutzten Ordner, der Hinweis den der eben gespeicherten Datei.
    $('recFolder').addEventListener('click', () => window.vpDesktop.openRecordings());
    $('savedOpen').addEventListener('click', () => window.vpDesktop.openRecordings(savedFolder));
  }
  $('savedClose').addEventListener('click', () => {
    $('savedToast').hidden = true;
  });
  recordMode.value = load('vp.record.mode', 'video');
  recordMode.addEventListener('change', () => save('vp.record.mode', recordMode.value));
  recordButton.addEventListener('click', () => {
    if (!isPro()) openUpgrade('Kamera und Aufnahme gehören zur Pro-Version.');
    else if (recorder) stopRecording();
    else startRecording();
  });
  cameraSelect.addEventListener('change', async () => {
    chosenCamera = cameraSelect.value;
    const recording = Boolean(recorder) && recordingVideo;
    stopCameraOnly();
    await startCamera();
    if (recording) report('Aufnahme beendet, weil die Kamera gewechselt wurde');
  });
}
