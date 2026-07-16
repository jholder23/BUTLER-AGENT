import { describe, expect, it } from 'vitest';
import { chunkTextForSpeech, stripForSpeechSynthesis } from './speechStrip';

describe('stripForSpeechSynthesis', () => {
  it('removes fenced code and inline code', () => {
    const s = stripForSpeechSynthesis('Hello ```js\nx\n``` and `tick` end');
    expect(s).toBe('Hello  and  end');
  });

  it('turns markdown links into label text', () => {
    expect(stripForSpeechSynthesis('See [docs](https://a.com/b) here')).toBe('See docs here');
  });

  it('strips bare URLs', () => {
    expect(stripForSpeechSynthesis('Go to https://x.com/y ok')).toBe('Go to  ok');
  });

  it('respects max length', () => {
    const long = 'a'.repeat(600);
    expect(stripForSpeechSynthesis(long, 100).length).toBe(100);
  });

  it('chunks long replies for voice mode', () => {
    const long = `${'Word. '.repeat(900)}Done.`;
    const chunks = chunkTextForSpeech(long, 200, 12000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('Done.');
  });
});
