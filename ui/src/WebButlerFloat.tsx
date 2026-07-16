import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ButlerAvatar3D } from './ButlerAvatar3D';
import type { ButlerDockFlyPayload } from './ButlerDockFlyOverlay';

const POS_KEY = 'butler-web-float-pos';
const BOX = 288;
const EXTRA_H = 34;

export type WebButlerFloatHandle = {
  getDockFlyMetrics: () => ButlerDockFlyPayload | null;
};

type WebButlerFloatProps = {
  speaking: boolean;
  voiceActive: boolean;
  onRequestDock: (fly?: ButlerDockFlyPayload) => void;
  userSpeaking?: boolean;
  heardPreview?: string | null;
  voicePaused?: boolean;
  micMuted?: boolean;
  onMicMutedChange?: (muted: boolean) => void;
};

function loadPos(): { left: number; top: number } | null {
  try {
    const s = sessionStorage.getItem(POS_KEY);
    if (s) {
      const p = JSON.parse(s) as { left?: number; top?: number };
      if (typeof p.left === 'number' && typeof p.top === 'number') return { left: p.left, top: p.top };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function defaultPos() {
  const margin = 16;
  const estH = BOX + EXTRA_H;
  return {
    left: Math.max(margin, window.innerWidth - BOX - margin),
    top: Math.max(margin, window.innerHeight - estH - margin),
  };
}

function metricsFromSphere(el: HTMLDivElement | null): ButlerDockFlyPayload | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  return {
    fromCenter: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    fromDiameter: r.width,
  };
}

export const WebButlerFloat = forwardRef<WebButlerFloatHandle, WebButlerFloatProps>(function WebButlerFloat(
  {
    speaking,
    voiceActive,
    onRequestDock,
    userSpeaking = false,
    heardPreview = null,
    voicePaused = false,
    micMuted = false,
    onMicMutedChange,
  },
  ref,
) {
  const shellRef = useRef<HTMLDivElement>(null);
  const sphereRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ ox: number; oy: number } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>(() => {
    if (typeof window === 'undefined') return { left: 24, top: 80 };
    const p = loadPos();
    return p ?? defaultPos();
  });

  useImperativeHandle(
    ref,
    () => ({
      getDockFlyMetrics: () => metricsFromSphere(sphereRef.current),
    }),
    [],
  );

  const savePos = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    try {
      sessionStorage.setItem(POS_KEY, JSON.stringify({ left: r.left, top: r.top }));
    } catch {
      /* ignore */
    }
  }, []);

  const clamp = useCallback((left: number, top: number) => {
    const el = shellRef.current;
    const w = el?.offsetWidth ?? BOX;
    const h = el?.offsetHeight ?? BOX + EXTRA_H;
    const margin = 8;
    return {
      left: Math.max(margin, Math.min(left, window.innerWidth - w - margin)),
      top: Math.max(margin, Math.min(top, window.innerHeight - h - margin)),
    };
  }, []);

  const onDragStart = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const el = shellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { ox: e.clientX - r.left, oy: e.clientY - r.top };
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos(clamp(e.clientX - d.ox, e.clientY - d.oy));
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      savePos();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [clamp, savePos]);

  useEffect(() => {
    const onResize = () => setPos((p) => clamp(p.left, p.top));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [clamp]);

  const onDockClick = () => {
    const fly = metricsFromSphere(sphereRef.current);
    if (fly) onRequestDock(fly);
    else onRequestDock();
  };

  const capClass =
    micMuted ? 'web-butler-float-caption--paused'
    : voicePaused ? 'web-butler-float-caption--paused'
    : heardPreview ? 'web-butler-float-caption--heard'
    : userSpeaking ? 'web-butler-float-caption--speaking'
    : 'web-butler-float-caption--idle';

  const capText = micMuted
    ? 'Mic muted — tap mic to speak'
    : voicePaused
      ? 'Paused…'
      : heardPreview
        ? `Heard: “${heardPreview.length > 40 ? `${heardPreview.slice(0, 40)}…` : heardPreview}”`
        : userSpeaking
          ? 'Hearing you…'
          : 'Listening…';

  return (
    <div
      ref={shellRef}
      className="web-butler-float"
      style={{ left: pos.left, top: pos.top, width: BOX }}
      role="group"
      aria-label="Floating Butler — drag the sphere to move"
    >
      <button type="button" className="web-butler-float-dock" onClick={onDockClick} aria-label="Dock Butler to header">
        ×
      </button>
      {onMicMutedChange ? (
        <button
          type="button"
          className="web-butler-float-mic"
          onClick={(e) => {
            e.stopPropagation();
            onMicMutedChange(!micMuted);
          }}
          aria-pressed={micMuted}
          aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
          title={micMuted ? 'Unmute mic' : 'Mute mic'}
        >
          {micMuted ? '🔇' : '🎤'}
        </button>
      ) : null}
      <div ref={sphereRef} className="web-butler-float-sphere" onMouseDown={onDragStart}>
        <ButlerAvatar3D speaking={speaking} voiceActive={voiceActive} layout="float" />
      </div>
      <div className={`web-butler-float-caption ${capClass}`} aria-live="polite">
        {capText}
      </div>
    </div>
  );
});
