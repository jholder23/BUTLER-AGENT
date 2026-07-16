/**
 * Résumé PDF: Quill HTML → blocks (cheerio) → US Letter PDF (pdfkit).
 * Exactly two layouts; ids + labels come from `resume-pdf-presets.json`.
 *
 * We do NOT use PDFKit's width-based text wrapping (LineWrapper). It can infer a ~54pt wrap
 * width when doc.x is stale — the "narrow receipt column". Instead we wrap lines ourselves
 * with widthOfString and draw each line with { lineBreak: false }.
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { load } from 'cheerio';
import PDFDocument from 'pdfkit';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadPresets() {
  const p = path.join(__dirname, 'resume-pdf-presets.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

const PRESETS = loadPresets();
export const RESUME_PDF_STYLE_IDS = PRESETS.styles.map((s) => s.id);

/** Old five-template ids → one of the two current layouts */
const LEGACY_STYLE_MAP = {
  classic: 'standard',
  modern: 'accent',
  executive: 'standard',
  minimal: 'standard',
  technical: 'accent',
};

export function normalizeResumePdfStyleId(id) {
  const s = String(id || '')
    .toLowerCase()
    .trim();
  if (RESUME_PDF_STYLE_IDS.includes(s)) return s;
  if (LEGACY_STYLE_MAP[s]) return LEGACY_STYLE_MAP[s];
  return PRESETS.defaultStyleId || RESUME_PDF_STYLE_IDS[0];
}

function cleanText(s) {
  return String(s || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse Quill-ish HTML into ordered blocks. */
export function parseResumeHtmlToBlocks(html) {
  const $ = load(`<div id="__b">${html || ''}</div>`);
  let root = $('#__b');
  const kids = root.children();
  if (kids.length === 1) {
    const el0 = kids.first();
    const cls = (el0.attr('class') || '') + (el0.attr('id') || '');
    if (/ql-editor|ql-container/i.test(cls)) {
      const inner = el0.children();
      if (inner.length && el0.find('h1, h2, h3, p, ul, ol, blockquote').length) {
        root = el0;
      }
    }
  }
  const blocks = [];
  root.children().each((_, el) => {
    const tag = el.tagName?.toLowerCase();
    const $el = $(el);
    const dataPagebreak = ($el.attr('data-pagebreak') || '').toString();
    const cls = ($el.attr('class') || '').toString().toLowerCase();
    const style = ($el.attr('style') || '').toString().toLowerCase();
    const isPageBreak =
      (dataPagebreak && dataPagebreak !== '0' && !/^(false|no)$/i.test(dataPagebreak)) ||
      cls.includes('page-break') ||
      cls.includes('pagebreak') ||
      (style.includes('page-break-after') && style.includes('always'));

    if (isPageBreak) {
      blocks.push({ type: 'pagebreak' });
      return;
    }
    if (tag === 'h1') {
      const t = cleanText($el.text());
      if (t) blocks.push({ type: 'h1', text: t });
    } else if (tag === 'h2') {
      const t = cleanText($el.text());
      if (t) blocks.push({ type: 'h2', text: t });
    } else if (tag === 'h3') {
      const t = cleanText($el.text());
      if (t) blocks.push({ type: 'h3', text: t });
    } else if (tag === 'p') {
      const t = cleanText($el.text());
      if (t) blocks.push({ type: 'p', text: t });
    } else if (tag === 'ul' || tag === 'ol') {
      const items = [];
      $el.find('li').each((__, li) => {
        const x = cleanText($(li).text());
        if (x) items.push(x);
      });
      if (items.length) blocks.push({ type: 'list', ordered: tag === 'ol', items });
    } else if (tag === 'blockquote') {
      const t = cleanText($el.text());
      if (t) blocks.push({ type: 'quote', text: t });
    }
  });
  if (blocks.length === 0) {
    const $flat = load(html || '');
    $flat('h1, h2, h3, p, ul, ol, blockquote, hr, [data-pagebreak], .page-break, .pagebreak, [style*="page-break-after"]').each((_, el) => {
      const tag = el.tagName?.toLowerCase();
      const $el = $flat(el);
      const dataPagebreak = ($el.attr('data-pagebreak') || '').toString();
      const cls = ($el.attr('class') || '').toString().toLowerCase();
      const style = ($el.attr('style') || '').toString().toLowerCase();
      const isPageBreak =
        (dataPagebreak && dataPagebreak !== '0' && !/^(false|no)$/i.test(dataPagebreak)) ||
        cls.includes('page-break') ||
        cls.includes('pagebreak') ||
        (style.includes('page-break-after') && style.includes('always'));

      if (isPageBreak) {
        blocks.push({ type: 'pagebreak' });
        return;
      }
      if (tag === 'h1') {
        const t = cleanText($el.text());
        if (t) blocks.push({ type: 'h1', text: t });
      } else if (tag === 'h2') {
        const t = cleanText($el.text());
        if (t) blocks.push({ type: 'h2', text: t });
      } else if (tag === 'h3') {
        const t = cleanText($el.text());
        if (t) blocks.push({ type: 'h3', text: t });
      } else if (tag === 'p') {
        const t = cleanText($el.text());
        if (t) blocks.push({ type: 'p', text: t });
      } else if (tag === 'ul' || tag === 'ol') {
        const items = [];
        $el.find('li').each((__, li) => {
          const x = cleanText($flat(li).text());
          if (x) items.push(x);
        });
        if (items.length) blocks.push({ type: 'list', ordered: tag === 'ol', items });
      } else if (tag === 'blockquote') {
        const t = cleanText($el.text());
        if (t) blocks.push({ type: 'quote', text: t });
      }
    });
  }
  if (blocks.length === 0) blocks.push({ type: 'p', text: '(No content)' });
  return blocks;
}

const PAGE_W = 612;
const PAGE_H = 792;

const TOP_STRIP = {
  standard: '#78716c',
  accent: '#2563eb',
};

/**
 * Greedy word wrap using current font metrics (no LineWrapper).
 * @param {import('pdfkit').PDFDocument} doc
 */
function wrapLines(doc, text, maxWidth, measureOpts = {}) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (!t) return [''];
  const words = t.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    let w = word;
    while (w.length) {
      const trial = line ? `${line} ${w}` : w;
      if (doc.widthOfString(trial, measureOpts) <= maxWidth) {
        line = trial;
        break;
      }
      if (line) {
        lines.push(line);
        line = '';
        continue;
      }
      let low = 1;
      let high = w.length;
      let best = 1;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const part = w.slice(0, mid);
        if (doc.widthOfString(part, measureOpts) <= maxWidth) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      const take = Math.max(1, best);
      lines.push(w.slice(0, take));
      w = w.slice(take);
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Draw pre-wrapped lines; each line uses lineBreak:false so PDFKit never runs LineWrapper.
 * @param {import('pdfkit').PDFDocument} doc
 * @param {() => number} onOverflow — add page, return new Y for top margin
 */
function drawLines(doc, lines, x, y, lineGap, textOpts, maxY, onOverflow) {
  doc._wrapper = null;
  doc._textOptions = null;
  const lh = doc.currentLineHeight(true);
  for (const line of lines) {
    if (y + lh > maxY) {
      y = onOverflow();
    }
    doc.x = x;
    doc.text(line, x, y, { ...textOpts, lineBreak: false });
    y += lh + lineGap;
  }
  return y;
}

/** @param {import('pdfkit').PDFDocument} doc */
function drawStandard(doc, blocks) {
  const margin = 54;
  const bottom = 54;
  const w = PAGE_W - margin * 2;
  const maxY = PAGE_H - bottom;
  let y = margin;

  const onOverflow = () => {
    doc.addPage();
    y = margin;
    return margin;
  };

  for (const b of blocks) {
    if (y + 40 > maxY) {
      y = onOverflow();
    }
    if (b.type === 'pagebreak') {
      y = onOverflow();
      continue;
    }

    if (b.type === 'h1') {
      doc.font('Times-Bold').fontSize(24).fillColor('#111827');
      const lines = wrapLines(doc, b.text, w);
      y = drawLines(doc, lines, margin, y, 2, {}, maxY, onOverflow);
      y += 18;
    } else if (b.type === 'h2') {
      const label = b.text.toUpperCase();
      doc.font('Times-Bold').fontSize(9).fillColor('#4b5563');
      const mo = { characterSpacing: 1.2 };
      const lines = wrapLines(doc, label, w, mo);
      const h2Gap = 1;
      y = drawLines(doc, lines, margin, y, h2Gap, mo, maxY, onOverflow);
      const lineY = y - h2Gap + 2;
      doc.moveTo(margin, lineY).lineTo(margin + w, lineY).strokeColor('#d1d5db').lineWidth(0.5).stroke();
      y = lineY + 12;
    } else if (b.type === 'h3') {
      doc.font('Times-Bold').fontSize(11).fillColor('#1f2937');
      const lines = wrapLines(doc, b.text, w);
      y = drawLines(doc, lines, margin, y, 2, {}, maxY, onOverflow);
      y += 10;
    } else if (b.type === 'p') {
      doc.font('Times-Roman').fontSize(11).fillColor('#374151');
      const lines = wrapLines(doc, b.text, w);
      y = drawLines(doc, lines, margin, y, 3, {}, maxY, onOverflow);
      y += 10;
    } else if (b.type === 'list') {
      doc.font('Times-Roman').fontSize(11).fillColor('#374151');
      const innerW = w - 12;
      for (let i = 0; i < b.items.length; i++) {
        if (y + 24 > maxY) {
          y = onOverflow();
        }
        const prefix = b.ordered ? `${i + 1}. ` : '• ';
        const lines = wrapLines(doc, prefix + b.items[i], innerW);
        y = drawLines(doc, lines, margin + 8, y, 2, {}, maxY, onOverflow);
        y += 6;
      }
      y += 4;
    } else if (b.type === 'quote') {
      doc.font('Times-Italic').fontSize(10.5).fillColor('#4b5563');
      const qw = w - 14;
      const lines = wrapLines(doc, b.text, qw);
      y = drawLines(doc, lines, margin + 12, y, 2, {}, maxY, onOverflow);
      y += 12;
    }
    doc.x = margin;
  }
}

/** @param {import('pdfkit').PDFDocument} doc */
function drawAccent(doc, blocks) {
  const margin = 54;
  const leftBar = 6;
  const barX = margin;
  const contentX = margin + leftBar + 14;
  const bottom = 54;
  const w = PAGE_W - contentX - margin;
  const maxY = PAGE_H - bottom;
  let y = margin;

  const paintBar = () => {
    doc.save();
    doc.rect(barX, 0, leftBar, PAGE_H).fill('#2563eb');
    doc.restore();
  };
  paintBar();
  doc.on('pageAdded', paintBar);

  const onOverflow = () => {
    doc.addPage();
    paintBar();
    y = margin;
    return margin;
  };

  for (const b of blocks) {
    if (y + 40 > maxY) {
      y = onOverflow();
    }
    if (b.type === 'pagebreak') {
      y = onOverflow();
      continue;
    }

    if (b.type === 'h1') {
      doc.font('Helvetica-Bold').fontSize(28).fillColor('#0a0a0a');
      const lines = wrapLines(doc, b.text, w);
      y = drawLines(doc, lines, contentX, y, 2, {}, maxY, onOverflow);
      y += 14;
    } else if (b.type === 'h2') {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#2563eb');
      const mo = { characterSpacing: 0.8 };
      const lines = wrapLines(doc, b.text.toUpperCase(), w, mo);
      y = drawLines(doc, lines, contentX, y, 2, mo, maxY, onOverflow);
      y += 10;
    } else if (b.type === 'h3') {
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#171717');
      const lines = wrapLines(doc, b.text, w);
      y = drawLines(doc, lines, contentX, y, 2, {}, maxY, onOverflow);
      y += 8;
    } else if (b.type === 'p') {
      doc.font('Helvetica').fontSize(11).fillColor('#262626');
      const lines = wrapLines(doc, b.text, w);
      y = drawLines(doc, lines, contentX, y, 3, {}, maxY, onOverflow);
      y += 10;
    } else if (b.type === 'list') {
      doc.font('Helvetica').fontSize(11).fillColor('#262626');
      const innerW = w - 10;
      for (let i = 0; i < b.items.length; i++) {
        if (y + 24 > maxY) {
          y = onOverflow();
        }
        const prefix = b.ordered ? `${i + 1}. ` : '• ';
        const lines = wrapLines(doc, prefix + b.items[i], innerW);
        y = drawLines(doc, lines, contentX + 6, y, 2, {}, maxY, onOverflow);
        y += 6;
      }
      y += 4;
    } else if (b.type === 'quote') {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor('#525252');
      const qw = w - 14;
      const lines = wrapLines(doc, b.text, qw);
      y = drawLines(doc, lines, contentX + 10, y, 2, {}, maxY, onOverflow);
      y += 12;
    }
    doc.x = contentX;
  }
}

/**
 * @param {string} htmlBody — HTML fragment from Quill
 * @param {string} styleId
 * @returns {Promise<Buffer>}
 */
export async function renderResumeHtmlToPdfBuffer(htmlBody, styleId) {
  const id = normalizeResumePdfStyleId(styleId);
  const blocks = parseResumeHtmlToBlocks(htmlBody);

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: 'LETTER',
      margins: 0,
      autoFirstPage: true,
      info: {
        Title: `Résumé (${id})`,
        Author: 'Butler',
        Subject: `butler-resume-style:${id}`,
        Keywords: id,
      },
    });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const stripColor = TOP_STRIP[id];
    const paintTopStrip = () => {
      if (!stripColor) return;
      doc.save();
      doc.rect(0, 0, PAGE_W, 6).fill(stripColor);
      doc.restore();
    };

    try {
      paintTopStrip();
      doc.on('pageAdded', paintTopStrip);

      if (id === 'accent') drawAccent(doc, blocks);
      else drawStandard(doc, blocks);
      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
