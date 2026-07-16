/**
 * Hands-free listening when Web Speech API is unavailable: detects end of utterance
 * via RMS silence and POSTs PCM to /api/speech-to-text.
 */

export type VoiceModePcmLoopOptions = {
  shouldPause: () => boolean;
  onTranscript: (text: string) => void;
  signal: AbortSignal;
  /** Called when the browser denies the mic or no device is available (conversation mode cannot listen). */
  onMicAccessFailed?: (message: string) => void;
  /** Throttled callback when /api/speech-to-text fails (e.g. missing Python deps). */
  onSttFailed?: (message: string) => void;
  /** True while RMS detects an utterance (user is speaking into the mic). */
  onUtteranceActive?: (active: boolean) => void;
};

const RMS_START = 0.018;
const RMS_END = 0.012;
const SILENCE_MS = 720;
const MIN_UTTERANCE_MS = 450;
const MAX_UTTERANCE_MS = 14000;
const PREROLL_MS = 400;

function mergeInt16(chunks: Int16Array[]): Int16Array {
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Int16Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function rmsFloat(input: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
  return Math.sqrt(sum / input.length);
}

function waitUtteranceOnce(
  stream: MediaStream,
  signal: AbortSignal,
  shouldPause: () => boolean,
  onUtteranceActive?: (active: boolean) => void,
): Promise<{ pcm: ArrayBuffer; sampleRate: number } | null> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  void ctx.resume().catch(() => {});

  const sampleRate = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const gain = ctx.createGain();
  gain.gain.value = 0;

  const preroll: Int16Array[] = [];
  const prerollMax = Math.ceil((PREROLL_MS / 1000) * sampleRate / 4096) + 2;
  const body: Int16Array[] = [];
  let speaking = false;
  let speechStartTime = 0;
  let lastLoudTime = 0;
  let settled = false;

  return new Promise((resolve) => {
    const finish = (pcm: Int16Array | null) => {
      if (settled) return;
      settled = true;
      onUtteranceActive?.(false);
      try {
        processor.disconnect();
      } catch {
        /* */
      }
      try {
        src.disconnect();
      } catch {
        /* */
      }
      void ctx.close();
      if (pcm && pcm.length > 800) resolve({ pcm: pcm.buffer.slice(0), sampleRate });
      else resolve(null);
    };

    processor.onaudioprocess = (e) => {
      if (signal.aborted) {
        finish(null);
        return;
      }
      if (shouldPause()) {
        if (speaking) onUtteranceActive?.(false);
        speaking = false;
        body.length = 0;
        return;
      }

      const input = e.inputBuffer.getChannelData(0);
      const rms = rmsFloat(input);
      const chunk = floatToInt16(input);
      const now = performance.now();

      if (!speaking) {
        preroll.push(chunk);
        if (preroll.length > prerollMax) preroll.shift();
        if (rms >= RMS_START) {
          speaking = true;
          speechStartTime = now;
          lastLoudTime = now;
          body.length = 0;
          for (const p of preroll) body.push(new Int16Array(p));
          onUtteranceActive?.(true);
        }
        return;
      }

      body.push(chunk);
      if (rms >= RMS_END) lastLoudTime = now;

      const dur = now - speechStartTime;
      if (dur > MAX_UTTERANCE_MS) {
        finish(mergeInt16(body));
        return;
      }
      if (dur >= MIN_UTTERANCE_MS && now - lastLoudTime >= SILENCE_MS) {
        finish(mergeInt16(body));
      }
    };

    src.connect(processor);
    processor.connect(gain);
    gain.connect(ctx.destination);

    signal.addEventListener('abort', () => finish(null), { once: true });
  });
}

function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    const sub = u8.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

export function startVoiceModePcmAutoListen(opts: VoiceModePcmLoopOptions): () => void {
  const { shouldPause, onTranscript, signal, onMicAccessFailed, onSttFailed, onUtteranceActive } = opts;
  let cancelled = false;
  let lastSttErrorAt = 0;

  const run = async () => {
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = err && typeof err === 'object' && 'name' in err ? String((err as DOMException).name) : '';
      let msg = 'Could not open the microphone for conversation mode.';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
        msg =
          'Microphone permission denied. Open Settings → Microphone → “Allow / test microphone”, and allow desktop apps in Windows Privacy.';
      } else if (name === 'NotFoundError') {
        msg = 'No microphone was found. Plug in a mic or headset and turn voice mode off and on again.';
      }
      onMicAccessFailed?.(msg);
      return;
    }

    try {
      while (!cancelled && !signal.aborted) {
        while ((shouldPause() || cancelled) && !signal.aborted) {
          await new Promise((r) => setTimeout(r, 200));
        }
        if (signal.aborted || cancelled) break;

        const chunk = await waitUtteranceOnce(stream, signal, shouldPause, onUtteranceActive);
        if (!chunk || cancelled || signal.aborted) continue;

        const pcmU8 = new Uint8Array(chunk.pcm);
        if (pcmU8.length < 1000) continue;

        try {
          const res = await fetch('/api/speech-to-text', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pcm: uint8ToBase64(pcmU8), sampleRate: Math.round(chunk.sampleRate) }),
          });
          const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
          if (!res.ok) {
            const now = Date.now();
            if (onSttFailed && now - lastSttErrorAt > 22000) {
              lastSttErrorAt = now;
              onSttFailed(String(data?.error || `speech-to-text HTTP ${res.status}`));
            }
          } else {
            const text = String(data?.text || '').trim();
            if (text && !cancelled && !signal.aborted) onTranscript(text);
          }
        } catch {
          const now = Date.now();
          if (onSttFailed && now - lastSttErrorAt > 22000) {
            lastSttErrorAt = now;
            onSttFailed('Could not reach speech-to-text (is the Butler host running?)');
          }
        }

        await new Promise((r) => setTimeout(r, 260));
      }
    } finally {
      stream?.getTracks().forEach((t) => t.stop());
    }
  };

  void run();

  return () => {
    cancelled = true;
  };
}
