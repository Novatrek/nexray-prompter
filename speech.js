// Spracherkennung, die vollständig auf dem Gerät läuft (Vosk). Kein Ton verlässt den Rechner.

// Ein Sprachmodell je Sprache; geladen wird nur das gerade gewählte.
const MODELS = Object.fromEntries(
  ['de', 'en', 'fr', 'es', 'it'].map((key) => [key, `vendor/models/${key}.tar.gz`])
);
const loaded = {};
let library = null;

function loadLibrary() {
  library ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'vendor/vosk.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Spracherkennung fehlt in dieser Installation'));
    document.head.append(script);
  });
  return library;
}

// Startet die Erkennung auf einem offenen Mikrofon und liefert eine Funktion zum Beenden.
// vocabulary: die Wörter des Skripts. Die Erkennung beschränkt sich darauf und wird dadurch
// deutlich treffsicherer; alles andere meldet sie als unbekannt.
export async function startLocalSpeech({ lang, stream, audioContext, vocabulary, onText, onStatus }) {
  await loadLibrary();
  const key = MODELS[lang.slice(0, 2)] ? lang.slice(0, 2) : 'en';
  if (!loaded[key]) {
    onStatus('Sprachmodell wird geladen …');
    const url = new URL(MODELS[key], location.href).href;
    loaded[key] = window.Vosk.createModel(url, -1);
    loaded[key].catch(() => delete loaded[key]);
  }
  const model = await loaded[key];

  const grammar = JSON.stringify([...new Set(vocabulary), '[unk]']);
  const recognizer = new model.KaldiRecognizer(audioContext.sampleRate, grammar);
  // Mit Sicherheit je Wort; der Sprech-Coach schätzt daraus die Deutlichkeit.
  recognizer.setWords(true);
  recognizer.on('partialresult', (message) => onText(message.result.partial, false));
  recognizer.on('result', (message) => onText(message.result.text, true, message.result.result || []));

  const source = audioContext.createMediaStreamSource(stream);
  const tap = audioContext.createScriptProcessor(4096, 1, 1);
  tap.onaudioprocess = (event) => {
    try {
      recognizer.acceptWaveform(event.inputBuffer);
    } catch { /* Erkennung wurde gerade beendet */ }
  };
  source.connect(tap);
  // Ohne Verbindung zum Ausgang liefert der Knoten keine Daten; er gibt selbst nur Stille aus.
  tap.connect(audioContext.destination);

  return () => {
    tap.onaudioprocess = null;
    tap.disconnect();
    source.disconnect();
    recognizer.remove();
  };
}
