import { useCallback, useEffect, useRef, type MouseEvent } from 'react';

/** Q+W+E chord + double-click target to open the secret utility panel. */
export function useAgentSecretChord(onUnlock: () => void) {
  const chordRef = useRef({ q: false, w: false, e: false });

  useEffect(() => {
    const setKey = (code: string, down: boolean) => {
      if (code === 'KeyQ') chordRef.current.q = down;
      else if (code === 'KeyW') chordRef.current.w = down;
      else if (code === 'KeyE') chordRef.current.e = down;
    };
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      setKey(e.code, true);
    };
    const onUp = (e: KeyboardEvent) => setKey(e.code, false);
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  return useCallback(
    (e: MouseEvent) => {
      const k = chordRef.current;
      if (!k.q || !k.w || !k.e) return;
      e.preventDefault();
      onUnlock();
    },
    [onUnlock],
  );
}
