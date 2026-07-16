/**
 * Quill HTML → blocks (reuse cheerio parse) → .docx (docx library).
 * Five visual styles inspired by common professional templates (Harvard, modern, executive, ATS, corporate).
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TextRun, convertInchesToTwip, Table, TableRow, TableCell, WidthType, ShadingType, VerticalAlign } from 'docx';
import { parseResumeHtmlToBlocks } from './resumePdfKit.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadPresets() {
  return JSON.parse(readFileSync(path.join(__dirname, 'resume-docx-presets.json'), 'utf8'));
}

const PRESETS = loadPresets();
export const RESUME_DOCX_STYLE_IDS = PRESETS.styles.map((s) => s.id);

const LEGACY_MAP = {
  standard: 'harvard',
  accent: 'modern',
  classic: 'harvard',
  modern: 'modern',
  executive: 'executive',
  minimal: 'ats',
  technical: 'corporate',
};

export function normalizeResumeDocxStyleId(id) {
  const s = String(id || '')
    .toLowerCase()
    .trim();
  if (RESUME_DOCX_STYLE_IDS.includes(s)) return s;
  if (LEGACY_MAP[s]) return LEGACY_MAP[s];
  return PRESETS.defaultStyleId || RESUME_DOCX_STYLE_IDS[0];
}

/** Font sizes in half-points (Word convention: 24 = 12pt) */
function theme(styleId) {
  const m = {
    top: convertInchesToTwip(1),
    bottom: convertInchesToTwip(1),
    left: convertInchesToTwip(1),
    right: convertInchesToTwip(1),
  };
  switch (styleId) {
    case 'modern':
      return {
        margin: { ...m, left: convertInchesToTwip(0.75), right: convertInchesToTwip(0.75) },
        bodyFont: 'Calibri',
        body: 22,
        titleFont: 'Calibri Light',
        title: 56,
        titleAlign: AlignmentType.CENTER,
        titleCaps: false,
        h2Font: 'Calibri',
        h2: 24,
        h2Bold: true,
        h2Color: '2563EB',
        h2Upper: true,
        h2Rule: true,
        ruleColor: '2563EB',
        h3Font: 'Calibri',
        h3: 22,
        quoteItalic: true,
        afterTitle: 240,
        afterH2: 120,
        afterP: 120,
        layout: 'two_col_right_bar',
        sidebarBg: '0B1220',
        sidebarText: 'FFFFFF',
        accent: '2563EB',
      };
    case 'executive':
      return {
        margin: { ...m, left: convertInchesToTwip(0.75), right: convertInchesToTwip(0.75) },
        bodyFont: 'Cambria',
        body: 22,
        titleFont: 'Cambria',
        title: 56,
        titleAlign: AlignmentType.CENTER,
        titleCaps: false,
        h2Font: 'Cambria',
        h2: 26,
        h2Bold: true,
        h2Color: '44403C',
        h2Upper: false,
        h2Rule: true,
        ruleColor: 'A8A29E',
        h3Font: 'Cambria',
        h3: 24,
        quoteItalic: true,
        afterTitle: 360,
        afterH2: 200,
        afterP: 160,
        layout: 'single_col_accent_top',
        accent: '78350F',
      };
    case 'ats':
      return {
        margin: m,
        bodyFont: 'Arial',
        body: 22,
        titleFont: 'Arial',
        title: 48,
        titleAlign: AlignmentType.LEFT,
        titleCaps: false,
        h2Font: 'Arial',
        h2: 24,
        h2Bold: true,
        h2Color: '000000',
        h2Upper: true,
        h2Rule: false,
        ruleColor: '000000',
        h3Font: 'Arial',
        h3: 22,
        quoteItalic: true,
        afterTitle: 160,
        afterH2: 100,
        afterP: 100,
        layout: 'single_col_plain',
      };
    case 'corporate':
      return {
        margin: { ...m, left: convertInchesToTwip(0.75), right: convertInchesToTwip(0.75) },
        bodyFont: 'Calibri',
        body: 22,
        titleFont: 'Calibri',
        title: 52,
        titleAlign: AlignmentType.LEFT,
        titleCaps: false,
        h2Font: 'Calibri',
        h2: 24,
        h2Bold: true,
        h2Color: '334155',
        h2Upper: true,
        h2Rule: true,
        ruleColor: '64748B',
        h3Font: 'Calibri',
        h3: 22,
        quoteItalic: true,
        afterTitle: 120,
        afterH2: 140,
        afterP: 120,
        nameRule: true,
        layout: 'two_col_left_bar',
        sidebarBg: '334155',
        sidebarText: 'FFFFFF',
        accent: '64748B',
      };
    case 'harvard':
    default:
      return {
        margin: { ...m, left: convertInchesToTwip(0.9), right: convertInchesToTwip(0.9) },
        bodyFont: 'Times New Roman',
        body: 22,
        titleFont: 'Times New Roman',
        title: 52,
        titleAlign: AlignmentType.CENTER,
        titleCaps: true,
        h2Font: 'Times New Roman',
        h2: 22,
        h2Bold: true,
        h2Color: '111827',
        h2Upper: true,
        h2Rule: true,
        ruleColor: '9CA3AF',
        h3Font: 'Times New Roman',
        h3: 22,
        quoteItalic: true,
        afterTitle: 200,
        afterH2: 120,
        afterP: 120,
        nameRule: false,
        layout: 'single_col_classic',
      };
  }
}

/**
 * @param {Array<{type: string, text?: string, items?: string[], ordered?: boolean}>} blocks
 * @param {ReturnType<typeof theme>} t
 * @param {{ forceColor?: string }} [opts]
 */
function blocksToDocx(blocks, t, opts = {}) {
  /** @type {import('docx').Paragraph[]} */
  const out = [];
  const forceColor = opts.forceColor ? String(opts.forceColor).toUpperCase() : '';
  const applyColor = (c) => (forceColor ? forceColor : c);

  for (const b of blocks) {
    if (b.type === 'h1') {
      const raw = String(b.text || '');
      const display = t.titleCaps ? raw.toUpperCase() : raw;
      const runs = [
        new TextRun({
          text: display,
          font: t.titleFont,
          size: t.title,
          bold: true,
          color: applyColor(undefined),
        }),
      ];
      out.push(
        new Paragraph({
          style: 'Heading1',
          alignment: t.titleAlign,
          spacing: { after: t.afterTitle },
          children: runs,
          border: t.nameRule
            ? {
                bottom: {
                  color: applyColor(t.ruleColor),
                  space: 1,
                  style: BorderStyle.SINGLE,
                  size: 6,
                },
              }
            : undefined,
        }),
      );
    } else if (b.type === 'h2') {
      const label = t.h2Upper ? String(b.text || '').toUpperCase() : String(b.text || '');
      const runs = [
        new TextRun({
          text: label,
          font: t.h2Font,
          size: t.h2,
          bold: t.h2Bold,
          color: applyColor(t.h2Color),
        }),
      ];
      out.push(
        new Paragraph({
          style: 'Heading2',
          spacing: { before: 200, after: t.afterH2 },
          border: t.h2Rule
            ? {
                bottom: {
                  color: applyColor(t.ruleColor),
                  space: 1,
                  style: BorderStyle.SINGLE,
                  size: 4,
                },
              }
            : undefined,
          children: runs,
        }),
      );
    } else if (b.type === 'h3') {
      out.push(
        new Paragraph({
          style: 'Heading3',
          spacing: { after: 80 },
          children: [
            new TextRun({
              text: String(b.text || ''),
              font: t.h3Font,
              size: t.h3,
              bold: true,
              color: applyColor(undefined),
            }),
          ],
        }),
      );
    } else if (b.type === 'p') {
      out.push(
        new Paragraph({
          style: 'Normal',
          spacing: { after: t.afterP },
          alignment: AlignmentType.JUSTIFIED,
          children: [
            new TextRun({
              text: String(b.text || ''),
              font: t.bodyFont,
              size: t.body,
              color: applyColor(undefined),
            }),
          ],
        }),
      );
    } else if (b.type === 'list') {
      for (let i = 0; i < (b.items || []).length; i++) {
        const prefix = b.ordered ? `${i + 1}. ` : '• ';
        out.push(
          new Paragraph({
            style: 'ListParagraph',
            spacing: { after: 80 },
            indent: { left: convertInchesToTwip(0.25), hanging: convertInchesToTwip(0.15) },
            children: [
              new TextRun({
                text: prefix + String(b.items[i]),
                font: t.bodyFont,
                size: t.body,
                color: applyColor(undefined),
              }),
            ],
          }),
        );
      }
    } else if (b.type === 'quote') {
      out.push(
        new Paragraph({
          style: 'IntenseQuote',
          spacing: { after: t.afterP },
          indent: { left: convertInchesToTwip(0.2) },
          children: [
            new TextRun({
              text: String(b.text || ''),
              font: t.bodyFont,
              size: t.body,
              italics: t.quoteItalic,
              color: applyColor('4B5563'),
            }),
          ],
        }),
      );
    } else if (b.type === 'pagebreak') {
      // Forces the next paragraph onto a new Word page.
      out.push(
        new Paragraph({
          style: 'Normal',
          pageBreakBefore: true,
          children: [new TextRun({ text: '', font: t.bodyFont, size: t.body })],
        }),
      );
    }
  }

  if (out.length === 0) {
    out.push(
      new Paragraph({
        children: [new TextRun({ text: '(No content)', font: t.bodyFont, size: t.body })],
      }),
    );
  }

  return out;
}

function pickSidebarBlocks(blocks) {
  const left = [];
  const right = [];
  const sidebarHeads = new Set(['skills', 'tools', 'tooling', 'languages', 'certifications', 'certificates', 'links', 'contact', 'core competencies']);
  let mode = 'main';
  for (const b of blocks) {
    if (b.type === 'h2') {
      const key = String(b.text || '').toLowerCase().trim();
      mode = sidebarHeads.has(key) ? 'side' : 'main';
    }
    (mode === 'side' ? left : right).push(b);
  }
  return { sidebar: left, main: right };
}

function tableNoBorders() {
  return {
    top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  };
}

function renderTwoColumnDocx(blocks, t, sideOnRight) {
  const { sidebar, main } = pickSidebarBlocks(blocks);
  const sideChildren = blocksToDocx(
    sidebar,
    { ...t, h2Rule: false, h2Color: t.sidebarText || 'FFFFFF', ruleColor: t.sidebarText || 'FFFFFF' },
    { forceColor: t.sidebarText || 'FFFFFF' },
  );
  const mainChildren = blocksToDocx(main, t);

  const sideCell = new TableCell({
    width: { size: 32, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.TOP,
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: t.sidebarBg || '111827' },
    margins: { top: 180, bottom: 180, left: 220, right: 220 },
    borders: tableNoBorders(),
    children: sideChildren.length ? sideChildren : [new Paragraph({ children: [new TextRun({ text: ' ', color: t.sidebarText || 'FFFFFF' })] })],
  });

  const mainCell = new TableCell({
    width: { size: 68, type: WidthType.PERCENTAGE },
    verticalAlign: VerticalAlign.TOP,
    margins: { top: 180, bottom: 180, left: 260, right: 260 },
    borders: tableNoBorders(),
    children: mainChildren,
  });

  const rowChildren = sideOnRight ? [mainCell, sideCell] : [sideCell, mainCell];
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: tableNoBorders(),
      rows: [
        new TableRow({
          children: rowChildren,
        }),
      ],
    }),
  ];
}

function renderSingleColumnWithTopAccent(blocks, t) {
  // Create a thin accent band at top using a 1-row table.
  const band = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableNoBorders(),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, color: 'auto', fill: t.accent || '111827' },
            borders: tableNoBorders(),
            children: [new Paragraph({ children: [new TextRun({ text: ' ' })], spacing: { after: 0 } })],
          }),
        ],
        height: { value: 180 },
      }),
    ],
  });
  return [band, ...blocksToDocx(blocks, t)];
}

/**
 * @param {string} htmlBody
 * @param {string} styleId
 * @returns {Promise<Buffer>}
 */
export async function renderResumeHtmlToDocxBuffer(htmlBody, styleId) {
  const id = normalizeResumeDocxStyleId(styleId);
  const blocks = parseResumeHtmlToBlocks(htmlBody);
  const t = theme(id);
  let children;
  if (t.layout === 'two_col_left_bar') children = renderTwoColumnDocx(blocks, t, false);
  else if (t.layout === 'two_col_right_bar') children = renderTwoColumnDocx(blocks, t, true);
  else if (t.layout === 'single_col_accent_top') children = renderSingleColumnWithTopAccent(blocks, t);
  else children = blocksToDocx(blocks, t);

  const doc = new Document({
    creator: 'Butler',
    title: `Résumé (${id})`,
    description: `butler-resume-docx:${id}`,
    sections: [
      {
        properties: {
          page: {
            margin: t.margin,
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
