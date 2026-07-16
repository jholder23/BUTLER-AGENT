export function uint8ToBase64(u8: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK) {
    const sub = u8.subarray(i, i + CHUNK);
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

export async function startPcmRecording(stream: MediaStream): Promise<{
  stop: () => Promise<{ pcm: ArrayBuffer; sampleRate: number }>;
}> {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    await ctx.resume();
  } catch {
    /* still try recording */
  }
  const sampleRate = ctx.sampleRate;
  const src = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Int16Array[] = [];
  const gain = ctx.createGain();
  gain.gain.value = 0;

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    chunks.push(out);
  };

  src.connect(processor);
  processor.connect(gain);
  gain.connect(ctx.destination);

  return {
    stop: () =>
      new Promise((resolve) => {
        processor.disconnect();
        src.disconnect();
        void ctx.close();

        const totalLen = chunks.reduce((a, c) => a + c.length, 0);
        const merged = new Int16Array(totalLen);
        let offset = 0;
        for (const c of chunks) {
          merged.set(c, offset);
          offset += c.length;
        }

        resolve({ pcm: merged.buffer, sampleRate });
      }),
  };
}

export async function transcribePcmViaButler(pcm: ArrayBuffer, sampleRate: number): Promise<string> {
  const pcmU8 = new Uint8Array(pcm);
  if (pcmU8.length < 500) {
    throw new Error('Recording too short. Speak for at least a second.');
  }
  const res = await fetch('/api/speech-to-text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pcm: uint8ToBase64(pcmU8), sampleRate: Math.round(sampleRate) }),
  });
  const data = await res.json().catch(() => ({}));
  const text = String(data?.text || '').trim();
  if (text) return text;
  const errMsg =
    data?.error ||
    (res.ok
      ? 'Could not understand audio. Speak clearly and try again. (Speech-to-text needs internet.)'
      : 'Speech recognition failed.');
  throw new Error(String(errMsg));
}
