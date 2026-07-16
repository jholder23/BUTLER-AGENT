import React, { useMemo, useState } from 'react';
import {
  readStoredResumePdfStyle,
  RESUME_STYLE_OPTIONS,
  type ResumePdfStyleId,
  writeStoredResumePdfStyle,
} from '../lib/resumePdfStyles';

type Props = {
  open: boolean;
  onClose: () => void;
  onExport: (styleId: ResumePdfStyleId) => void | Promise<void>;
  resumeHtml: string;
};

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function analyzeResumeHtmlForIndicators(html: string) {
  const raw = html || '';
  if (!raw.trim()) {
    return {
      hasHtml: false,
      h1Count: 0,
      firstH1: null as string | null,
      h2Count: 0,
      pageBreakMarkerCount: 0,
      markerHint: null as string | null,
      firstH1Index: null as number | null,
      h2Names: [] as string[],
    };
  }

  // DOMParser handles Quill-ish fragments well enough for preflight indicators.
  const doc = new DOMParser().parseFromString(`<div>${raw}</div>`, 'text/html');
  const h1Els = Array.from(doc.querySelectorAll('h1'));
  const h2Els = Array.from(doc.querySelectorAll('h2'));

  // Page-break markers we honor:
  // - <hr data-pagebreak="1" />
  // - any element with data-pagebreak="1"
  // - .page-break / .pagebreak classes
  // - style="page-break-after: always"
  const allEls = Array.from(doc.querySelectorAll('*'));
  let pageBreakMarkerCount = 0;
  let firstMarkerText: string | null = null;
  for (const el of allEls) {
    const tag = el.tagName?.toLowerCase();
    const data = el.getAttribute('data-pagebreak');
    const cls = (el.getAttribute('class') || '').toLowerCase();
    const style = (el.getAttribute('style') || '').toLowerCase();
    const isMarker =
      (data && data !== '0' && data.toLowerCase() !== 'false' && data.toLowerCase() !== 'no' && data.toLowerCase() !== '') ||
      cls.includes('page-break') ||
      cls.includes('pagebreak') ||
      (style.includes('page-break-after') && style.includes('always'));

    if (isMarker) {
      pageBreakMarkerCount++;
      if (!firstMarkerText) {
        const t = stripTags(el.outerHTML);
        firstMarkerText = t.slice(0, 80);
      }
    }
  }

  const firstH1 = h1Els.length ? stripTags(h1Els[0].textContent || '') : null;

  // "Where should H1 be?" -> we treat it as the first heading in document order.
  const headingEls = Array.from(doc.body.querySelectorAll('h1, h2, h3')).filter((el) => (el as HTMLElement).textContent?.trim());
  const firstH1Index = h1Els.length ? Math.max(0, headingEls.findIndex((el) => el.tagName.toLowerCase() === 'h1')) : null;
  const h2Names = h2Els
    .map((el) => stripTags(el.textContent || ''))
    .filter(Boolean)
    .slice(0, 5);

  return {
    hasHtml: true,
    h1Count: h1Els.length,
    firstH1,
    h2Count: h2Els.length,
    h2Names,
    pageBreakMarkerCount,
    markerHint:
      pageBreakMarkerCount > 0
        ? `Found ${pageBreakMarkerCount} explicit page-break marker(s).`
        : 'No explicit page-break markers found; page breaks will be automatic when content overflows.',
    firstH1Index: typeof firstH1Index === 'number' && firstH1Index >= 0 ? firstH1Index : null,
    markerSnippet: firstMarkerText,
  };
}

export function ResumePdfStyleModal({ open, onClose, onExport, resumeHtml }: Props) {
  // Lazy init reads storage on each mount. Do not sync in useEffect — it runs after paint and can
  // overwrite a fast click with the stored style, so every export looked identical.
  const [selected, setSelected] = useState<ResumePdfStyleId>(() => readStoredResumePdfStyle());
  const indicators = useMemo(() => analyzeResumeHtmlForIndicators(resumeHtml), [resumeHtml]);

  if (!open) return null;

  const handleExport = async () => {
    writeStoredResumePdfStyle(selected);
    try {
      await Promise.resolve(onExport(selected));
      onClose();
    } catch {
      /* parent may alert; keep modal open */
    }
  };

  return (
    <div
      className="settings-modal-backdrop resume-pdf-style-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="settings-modal settings-modal--wide resume-pdf-style-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-pdf-style-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal-header">
          <h2 id="resume-pdf-style-title" className="settings-modal-title">
            Export résumé (Word)
          </h2>
          <button type="button" className="settings-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="settings-modal-body">
          <p className="resume-pdf-style-intro">
            Pick a template — you get a formatted .docx. Open in Microsoft Word (or similar), then print to PDF if needed. H1/H2
            become headings.
          </p>

          <div
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
              background: 'rgba(255,255,255,0.75)',
            }}
          >
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Export indicators</div>
            <div style={{ fontSize: '0.9em', opacity: 0.9, lineHeight: 1.35 }}>
              <div>
                <strong>H1 (name/title)</strong>: {indicators.h1Count > 0 ? `${indicators.h1Count} found` : 'missing'}{' '}
                {indicators.firstH1 ? (
                  <>
                    — first: <code>{indicators.firstH1.slice(0, 60)}</code>
                  </>
                ) : null}
                  {indicators.h1Count > 0 && indicators.firstH1Index !== null && indicators.firstH1Index > 0 ? (
                    <>
                      <div style={{ marginTop: 4, color: '#b45309', fontWeight: 700 }}>
                        Tip: your first heading is not H1. Put your name in the first <code>{'<h1>'}</code> near the top.
                      </div>
                    </>
                  ) : null}
              </div>
              <div>
                <strong>H2 (sections)</strong>: {indicators.h2Count} found{' '}
                {indicators.h2Names.length ? (
                  <>
                    — first: <code>{indicators.h2Names[0]}</code>
                  </>
                ) : null}
              </div>
              <div style={{ marginTop: 6 }}>
                <strong>Page breaks</strong>: {indicators.pageBreakMarkerCount > 0 ? `${indicators.pageBreakMarkerCount} marker(s)` : 'automatic'}.
              </div>
              <div style={{ marginTop: 6 }}>{indicators.markerHint}</div>
              <div style={{ marginTop: 8, fontSize: '0.85em', opacity: 0.85 }}>
                To force a new page, insert: <code>&lt;hr data-pagebreak=&quot;1&quot; /&gt;</code> (or set{" "}
                <code>style=&quot;page-break-after: always&quot;</code> / <code>class=&quot;page-break&quot;</code>).
              </div>
            </div>
          </div>

          <div className="resume-pdf-style-grid">
            {RESUME_STYLE_OPTIONS.map((opt) => {
              const isSel = selected === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`resume-pdf-style-card${isSel ? ' resume-pdf-style-card--selected' : ''}`}
                  onClick={() => setSelected(opt.id)}
                >
                  <div
                    className="resume-pdf-style-card-preview"
                    style={{
                      background: opt.preview.bg,
                      borderColor: isSel ? opt.preview.accent : '#e2e8f0',
                    }}
                  >
                    <div className="resume-pdf-style-card-bar" style={{ background: opt.preview.bar }} />
                    <div className="resume-pdf-style-lines">
                      <span style={{ color: opt.preview.accent, fontWeight: 700 }}>Name</span>
                      <span style={{ color: opt.preview.text, opacity: 0.85 }}>Section</span>
                      <span style={{ color: opt.preview.text, opacity: 0.6 }}>Body line…</span>
                    </div>
                  </div>
                  <span className="resume-pdf-style-card-name">{opt.name}</span>
                  <span className="resume-pdf-style-card-blurb">{opt.blurb}</span>
                </button>
              );
            })}
          </div>
          <div className="resume-pdf-style-actions">
            <button type="button" className="butler-btn butler-btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="butler-btn" onClick={() => void handleExport()}>
              Export Word
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
