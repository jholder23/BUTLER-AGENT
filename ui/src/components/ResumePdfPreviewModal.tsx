import React from 'react';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Object URL for the PDF blob */
  pdfUrl: string;
  filename: string;
};

export function ResumePdfPreviewModal({ open, onClose, pdfUrl, filename }: Props) {
  if (!open) return null;

  return (
    <div
      className="settings-modal-backdrop resume-pdf-preview-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <div
        className="settings-modal settings-modal--wide resume-pdf-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-pdf-preview-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal-header">
          <h2 id="resume-pdf-preview-title" className="settings-modal-title">
            PDF preview
          </h2>
          <button type="button" className="settings-modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="resume-pdf-preview-body">
          <iframe
            title={`Preview of ${filename}`}
            src={`${pdfUrl}#view=FitH`}
            className="resume-pdf-preview-iframe"
          />
        </div>
        <div className="resume-pdf-preview-footer">
          <button type="button" className="butler-btn butler-btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
