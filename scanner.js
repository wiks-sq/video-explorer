// Functions in this file are injected into web pages with
// chrome.scripting.executeScript({ func }). Chrome serialises them with
// toString(), so each one must be fully self-contained (no outer references).

/**
 * Scan the current document (and open shadow roots) for video files.
 * Runs in every frame of the tab.
 */
export async function scanPage() {
  const EXT_RE = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|wmv|flv|3gp|3g2|mpe?g|m3u8|mpd|m4s)(?=$|[?#&;])/i;
  const GIF_RE = /\.gif(?=$|[?#&;])/i;
  const isGifUrl = (u) => !!u && (GIF_RE.test(u) || /^data:image\/gif/i.test(u));
  const srcsetUrls = (s) =>
    (s || '')
      .split(',')
      .map((p) => p.trim().split(/\s+/)[0])
      .filter(Boolean);
  const found = new Map();

  const abs = (u) => {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return null;
    }
  };
  const clean = (v) => (v == null || v === '' || Number.isNaN(v) ? null : v);

  const add = (rawUrl, source, extra = {}) => {
    if (!rawUrl) return;
    const url = abs(String(rawUrl).trim());
    if (!url || !/^(https?|blob|data):/i.test(url)) return;
    if (/^data:/i.test(url)) {
      const okVideo = /^data:video\//i.test(url);
      // Tiny inline GIFs are almost always lazy-load placeholders or spacers.
      const okGif = /^data:image\/gif/i.test(url) && url.length > 4000;
      if (!okVideo && !okGif) return;
    }
    const prev = found.get(url);
    if (prev) {
      if (!prev.sources.includes(source)) prev.sources.push(source);
      for (const [k, v] of Object.entries(extra)) if (prev[k] == null && clean(v) != null) prev[k] = v;
      return;
    }
    const item = { url, sources: [source] };
    for (const [k, v] of Object.entries(extra)) item[k] = clean(v);
    found.set(url, item);
  };

  // Collect every element, descending into open shadow roots.
  const elements = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      elements.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);

  let ogVideoType = '';
  const metas = [];
  const GIF = { kind: 'gif' };

  for (const el of elements) {
    const tag = el.tagName;

    // Inline CSS backgrounds: style="background-image:url(x.gif)"
    const style = el.getAttribute('style');
    if (style && /\.gif/i.test(style)) {
      for (const m of style.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
        if (isGifUrl(m[1])) add(m[1], 'CSS background', GIF);
      }
    }

    if (tag === 'IMG') {
      const candidates = [
        el.currentSrc,
        el.getAttribute('src'),
        el.getAttribute('data-src'),
        el.getAttribute('data-original'),
        el.getAttribute('data-gif'),
        el.getAttribute('data-lazy-src'),
        ...srcsetUrls(el.getAttribute('srcset')),
        ...srcsetUrls(el.getAttribute('data-srcset')),
      ].filter(isGifUrl);
      if (!candidates.length) continue;
      const loaded = el.complete && el.naturalWidth > 0;
      const tiny = loaded && (el.naturalWidth < 16 || el.naturalHeight < 16);
      const shown = el.currentSrc || el.src;
      for (const u of new Set(candidates)) {
        const isShown = abs(u) === shown;
        // Skip tracking pixels / spacers — but only the URL actually displayed,
        // so a lazy-load placeholder doesn't hide the real GIF in data-src.
        if (isShown && tiny) continue;
        add(u, 'Image', {
          kind: 'gif',
          width: isShown && loaded ? el.naturalWidth : null,
          height: isShown && loaded ? el.naturalHeight : null,
          title: el.alt || el.title || null,
        });
      }
    } else if (tag === 'SOURCE' && el.parentElement?.tagName === 'PICTURE') {
      const urls = srcsetUrls(el.getAttribute('srcset'));
      const gifType = /^image\/gif/i.test(el.type || '');
      for (const u of urls) if (gifType || isGifUrl(u)) add(u, 'Image', GIF);
    } else if (tag === 'VIDEO') {
      const meta = {
        poster: el.poster ? abs(el.poster) : null,
        width: el.videoWidth || null,
        height: el.videoHeight || null,
        duration: Number.isFinite(el.duration) ? el.duration : null,
        title: el.title || el.getAttribute('aria-label') || null,
      };
      const src = el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src');
      if (src) add(src, 'Video element', meta);
      for (const s of el.querySelectorAll('source')) {
        const ssrc = s.getAttribute('src') || s.getAttribute('data-src');
        if (ssrc) add(ssrc, 'Source tag', { ...meta, mime: s.type || null });
      }
    } else if (tag === 'A' || tag === 'AREA') {
      const href = el.getAttribute('href');
      if (href && (EXT_RE.test(href) || GIF_RE.test(href))) {
        add(href, 'Link', {
          title: (el.textContent || '').trim().slice(0, 140) || el.getAttribute('download') || null,
          kind: GIF_RE.test(href) && !EXT_RE.test(href) ? 'gif' : null,
        });
      }
    } else if (tag === 'EMBED' || tag === 'OBJECT') {
      const src = el.getAttribute('src') || el.getAttribute('data');
      if (src && (EXT_RE.test(src) || /^video\//i.test(el.type || ''))) add(src, 'Embed');
    } else if (tag === 'META') {
      const key = (el.getAttribute('property') || el.getAttribute('name') || '').toLowerCase();
      if (key === 'og:video:type') ogVideoType = el.getAttribute('content') || '';
      if (['og:video', 'og:video:url', 'og:video:secure_url', 'twitter:player:stream'].includes(key)) {
        metas.push(el.getAttribute('content'));
      }
      if (['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image'].includes(key)) {
        const c = el.getAttribute('content');
        if (c && GIF_RE.test(c)) add(c, 'Meta tag', GIF);
      }
    } else if (tag === 'SCRIPT' && el.type === 'application/ld+json') {
      try {
        const visit = (node) => {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) return node.forEach(visit);
          const type = [].concat(node['@type'] || []);
          if (type.includes('VideoObject') && node.contentUrl) {
            const thumb = [].concat(node.thumbnailUrl || [])[0];
            add(node.contentUrl, 'Structured data', {
              title: node.name || null,
              poster: typeof thumb === 'string' ? abs(thumb) : thumb?.url || null,
            });
          }
          Object.values(node).forEach(visit);
        };
        visit(JSON.parse(el.textContent));
      } catch {
        /* ignore malformed JSON-LD */
      }
    }
  }

  for (const content of metas) {
    if (content && (EXT_RE.test(content) || /^video\//i.test(ogVideoType))) add(content, 'Meta tag');
  }

  // Resources the page has already fetched (Resource Timing API).
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (EXT_RE.test(e.name)) {
        const seg = /\.m4s(?=$|[?#])/i.test(e.name);
        add(e.name, 'Page resources', seg ? { size: e.decodedBodySize || e.encodedBodySize || null } : {});
      }
      // GIFs: only ones we know are real images (>= 2 KB), not tracking pixels.
      else if (GIF_RE.test(e.name) && e.decodedBodySize >= 2048) {
        add(e.name, 'Page resources', { kind: 'gif', size: e.decodedBodySize });
      }
    }
  } catch {
    /* not available */
  }

  // blob: URLs — find out whether they are real files (downloadable) or
  // MediaSource streams (fetch fails), and how big they are.
  const blobChecks = [...found.values()]
    .filter((it) => it.url.startsWith('blob:'))
    .map(async (it) => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch(it.url, { signal: ctrl.signal });
        clearTimeout(timer);
        const len = Number(r.headers.get('content-length'));
        if (len > 0) it.size = len;
        it.mime = it.mime || r.headers.get('content-type') || null;
        it.blobKind = 'file';
        r.body?.cancel?.();
      } catch {
        it.blobKind = 'stream';
      }
    });
  await Promise.all(blobChecks);

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    items: [...found.values()],
  };
}

/**
 * Install a lightweight watcher in the page that tells the open popup when
 * new video-ish content appears (DOM changes, media loads, new resources).
 * It talks over a port, so it shuts itself down as soon as the popup closes.
 */
export function installWatcher() {
  if (window.__videoExplorerWatch) return 'already';
  let port;
  try {
    port = chrome.runtime.connect({ name: 'video-explorer-watch' });
  } catch {
    return 'no-runtime';
  }
  window.__videoExplorerWatch = true;

  const VIDEO_RE = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|wmv|flv|3gp|3g2|mpe?g|m3u8|mpd|m4s)(?=$|[?#&;])/i;
  const GIF_RE = /\.gif(?=$|[?#&;])/i;
  const MEDIA_SEL = 'video, source, iframe, embed, object';
  let timer = null;
  let stopped = false;

  const mediaUrl = (u) => !!u && (VIDEO_RE.test(u) || GIF_RE.test(u));
  const gifImg = (img) =>
    ['src', 'data-src', 'srcset', 'data-srcset', 'data-gif', 'data-original'].some((a) =>
      GIF_RE.test(img.getAttribute(a) || '')
    ) || GIF_RE.test(img.currentSrc || '');
  const gifStyle = (el) => /url\([^)]*\.gif/i.test(el.getAttribute('style') || '');

  const relevant = (el) => {
    if (el.nodeType !== 1) return false;
    if (el.matches(MEDIA_SEL)) return true;
    if (el.tagName === 'A') return mediaUrl(el.getAttribute('href'));
    if (el.tagName === 'IMG') return gifImg(el);
    if (gifStyle(el)) return true;
    if (!el.firstElementChild) return false;
    if (el.querySelector(MEDIA_SEL)) return true;
    for (const a of el.querySelectorAll('a[href]')) if (mediaUrl(a.getAttribute('href'))) return true;
    for (const img of el.querySelectorAll('img')) if (gifImg(img)) return true;
    for (const s of el.querySelectorAll('[style*=".gif" i]')) if (gifStyle(s)) return true;
    return false;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    mo.disconnect();
    po?.disconnect();
    document.removeEventListener('loadstart', onMedia, true);
    document.removeEventListener('loadedmetadata', onMedia, true);
    clearTimeout(timer);
    window.__videoExplorerWatch = false;
  };

  const ping = () => {
    if (timer || stopped) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        port.postMessage({ type: 'changed' });
      } catch {
        stop();
      }
    }, 400);
  };

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') {
        if (relevant(m.target)) return ping();
        continue;
      }
      for (const n of m.addedNodes) if (relevant(n)) return ping();
    }
  });
  mo.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'data-src', 'poster', 'srcset', 'style'],
  });

  // Players often swap src or finish loading metadata without DOM changes.
  const onMedia = (e) => {
    if (e.target?.tagName === 'VIDEO') ping();
  };
  document.addEventListener('loadstart', onMedia, true);
  document.addEventListener('loadedmetadata', onMedia, true);

  let po = null;
  try {
    po = new PerformanceObserver((list) => {
      if (list.getEntries().some((e) => VIDEO_RE.test(e.name) || (GIF_RE.test(e.name) && e.decodedBodySize >= 2048))) ping();
    });
    po.observe({ type: 'resource' });
  } catch {
    po = null;
  }

  port.onDisconnect.addListener(stop);
  return 'installed';
}

/** Download a page-owned blob: URL by clicking a temporary <a download>. */
export function downloadInPage(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '';
  a.style.display = 'none';
  (document.body || document.documentElement).appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
  return true;
}
