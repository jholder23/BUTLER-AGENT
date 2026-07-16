import { describe, expect, it } from 'vitest';

import {
  isPlayableVideoUrl,
  watchPageToIframeEmbedSrc,
  youtubeEmbedUrl,
} from './chatUrlUtils';

describe('watchPageToIframeEmbedSrc', () => {
  it('maps xvideos listing paths to embedframe', () => {
    expect(watchPageToIframeEmbedSrc('https://www.xvideos.com/video12345/foo-bar')).toBe(
      'https://www.xvideos.com/embedframe/12345',
    );
  });

  it('maps pornhub viewkey URLs to embed', () => {
    expect(watchPageToIframeEmbedSrc('https://www.pornhub.com/view_video.php?viewkey=abcdefghijklmnopqrst')).toBe(
      'https://www.pornhub.com/embed/abcdefghijklmnopqrst',
    );
  });

  it('passthrough xvideos embedframe URLs when already embed', () => {
    expect(watchPageToIframeEmbedSrc('https://www.xvideos.com/embedframe/999')).toContain('xvideos.com');
    expect(watchPageToIframeEmbedSrc('https://www.xvideos.com/embedframe/999')).toContain('embedframe');
  });

  it('does not iframe arbitrary HTTPS pages', () => {
    expect(watchPageToIframeEmbedSrc('https://example.com/watch/anything')).toBeNull();
    expect(isPlayableVideoUrl('https://example.com/page')).toBe(false);
    expect(isPlayableVideoUrl('http://evil.com/mp4/not-really')).toBe(false);
  });

  it('youtube still uses nocookie iframe', () => {
    expect(youtubeEmbedUrl('https://www.youtube.com/watch?v=aaaaaaaaaaa')).toContain('youtube-nocookie.com/embed/aaaaaaaaaaa');
    expect(isPlayableVideoUrl('https://youtu.be/aaaaaaaaaaa')).toBe(true);
  });
});
