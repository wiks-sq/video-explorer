// Background service worker: watches network traffic per tab and remembers
// every response that looks like a video or GIF (including ones loaded by
// players via XHR/fetch that never appear as a plain URL in the page's HTML).

import { DEFAULTS, loadSettings, watchSettings, resolve, loadEnabled, watchEnabled } from './settings.js';

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

let cfg = resolve(DEFAULTS); // settings page choices, see settings.js
const settingsLoaded = loadSettings().then((s) => (cfg = resolve(s)));
watchSettings((s) => {
  cfg = resolve(s);
  pumpDownloads();
});

// The popup's on/off switch. Off: nothing is recorded, and the toolbar icon is grey.
let enabled = true;
const enabledLoaded = loadEnabled().then((on) => {
  enabled = on;
  showEnabled();
});
watchEnabled((on) => {
  enabled = on;
  showEnabled();
  if (!on) ready.then(forgetAllTabs);
});
// The icon isn't kept across browser restarts.
chrome.runtime.onStartup?.addListener(() => enabledLoaded.then(showEnabled));
chrome.runtime.onInstalled?.addListener(() => enabledLoaded.then(showEnabled));

function showEnabled() {
  const suffix = enabled ? '' : '-off';
  const path = Object.fromEntries([16, 32, 48, 128].map((n) => [n, `icons/icon${n}${suffix}.png`]));
  chrome.action?.setIcon({ path }).catch(() => {});
  chrome.action?.setTitle({ title: enabled ? 'Video Explorer' : 'Video Explorer (off)' }).catch(() => {});
}

function forgetAllTabs() {
  for (const t of saveTimers.values()) clearTimeout(t);
  saveTimers.clear();
  tabs.clear();
  chrome.storage.session
    .get(null)
    .then((all) => chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith('tab_'))))
    .catch(() => {});
}

const ready = chrome.storage.session
  .get(null)
  .then(async (all) => {
    await settingsLoaded;
    await enabledLoaded;
    for (const [key, list] of Object.entries(all)) {
      if (!key.startsWith('tab_') || !Array.isArray(list)) continue;
      tabs.set(Number(key.slice(4)), new Map(list.map((it) => [it.url, it])));
    }
    if (all[DL_KEY]) dl = { queue: all[DL_KEY].queue || [], active: all[DL_KEY].active || {} };
  })
  .catch(() => {});
ready.then(() => pumpDownloads());

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
    // Any request, the page's own or ours (thumbnails, sizes, downloads).
    // When switched off, only "Download all" (already started) still cares.
    if ((details.statusCode === 429 || details.statusCode === 503) && (enabled || downloadsPending())) noteRateLimit(details);
    if (!enabled || details.tabId < 0 || details.statusCode >= 400) return;
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
      if (!enabled) return;
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
  if (msg?.type === 'getRateLimits') {
    sendResponse(Object.fromEntries([...limits].map(([host, l]) => [host, { until: l.until, strikes: l.strikes }])));
    return false;
  }
  if (msg?.type === 'downloadAll' && Array.isArray(msg.files)) {
    ready.then(() => {
      for (const f of msg.files) {
        if (typeof f?.url === 'string') dl.queue.push({ url: f.url, filename: f.filename || '', host: hostOf(f.url), tries: 0 });
      }
      saveDl();
      pumpDownloads();
      sendResponse({ queued: msg.files.length, waiting: dl.queue.length + Object.keys(dl.active).length });
    });
    return true;
  }
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

// ---------------------------------------------------------------------------
// "Too many requests"
// ---------------------------------------------------------------------------

// Sites that recently answered 429 (or 503). The popup pauses thumbnails and
// size lookups for them, and "Download all" waits before starting more.
/** host -> { until, strikes, lastNotice } */
const limits = new Map();

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function retryAfterMs(headers) {
  const v = header(headers, 'retry-after');
  if (!v) return null;
  const s = Number(v);
  const ms = Number.isFinite(s) ? s * 1000 : Date.parse(v) - Date.now();
  return ms >= 0 ? ms : null;
}

/** Pause `host`: as long as the site asked, else 10 s, doubling each time (max 2 min). */
function pauseHost(host, ms) {
  const now = Date.now();
  const l = limits.get(host) || { until: 0, strikes: 0, lastNotice: 0 };
  if (l.until <= now) l.strikes++;
  const wait = ms ?? Math.min(10000 * 2 ** (l.strikes - 1), 120000);
  l.until = Math.max(l.until, now + Math.min(Math.max(wait, 1000), 300000));
  limits.set(host, l);
  return l;
}

function noteRateLimit(details) {
  const host = hostOf(details.url);
  if (!host) return;
  const ms = retryAfterMs(details.responseHeaders);
  const l = pauseHost(host, ms);
  const now = Date.now();
  if (now - l.lastNotice > 1000) {
    l.lastNotice = now;
    notify({ type: 'rateLimited', host, ms });
  }
}

// ---------------------------------------------------------------------------
// "Download all" queue
// ---------------------------------------------------------------------------

// Starting dozens of downloads at once is a sure way to get "too many
// requests", so a batch runs a few at a time. It lives here, not in the popup,
// so it keeps going after the popup closes.
// How many at once and whether to retry come from the settings page (cfg).
const DL_KEY = 'dlQueue';
const DL_GAP_MS = 500; // between starting two downloads
const RETRY_REASONS = /^(SERVER_FAILED|NETWORK_FAILED|NETWORK_TIMEOUT|NETWORK_SERVER_DOWN|NETWORK_DISCONNECTED)$/;

/** queue: jobs waiting; active: downloadId -> job */
let dl = { queue: [], active: {} };
let dlBusy = false;
let dlTimer = null;
let dlLastStart = 0;

function downloadsPending() {
  return dl.queue.length > 0 || Object.keys(dl.active).length > 0;
}

function saveDl() {
  chrome.storage.session.set({ [DL_KEY]: dl }).catch(() => {});
}

function pumpLater(ms) {
  clearTimeout(dlTimer);
  dlTimer = setTimeout(pumpDownloads, ms);
  // The worker may be stopped while it waits; an alarm wakes it up again.
  if (ms > 20000) chrome.alarms?.create('dl-pump', { when: Date.now() + ms });
}

async function pumpDownloads() {
  if (dlBusy) return;
  dlBusy = true;
  try {
    while (dl.queue.length) {
      const active = Object.values(dl.active);
      if (active.length >= cfg.downloadsTotal) break; // continues when one finishes
      const now = Date.now();
      // "Keep going" in Settings: don't wait for sites that said too many requests.
      const paused = (host) => cfg.onLimit !== 'ignore' && (limits.get(host)?.until || 0) > now;
      const idx = dl.queue.findIndex(
        (j) => !paused(j.host) && active.filter((a) => a.host === j.host).length < cfg.downloadsPerSite
      );
      if (idx < 0) {
        const ends = dl.queue.map((j) => limits.get(j.host)?.until || 0).filter((u) => u > now);
        if (ends.length) pumpLater(Math.min(...ends) - now + 100);
        break;
      }
      const wait = dlLastStart + DL_GAP_MS - now;
      if (wait > 0) {
        pumpLater(wait);
        break;
      }
      const [job] = dl.queue.splice(idx, 1);
      dlLastStart = Date.now();
      const id = await startDownload(job);
      if (id != null) dl.active[id] = job;
      saveDl();
    }
  } finally {
    dlBusy = false;
  }
}

async function startDownload(job) {
  try {
    return await chrome.downloads.download(job.filename ? { url: job.url, filename: job.filename } : { url: job.url });
  } catch {
    try {
      return await chrome.downloads.download({ url: job.url }); // Chrome rejected the filename
    } catch {
      return null;
    }
  }
}

chrome.downloads.onChanged.addListener((d) => {
  const state = d.state?.current;
  if (!state || state === 'in_progress') return;
  ready.then(() => {
    const job = dl.active[d.id];
    if (!job) return;
    delete dl.active[d.id];
    if (state === 'interrupted' && RETRY_REASONS.test(d.error?.current || '') && job.tries < cfg.downloadRetries) {
      // Usually the site refusing ("too many requests") or a dropped connection: wait, then try again.
      job.tries++;
      if (!((limits.get(job.host)?.until || 0) > Date.now())) pauseHost(job.host, 15000 * job.tries);
      dl.queue.push(job);
    }
    saveDl();
    pumpDownloads();
  });
});

chrome.alarms?.onAlarm.addListener((a) => {
  if (a.name === 'dl-pump') ready.then(pumpDownloads);
});
