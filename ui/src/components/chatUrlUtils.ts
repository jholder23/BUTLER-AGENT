/** Shared URL parsing for chat bubbles + media embeds. */

const URL_RE = /https?:\/\/[^\s\])>'"<]+/gi;

function pushUrlDedupe(out: string[], seen: Set<string>, cand: string) {
  let u = cand.trim().replace(/[),.;:]+$/g, '');
  if (u.length < 12) return;
  if (seen.has(u)) return;
  seen.add(u);
  out.push(u);
}

/** Collect http(s) links: bare URLs, markdown [text](url), and angle brackets <url>. */
export function extractUrls(text: string): string[] {
  const raw = String(text || '');
  const out: string[] = [];
  const seen = new Set<string>();

  const re = new RegExp(URL_RE.source, URL_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    pushUrlDedupe(out, seen, m[0]);
  }

  const md = /\]\((https?:\/\/[^)\s<>"']+)/gi;
  while ((m = md.exec(raw))) {
    pushUrlDedupe(out, seen, m[1]);
  }

  const angled = /<(https?:\/\/[^>\s]+)>/gi;
  while ((m = angled.exec(raw))) {
    pushUrlDedupe(out, seen, m[1]);
  }

  return out;
}

export function isSafeHttpUrl(u: string): boolean {
  try {
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return false;
    if (x.protocol === 'http:') {
      const h = x.hostname.toLowerCase();
      if (h !== 'localhost' && h !== '127.0.0.1') return false;
    }
    return true;
  } catch {
    return false;
  }
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i;
const VID_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i;

/**
 * Turns known third-party **watch/listing pages** into stable https **iframe embed** URLs.
 * Only hosts/patterns Butler understands are emitted — never blindly iframes arbitrary pages.
 */
export function watchPageToIframeEmbedSrc(pageUrl: string): string | null {
  if (!isSafeHttpUrl(pageUrl)) return null;
  let u: URL;
  try {
    u = new URL(pageUrl.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const hostRaw = u.hostname.replace(/^www\./i, '').toLowerCase();

  const isHost = (...names: string[]) => names.some((n) => hostRaw === n || hostRaw.endsWith(`.${n}`));

  // Already pointing at an iframe player we're willing to wrap
  if (
    hostRaw === 'embed.redtube.com' ||
    /\b\/embed\b/i.test(u.pathname) ||
    u.pathname.includes('embedframe') ||
    /^player\.vimeo\.com$/i.test(u.hostname)
  ) {
    if (
      isHost(
        'pornhub.com',
        'xvideos.com',
        'xhamster.com',
        'xh.video',
        'redtube.com',
        'spankbang.com',
        'youporn.com',
        'dailymotion.com',
        'dai.ly',
      ) ||
      hostRaw === 'embed.redtube.com' ||
      /^player\.vimeo\.com$/i.test(u.hostname)
    ) {
      const out = new URL(pageUrl.trim());
      if (out.protocol === 'http:') out.protocol = 'https:';
      return out.toString();
    }
  }

  const path = u.pathname.replace(/\/+$/, '') || '/';

  /* Vimeo landing pages → official player iframe */
  if (isHost('vimeo.com')) {
    const m = path.match(/^\/(?:video\/)?(\d+)\/?$/);
    if (m?.[1]) return `https://player.vimeo.com/video/${m[1]}`;
    const ch = path.match(/^\/channels\/[^/]+\/(\d+)/);
    if (ch?.[1]) return `https://player.vimeo.com/video/${ch[1]}`;
    const one = path.match(/^\/([^/]+)\/?$/);
    if (one?.[1] && /^\d+$/.test(one[1])) return `https://player.vimeo.com/video/${one[1]}`;
    return null;
  }

  /* Dailymotion */
  if (isHost('dai.ly')) {
    const id = path.replace(/^\//, '').split('/')[0];
    if (id && /^[a-z0-9]+$/i.test(id)) return `https://www.dailymotion.com/embed/video/${id}`;
    return null;
  }
  if (isHost('dailymotion.com')) {
    const m = path.match(/\/video\/([a-z0-9]+)/i);
    if (m?.[1]) return `https://www.dailymotion.com/embed/video/${m[1]}`;
    return null;
  }

  /* Pornhub / network-style view keys */
  if (isHost('pornhub.com')) {
    const vk = u.searchParams.get('viewkey');
    if (vk && /^[a-zA-Z0-9]+$/i.test(vk) && vk.length <= 64) return `https://www.pornhub.com/embed/${vk}`;
    const slug = path.match(/^\/video\/([a-zA-Z0-9]+)/i);
    if (slug?.[1]) return `https://www.pornhub.com/embed/${slug[1]}`;
    return null;
  }

  if (isHost('youporn.com')) {
    const m = path.match(/^\/(?:watch|embed)\/([a-zA-Z0-9]+)/i);
    if (m?.[1]) return `https://www.youporn.com/embed/${m[1]}`;
    return null;
  }

  /* xHamster numeric id suffix or /movie/id */
  if (isHost('xhamster.com', 'xh.video')) {
    const trail = path.match(/-(\d{5,})\/?$/);
    const mid = path.match(/^\/movie\/(\d{4,})\/?$/i);
    const id = trail?.[1] || mid?.[1];
    if (id) return `https://xhamster.com/embed/${id}`;
    const emb = path.match(/^\/embed\/(\d+)/i);
    if (emb?.[1]) return `https://xhamster.com/embed/${emb[1]}`;
    return null;
  }

  /* xVideos numeric id inside /video{num}/ */
  if (isHost('xvideos.com')) {
    const m = path.match(/\/video(\d+)/i);
    if (m?.[1]) return `https://www.xvideos.com/embedframe/${m[1]}`;
    return null;
  }

  /* RedTube numeric-only path segments */
  if (isHost('redtube.com')) {
    const m = path.match(/^\/(\d{4,})\/?$/);
    if (m?.[1]) return `https://embed.redtube.com/?id=${encodeURIComponent(m[1])}`;
    return null;
  }

  /* SpankBang /{id}/video/… */
  if (isHost('spankbang.com')) {
    const m = path.match(/^\/([0-9a-z]+)\/(?:video(?:s)?|[\w%-]+)/i);
    if (m?.[1]) return `https://spankbang.com/embed/${encodeURIComponent(m[1])}`;
    return null;
  }

  return null;
}

export function youtubeEmbedUrl(pageUrl: string): string | null {
  try {
    const u = new URL(pageUrl);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    let id: string | null = null;
    if (host === 'youtu.be') {
      id = u.pathname.replace(/^\//, '').slice(0, 32);
    } else if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (u.pathname.startsWith('/embed/')) {
        id = u.pathname.slice('/embed/'.length).split('/')[0] || null;
      } else if (u.pathname.startsWith('/shorts/')) {
        id = u.pathname.slice('/shorts/'.length).split('/')[0] || null;
      } else {
        id = u.searchParams.get('v');
      }
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    return `https://www.youtube-nocookie.com/embed/${id}`;
  } catch {
    return null;
  }
}

export function isPlayableVideoUrl(u: string): boolean {
  if (!isSafeHttpUrl(u)) return false;
  return !!(youtubeEmbedUrl(u) || watchPageToIframeEmbedSrc(u) || VID_EXT.test(u));
}

/**
 * If the message is essentially one video URL (short framing text), return that URL for deferred in-thread play.
 */
export function getSingleStandaloneVideoUrl(text: string): string | null {
  const t = String(text || '').trim();
  if (!t) return null;
  const urls = extractUrls(t);
  if (urls.length !== 1) return null;
  const u = urls[0];
  if (!isPlayableVideoUrl(u)) return null;
  const stripped = t
    .replace(urls[0], '')
    .replace(/^\s*(here|this|link|watch|video|url)?\s*[:.,\-—]*\s*/i, '')
    .replace(/\s*[:.,\-—]*\s*(above|below|here)?\s*$/i, '')
    .trim();
  if (stripped.length > 140) return null;
  return u;
}
