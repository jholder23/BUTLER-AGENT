/**
 * Smoke test: generate a résumé PDF with resumePdfKit only (no Python, no HTTP).
 * Run from repo root: node scripts/test-resume-pdf.mjs
 * Optional: BUTLER_TEST_HTTP=1 also POSTs to http://127.0.0.1:4001/api/jobs/resume_pdf
 */
import { writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const { renderResumeHtmlToPdfBuffer } = await import(pathToFileURL(path.join(root, 'resumePdfKit.mjs')).href);

const html = `<h1>Smoke Test Name</h1>
<h2>Professional summary</h2>
<p>${'This paragraph must wrap at normal page margins, not a narrow receipt column. '.repeat(25)}</p>
<h2>Experience</h2>
<ul><li>First role with responsibilities described in enough text to wrap.</li><li>Second item.</li></ul>`;

const buf = await renderResumeHtmlToPdfBuffer(html, 'standard');
const head = buf.slice(0, 5).toString('ascii');
if (head !== '%PDF-') {
  console.error('FAIL: expected PDF header, got', JSON.stringify(head));
  process.exit(1);
}

const outPath = path.join(root, '_resume-smoke-test.pdf');
await writeFile(outPath, buf);
// eslint-disable-next-line no-console
console.log('OK:', outPath, buf.length, 'bytes (open locally to verify layout)');

if (process.env.BUTLER_TEST_HTTP === '1') {
  const r = await fetch('http://127.0.0.1:4001/api/jobs/resume_pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html,
      filename_stem: 'smoke_http',
      style_id: 'standard',
    }),
  });
  const ct = r.headers.get('content-type') || '';
  const ab = await r.arrayBuffer();
  if (!r.ok || !ct.includes('pdf')) {
    const t = new TextDecoder().decode(ab);
    console.error('HTTP FAIL:', r.status, ct, t.slice(0, 500));
    process.exit(1);
  }
  const httpPath = path.join(root, '_resume-smoke-http.pdf');
  await writeFile(httpPath, Buffer.from(ab));
  // eslint-disable-next-line no-console
  console.log('OK HTTP:', httpPath, ab.byteLength, 'bytes');
}
