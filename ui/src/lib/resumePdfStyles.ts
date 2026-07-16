/**
 * Word (.docx) export styles — repo-root `resume-docx-presets.json`.
 * Layout is built in `resumeDocxKit.mjs` (docx library).
 */
import presets from '@resume-docx-presets';

type StyleRow = (typeof presets.styles)[number];
export type ResumePdfStyleId = StyleRow['id'];

export const RESUME_PDF_STYLE_IDS = presets.styles.map((s) => s.id) as readonly ResumePdfStyleId[];

export const DEFAULT_RESUME_PDF_STYLE: ResumePdfStyleId =
  (presets.defaultStyleId as ResumePdfStyleId) ?? RESUME_PDF_STYLE_IDS[0];

const STORAGE_KEY = 'butler.resumeDocxStyleId';

/** Older PDF-only ids → Word template */
const LEGACY_ID_MAP: Record<string, ResumePdfStyleId> = {
  standard: 'harvard',
  accent: 'modern',
  classic: 'harvard',
  modern: 'modern',
  executive: 'executive',
  minimal: 'ats',
  technical: 'corporate',
};

export function readStoredResumePdfStyle(): ResumePdfStyleId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (!v) return DEFAULT_RESUME_PDF_STYLE;
    if (RESUME_PDF_STYLE_IDS.includes(v as ResumePdfStyleId)) return v as ResumePdfStyleId;
    const migrated = LEGACY_ID_MAP[v];
    if (migrated) return migrated;
  } catch {
    /* ignore */
  }
  return DEFAULT_RESUME_PDF_STYLE;
}

export function writeStoredResumePdfStyle(id: ResumePdfStyleId) {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}

export const RESUME_STYLE_OPTIONS: Array<{
  id: ResumePdfStyleId;
  name: string;
  blurb: string;
  preview: { bg: string; accent: string; text: string; bar: string };
}> = presets.styles.map((s) => ({
  id: s.id as ResumePdfStyleId,
  name: s.name,
  blurb: s.blurb,
  preview: s.preview,
}));
