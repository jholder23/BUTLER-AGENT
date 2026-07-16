import { useLayoutEffect, useRef, type RefObject } from 'react';
import { ButlerAvatar3D } from './ButlerAvatar3D';

export type ButlerDockFlyPayload = {
  fromCenter: { x: number; y: number };
  fromDiameter: number;
};

type ButlerDockFlyOverlayProps = {
  session: ButlerDockFlyPayload;
  targetRef: RefObject<HTMLElement | null>;
  speaking: boolean;
  voiceActive: boolean;
  onComplete: () => void;
};

const DURATION_MS = 640;

export function ButlerDockFlyOverlay({
  session,
  targetRef,
  speaking,
  voiceActive,
  onComplete,
}: ButlerDockFlyOverlayProps) {
  const orbRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  useLayoutEffect(() => {
    doneRef.current = false;
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onCompleteRef.current();
    };

    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (prefersReduced) {
      finish();
      return;
    }

    const node = orbRef.current;
    const targetEl = targetRef.current;
    if (!node || !targetEl) {
      finish();
      return;
    }

    const tr = targetEl.getBoundingClientRect();
    const tcx = tr.left + tr.width / 2;
    const tcy = tr.top + tr.height / 2;
    const toD = tr.width;
    const { fromCenter: fc, fromDiameter: fromD } = session;

    node.style.transition = 'none';
    node.style.left = `${fc.x}px`;
    node.style.top = `${fc.y}px`;
    node.style.width = `${fromD}px`;
    node.style.height = `${fromD}px`;
    void node.offsetWidth;

    let raf0 = 0;
    let raf1 = 0;
    let tid: ReturnType<typeof setTimeout> | undefined;

    raf0 = requestAnimationFrame(() => {
      raf1 = requestAnimationFrame(() => {
        node.style.transition = `left ${DURATION_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1), top ${DURATION_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1), width ${DURATION_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1), height ${DURATION_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1), box-shadow ${DURATION_MS}ms ease, opacity ${DURATION_MS}ms ease`;
        node.style.left = `${tcx}px`;
        node.style.top = `${tcy}px`;
        node.style.width = `${toD}px`;
        node.style.height = `${toD}px`;
        tid = setTimeout(finish, DURATION_MS + 80);
      });
    });

    return () => {
      cancelAnimationFrame(raf0);
      cancelAnimationFrame(raf1);
      if (tid !== undefined) clearTimeout(tid);
    };
  }, [session, targetRef]);

  return (
    <div className="butler-dock-fly-layer" aria-hidden>
      <div ref={orbRef} className="butler-dock-fly-orb">
        <ButlerAvatar3D speaking={speaking} voiceActive={voiceActive} layout="float" />
      </div>
    </div>
  );
}
