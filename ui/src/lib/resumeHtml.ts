import { DEFAULT_RESUME_PDF_STYLE, type ResumePdfStyleId } from './resumePdfStyles';

const DOCX_CT =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function cleanOneLine(s: string): string {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function isLikelySectionHeading(t: string): boolean {
  const s = cleanOneLine(t).replace(/[:\-–—]+$/, '').trim();
  if (!s) return false;
  if (s.length > 32) return false;
  const key = s.toLowerCase();
  const common = new Set([
    'summary',
    'professional summary',
    'experience',
    'work experience',
    'employment',
    'projects',
    'skills',
    'technical skills',
    'education',
    'certifications',
    'certificates',
    'awards',
    'leadership',
    'volunteering',
    'volunteer',
    'publications',
    'organizations',
    'interests',
    'links',
  ]);
  if (common.has(key)) return true;
  // All-caps short headings (allow spaces and &/).
  const letters = s.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 4) {
    const upper = letters === letters.toUpperCase();
    if (upper) return true;
  }
  return false;
}

/**
 * Export-time auto styling:
 * - If there is no <h1>, promote the first meaningful line to <h1>.
 * - Promote common section labels (Experience/Education/Skills/etc) to <h2>.
 * - Optional explicit page break: insert <hr data-pagebreak="1" /> before Education when long.
 *
 * This DOES NOT change what’s stored in profile; only the exported file layout.
 */
export function prepareResumeHtmlForExport(rawHtml: string): string {
  const html = String(rawHtml || '').trim();
  if (!html || typeof document === 'undefined') return html;

  const doc = new DOMParser().parseFromString(`<div id="__r">${html}</div>`, 'text/html');
  const root = doc.querySelector('#__r') as HTMLElement | null;
  if (!root) return html;

  const h1Count = root.querySelectorAll('h1').length;

  // Promote first non-empty paragraph line to H1 if missing.
  if (h1Count === 0) {
    const firstP = Array.from(root.children).find((el) => el.tagName.toLowerCase() === 'p') as HTMLParagraphElement | undefined;
    if (firstP) {
      const text = cleanOneLine(firstP.textContent || '');
      if (text) {
        const h1 = doc.createElement('h1');
        h1.textContent = text;
        root.insertBefore(h1, firstP);
        firstP.remove();
      }
    }
  }

  // Promote section heading paragraphs to <h2>
  const children = Array.from(root.children);
  for (const el of children) {
    if (el.tagName.toLowerCase() !== 'p') continue;
    const t = cleanOneLine(el.textContent || '');
    if (!t) continue;
    if (isLikelySectionHeading(t)) {
      const h2 = doc.createElement('h2');
      h2.textContent = t.replace(/[:\-–—]+$/, '').trim();
      root.replaceChild(h2, el);
    }
  }

  // If long, force Education onto a new page for cleaner Word/PDF exports.
  const blocks = Array.from(root.children).filter((el) => cleanOneLine(el.textContent || ''));
  if (blocks.length >= 48) {
    const h2s = Array.from(root.querySelectorAll('h2'));
    const edu = h2s.find((x) => cleanOneLine(x.textContent || '').toLowerCase() === 'education');
    if (edu) {
      const prev = edu.previousElementSibling as HTMLElement | null;
      const already =
        prev?.getAttribute('data-pagebreak') ||
        (prev?.getAttribute('class') || '').toLowerCase().includes('page-break');
      if (!already) {
        const hr = doc.createElement('hr');
        hr.setAttribute('data-pagebreak', '1');
        root.insertBefore(hr, edu);
      }
    }
  }

  return root.innerHTML;
}

export async function autoStructureResumeHtmlForExport(rawHtml: string): Promise<string> {
  const html = String(rawHtml || '').trim();
  if (!html) return html;
  try {
    const res = await fetch('/api/jobs/resume_auto_structure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html }),
    });
    if (!res.ok) {
      // 409 = no OpenAI key configured; fall back silently.
      return prepareResumeHtmlForExport(html);
    }
    const data = (await res.json()) as { ok?: boolean; html?: string };
    const out = String(data?.html || '').trim();
    if (!out) return prepareResumeHtmlForExport(html);
    // Still run our deterministic pass to ensure markers/headings are normalized.
    return prepareResumeHtmlForExport(out);
  } catch {
    return prepareResumeHtmlForExport(html);
  }
}

/** Plain text from profile (HTML resume or legacy plain field). */
export function resumePlainFromProfile(
  p: { base_resume?: string; base_resume_html?: string } | null | undefined,
): string {
  if (!p) return '';
  const html = (p.base_resume_html || '').trim();
  if (html && typeof document !== 'undefined') {
    const d = document.createElement('div');
    d.innerHTML = html;
    const t = (d.innerText || '').trim();
    if (t) return t;
  }
  return (p.base_resume || '').trim();
}

/** Seed Quill from plain text paragraphs. */
export function plainLinesToHtml(plain: string): string {
  const t = plain.trim();
  if (!t) return '<p><br></p>';
  return t
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim());
      return `<p>${lines.join('<br/>')}</p>`;
    })
    .join('');
}

export function stripHtmlToPlain(html: string): string {
  if (!html.trim()) return '';
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const d = document.createElement('div');
  d.innerHTML = html;
  return (d.innerText || '').trim();
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

/**
 * Formatted Word (.docx) via Butler ui-server. Open in Word and print to PDF if you like.
 * File is written under the Butler data folder (e.g. D:\\butlor\\resumes).
 */
export async function downloadResumeDocx(opts: {
  html: string;
  filenameStem: string;
  styleId?: ResumePdfStyleId;
  /** Legacy; server ignores. */
  useTemplate?: boolean;
}): Promise<{ blob: Blob; filenameStem: string; savedPath?: string }> {
  const style = opts.styleId ?? DEFAULT_RESUME_PDF_STYLE;
  const exportHtml = await autoStructureResumeHtmlForExport(opts.html);
  const rawStem =
    String(opts.filenameStem || 'resume')
      .replace(/[^\w\-]+/g, '_')
      .slice(0, 80) || 'resume';
  const maxBase = Math.max(1, 80 - 1 - style.length);
  const fn = `${rawStem.slice(0, maxBase)}_${style}`;
  const res = await fetch('/api/jobs/resume_docx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html: exportHtml,
      filename_stem: fn,
      style_id: style,
    }),
  });
  const ct = res.headers.get('content-type') || '';
  const buf = await res.arrayBuffer();
  const okDocx = ct.includes('wordprocessingml') || ct.includes('officedocument');
  if (!res.ok || !okDocx) {
    const text = new TextDecoder().decode(buf);
    let detail = '';
    try {
      const j = JSON.parse(text) as { message?: string; error?: string };
      detail = (j.message || j.error || '').trim();
    } catch {
      detail = text.slice(0, 1200).trim();
    }
    if (!detail && res.status === 500 && !ct.includes('json')) {
      detail =
        'API returned non-JSON (often the Vite proxy cannot reach Butler on port 4001). From repo root run: node ui-server.js';
    }
    throw new Error(detail || `Could not generate Word document (${res.status}${ct ? `, ${ct}` : ''})`);
  }
  const savedPath = res.headers.get('x-butler-saved-path')?.trim() || undefined;
  const blob = new Blob([buf], { type: DOCX_CT });
  return { blob, filenameStem: fn, savedPath };
}
