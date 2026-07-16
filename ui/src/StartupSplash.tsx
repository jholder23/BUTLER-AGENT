import React, { useCallback, useEffect, useRef, useState } from 'react';

type Props = { onComplete: () => void };

/**
 * Full-screen boot sequence: aurora mesh, glass mark, progress — then crossfade into the app.
 * Rendered in-tree (not createPortal to document.body) so React 18 unmount matches the DOM
 * and avoids removeChild errors with Strict Mode / concurrent features.
 */
export function StartupSplash({ onComplete }: Props) {
  const [exiting, setExiting] = useState(false);
  const doneRef = useRef(false);

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    onComplete();
  }, [onComplete]);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const holdMs = reduced ? 320 : 2200;
    const exitAnimMs = reduced ? 120 : 520;
    const t1 = window.setTimeout(() => setExiting(true), holdMs);
    const t2 = window.setTimeout(() => finish(), holdMs + exitAnimMs);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [finish]);

  return (
    <div
      className={`startup-splash ${exiting ? 'startup-splash--exit' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Loading Butler"
    >
      <div className="startup-splash__mesh" aria-hidden />
      <div className="startup-splash__orb startup-splash__orb--1" aria-hidden />
      <div className="startup-splash__orb startup-splash__orb--2" aria-hidden />
      <div className="startup-splash__orb startup-splash__orb--3" aria-hidden />
      <div className="startup-splash__grid" aria-hidden />

      <div className="startup-splash__content">
        <div className="startup-splash__mark">
          <div className="startup-splash__ring" aria-hidden />
          <div className="startup-splash__ring startup-splash__ring--delay" aria-hidden />
          <div className="startup-splash__icon-wrap">
            <img src="./icon.png" alt="" width={72} height={72} className="startup-splash__icon" />
          </div>
        </div>
        <h1 className="startup-splash__title">Butler</h1>
        <p className="startup-splash__tagline">Private concierge</p>
        <div className="startup-splash__progress" aria-hidden>
          <div className="startup-splash__progress-bar" />
        </div>
      </div>
    </div>
  );
}
