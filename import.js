// Liest Skripte aus Text-, Word-, OpenDocument- und PDF-Dateien.

// pdf.js 4.10.38 liegt im Programm, damit der PDF-Import auch ohne Internet funktioniert.
const PDFJS = new URL('vendor/pdfjs/', location.href).href;

export const ACCEPT = '.txt,.md,.docx,.odt,.pdf';

export async function readScriptFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  switch (ext) {
    case 'txt':
    case 'md':
      return file.text();
    case 'docx':
      return readDocx(await file.arrayBuffer());
    case 'odt':
      return readOdt(await file.arrayBuffer());
    case 'pdf':
      return readPdf(await file.arrayBuffer());
    case 'doc':
      throw new Error('Das alte Word-Format .doc wird nicht unterstützt. Bitte als .docx speichern.');
    default:
      throw new Error(`Dateityp .${ext} wird nicht unterstützt.`);
  }
}

/* ---------- ZIP (Grundlage von .docx und .odt) ---------- */

async function unzipEntry(buffer, name) {
  const view = new DataView(buffer);
  let eocd = buffer.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Die Datei ist beschädigt oder kein gültiges Dokument.');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const entry = decoder.decode(new Uint8Array(buffer, at + 46, nameLength));

    if (entry === name) {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const bytes = new Uint8Array(buffer, start, size);
      if (method === 0) return decoder.decode(bytes);
      const inflated = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Response(inflated).text();
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('In der Datei wurde kein Text gefunden.');
}

function parseXml(xml) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

async function readDocx(buffer) {
  const doc = parseXml(await unzipEntry(buffer, 'word/document.xml'));
  const paragraphs = [];
  for (const p of doc.getElementsByTagName('w:p')) {
    let text = '';
    for (const node of p.getElementsByTagName('*')) {
      if (node.tagName === 'w:t') text += node.textContent;
      else if (node.tagName === 'w:tab') text += ' ';
      else if (node.tagName === 'w:br') text += '\n';
    }
    if (text.trim()) paragraphs.push(text.trim());
  }
  return paragraphs.join('\n\n');
}

async function readOdt(buffer) {
  const doc = parseXml(await unzipEntry(buffer, 'content.xml'));
  const paragraphs = [];
  for (const node of doc.getElementsByTagName('*')) {
    if (node.tagName !== 'text:p' && node.tagName !== 'text:h') continue;
    const text = node.textContent.trim();
    if (text) paragraphs.push(text);
  }
  return paragraphs.join('\n\n');
}

/* ---------- PDF ---------- */

async function readPdf(buffer) {
  let pdfjs;
  try {
    pdfjs = await import(PDFJS + 'pdf.min.mjs');
  } catch {
    throw new Error('Der PDF-Leser fehlt in dieser Installation.');
  }
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';

  const pdf = await pdfjs.getDocument({ data: buffer }).promise;
  const paragraphs = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    paragraphs.push(...toParagraphs(content.items));
  }
  if (!paragraphs.length) {
    throw new Error('Das PDF enthält keinen lesbaren Text (vermutlich ein Scan).');
  }
  return paragraphs.join('\n\n');
}

// PDF kennt nur Zeilen. Zeilen mit normalem Abstand werden zu Absätzen verbunden.
function toParagraphs(items) {
  const lines = [];
  for (const item of items) {
    if (!item.str) continue;
    const y = item.transform[5];
    const height = item.height || Math.abs(item.transform[3]) || 10;
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - y) < height * 0.5) line.text += item.str;
    else lines.push({ y, height, text: item.str });
  }

  const paragraphs = [];
  let current = '';
  let previous = null;
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const gap = previous ? Math.abs(previous.y - line.y) : 0;
    if (previous && gap > previous.height * 1.8) {
      paragraphs.push(current);
      current = text;
    } else if (/[a-zäöüß]-$/.test(current) && /^[a-zäöüß]/.test(text)) {
      // Silbentrennung am Zeilenende auflösen.
      current = current.slice(0, -1) + text;
    } else {
      current += (current ? ' ' : '') + text;
    }
    previous = line;
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}
