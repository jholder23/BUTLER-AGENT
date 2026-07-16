import React, { useEffect, useMemo, useState } from 'react';
import {
  extractUrls,
  getSingleStandaloneVideoUrl,
  isPlayableVideoUrl,
  isSafeHttpUrl,
  watchPageToIframeEmbedSrc,
  youtubeEmbedUrl,
} from './chatUrlUtils';

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i;
const VID_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i;

/**
 * Renders inline previews for direct image/video URLs, YouTube, and other known embeddable watch pages.
 * If the message is essentially a single video URL, shows "Play in thread" instead of auto-loading the player.
 */
export function ChatMediaEmbeds({ text }: { text: string }) {
  const [playSingleInThread, setPlaySingleInThread] = useState(false);
  const singleVideo = useMemo(() => getSingleStandaloneVideoUrl(text), [text]);

  useEffect(() => {
    try {
      if (typeof window === 'undefined' || window.localStorage.getItem('BUTLER_VERBOSE_MEDIA_EMBEDS') !== '1') return;
      const urls = extractUrls(text || '');
      // eslint-disable-next-line no-console
      console.debug('[ChatMediaEmbeds]', { urlCount: urls.length, snippets: urls.slice(0, 6), plainLen: String(text || '').length });
    } catch {
      /* ignore */
    }
  }, [text]);

  const blocks = useMemo(() => {
    const urls = extractUrls(text);
    const items: React.ReactNode[] = [];
    const used = new Set<string>();

    if (singleVideo && !playSingleInThread) {
      return items;
    }

    for (const u of urls) {
      if (!isSafeHttpUrl(u)) continue;
      if (singleVideo && playSingleInThread && u !== singleVideo) {
        continue;
      }
      const yt = youtubeEmbedUrl(u);
      const iframeSrc = yt || watchPageToIframeEmbedSrc(u);
      if (iframeSrc && !used.has('iframe:' + iframeSrc)) {
        used.add('iframe:' + iframeSrc);
        const frameClass = yt ? 'chat-embedded-media--youtube' : 'chat-embedded-media--iframe';
        items.push(
          <div key={u} className={`chat-embedded-media ${frameClass}`}>
            <iframe
              src={iframeSrc}
              title="Embedded video"
              className="chat-embedded-youtube"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              referrerPolicy="no-referrer"
            />
          </div>,
        );
        continue;
      }
      if (IMG_EXT.test(u) && !used.has(u)) {
        used.add(u);
        items.push(
          <figure key={u} className="chat-image-figure chat-embedded-figure">
            <img src={u} alt="" className="chat-generated-image" loading="lazy" referrerPolicy="no-referrer" />
          </figure>,
        );
        continue;
      }
      if (VID_EXT.test(u) && !used.has(u)) {
        used.add(u);
        items.push(
          <video key={u} className="chat-generated-video" controls playsInline preload="metadata" src={u}>
            Video
          </video>,
        );
      }
    }
    return items;
  }, [text, singleVideo, playSingleInThread]);

  const showPlayPrompt = singleVideo && !playSingleInThread && isPlayableVideoUrl(singleVideo);

  return (
    <>
      {showPlayPrompt ? (
        <div className="chat-single-video-prompt">
          <button
            type="button"
            className="chat-single-video-play-btn"
            onClick={() => setPlaySingleInThread(true)}
          >
            Play in thread
          </button>
          <span className="chat-single-video-prompt-hint">Loads the player here (same tab).</span>
        </div>
      ) : null}
      {blocks.length ? <div className="chat-embedded-media-wrap">{blocks}</div> : null}
    </>
  );
}
