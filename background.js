// Background service worker: watches network traffic per tab and remembers
// every response that looks like a video or GIF (including ones loaded by
// players via XHR/fetch that never appear as a plain URL in the page's HTML).

const VIDEO_EXT = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|wmv|flv|3gp|3g2|mpe?g|m3u8|mpd)$/i;
// DASH segments (.m4s): listed, whatever content type they're served with
// (video/mp4, video/iso.segment, audio/mp4, application/octet-stream...).
const SEGMENT_EXT = /\.m4s$/i;
// HLS segments, audio and subtitles: skipped.
const SKIP_EXT = /\.(ts|m4a|aac|mp3|oga|opus|wav|flac|vtt|srt)$/i;
const VIDEO_MIME = /^(video\/(?!mp2t)|application\/(x-mpegurl|vnd\.apple\.mpegurl|dash\+xml))/i;
// Query params that only describe which byte range was requested (e.g. YouTube).
const RANGE_PARAMS = ['range', 'rn', 'rbuf'];
const GIF_EXT = /\.gif$/i;
const MIN_GIF_BYTES = 2048;
const MAX_PER_TAB = 400; // full videos and GIFs
const MAX_SEGMENTS_PER_TAB = 400; // .m4s pieces get their own budget so they can't crowd out videos

/** tabId -> Map(url -> item) */
const tabs = new Map();
const saveTimers = new Map();

const ready = chrome.storage.session
  .get(null)
  .then((all) => {
    for (const [key, list] of Object.entries(all)) {
      if (!key.startsWith('tab_') || !Array.isArray(list)) continue;
      tabs.set(Number(key.slice(4)), new Map(list.map((it) => [it.url, it])));
    }
  })
  .catch(() => {});

function scheduleSave(tabId) {
  clearTimeout(saveTimers.get(tabId));
  saveTimers.set(
    tabId,
    setTimeout(() => {
      saveTimers.delete(tabId);
      const map = tabs.get(tabId);
      const key = `tab_${tabId}`;
      if (map && map.size) chrome.storage.session.set({ [key]: [...map.values()] }).catch(() => {});
      else chrome.storage.session.remove(key).catch(() => {});
    }, 400)
  );
}

function clearTab(tabId) {
  tabs.delete(tabId);
  scheduleSave(tabId);
}

function header(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

function normaliseUrl(raw) {
  try {
    const u = new URL(raw);
    for (const p of RANGE_PARAMS) u.searchParams.delete(p);
    u.hash = '';
    return u;
  } catch {
    return null;
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || details.statusCode >= 400) return;
    const u = normaliseUrl(details.url);
    if (!u || !/^https?:$/.test(u.protocol)) return;
    const path = u.pathname;
    if (SKIP_EXT.test(path)) return;

    const ct = header(details.responseHeaders, 'content-type').split(';')[0].trim();

    // GIFs: served as image/gif (a ".gif" URL with a different type is usually
    // a CDN handing back WebP/MP4 instead).
    const isGif = /^image\/gif$/i.test(ct) || (!ct && GIF_EXT.test(path));
    const isSegment = SEGMENT_EXT.test(path);

    if (!isGif && !isSegment) {
      if (/^(audio|image|text)\//i.test(ct)) return;
      if (/^video\/mp2t/i.test(ct)) return;
      const isVideo =
        VIDEO_MIME.test(ct) || VIDEO_EXT.test(path) || (details.type === 'media' && !/^audio\//i.test(ct));
      if (!isVideo) return;
    }

    // Total size: prefer Content-Range "bytes a-b/TOTAL" (range requests), else Content-Length.
    let size = null;
    const cr = header(details.responseHeaders, 'content-range').match(/\/(\d+)\s*$/);
    if (cr) size = Number(cr[1]);
    else if (details.statusCode === 200) {
      const cl = Number(header(details.responseHeaders, 'content-length'));
      if (cl > 0) size = cl;
    }
    // Tracking pixels and spacer GIFs are tiny; skip them.
    if (isGif && size != null && size < MIN_GIF_BYTES) return;

    ready.then(() => {
      let map = tabs.get(details.tabId);
      if (!map) tabs.set(details.tabId, (map = new Map()));
      const url = u.href;
      const prev = map.get(url);
      if (prev) {
        if (size && !prev.size) prev.size = size;
        if (ct && !prev.mime) prev.mime = ct;
      } else {
        let segments = 0;
        for (const it of map.values()) if (it.segment) segments++;
        if (isSegment ? segments >= MAX_SEGMENTS_PER_TAB : map.size - segments >= MAX_PER_TAB) return;
        map.set(url, {
          url,
          mime: ct || null,
          size,
          frameId: details.frameId,
          requestType: details.type,
          kind: isGif ? 'gif' : 'video',
          segment: isSegment || undefined,
          time: Date.now(),
        });
        // Let an open popup know so it can refresh live (no-op if it's closed).
        notify({ type: 'networkUpdate', tabId: details.tabId });
      }
      scheduleSave(details.tabId);
    });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

function notify(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// New top-level page → forget the previous page's videos.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  ready.then(() => {
    clearTab(details.tabId);
    notify({ type: 'tabNavigated', tabId: details.tabId });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  ready.then(() => clearTab(tabId));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'getNetwork') {
    ready.then(() => sendResponse([...(tabs.get(msg.tabId)?.values() ?? [])]));
    return true;
  }
  if (msg?.type === 'clearNetwork') {
    ready.then(() => {
      clearTab(msg.tabId);
      sendResponse(true);
    });
    return true;
  }
  return false;
});
