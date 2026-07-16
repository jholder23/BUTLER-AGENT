/** Strip markdown/URLs for browser TTS (voice mode). */
export function stripForSpeechSynthesis(text: string, maxLen?: number): string {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]+`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s]+/g, '')
    .trim();
  if (maxLen == null || maxLen <= 0) return clean;
  return clean.slice(0, maxLen);
}

/**
 * Split long assistant replies into TTS-sized chunks (voice mode reads the full answer, not the first 500 chars).
 */
export function chunkTextForSpeech(
  text: string,
  chunkSize = 2000,
  maxTotal = 12000,
): string[] {
  const clean = stripForSpeechSynthesis(text);
  if (!clean) return [];
  const cap = Math.max(chunkSize, Math.min(maxTotal, clean.length));
  const bounded = clean.slice(0, cap);
  if (bounded.length <= chunkSize) return [bounded];

  const chunks: string[] = [];
  let rest = bounded;
  while (rest.length > chunkSize) {
    let cut = rest.lastIndexOf('. ', chunkSize);
    if (cut < chunkSize * 0.45) cut = rest.lastIndexOf(' ', chunkSize);
    if (cut < chunkSize * 0.35) cut = chunkSize;
    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}