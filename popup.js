import { scanPage, downloadInPage, installWatcher } from './scanner.js';
import { DEFAULTS, loadSettings, watchSettings, resolve } from './settings.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOURCE_ORDER = [
  'Video element',
  'Source tag',
  'Image',
  'CSS background',
  'Link',
  'Embed',
  'Meta tag',
  'Structured data',
  'Page resources',
  'Network',
];

const KNOWN_EXT = new Set([
  'mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov', 'mkv', 'avi', 'wmv', 'flv',
  '3gp', '3g2', 'mpg', 'mpeg', 'ts', 'm3u8', 'mpd', 'm4s', 'gif',
]);
const EXT_IN_URL = /\.(mp4|m4v|webm|ogv|mov|mkv|avi|wmv|flv|3gp|3g2|mpe?g|m3u8|mpd|m4s|gif)(?=$|[?#&;])/i;

const MIME_FORMAT = {
  'video/mp4': 'MP4',
  'video/x-m4v': 'M4V',
  'video/webm': 'WEBM',
  'video/ogg': 'OGV',
  'video/quicktime': 'MOV',
  'video/x-matroska': 'MKV',
  'video/x-msvideo': 'AVI',
  'video/x-ms-wmv': 'WMV',
  'video/x-flv': 'FLV',
  'video/3gpp': '3GP',
  'video/3gpp2': '3G2',
  'video/mpeg': 'MPEG',
  'video/mp2t': 'TS',
  'video/iso.segment': 'M4S',
  'application/x-mpegurl': 'M3U8',
  'application/vnd.apple.mpegurl': 'M3U8',
  'audio/mpegurl': 'M3U8',
  'application/dash+xml': 'MPD',
  'image/gif': 'GIF',
};

const FORMAT_LABEL = {
  M3U8: 'HLS playlist (M3U8)',
  MPD: 'DASH manifest (MPD)',
  M4S: 'DASH segment (M4S)',
  BLOB: 'Blob (in-page)',
  GIF: 'GIF (animated image)',
  VIDEO: 'Unknown format',
};

const SIZE_BUCKETS = [
  { key: 's0', label: 'Small (< 10 MB)', max: 10 * 2 ** 20 },
  { key: 's1', label: 'Medium (10 – 100 MB)', max: 100 * 2 ** 20 },
  { key: 's2', label: 'Large (100 MB – 1 GB)', max: 2 ** 30 },
  { key: 's3', label: 'Huge (> 1 GB)', max: Infinity },
  { key: 's4', label: 'Unknown size', max: null },
];

const ICON = {
  download:
    '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  copy:
    '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/></svg>',
  open:
    '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
  film:
    '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
  stream:
    '<svg viewBox="0 0 24 24"><path d="M5 12a7 7 0 0 1 14 0M8.5 12a3.5 3.5 0 0 1 7 0"/><circle cx="12" cy="12" r="1"/><path d="M12 13v7"/></svg>',
  image:
    '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/></svg>',
  chevron: '<svg class="chev" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  caret: '<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>',
};

const MAX_PROBES = 80; // how many videos get a metadata/thumbnail probe
const MAX_GIF_PROBES = 250; // GIF still frames are cheap (usually already in the cache)
// Thumbnails, lengths and sizes are fetched from the site's own servers, so
// they count against the same rate limits as the page. How many at once and
// how far apart comes from the settings page (`cfg`); these are the fixed parts.
const NET = {
  slowGapMs: 1500, // Auto pause between requests after the site pushed back (one at a time)
  slowForMs: 60000, // how long Auto stays that careful after a pause ends
  backoffMs: 10000, // first pause after "too many requests"; doubles each time
  maxBackoffMs: 120000,
  retries: 2, // a request that hit the limit is retried after the pause
};
const POLL_MS = 5000; // safety-net rescan (e.g. shadow DOM changes the watcher can't see)
const NEW_HIGHLIGHT_MS = 4000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cfg = resolve(DEFAULTS); // settings page choices, see settings.js

const prefs = {
  view: 'icons',
  groupBy: 'none',
  sortBy: 'order',
  sortDir: 'asc',
  kind: 'all',
  hiddenFormats: [],
  cmdOs: /win/i.test(navigator.userAgentData?.platform || navigator.platform || '') ? 'win' : 'unix',
  cmdHeaders: true, // add Referer + User-Agent to copied commands
};
const state = {
  tab: null,
  items: [],
  filter: '',
  collapsed: new Set(),
  scanError: null,
  scanning: false, // true only until the first scan completes
  confirmAll: false,
};
const itemsByKey = new Map(); // mediaKey -> item (persistent across live rescans)
const thumbCache = new Map(); // url -> HTMLElement | null
const sizeCache = new Map(); // url -> number | null
const metaCache = new Map(); // url -> {width, height, duration}
let nextOrder = 0;
let generation = 0; // bumped when the tab navigates; stale async work checks it

const $ = (sel) => document.querySelector(sel);
const els = {
  pageInfo: $('#page-info'),
  rescan: $('#rescan'),
  filter: $('#filter'),
  viewSwitch: $('#view-switch'),
  groupBy: $('#group-by'),
  sortBy: $('#sort-by'),
  sortDir: $('#sort-dir'),
  content: $('#content'),
  status: $('#status'),
  copyAll: $('#copy-all'),
  downloadAll: $('#download-all'),
  downloadAllMenu: $('#download-all-menu'),
  toast: $('#toast'),
  live: $('#live'),
  resort: $('#resort'),
  kindSwitch: $('#kind-switch'),
  formats: $('#formats'),
  formatsPop: $('#formats-pop'),
  formatsHidden: $('#formats-hidden'),
  netNote: $('#net-note'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function safeURL(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}

function formatRes(it) {
  return it.width && it.height ? `${it.width}×${it.height}` : '—';
}

function primarySource(it) {
  return [...it.sources].sort((a, b) => SOURCE_ORDER.indexOf(a) - SOURCE_ORDER.indexOf(b))[0];
}

function canDownload(it) {
  return !(it.isBlob && it.blobKind === 'stream');
}

/** "3 videos · 2 GIFs" */
function countLabel(items) {
  const g = items.filter((it) => it.kind === 'gif').length;
  const v = items.length - g;
  const parts = [];
  if (v || !g) parts.push(`${v} video${v === 1 ? '' : 's'}`);
  if (g) parts.push(`${g} GIF${g === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function canProbe(it) {
  return !it.isBlob && !it.playlist && !it.segment;
}

function downloadHint(it) {
  if (!canDownload(it)) return 'This is a live MediaSource stream (blob:) and cannot be saved directly';
  if (it.playlist) return 'Streaming playlist: this saves the playlist file, not the video itself (use ffmpeg / yt-dlp for the stream)';
  if (it.segment) return 'DASH segment: this saves only this piece of the stream, not the whole video';
  return 'Download';
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

// ---------------------------------------------------------------------------
// Building the item list
// ---------------------------------------------------------------------------

function detectFormat(raw, u, isBlob, isData) {
  let ext = null;
  if (u && !isBlob && !isData) {
    const m = u.pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (m && KNOWN_EXT.has(m[1].toLowerCase())) ext = m[1].toUpperCase();
  }
  const mime = (raw.mime || '').toLowerCase().split(';')[0].trim();
  if (!ext && mime) ext = MIME_FORMAT[mime] || null;
  if (!ext && isData) {
    if (/^data:image\/gif/i.test(raw.url)) return 'GIF';
    const m = raw.url.match(/^data:video\/([a-z0-9.+-]+)/i);
    if (m) ext = MIME_FORMAT[`video/${m[1].toLowerCase()}`] || m[1].toUpperCase();
  }
  if (!ext && !isBlob && !isData) {
    const m = raw.url.match(EXT_IN_URL);
    if (m) ext = m[1].toUpperCase();
  }
  if (ext === 'MPG') ext = 'MPEG';
  if (ext === 'OGG') ext = 'OGV';
  return ext || (isBlob ? 'BLOB' : 'VIDEO');
}

function buildItem(raw, order) {
  const isBlob = raw.url.startsWith('blob:');
  const isData = raw.url.startsWith('data:');
  const u = safeURL(isBlob ? raw.url.slice(5) : raw.url);
  const format = detectFormat(raw, isBlob ? null : u, isBlob, isData);
  const kind = raw.kind === 'gif' || format === 'GIF' ? 'gif' : 'video';

  const name =
    isBlob || isData
      ? raw.title || `${isBlob ? 'blob' : 'inline'}-${kind}-${order + 1}`
      : fileName(u) || u?.hostname || raw.url;

  const domain = isData ? '(inline data)' : u?.hostname || '(unknown)';
  const cachedMeta = metaCache.get(raw.url) || {};
  let size = raw.size ?? sizeCache.get(raw.url) ?? null;
  if (isData && size == null) size = Math.round((raw.url.length - raw.url.indexOf(',') - 1) * 0.75);
  const playlist = format === 'M3U8' || format === 'MPD';
  // DASH pieces: sizes come from the network capture; no HEAD request per piece.
  const segment = format === 'M4S';

  return {
    id: `v${order}`,
    order,
    key: mediaKey(raw.url).key,
    url: raw.url,
    alts: [], // other links that serve the same file
    kind,
    name,
    title: raw.title && raw.title !== name ? raw.title : null,
    format,
    mime: raw.mime || null,
    sources: raw.sources,
    size,
    sizeState: size != null ? 'done' : isBlob || playlist || segment ? 'na' : 'pending',
    width: raw.width || cachedMeta.width || null,
    height: raw.height || cachedMeta.height || null,
    duration: raw.duration ?? cachedMeta.duration ?? null,
    poster: raw.poster || null,
    frameId: raw.frameId ?? 0,
    isBlob,
    isData,
    blobKind: raw.blobKind || null,
    playlist,
    segment,
    domain,
  };
}

/** Last path segment, decoded. */
function fileName(u) {
  const seg = (u?.pathname || '').split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** A random-looking file id such as "tbpo5on1810i1" (not "episode10" or "video_720p"). */
function looksLikeId(s) {
  if (/^\d{12,}$/.test(s)) return true;
  if (!/^[a-z0-9]{10,}$/.test(s)) return false;
  const digits = s.replace(/\D/g, '').length;
  const letters = s.length - digits;
  return digits >= 2 && letters >= 2 && !/^[a-z]+\d+$|^\d+[a-z]+$/.test(s);
}

/**
 * Many sites serve one file under several links: resized previews with
 * query parameters, CDN mirrors, or a descriptive slug in front of the file
 * id ("gif-heaven-v0-tbpo5on1810i1.gif" vs "tbpo5on1810i1.gif"). Links with
 * the same key are shown as one item. `score` ranks which link to keep as the
 * main one: plain, original-looking links win over preview variants.
 */
function mediaKey(url) {
  if (url.startsWith('blob:') || url.startsWith('data:')) return { key: url, score: 0 };
  const u = safeURL(url);
  if (!u) return { key: url, score: 0 };
  const m = fileName(u).toLowerCase().match(/^(.+)\.([a-z0-9]{2,5})$/);
  if (!m || !KNOWN_EXT.has(m[2])) return { key: url.split('#')[0], score: 0 };

  const stem = m[1];
  const site = u.hostname.split('.').slice(-2).join('.');
  const tail = stem.split(/[-_.]/).pop();
  const id = looksLikeId(stem) ? stem : looksLikeId(tail) ? tail : null;
  const score = (u.search ? 2 : 0) + (id && id !== stem ? 1 : 0);
  return { key: id ? `${site}|${id}` : `${u.host}${u.pathname}`, score };
}

function mergeRaw(map, raw) {
  const prev = map.get(raw.url);
  if (!prev) {
    map.set(raw.url, { ...raw, sources: [...raw.sources] });
    return;
  }
  for (const s of raw.sources) if (!prev.sources.includes(s)) prev.sources.push(s);
  for (const [k, v] of Object.entries(raw)) if (prev[k] == null && v != null) prev[k] = v;
}

async function scanFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: scanPage,
  });
  const out = [];
  for (const r of results || []) {
    const res = r?.result;
    if (!res?.items) continue;
    for (const it of res.items) out.push({ ...it, frameId: r.frameId });
  }
  return out;
}

function installWatchers(tabId) {
  chrome.scripting
    .executeScript({ target: { tabId, allFrames: true }, func: installWatcher })
    .catch(() => {});
}

/** Fill in anything the existing item was missing. Returns true if it changed. */
function updateItem(it, raw) {
  let changed = false;
  for (const s of raw.sources) {
    if (!it.sources.includes(s)) {
      it.sources.push(s);
      changed = true;
    }
  }
  for (const k of ['width', 'height', 'duration', 'poster', 'mime', 'blobKind']) {
    if (it[k] == null && raw[k] != null) {
      it[k] = raw[k];
      changed = true;
      if (k === 'poster' && thumbCache.get(it.url) == null) thumbCache.delete(it.url);
    }
  }
  if (it.size == null && raw.size != null) {
    it.size = raw.size;
    it.sizeState = 'done';
    changed = true;
  }
  if (!it.title && raw.title && raw.title !== it.name) {
    it.title = raw.title;
    changed = true;
  }
  return changed;
}

/**
 * `raw` is another link to the same file as `it`. Remember the link, take its
 * extra info, and switch to it if it looks like the original rather than a
 * preview. Returns true if anything visible changed.
 */
function addAlternate(it, raw) {
  let changed = false;
  if (!it.alts.includes(raw.url)) {
    it.alts.push(raw.url);
    changed = true;
  }
  for (const s of raw.sources) {
    if (!it.sources.includes(s)) {
      it.sources.push(s);
      changed = true;
    }
  }
  for (const k of ['poster', 'duration']) {
    if (it[k] == null && raw[k] != null) {
      it[k] = raw[k];
      changed = true;
    }
  }
  if (!it.title && raw.title && raw.title !== it.name) {
    it.title = raw.title;
    changed = true;
  }
  // Keep the most descriptive name ("gif-heaven-v0-tbpo5on1810i1.gif").
  const altName = fileName(safeURL(raw.url));
  if (altName.length > it.name.length) {
    it.name = altName;
    changed = true;
  }
  if (mediaKey(raw.url).score < mediaKey(it.url).score) {
    promote(it, raw);
    changed = true;
  }
  return changed;
}

/** Make `raw.url` the item's main link (size and resolution are re-read for it). */
function promote(it, raw) {
  const fresh = buildItem(raw, it.order);
  it.alts = [it.url, ...it.alts.filter((u) => u !== raw.url)];
  for (const k of ['url', 'format', 'mime', 'playlist', 'segment', 'domain', 'frameId', 'size', 'sizeState', 'width', 'height']) {
    it[k] = fresh[k];
  }
  if (fresh.duration != null) it.duration = fresh.duration;
  if (fresh.kind === 'gif') it.kind = 'gif';
  return it;
}

let scanRunning = false;
let scanAgain = false;
let firstScanDone = false;
let scanTimer = null;

/** Debounced scan request used by all the live-update triggers. */
function requestScan(delay = 250) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scan(), delay);
}

async function scan({ manual = false } = {}) {
  if (!state.tab) return;
  if (scanRunning) {
    scanAgain = true;
    return;
  }
  scanRunning = true;
  const gen = generation;
  const showSpinner = manual || !firstScanDone;
  if (showSpinner) els.rescan.classList.add('spinning');
  if (!firstScanDone) {
    state.scanning = true;
    render();
  }

  const tabId = state.tab.id;
  const [pageRes, netRes] = await Promise.allSettled([
    scanFrames(tabId),
    chrome.runtime.sendMessage({ type: 'getNetwork', tabId }),
  ]);
  installWatchers(tabId); // idempotent; also covers iframes added since last time

  scanRunning = false;
  if (showSpinner) els.rescan.classList.remove('spinning');
  if (gen !== generation) {
    // The tab navigated while we were scanning — results belong to the old page.
    requestScan(0);
    return;
  }

  const map = new Map();
  const prevError = state.scanError;
  if (pageRes.status === 'fulfilled') {
    pageRes.value.forEach((r) => mergeRaw(map, r));
    state.scanError = null;
  } else {
    state.scanError = pageRes.reason?.message || String(pageRes.reason);
  }
  if (netRes.status === 'fulfilled' && Array.isArray(netRes.value)) {
    for (const n of netRes.value) mergeRaw(map, { ...n, sources: ['Network'] });
  }

  let changed = prevError !== state.scanError;
  const added = [];
  const promoted = new Set();
  for (const raw of map.values()) {
    const { key } = mediaKey(raw.url);
    const existing = itemsByKey.get(key);
    if (!existing) {
      const it = buildItem(raw, nextOrder++);
      if (firstScanDone) it.newAt = Date.now();
      itemsByKey.set(key, it);
      added.push(it);
    } else if (existing.url === raw.url) {
      if (updateItem(existing, raw)) changed = true;
    } else {
      const before = existing.url;
      if (addAlternate(existing, raw)) changed = true;
      if (existing.url !== before) promoted.add(existing);
    }
  }
  state.items = [...itemsByKey.values()];

  const wasFirst = !firstScanDone;
  firstScanDone = true;
  state.scanning = false;
  if (wasFirst) arrange();
  if (wasFirst || changed || added.length) render();
  if (added.length && !wasFirst) {
    toast(`New: ${countLabel(added)}`);
    setTimeout(scheduleRender, NEW_HIGHLIGHT_MS + 50); // drop the highlight
  }
  for (const it of new Set([...added, ...promoted])) {
    queueProbe(it);
    queueSize(it);
  }
  if (scanAgain) {
    scanAgain = false;
    requestScan(0);
  }
}

/** The tab loaded a new page: start over. */
function resetItems() {
  generation++;
  itemsByKey.clear();
  state.items = [];
  arrangement = [];
  arranged.clear();
  state.scanError = null;
  nextOrder = 0;
  probeCount = 0;
  gifProbeCount = 0;
  probeQueued.clear(); // queued work for the old page is dropped by the generation check
  for (const el of thumbCache.values()) {
    if (el instanceof HTMLVideoElement) {
      el.removeAttribute('src');
      el.load();
    } else if (el?.classList?.contains('gif-thumb')) {
      el.lastElementChild.removeAttribute('src');
    }
  }
  thumbCache.clear();
  hidePreview();
  firstScanDone = false;
  state.scanning = true;
  render();
}

// ---------------------------------------------------------------------------
// Background work: thumbnails/metadata and file sizes
// ---------------------------------------------------------------------------

/**
 * A request the site refused with "too many requests" (HTTP 429, or 503).
 * `ms` is how long the site asked us to wait, if it said. `counted` means the
 * pause is already in place (the background worker reported it), so the
 * request only needs to be retried.
 */
class RateLimited extends Error {
  constructor(ms = null, counted = false) {
    super('rate limited');
    this.ms = ms;
    this.counted = counted;
  }
}

/** host -> { host, active, queue, until, strikes, lastStart, timer, headFails } */
const hosts = new Map();
let netSeq = 0;
let netTicker = null;

function hostOf(url) {
  return safeURL(url)?.host || '';
}

function hostEntry(host) {
  let h = hosts.get(host);
  if (!h) {
    h = { host, active: 0, queue: [], until: 0, slowUntil: 0, strikes: 0, lastStart: 0, timer: null, headFails: 0 };
    hosts.set(host, h);
  }
  return h;
}

/**
 * Run `run()` once the site behind `url` has a free slot: at most cfg.perSite
 * requests to one site at a time, spaced out, the highest `prio()` first (what's
 * on screen), and nothing while the site has asked us to back off. `giveUp()`
 * is called if the task is dropped after too many "too many requests".
 */
function netSchedule(url, run, { prio = () => 0, giveUp = () => {} } = {}) {
  const h = hostEntry(hostOf(url));
  if (h.stopped) return giveUp();
  h.queue.push({ run, prio, giveUp, gen: generation, tries: 0, seq: netSeq++ });
  pumpHost(h);
}

function pumpHost(h) {
  clearTimeout(h.timer);
  h.timer = null;
  h.queue = h.queue.filter((t) => t.gen === generation);
  if (h.stopped) {
    for (const t of h.queue.splice(0)) t.giveUp();
    return;
  }
  while (h.queue.length) {
    const now = Date.now();
    // Auto settings slow down for a while after the site pushed back; numbers picked by hand stay as they are.
    const slow = now < h.slowUntil;
    if (h.active >= (slow && cfg.perSiteAuto ? 1 : cfg.perSite)) return; // continues when one finishes
    const gap = slow && cfg.gapAuto ? NET.slowGapMs : cfg.gapMs;
    const wait = Math.max(h.until - now, h.lastStart + gap - now);
    if (wait > 0) {
      h.timer = setTimeout(() => pumpHost(h), wait);
      return;
    }
    // Highest priority first; among equals, the oldest (the queue is in order).
    let best = 0;
    let bestPrio = h.queue[0].prio();
    for (let i = 1; i < h.queue.length; i++) {
      const p = h.queue[i].prio();
      if (p > bestPrio) {
        best = i;
        bestPrio = p;
      }
    }
    const [task] = h.queue.splice(best, 1);
    h.active++;
    h.lastStart = now;
    Promise.resolve()
      .then(task.run)
      .catch((err) => {
        if (!(err instanceof RateLimited)) return;
        if (!err.counted) rateLimit(h, err.ms);
        if (cfg.onLimit === 'auto' && task.tries++ < NET.retries && task.gen === generation) h.queue.unshift(task);
        else task.giveUp();
      })
      .finally(() => {
        h.active--;
        pumpHost(h);
      });
  }
}

/**
 * The site said "too many requests". Auto: pause it, then carry on slowly.
 * The settings page can instead stop loading from it, or ignore it.
 */
function rateLimit(h, ms) {
  if (cfg.onLimit === 'ignore') return;
  if (cfg.onLimit === 'stop') {
    h.stopped = true;
    pumpHost(h); // drops what was waiting
    renderNetNote();
    return;
  }
  const now = Date.now();
  if (h.until <= now) h.strikes++; // a burst of refusals during one pause is one strike
  const wait = ms ?? Math.min(NET.backoffMs * 2 ** (Math.max(1, h.strikes) - 1), NET.maxBackoffMs);
  h.until = Math.max(h.until, now + Math.min(Math.max(wait, 1000), 5 * 60000));
  h.slowUntil = h.until + NET.slowForMs;
  pumpHost(h);
  startNetTicker();
}

/** Footer note while a site with work waiting is paused. Returns false once nothing is paused. */
function renderNetNote() {
  const now = Date.now();
  const paused = [...hosts.values()].filter((h) => h.until > now && !h.stopped);
  const waiting = paused.filter((h) => h.queue.length);
  const stopped = [...hosts.values()].filter((h) => h.stopped);
  els.netNote.hidden = !waiting.length && !stopped.length;
  if (stopped.length && !waiting.length) {
    const names = stopped.map((h) => h.host);
    els.netNote.textContent = `${names.length === 1 ? names[0] : `${names.length} sites`} said too many requests · stopped`;
    els.netNote.title =
      `${names.join(', ')} answered “too many requests”, so no more thumbnails or sizes are loaded from ` +
      `${names.length === 1 ? 'it' : 'them'} until you reopen the popup (as chosen in Settings).`;
  } else if (waiting.length) {
    const secs = Math.ceil((Math.max(...waiting.map((h) => h.until)) - now) / 1000);
    const names = waiting.map((h) => h.host);
    els.netNote.textContent = `${names.length === 1 ? names[0] : `${names.length} sites`} asked to slow down · ${secs} s`;
    els.netNote.title =
      `${names.join(', ')} answered “too many requests”, so loading thumbnails and sizes is paused for ${secs} s. ` +
      'This keeps the page’s own videos working. Afterwards files load one at a time.';
  }
  return paused.length > 0;
}

function startNetTicker() {
  renderNetNote();
  if (netTicker) return;
  netTicker = setInterval(() => {
    if (!renderNetNote()) {
      clearInterval(netTicker);
      netTicker = null;
    }
  }, 1000);
}

function retryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

function checkLimited(res, ctrl) {
  if (res.status !== 429 && res.status !== 503) return;
  ctrl?.abort();
  throw new RateLimited(retryAfterMs(res));
}

/**
 * A thumbnail or GIF didn't load. Media elements don't expose the HTTP status,
 * so give the background worker (which does see it) a moment to report a
 * "too many requests"; if the site has started refusing, retry after the pause.
 */
async function checkFailedLoad(url, strikesBefore) {
  await new Promise((r) => setTimeout(r, 1500));
  const h = hostEntry(hostOf(url));
  if (h.strikes > strikesBefore || h.until > Date.now()) throw new RateLimited(null, true);
}

// Sizes and metadata survive closing the popup (until the browser restarts),
// so opening it again doesn't ask the site for everything a second time.
const CACHE_KEY = 'probeCache';
const CACHE_MAX = 3000;
let cacheTimer = null;

async function loadProbeCache() {
  if (!cfg.remember) return;
  try {
    const { [CACHE_KEY]: c } = (await chrome.storage.session?.get(CACHE_KEY)) || {};
    for (const [url, e] of Object.entries(c || {})) {
      if (e.size != null && !sizeCache.has(url)) sizeCache.set(url, e.size);
      if (e.meta && !metaCache.has(url)) metaCache.set(url, e.meta);
    }
  } catch {
    /* no cache */
  }
}

function saveProbeCache() {
  if (!cfg.remember) return;
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    const out = {};
    const urls = [...new Set([...sizeCache.keys(), ...metaCache.keys()])].slice(-CACHE_MAX);
    for (const url of urls) {
      const size = sizeCache.get(url);
      const meta = metaCache.get(url);
      if (size == null && !meta) continue;
      out[url] = {};
      if (size != null) out[url].size = size;
      if (meta) out[url].meta = meta;
    }
    chrome.storage.session?.set({ [CACHE_KEY]: out }).catch(() => {});
  }, 1000);
}

let probeCount = 0;
let gifProbeCount = 0;
const probeQueued = new Set(); // urls with a probe waiting, running or done
const visibleIds = new Set(); // items on or near the screen (they get thumbnails)
const onScreenIds = new Set(); // items actually on screen (they go first)

// Only what's on screen (plus a margin) gets a thumbnail.
const visibility = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const id = e.target.dataset.item;
      if (!e.isIntersecting) {
        visibleIds.delete(id);
        continue;
      }
      visibleIds.add(id);
      const it = itemById(id);
      if (it) queueProbe(it);
    }
  },
  { root: els.content, rootMargin: '300px 0px' }
);
const onScreen = new IntersectionObserver(
  (entries) => {
    for (const e of entries) e.isIntersecting ? onScreenIds.add(e.target.dataset.item) : onScreenIds.delete(e.target.dataset.item);
  },
  { root: els.content }
);

function itemById(id) {
  return state.items.find((x) => x.id === id);
}

function observeItems() {
  visibility.disconnect();
  onScreen.disconnect();
  visibleIds.clear();
  onScreenIds.clear();
  for (const el of els.content.querySelectorAll('[data-item]')) {
    visibility.observe(el);
    onScreen.observe(el);
  }
}

/** Queue priority: on screen, then near it, then the rest. */
function screenPrio(it) {
  return onScreenIds.has(it.id) ? 2 : visibleIds.has(it.id) ? 1 : 0;
}

/** Sorting by these needs every file's metadata, not just what's on screen. */
function needsAllMeta() {
  return prefs.sortBy === 'duration' || prefs.sortBy === 'resolution';
}

const VIEWS_WITH_THUMBS = new Set(['icons', 'tiles']);

/** Whether loading this file now is worth a request. */
function wantProbe(it) {
  if (cfg.thumbnails === 'off') return false;
  if (cfg.thumbnails === 'all') return true;
  const known = it.width != null && (it.kind === 'gif' || it.duration != null);
  if (needsAllMeta() && !known) return true;
  if (!visibleIds.has(it.id)) return false;
  if (VIEWS_WITH_THUMBS.has(prefs.view)) return true;
  return prefs.view === 'details' && !known; // Details shows resolution and length; List shows neither
}

/**
 * GIF thumbnails show a still first frame (a canvas) and only animate while
 * the mouse is over them: the <img> gets its src on hover and loses it again
 * on mouse-out, so the GIF restarts from the first frame each time.
 */
function makeGifThumb(it) {
  const wrap = document.createElement('div');
  wrap.className = 'gif-thumb';
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 0;
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.onload = () => {
    if (!img.dataset.url) return;
    img.classList.add('ready');
    if (!wrap.classList.contains('has-still')) paintStill(wrap, img);
    if (applyMeta(it, { width: img.naturalWidth || null, height: img.naturalHeight || null, duration: null }, img.dataset.url)) {
      scheduleRender();
    }
  };
  wrap.append(canvas, img);
  return wrap;
}

function paintStill(wrap, source) {
  const w = source.naturalWidth;
  const h = source.naturalHeight;
  if (!w || !h) return;
  const s = Math.min(1, 360 / Math.max(w, h));
  const c = wrap.firstElementChild;
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  try {
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    wrap.classList.add('has-still');
  } catch {
    /* undecodable: the placeholder icon stays visible */
  }
}

function setGifPlaying(slot, on) {
  const it = state.items.find((x) => x.id === slot.dataset.thumb);
  if (!it || it.kind !== 'gif') return;
  const wrap = thumbCache.get(it.url);
  if (!wrap?.classList?.contains('gif-thumb')) return;
  const img = wrap.lastElementChild;
  wrap.classList.toggle('playing', on);
  if (on) {
    if (img.dataset.url === it.url) return;
    img.classList.remove('ready');
    img.dataset.url = it.url;
    img.src = it.url;
  } else {
    img.classList.remove('ready');
    img.removeAttribute('src');
    delete img.dataset.url;
  }
}

function getThumb(it) {
  if (thumbCache.has(it.url)) return thumbCache.get(it.url);
  let el = null;
  if (it.kind === 'gif' && !it.isBlob) {
    el = makeGifThumb(it); // the still frame is painted by probeGif()
  } else if (it.poster && cfg.thumbnails !== 'off') {
    el = document.createElement('img');
    el.src = it.poster;
    el.alt = '';
    el.loading = 'lazy';
    el.onerror = () => el.remove();
  }
  thumbCache.set(it.url, el);
  return el;
}

/** Store probed metadata for `url`; only applied if it's still the item's main link. */
function applyMeta(it, meta, url = it.url) {
  metaCache.set(url, meta);
  saveProbeCache();
  if (it.url !== url) return false;
  let changed = false;
  for (const k of ['width', 'height', 'duration']) {
    if (it[k] == null && meta[k] != null) {
      it[k] = meta[k];
      changed = true;
    }
  }
  return changed;
}

/** Load the GIF once to read its size and paint the still first-frame thumbnail. Resolves false if it failed. */
function probeGif(it) {
  const url = it.url;
  return new Promise((resolve) => {
    const img = new Image();
    const finish = (ok) => {
      clearTimeout(timer);
      img.onload = img.onerror = null;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 15000);
    // (No img.decode() here: it can hang forever on animated GIFs. drawImage
    // decodes the first frame synchronously.)
    img.onload = () => {
      let changed = applyMeta(it, { width: img.naturalWidth || null, height: img.naturalHeight || null, duration: null }, url);
      const wrap = it.url === url ? getThumb(it) : null;
      if (wrap?.classList?.contains('gif-thumb')) {
        paintStill(wrap, img);
        changed = true;
      }
      if (changed) scheduleRender();
      finish(true);
    };
    img.onerror = () => finish(false);
    img.src = url;
  });
}

/** Load a video's metadata and first frame (it becomes the thumbnail). Resolves false if it failed. */
function probe(it) {
  if (it.kind === 'gif') return probeGif(it);
  const url = it.url;
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'metadata';
    if (it.poster) v.poster = it.poster;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 10000);
    v.addEventListener('loadedmetadata', () => {
      let changed = applyMeta(
        it,
        {
          width: v.videoWidth || null,
          height: v.videoHeight || null,
          duration: Number.isFinite(v.duration) ? v.duration : null,
        },
        url
      );
      // Use the video as the thumbnail (it shows the poster or the frame at 1s).
      if (v.videoWidth && it.url === url && itemsByKey.get(it.key) === it) {
        thumbCache.set(url, v);
        changed = true;
      }
      if (changed) scheduleRender();
    });
    v.addEventListener('loadeddata', () => finish(true));
    v.addEventListener('error', () => {
      v.removeAttribute('src'); // stop it from trying again on its own
      finish(false);
    });
    v.src = url.includes('#') ? url : `${url}#t=1`;
  });
}

function hasThumb(it) {
  const t = thumbCache.get(it.url);
  return it.kind === 'gif' ? !!t?.classList?.contains('has-still') : t instanceof HTMLVideoElement;
}

/**
 * Queue a thumbnail/metadata load, if it's worth one right now (see
 * wantProbe). Called when an item scrolls into view, and for every item when
 * sorting by length or resolution.
 */
function queueProbe(it) {
  if (!canProbe(it) || probeQueued.has(it.url) || hasThumb(it) || !wantProbe(it)) return;
  const gif = it.kind === 'gif';
  // Caps for Auto; "All files" in Settings means all of them.
  if (cfg.thumbnails !== 'all' && (gif ? gifProbeCount >= MAX_GIF_PROBES : probeCount >= MAX_PROBES)) return;
  gif ? gifProbeCount++ : probeCount++;
  const url = it.url;
  const gen = generation;
  probeQueued.add(url);
  const release = () => {
    // Not loaded: let it be queued again the next time it comes into view.
    if (gen !== generation) return;
    probeQueued.delete(url);
    gif ? gifProbeCount-- : probeCount--;
  };
  netSchedule(
    url,
    async () => {
      if (gen !== generation) return;
      if (it.url !== url || !wantProbe(it)) return release(); // scrolled away, or no longer needed
      const strikes = hostEntry(hostOf(url)).strikes;
      if ((await probe(it)) === false) await checkFailedLoad(url, strikes);
    },
    { prio: () => 2 + screenPrio(it), giveUp: release }
  );
}

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return { res: await fetch(url, { ...opts, signal: ctrl.signal, credentials: 'include' }), ctrl };
  } finally {
    clearTimeout(timer);
  }
}

/** File size from the server, or null. Throws RateLimited if the site refuses. */
async function fetchSize(url) {
  const h = hostEntry(hostOf(url));
  // Some servers reject HEAD; after two refusals, go straight to the range request.
  if (h.headFails < 2) {
    try {
      const { res } = await fetchWithTimeout(url, { method: 'HEAD' }, 6000);
      checkLimited(res);
      const n = Number(res.headers.get('content-length'));
      if (res.ok && n > 0) return n;
      if (!res.ok) h.headFails++;
    } catch (e) {
      if (e instanceof RateLimited) throw e;
      /* fall through to range request */
    }
  }
  try {
    const { res, ctrl } = await fetchWithTimeout(url, { headers: { Range: 'bytes=0-0' } }, 6000);
    checkLimited(res, ctrl);
    const cr = res.headers.get('content-range');
    let n = cr ? Number(cr.split('/')[1]) : 0;
    if (!n && res.status === 200) n = Number(res.headers.get('content-length'));
    ctrl.abort();
    return n > 0 ? n : null;
  } catch (e) {
    if (e instanceof RateLimited) throw e;
    return null;
  }
}

function queueSize(it) {
  if (it.sizeState === 'skipped' && cfg.lookUpSizes) it.sizeState = 'pending'; // setting turned back on
  if (it.sizeState !== 'pending') return;
  const gen = generation;
  const url = it.url;
  if (sizeCache.has(url)) {
    finishSize(it, sizeCache.get(url));
    return;
  }
  if (!cfg.lookUpSizes) {
    it.sizeState = 'skipped'; // Settings: only sizes the page revealed
    scheduleRender();
    return;
  }
  it.sizeState = 'queued';
  netSchedule(
    url,
    async () => {
      if (gen !== generation || it.sizeState !== 'queued') return;
      if (!cfg.lookUpSizes) {
        it.sizeState = 'skipped'; // turned off in Settings meanwhile
        return;
      }
      if (it.url !== url) {
        it.sizeState = 'pending';
        return queueSize(it); // main link changed meanwhile
      }
      it.sizeState = 'loading';
      let size;
      try {
        size = await fetchSize(url);
      } catch (e) {
        it.sizeState = 'queued'; // retried after the pause
        throw e;
      }
      sizeCache.set(url, size);
      if (size != null) saveProbeCache();
      if (gen === generation && it.url === url) finishSize(it, size);
    },
    {
      prio: () => screenPrio(it),
      giveUp: () => gen === generation && finishSize(it, null),
    }
  );
}

function finishSize(it, size) {
  if (it.size == null) it.size = size;
  it.sizeState = it.size != null ? 'done' : 'na';
  scheduleRender();
}

// ---------------------------------------------------------------------------
// Filtering, sorting, grouping
// ---------------------------------------------------------------------------

/** Kind switch, Formats menu and search box. */
function filterFn() {
  const q = state.filter.trim().toLowerCase();
  const hidden = new Set(prefs.hiddenFormats);
  return (it) =>
    (prefs.kind === 'all' || it.kind === prefs.kind) &&
    !hidden.has(it.format) &&
    (!q || [it.name, it.url, it.title, it.format, it.domain, ...it.alts].some((f) => f && f.toLowerCase().includes(q)));
}

/** A sorted copy of `items` by the chosen sort. */
function sortItems(items) {
  const list = [...items];
  const key = {
    order: (it) => it.order,
    name: (it) => it.name.toLowerCase(),
    size: (it) => it.size,
    type: (it) => it.format,
    duration: (it) => it.duration,
    resolution: (it) => (it.width && it.height ? it.width * it.height : null),
    domain: (it) => it.domain,
  }[prefs.sortBy] || ((it) => it.order);

  const dir = prefs.sortDir === 'desc' ? -1 : 1;
  list.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka == null && kb == null) return a.order - b.order;
    if (ka == null) return 1; // unknowns always last
    if (kb == null) return -1;
    const c = typeof ka === 'string' ? ka.localeCompare(kb, undefined, { numeric: true }) : ka - kb;
    return c * dir || a.order - b.order;
  });
  return list;
}

function groupItems(list) {
  const by = prefs.groupBy;
  if (by === 'none') return [{ key: 'all', label: null, items: list }];

  const groups = new Map();
  const put = (key, label, rank, it) => {
    if (!groups.has(key)) groups.set(key, { key, label, rank, items: [] });
    groups.get(key).items.push(it);
  };

  for (const it of list) {
    if (by === 'type') put(it.format, FORMAT_LABEL[it.format] || it.format, it.format, it);
    else if (by === 'domain') put(it.domain, it.domain, it.domain, it);
    else if (by === 'source') {
      const s = primarySource(it);
      put(s, s, SOURCE_ORDER.indexOf(s), it);
    } else if (by === 'size') {
      const idx = it.size == null ? 4 : SIZE_BUCKETS.findIndex((b) => b.max != null && it.size < b.max);
      const b = SIZE_BUCKETS[idx];
      put(b.key, b.label, idx, it);
    }
  }
  return [...groups.values()].sort((a, b) =>
    typeof a.rank === 'number' ? a.rank - b.rank : String(a.rank).localeCompare(String(b.rank))
  );
}

// ---------------------------------------------------------------------------
// Arrangement: files never move on their own
// ---------------------------------------------------------------------------
//
// The order (and grouping) of the list is worked out only when you choose a
// sort, direction or grouping, or press "Sort again" (and once when the popup
// opens). Live updates never re-sort: files keep their place even if their
// size or length shows up later, and new files are added at the bottom. With
// grouping on they go in a "New" group at the end, so no group above moves.

let arrangement = []; // [{ key, label, ids }]
const arranged = new Set(); // ids that have a place in `arrangement`

function arrange() {
  arrangement = groupItems(sortItems(state.items)).map((g) => ({
    key: g.key,
    label: g.label,
    ids: g.items.map((it) => it.id),
  }));
  arranged.clear();
  for (const g of arrangement) for (const id of g.ids) arranged.add(id);
}

/** What's on screen: the arrangement, filtered, plus new files at the bottom. */
function displayGroups() {
  const pass = filterFn();
  const byId = new Map(state.items.map((it) => [it.id, it]));
  const out = [];
  for (const g of arrangement) {
    const items = g.ids.map((id) => byId.get(id)).filter((it) => it && pass(it));
    if (items.length) out.push({ key: g.key, label: g.label, items });
  }
  const fresh = state.items.filter((it) => !arranged.has(it.id) && pass(it)).sort((a, b) => a.order - b.order);
  if (fresh.length) {
    if (prefs.groupBy === 'none') {
      if (out.length) out[out.length - 1].items.push(...fresh);
      else out.push({ key: 'all', label: null, items: fresh });
    } else {
      out.push({ key: 'new', label: 'New (added since the list was sorted)', items: fresh });
    }
  }
  return out;
}

const flatten = (groups) => groups.flatMap((g) => g.items);

/** True if sorting now would put things in a different order than shown. */
function outOfOrder(groups) {
  const shown = flatten(groups).map((it) => it.id).join();
  const sorted = flatten(groupItems(sortItems(state.items.filter(filterFn())))).map((it) => it.id).join();
  return shown !== sorted;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function thumbHTML(it, { overlays = false } = {}) {
  const ph = fileIcon(it);
  return `
    <div class="thumb" data-thumb="${it.id}" data-preview="${it.id}">
      <div class="ph">${ph}<span>${esc(it.format)}</span></div>
      ${overlays ? `<span class="overlay tl">${esc(it.format)}</span>` : ''}
      ${overlays && it.duration != null ? `<span class="overlay br">${formatDuration(it.duration)}</span>` : ''}
    </div>`;
}

function linkTitle(it) {
  if (!it.alts.length) return it.url;
  return `${it.url}\n\nSame file also found at:\n${it.alts.join('\n')}`;
}

function linkHTML(it) {
  if (it.isBlob) return `<span class="link" title="${esc(it.url)}">${esc(it.url)}</span>`;
  const shown = it.isData ? `${it.url.slice(0, 48)}…` : it.url;
  return `<a class="link" href="${esc(it.url)}" data-action="open" data-id="${it.id}" title="${esc(linkTitle(it))}">${esc(shown)}</a>`;
}

function altsText(it) {
  const n = it.alts.length;
  return n ? `+${n} other link${n === 1 ? '' : 's'}` : null;
}

function actionsHTML(it, { labels = true, open = true } = {}) {
  const dlDisabled = canDownload(it) ? '' : 'disabled';
  return `
    <div class="actions">
      <div class="split">
        <button class="act dl" data-action="download" data-id="${it.id}" title="${esc(downloadHint(it))}" ${dlDisabled}>
          ${ICON.download}${labels ? '<span>Download</span>' : ''}
        </button>
        ${
          canCommand(it)
            ? `<button class="act dl caret" data-action="dl-menu" data-id="${it.id}" aria-haspopup="menu" aria-expanded="false" title="Copy a download command (curl, wget, PowerShell, yt-dlp…)">${ICON.caret}</button>`
            : `<button class="act dl caret" disabled title="${esc(
                it.isBlob ? 'blob: links only exist inside the page, so no command can download them' : 'Inline data has no link to download from'
              )}">${ICON.caret}</button>`
        }
      </div>
      <button class="act" data-action="copy" data-id="${it.id}" title="Copy link">${ICON.copy}</button>
      ${
        !open
          ? ''
          : it.isBlob
            ? `<button class="act" disabled title="blob: links only work inside the page itself">${ICON.open}</button>`
            : `<button class="act" data-action="open" data-id="${it.id}" title="Open in new tab">${ICON.open}</button>`
      }
    </div>`;
}

function sizeText(it) {
  if (['pending', 'queued', 'loading'].includes(it.sizeState)) return '…';
  return formatSize(it.size);
}

function badges(it) {
  if (it.isBlob && it.blobKind === 'stream') return '<span class="badge stream">STREAM</span>';
  if (it.playlist) return '<span class="badge stream">PLAYLIST</span>';
  if (it.segment) return '<span class="badge">SEGMENT</span>';
  return '';
}

function metaLine(it, parts) {
  return parts.filter((p) => p && p !== '—').join(' · ');
}

// Items that showed up via a live update get a fading highlight. The negative
// animation-delay keeps the fade going smoothly across re-renders.
function newAge(it) {
  return it.newAt ? Date.now() - it.newAt : Infinity;
}
function newCls(it) {
  return newAge(it) < NEW_HIGHLIGHT_MS ? ' is-new' : '';
}
function newStyle(it) {
  const age = newAge(it);
  return age < NEW_HIGHLIGHT_MS ? ` style="--new-delay:-${Math.round(age)}ms"` : '';
}

const views = {
  icons(items) {
    return `<div class="view-icons">${items
      .map(
        (it) => `
        <div class="card${newCls(it)}"${newStyle(it)} data-item="${it.id}">
          ${thumbHTML(it, { overlays: true })}
          <div class="name" title="${esc(it.name)}">${esc(it.name)}</div>
          ${linkHTML(it)}
          <div class="meta">${badges(it)} ${esc(metaLine(it, [sizeText(it), formatRes(it)]))}</div>
          ${actionsHTML(it, { open: false })}
        </div>`
      )
      .join('')}</div>`;
  },

  tiles(items) {
    return `<div class="view-tiles">${items
      .map(
        (it) => `
        <div class="tile${newCls(it)}"${newStyle(it)} data-item="${it.id}">
          ${thumbHTML(it, { overlays: true })}
          <div class="info">
            <div class="name" title="${esc(it.name)}">${esc(it.name)} ${badges(it)}</div>
            ${it.title ? `<div class="sub" title="${esc(it.title)}">${esc(it.title)}</div>` : ''}
            ${linkHTML(it)}
            <div class="meta">${esc(
              metaLine(it, [
                FORMAT_LABEL[it.format] || it.format,
                sizeText(it),
                formatRes(it),
                formatDuration(it.duration),
                `Found via ${it.sources.join(', ')}`,
                altsText(it),
              ])
            )}</div>
          </div>
          ${actionsHTML(it)}
        </div>`
      )
      .join('')}</div>`;
  },

  list(items) {
    return `<div class="view-list">${items
      .map(
        (it) => `
        <div class="row${newCls(it)}"${newStyle(it)} data-item="${it.id}">
          <span class="ficon" data-preview="${it.id}">${fileIcon(it)}</span>
          <span class="name hoverable" data-preview="${it.id}">${esc(it.name)}</span>
          ${linkHTML(it)}
          <span class="size">${sizeText(it)}</span>
          ${actionsHTML(it, { labels: false })}
        </div>`
      )
      .join('')}</div>`;
  },

  details(items) {
    const cols = [
      { key: 'name', label: 'Name', w: '20%' },
      { key: 'type', label: 'Type', w: '68px' },
      { key: 'size', label: 'Size', w: '66px' },
      { key: 'resolution', label: 'Resolution', w: '80px' },
      { key: 'duration', label: 'Length', w: '62px' },
      { key: null, label: 'Found via', w: '88px' },
      { key: null, label: 'Link', w: 'auto' },
      { key: null, label: '', w: '118px' },
    ];
    const arrow = prefs.sortDir === 'asc' ? '▲' : '▼';
    return `
      <div class="table-wrap"><table>
        <colgroup>${cols.map((c) => `<col style="width:${c.w}">`).join('')}</colgroup>
        <thead><tr>${cols
          .map(
            (c) =>
              `<th class="${c.key ? 'sortable' : ''}" ${c.key ? `data-sort="${c.key}"` : ''}>${esc(c.label)}${
                c.key && prefs.sortBy === c.key ? `<span class="arrow">${arrow}</span>` : ''
              }</th>`
          )
          .join('')}</tr></thead>
        <tbody>${items
          .map(
            (it) => `
            <tr class="${newCls(it).trim()}"${newStyle(it)} data-item="${it.id}">
              <td><div class="name hoverable" data-preview="${it.id}">${esc(it.name)}</div></td>
              <td><span class="badge${it.playlist || it.blobKind === 'stream' ? ' stream' : ''}">${esc(it.format)}</span></td>
              <td class="num">${sizeText(it)}</td>
              <td class="num">${formatRes(it)}</td>
              <td class="num">${formatDuration(it.duration)}</td>
              <td title="${esc(it.sources.join(', '))}">${esc(primarySource(it))}</td>
              <td>${linkHTML(it)}</td>
              <td>${actionsHTML(it, { labels: false })}</td>
            </tr>`
          )
          .join('')}</tbody>
      </table></div>`;
  },
};

function fileIcon(it) {
  if (it.kind === 'gif') return ICON.image;
  return it.playlist ? ICON.stream : ICON.film;
}

function emptyHTML() {
  if (state.scanning) return '<div class="empty"><div><strong>Scanning page…</strong></div></div>';
  if (!state.items.length) {
    const why = state.scanError
      ? `<p>This page can't be scanned (${esc(state.scanError)}). Browser pages like chrome:// and the Web Store are off-limits to extensions.</p>`
      : '<p>No videos or GIFs were found on this page yet. The list updates by itself — if a video is still loading, press play and it will show up once the player fetches it.</p>';
    return `<div class="empty"><div><strong>Nothing found yet</strong>${why}</div></div>`;
  }
  const hidden = new Set(prefs.hiddenFormats);
  const ofKind = state.items.filter((it) => prefs.kind === 'all' || it.kind === prefs.kind);
  if (ofKind.length && ofKind.every((it) => hidden.has(it.format))) {
    return `<div class="empty"><div><strong>Every format here is hidden</strong><p>${ofKind.length} ${
      ofKind.length === 1 ? 'file is' : 'files are'
    } hidden by the Formats menu.</p><button class="btn" data-fmt-all>Show all formats</button></div></div>`;
  }
  if (!state.filter.trim()) {
    const what = prefs.kind === 'gif' ? 'GIFs' : 'videos';
    return `<div class="empty"><div><strong>No ${what} on this page</strong><p>Switch to “All” to see everything that was found.</p></div></div>`;
  }
  return `<div class="empty"><div><strong>No matches</strong><p>Nothing matches “${esc(state.filter)}”.</p></div></div>`;
}

function render() {
  const groups = displayGroups();
  renderContent(groups);
  renderChrome(groups);
}

function renderContent(groups) {
  const view = views[prefs.view] || views.icons;

  if (!groups.length) {
    els.content.innerHTML = emptyHTML();
  } else {
    els.content.innerHTML = groups
      .map((g) => {
        const ck = `${prefs.groupBy}:${g.key}`;
        const collapsed = state.collapsed.has(ck);
        const total = g.items.reduce((s, it) => s + (it.size || 0), 0);
        const header = g.label
          ? `<button class="group-header" data-group="${esc(ck)}">${ICON.chevron}<span>${esc(g.label)}</span>
               <span class="count">${g.items.length} ${g.items.length === 1 ? 'file' : 'files'}${
                 total ? ` · ${formatSize(total)}` : ''
               }</span></button>`
          : '';
        return `<section class="group${collapsed ? ' collapsed' : ''}">${header}<div class="group-body">${view(
          g.items
        )}</div></section>`;
      })
      .join('');

    // Re-attach cached thumbnail elements (keeps loaded videos alive across re-renders).
    const byId = new Map(state.items.map((it) => [it.id, it]));
    for (const slot of els.content.querySelectorAll('[data-thumb]')) {
      const it = byId.get(slot.dataset.thumb);
      const el = it && getThumb(it);
      if (!el) continue;
      slot.prepend(el);
      // A GIF that was playing keeps playing only if the mouse is still on it.
      if (el.classList?.contains('playing') && slot.dataset.thumb !== hoverThumbId) setGifPlaying(slot, false);
    }
  }
  observeItems();
}

/** Status bar, kind counts, Formats button and footer buttons. */
function renderChrome(groups = displayGroups()) {
  const list = flatten(groups);
  const total = state.items.length;
  const gifCount = state.items.filter((it) => it.kind === 'gif').length;
  const counts = { all: total, video: total - gifCount, gif: gifCount };
  for (const b of els.kindSwitch.querySelectorAll('button')) {
    b.querySelector('.n').textContent = state.scanning ? '' : counts[b.dataset.kind];
  }
  const known = state.items.reduce((s, it) => s + (it.size || 0), 0);
  const pendingSizes = state.items.some((it) => ['pending', 'queued', 'loading'].includes(it.sizeState));
  let status = state.scanning ? 'Scanning…' : countLabel(state.items);
  if (!state.scanning && known) status += ` · ${formatSize(known)}${pendingSizes ? '+' : ''}`;
  if (list.length !== total) status += ` · ${list.length} shown`;
  els.status.textContent = status;
  els.live.hidden = !!state.scanError || state.scanning;
  els.resort.hidden = state.scanning || !list.length || !outOfOrder(groups);
  renderFormats();

  const downloadable = list.filter(canDownload);
  els.downloadAll.disabled = !downloadable.length;
  els.downloadAllMenu.disabled = !downloadable.some(canCommand);
  els.copyAll.disabled = !list.length;
  els.downloadAll.textContent = state.confirmAll
    ? `Download ${downloadable.length} files?`
    : `Download all${downloadable.length ? ` (${downloadable.length})` : ''}`;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function syncControls() {
  for (const b of els.viewSwitch.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.view === prefs.view));
  }
  for (const b of els.kindSwitch.querySelectorAll('button')) {
    b.setAttribute('aria-checked', String(b.dataset.kind === prefs.kind));
  }
  els.groupBy.value = prefs.groupBy;
  els.sortBy.value = prefs.sortBy;
  const asc = prefs.sortDir === 'asc';
  els.sortDir.title = asc ? 'Ascending' : 'Descending';
  els.sortDir.innerHTML = asc
    ? '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 11l6-6 6 6"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
}

function setPref(key, value) {
  hidePreview();
  prefs[key] = value;
  chrome.storage.local.set({ prefs }).catch(() => {});
  syncControls();
  // Only choosing how to sort or group rearranges the list.
  if (key === 'sortBy' || key === 'sortDir' || key === 'groupBy') arrange();
  render();
  if (key === 'sortBy' && needsAllMeta()) state.items.forEach(queueProbe);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function makeFilename(it) {
  let base = it.name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150);
  if (!base) base = 'video';
  let ext = it.format;
  if (ext === 'BLOB' || ext === 'VIDEO') {
    const m = (it.mime || '').match(/^video\/([a-z0-9]+)/i);
    ext = m ? MIME_FORMAT[`video/${m[1].toLowerCase()}`] || m[1] : 'MP4';
  }
  if (ext === 'MPEG') ext = 'MPG';
  const suffix = `.${ext.toLowerCase()}`;
  if (!base.toLowerCase().endsWith(suffix) && !EXT_IN_URL.test(base)) base += suffix;
  return base;
}

async function download(it) {
  if (!canDownload(it)) {
    toast('This stream can’t be downloaded directly');
    return false;
  }
  const filename = makeFilename(it);
  try {
    if (it.isBlob) {
      await chrome.scripting.executeScript({
        target: { tabId: state.tab.id, frameIds: [it.frameId || 0] },
        func: downloadInPage,
        args: [it.url, filename],
      });
    } else {
      try {
        await chrome.downloads.download({ url: it.url, filename });
      } catch {
        // Some filenames are rejected by Chrome; let it pick one instead.
        await chrome.downloads.download({ url: it.url });
      }
    }
    return true;
  } catch (e) {
    toast(`Download failed: ${e.message || e}`);
    return false;
  }
}

function openItem(it) {
  if (it.isBlob) return;
  chrome.tabs.create({ url: it.url, active: true, index: state.tab.index + 1 });
}

els.content.addEventListener('click', async (e) => {
  const groupBtn = e.target.closest('[data-group]');
  if (groupBtn) {
    const k = groupBtn.dataset.group;
    state.collapsed.has(k) ? state.collapsed.delete(k) : state.collapsed.add(k);
    groupBtn.parentElement.classList.toggle('collapsed');
    return;
  }

  const th = e.target.closest('th[data-sort]');
  if (th) {
    const key = th.dataset.sort;
    if (prefs.sortBy === key) prefs.sortDir = prefs.sortDir === 'asc' ? 'desc' : 'asc';
    else {
      prefs.sortBy = key;
      prefs.sortDir = 'asc';
    }
    setPref('sortBy', prefs.sortBy);
    return;
  }

  const actEl = e.target.closest('[data-action]');
  if (!actEl) return;
  e.preventDefault();
  const it = state.items.find((x) => x.id === actEl.dataset.id);
  if (!it) return;

  switch (actEl.dataset.action) {
    case 'download':
      if (await download(it)) toast(`Downloading ${makeFilename(it)}`);
      break;
    case 'copy':
      await copyText(it.url);
      toast('Link copied');
      break;
    case 'open':
      openItem(it);
      break;
    case 'dl-menu':
      toggleCmdMenu(it, actEl);
      break;
  }
});

els.kindSwitch.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]');
  if (b) {
    state.confirmAll = false;
    setPref('kind', b.dataset.kind);
  }
});
els.viewSwitch.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) setPref('view', b.dataset.view);
});
els.groupBy.addEventListener('change', () => setPref('groupBy', els.groupBy.value));
els.sortBy.addEventListener('change', () => setPref('sortBy', els.sortBy.value));
els.sortDir.addEventListener('click', () => setPref('sortDir', prefs.sortDir === 'asc' ? 'desc' : 'asc'));
els.filter.addEventListener('input', () => {
  state.filter = els.filter.value;
  state.confirmAll = false;
  render();
});
els.rescan.addEventListener('click', () => scan({ manual: true }));
els.resort.addEventListener('click', () => {
  hidePreview();
  arrange();
  render();
});

els.copyAll.addEventListener('click', async () => {
  const list = flatten(displayGroups());
  await copyText(list.map((it) => it.url).join('\n'));
  toast(`Copied ${list.length} link${list.length === 1 ? '' : 's'}`);
});

let confirmTimer;
els.downloadAll.addEventListener('click', async () => {
  const list = flatten(displayGroups()).filter(canDownload);
  if (!list.length) return;
  if (list.length > 3 && !state.confirmAll) {
    state.confirmAll = true;
    renderChrome();
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      state.confirmAll = false;
      renderChrome();
    }, 4000);
    return;
  }
  clearTimeout(confirmTimer);
  state.confirmAll = false;
  els.downloadAll.disabled = true;
  // Regular files go to the background worker, which runs a few at a time (so
  // the site doesn't answer "too many requests") and keeps going after the
  // popup closes. In-page (blob:) files have to be saved from the page itself.
  const blobs = list.filter((it) => it.isBlob);
  const names = uniqueFilenames(list);
  const files = list.filter((it) => !it.isBlob).map((it) => ({ url: it.url, filename: names.get(it.id) }));
  let queued = 0;
  if (files.length) {
    try {
      queued = (await chrome.runtime.sendMessage({ type: 'downloadAll', files }))?.queued || 0;
    } catch (e) {
      toast(`Download failed: ${e.message || e}`);
    }
  }
  let ok = 0;
  for (const it of blobs) {
    if (await download(it)) ok++;
    await new Promise((r) => setTimeout(r, 150));
  }
  const total = queued + ok;
  if (total) {
    toast(
      queued > cfg.downloadsTotal
        ? `Downloading ${total} files, ${cfg.downloadsTotal} at a time. You can close this window.`
        : `Started ${total} of ${list.length} downloads`
    );
  }
  renderChrome();
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== els.filter) {
    e.preventDefault();
    els.filter.focus();
  }
});

// ---------------------------------------------------------------------------
// Formats menu: tick which formats (MP4, WEBM, GIF, M4S…) are listed.
// Hidden formats are remembered, so e.g. M4S stays hidden on every site.
// ---------------------------------------------------------------------------

// Short descriptions for the Formats menu (the format code is shown beside them).
const FORMAT_DESC = {
  MP4: 'MPEG-4 video',
  M4V: 'MPEG-4 video (Apple)',
  WEBM: 'WebM video',
  OGV: 'Ogg video',
  MOV: 'QuickTime video',
  MKV: 'Matroska video',
  AVI: 'AVI video',
  WMV: 'Windows Media video',
  FLV: 'Flash video',
  '3GP': 'Mobile video (3GP)',
  '3G2': 'Mobile video (3G2)',
  MPEG: 'MPEG video',
  TS: 'MPEG transport stream',
  M3U8: 'HLS playlist',
  MPD: 'DASH manifest',
  M4S: 'DASH segment',
  GIF: 'Animated image',
  BLOB: 'In-page video (blob:)',
  VIDEO: 'Unknown type',
};

function formatName(f) {
  return FORMAT_DESC[f] || 'Video';
}

/** Formats found on this page with their counts, in a stable order. */
function formatCounts() {
  const counts = new Map();
  for (const it of state.items) counts.set(it.format, (counts.get(it.format) || 0) + 1);
  return [...counts].sort((a, b) => a[0].localeCompare(b[0]));
}

function setHiddenFormats(list) {
  state.confirmAll = false;
  setPref('hiddenFormats', [...new Set(list)]);
}

let lastFormatsSig = null;

function renderFormats() {
  const hidden = new Set(prefs.hiddenFormats);
  const formats = formatCounts();
  const hiddenHere = formats.filter(([f]) => hidden.has(f));
  const filtered = hiddenHere.length > 0;
  els.formats.classList.toggle('filtered', filtered);
  els.formatsHidden.hidden = !filtered;
  els.formatsHidden.textContent = `${hiddenHere.length} hidden`;
  els.formats.title = filtered
    ? `Hidden: ${hiddenHere.map(([f]) => f).join(', ')}`
    : 'Choose which formats are listed';
  if (els.formatsPop.hidden) {
    lastFormatsSig = null;
    return;
  }
  // Only rebuild when something in the menu changed, so live updates don't
  // swap the elements out from under the mouse.
  const sig = JSON.stringify([formats, prefs.hiddenFormats]);
  if (sig === lastFormatsSig) return;
  lastFormatsSig = sig;

  const focused = document.activeElement?.closest?.('#formats-pop [data-format], #formats-pop [data-only]');
  const focusKey = focused ? `${focused.dataset.format ? 'f' : 'o'}:${focused.dataset.format || focused.dataset.only}` : null;
  const elsewhere = prefs.hiddenFormats.filter((f) => !formats.some(([g]) => g === f));

  els.formatsPop.innerHTML = `
    <div class="fmt-head"><span>Show these formats</span>
      <button data-fmt-all ${hidden.size ? '' : 'disabled'}>Show all</button></div>
    <div class="fmt-list">${
      formats.length
        ? formats
            .map(
              ([f, n]) => `
          <label class="fmt-row${hidden.has(f) ? ' off' : ''}" title="${esc(formatName(f))}">
            <input type="checkbox" data-format="${esc(f)}" aria-label="${esc(`${f}: ${formatName(f)}`)}" ${hidden.has(f) ? '' : 'checked'} />
            <span class="badge">${esc(f)}</span>
            <span class="fmt-label">${esc(formatName(f))}</span>
            <span class="fmt-n">${n}</span>
            <button class="fmt-only" data-only="${esc(f)}" title="Show only ${esc(f)}">Only</button>
          </label>`
            )
            .join('')
        : '<div class="fmt-foot" style="border:0">Nothing found yet.</div>'
    }</div>
    ${
      elsewhere.length
        ? `<div class="fmt-foot">Also kept hidden (not on this page): ${esc(elsewhere.join(', '))}</div>`
        : ''
    }`;

  if (focusKey) {
    const [t, f] = [focusKey[0], focusKey.slice(2)];
    const sel = t === 'f' ? `[data-format="${CSS.escape(f)}"]` : `[data-only="${CSS.escape(f)}"]`;
    els.formatsPop.querySelector(sel)?.focus();
  }
}

function openFormats(open) {
  els.formatsPop.hidden = !open;
  els.formats.setAttribute('aria-expanded', String(open));
  if (open) {
    hidePreview();
    renderFormats();
    els.formatsPop.querySelector('input, button:not(:disabled)')?.focus();
  }
}

els.formats.addEventListener('click', () => openFormats(els.formatsPop.hidden));

els.formatsPop.addEventListener('change', (e) => {
  const f = e.target.dataset?.format;
  if (!f) return;
  const rest = prefs.hiddenFormats.filter((x) => x !== f);
  setHiddenFormats(e.target.checked ? rest : [...rest, f]);
});

els.formatsPop.addEventListener('click', (e) => {
  const only = e.target.closest('[data-only]');
  if (only) {
    e.preventDefault(); // don't toggle the row's checkbox
    const keep = only.dataset.only;
    const others = formatCounts().map(([f]) => f).filter((f) => f !== keep);
    // Keep formats hidden on other pages hidden; everything else here but `keep` goes.
    setHiddenFormats([...prefs.hiddenFormats.filter((f) => f !== keep), ...others]);
  }
});

// "Show all" in the menu and in the empty state.
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-fmt-all]')) {
    setHiddenFormats([]);
    return;
  }
  // composedPath() still holds the original ancestors even if a re-render
  // has detached the clicked element in the meantime.
  const menu = els.formats.parentElement;
  if (!els.formatsPop.hidden && !e.composedPath().includes(menu)) openFormats(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.formatsPop.hidden) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openFormats(false);
    els.formats.focus();
  }
}, true);

// ---------------------------------------------------------------------------
// Download commands: the ▾ next to each Download button copies a command for
// curl, wget, PowerShell, yt-dlp, aria2c or ffmpeg, quoted for the chosen
// system (macOS / Linux shells, or Windows PowerShell).
// ---------------------------------------------------------------------------

function canCommand(it) {
  return !it.isBlob && !it.isData;
}

/** POSIX shells (bash, zsh): single quotes, with ' written as '\'' */
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
/** PowerShell: single quotes, doubling ' (PowerShell also treats ‘ ’ ‚ ‛ as quotes). */
const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, (m) => m + m)}'`;

function commandsFor(it, os, file = makeFilename(it)) {
  const q = os === 'win' ? psQuote : shQuote;
  const stem = file.replace(/\.[a-z0-9]{2,5}$/i, '');
  const pageUrl = state.tab?.url || '';
  const ref = prefs.cmdHeaders && /^https?:/i.test(pageUrl) ? pageUrl : null;
  const ua = prefs.cmdHeaders ? navigator.userAgent : null;
  const url = q(it.url);
  const opt = (flag, v, sep = ' ') => (v ? ` ${flag}${sep}${q(v)}` : '');

  const curl = os === 'win' ? 'curl.exe' : 'curl';
  // Retry options and aria2c connections come from the settings page.
  const retry = cfg.commandRetry;
  const conns = cfg.ariaConnections;
  const cmds = {
    curl: {
      label: 'curl',
      desc: os === 'win' ? 'Built into Windows 10 and 11' : 'Built into macOS and most Linux',
      cmd: `${curl} -fL${retry ? ' --retry 3' : ''} -o ${q(file)}${opt('-H', ref && `Referer: ${ref}`)}${opt('-A', ua)} ${url}`,
    },
    wget: {
      label: 'wget',
      desc: 'Most Linux; on macOS: brew install wget',
      cmd: `wget${retry ? ' --tries=3 --waitretry=10 --retry-on-http-error=429,503' : ''} -O ${q(file)}${opt('--referer', ref, '=')}${opt('--user-agent', ua, '=')} ${url}`,
    },
    powershell: {
      label: 'PowerShell',
      desc: 'Invoke-WebRequest, nothing to install',
      cmd:
        `$ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri ${url} -OutFile ${q(file)}` +
        `${opt('-UserAgent', ua)}${ref ? ` -Headers @{ Referer = ${q(ref)} }` : ''}`,
    },
    ytdlp: {
      label: 'yt-dlp',
      desc: it.playlist ? 'Downloads the whole stream (needs yt-dlp)' : 'Handles files and streams (needs yt-dlp)',
      // yt-dlp -o is a template: a literal % must be written %%.
      cmd: `yt-dlp${opt('--referer', ref)}${opt('--user-agent', ua)} -o ${q(
        it.playlist ? `${stem.replace(/%/g, '%%')}.%(ext)s` : file.replace(/%/g, '%%')
      )} ${url}`,
    },
    aria2c: {
      label: 'aria2c',
      desc: conns > 1 ? `Faster: ${conns} connections at once (needs aria2)` : 'One connection (needs aria2)',
      cmd: `aria2c -x ${conns} -s ${conns}${retry ? ' --retry-wait=10 --max-tries=5' : ''}${opt('--referer', ref, '=')}${opt('--user-agent', ua, '=')} -o ${q(file)} ${url}`,
    },
    ffmpeg: {
      label: 'ffmpeg',
      desc: 'Saves the stream as one MP4 (needs ffmpeg)',
      cmd: `ffmpeg${opt('-user_agent', ua)}${opt('-referer', ref)} -i ${url} -c copy ${q(`${stem}.mp4`)}`,
    },
  };

  const order = it.playlist
    ? ['ffmpeg', 'ytdlp', ...(os === 'win' ? ['curl', 'powershell'] : ['curl', 'wget'])]
    : os === 'win'
      ? ['curl', 'powershell', 'ytdlp', 'aria2c']
      : ['curl', 'wget', 'ytdlp', 'aria2c'];
  return order.map((id) => {
    const c = { id, ...cmds[id] };
    if (it.playlist && (id === 'curl' || id === 'wget' || id === 'powershell')) {
      c.desc = 'Saves only the playlist file, not the video';
    }
    return c;
  });
}

const PS_PROGRESS_OFF = "$ProgressPreference = 'SilentlyContinue'; ";

/** Files that "Download all" commands cover: what's shown, minus blob:/inline/streams. */
function batchItems() {
  return flatten(displayGroups()).filter((it) => canDownload(it) && canCommand(it));
}

/** Give every file its own name, so a batch never overwrites one file with another. */
function uniqueFilenames(items) {
  const used = new Set();
  const names = new Map();
  for (const it of items) {
    const base = makeFilename(it);
    const m = base.match(/^(.*?)(\.[a-z0-9]{2,5})?$/i);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${m[1]} (${n})${m[2] || ''}`;
    used.add(name.toLowerCase());
    names.set(it.id, name);
  }
  return names;
}

/**
 * Commands for many files at once. One line per file (pasting runs them one
 * after another), except aria2c, which gets the whole list on stdin and
 * downloads 2 files at a time (more tends to trip "too many requests"). Streaming playlists always get an ffmpeg line
 * (or yt-dlp), since curl/wget would only save the playlist file.
 */
function batchCommandsFor(items, os) {
  const q = os === 'win' ? psQuote : shQuote;
  const names = uniqueFilenames(items);
  const one = (it, tool) => commandsFor(it, os, names.get(it.id)).find((c) => c.id === tool)?.cmd || '';
  const line = (it, tool) => one(it, it.playlist && tool !== 'ytdlp' ? 'ffmpeg' : tool);
  const files = items.filter((it) => !it.playlist);
  const streams = items.filter((it) => it.playlist);

  const pageUrl = state.tab?.url || '';
  const ref = prefs.cmdHeaders && /^https?:/i.test(pageUrl) ? pageUrl : null;
  const ua = prefs.cmdHeaders ? navigator.userAgent : null;
  const opt = (flag, v) => (v ? ` ${flag}=${q(v)}` : '');

  const tools = os === 'win' ? ['curl', 'powershell', 'ytdlp', 'aria2c'] : ['curl', 'wget', 'ytdlp', 'aria2c'];
  const desc = {
    curl: 'One command per file, one after another',
    wget: 'One command per file, one after another',
    powershell: 'One command per file, nothing to install',
    ytdlp: 'One command per file (needs yt-dlp)',
    aria2c: '2 files at a time, usually fastest (needs aria2)',
  };
  const label = { curl: 'curl', wget: 'wget', powershell: 'PowerShell', ytdlp: 'yt-dlp', aria2c: 'aria2c' };

  return tools.map((tool) => {
    let cmd;
    if (tool === 'aria2c') {
      const parts = [];
      if (files.length) {
        // aria2 input list: a link, then indented options for that link.
        const list = files.map((it) => `${it.url}\n  out=${names.get(it.id)}`).join('\n');
        const bc = cfg.ariaBatchConnections;
        const head = `aria2c -j 2 -x ${bc} -s ${bc}${cfg.commandRetry ? ' --retry-wait=10 --max-tries=5' : ''}${opt('--referer', ref)}${opt('--user-agent', ua)} -i -`;
        parts.push(
          os === 'win'
            ? `@'\n${list}\n'@ | ${head}`
            : `${head} <<'VIDEO_EXPLORER_LIST'\n${list}\nVIDEO_EXPLORER_LIST`
        );
      }
      for (const it of streams) parts.push(line(it, 'ffmpeg'));
      cmd = parts.join('\n');
    } else if (tool === 'powershell') {
      cmd = PS_PROGRESS_OFF.trim() + '\n' + items.map((it) => line(it, tool).replace(PS_PROGRESS_OFF, '')).join('\n');
    } else {
      cmd = items.map((it) => line(it, tool)).join('\n');
    }
    return { id: tool, label: label[tool], desc: desc[tool], cmd };
  });
}

const cmdMenu = { el: $('#cmd-menu'), it: null, batch: false, anchor: null };

function menuHead(title, os) {
  return `
    <div class="cm-head">
      <span>${esc(title)}</span>
      <div class="seg cm-os" role="radiogroup" aria-label="System">
        <button data-os="unix" role="radio" aria-checked="${os === 'unix'}">macOS / Linux</button>
        <button data-os="win" role="radio" aria-checked="${os === 'win'}">Windows</button>
      </div>
    </div>`;
}

function menuFoot(os) {
  return `
    <label class="cm-opt" title="Some sites refuse downloads that don't look like they come from the page. Cookies are never included.">
      <input type="checkbox" data-headers ${prefs.cmdHeaders ? 'checked' : ''} />
      Send the page as Referer and this browser's User-Agent
    </label>
    ${os === 'win' ? '<div class="cm-foot">Paste into PowerShell or Windows Terminal.</div>' : '<div class="cm-foot">Paste into Terminal.</div>'}`;
}

function menuItems(cmds) {
  const preview = (cmd) => {
    const lines = cmd.split('\n');
    return lines.length > 6 ? `${lines.slice(0, 6).join('\n')}\n… ${lines.length - 6} more lines` : cmd;
  };
  return `<div class="cm-list">${cmds
    .map(
      (c) => `
      <button class="cm-item" role="menuitem" data-cmd="${c.id}" title="${esc(preview(c.cmd))}">
        <span class="cm-label">${esc(c.label)}</span>
        <span class="cm-desc">${esc(c.desc)}</span>
        <code class="cm-code">${esc(c.cmd.split('\n').find((l) => !l.startsWith('$ProgressPreference')) || '')}</code>
      </button>`
    )
    .join('')}</div>`;
}

function renderBatchMenu() {
  const os = prefs.cmdOs;
  const items = batchItems();
  const shown = flatten(displayGroups());
  const left = shown.filter((it) => !it.isBlob || it.blobKind !== 'stream').length - items.length;
  const streams = items.filter((it) => it.playlist).length;
  const notes = [];
  if (streams) notes.push(`${streams} streaming playlist${streams === 1 ? '' : 's'} will be saved with ffmpeg (or yt-dlp).`);
  if (left > 0) notes.push(`${left} in-page (blob:) file${left === 1 ? '' : 's'} can't be included; use Download all for ${left === 1 ? 'it' : 'those'}.`);
  cmdMenu.el.innerHTML = `
    ${menuHead(`Copy commands for ${items.length} file${items.length === 1 ? '' : 's'}`, os)}
    ${notes.map((n) => `<div class="cm-note info">${esc(n)}</div>`).join('')}
    ${menuItems(batchCommandsFor(items, os))}
    ${menuFoot(os)}`;
}

function renderCmdMenu() {
  if (cmdMenu.batch) return renderBatchMenu();
  const it = cmdMenu.it;
  if (!it) return;
  const os = prefs.cmdOs;
  const cmds = commandsFor(it, os);
  cmdMenu.el.innerHTML = `
    ${menuHead('Copy a download command', os)}
    ${it.playlist ? '<div class="cm-note">This is a streaming playlist: use ffmpeg or yt-dlp to get the actual video.</div>' : ''}
    ${menuItems(cmds)}
    ${menuFoot(os)}`;
}

function positionCmdMenu() {
  const a = cmdMenu.anchor;
  if (!a?.isConnected) return;
  const r = a.getBoundingClientRect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = cmdMenu.el.offsetWidth;
  const h = cmdMenu.el.offsetHeight;
  const m = 6;
  let x = r.right - w;
  let y = r.bottom + 4;
  if (y + h > H - m) y = r.top - h - 4; // flip above
  cmdMenu.el.style.left = `${Math.max(m, Math.min(x, W - w - m))}px`;
  cmdMenu.el.style.top = `${Math.max(m, Math.min(y, H - h - m))}px`;
}

function openCmdMenu(it, anchor) {
  hidePreview();
  closeCmdMenu();
  cmdMenu.it = it === 'all' ? null : it;
  cmdMenu.batch = it === 'all';
  cmdMenu.anchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  renderCmdMenu();
  cmdMenu.el.hidden = false;
  positionCmdMenu();
  cmdMenu.el.querySelector('.cm-item')?.focus();
}

function closeCmdMenu() {
  if (cmdMenu.el.hidden) return;
  cmdMenu.el.hidden = true;
  cmdMenu.anchor?.setAttribute('aria-expanded', 'false');
  cmdMenu.it = cmdMenu.anchor = null;
  cmdMenu.batch = false;
}

/** `it` is an item, or 'all' for the Download all menu. */
function toggleCmdMenu(it, anchor) {
  const same = it === 'all' ? cmdMenu.batch : cmdMenu.it === it;
  if (!cmdMenu.el.hidden && same) closeCmdMenu();
  else openCmdMenu(it, anchor);
}

cmdMenu.el.addEventListener('click', async (e) => {
  const osBtn = e.target.closest('[data-os]');
  if (osBtn) {
    prefs.cmdOs = osBtn.dataset.os;
    chrome.storage.local.set({ prefs }).catch(() => {});
    renderCmdMenu();
    positionCmdMenu();
    cmdMenu.el.querySelector(`[data-os="${prefs.cmdOs}"]`)?.focus();
    return;
  }
  const item = e.target.closest('[data-cmd]');
  if (item && cmdMenu.batch) {
    const items = batchItems();
    const c = batchCommandsFor(items, prefs.cmdOs).find((x) => x.id === item.dataset.cmd);
    if (!c || !items.length) return;
    await copyText(c.cmd);
    toast(`${c.label} commands for ${items.length} file${items.length === 1 ? '' : 's'} copied`);
    closeCmdMenu();
  } else if (item && cmdMenu.it) {
    const c = commandsFor(cmdMenu.it, prefs.cmdOs).find((x) => x.id === item.dataset.cmd);
    if (!c) return;
    await copyText(c.cmd);
    toast(`${c.label} command copied`);
    closeCmdMenu();
  }
});

cmdMenu.el.addEventListener('change', (e) => {
  if (!e.target.matches('[data-headers]')) return;
  prefs.cmdHeaders = e.target.checked;
  chrome.storage.local.set({ prefs }).catch(() => {});
  renderCmdMenu();
  cmdMenu.el.querySelector('[data-headers]')?.focus();
});

// Arrow keys move between commands; Esc closes.
cmdMenu.el.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...cmdMenu.el.querySelectorAll('.cm-item')];
  const i = items.indexOf(document.activeElement);
  const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
  if (next) {
    e.preventDefault();
    next.focus();
  }
});

document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && !cmdMenu.el.hidden) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const a = cmdMenu.anchor;
      closeCmdMenu();
      a?.focus();
    }
  },
  true
);

document.addEventListener('click', (e) => {
  if (cmdMenu.el.hidden) return;
  const path = e.composedPath();
  if (path.includes(cmdMenu.el) || path.some((n) => n?.dataset?.action === 'dl-menu' || n === els.downloadAllMenu)) return;
  closeCmdMenu();
});
els.content.addEventListener('scroll', closeCmdMenu, { passive: true });
els.downloadAllMenu.addEventListener('click', () => toggleCmdMenu('all', els.downloadAllMenu));
window.addEventListener('blur', closeCmdMenu);

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    const stored = await chrome.storage.local.get('prefs');
    Object.assign(prefs, stored.prefs || {});
  } catch {
    /* defaults */
  }
  syncControls();
  applySettings(await loadSettings(), { initial: true });
  watchSettings((s) => applySettings(s));
  await loadProbeCache();
  await listenForRateLimits();

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab;
  const host = safeURL(tab?.url || '')?.hostname;
  els.pageInfo.textContent = [tab?.title, host].filter(Boolean).join(' — ') || 'Current tab';
  els.pageInfo.title = tab?.url || '';
  await scan();
  startLiveUpdates();
}

/** Settings changed (or were just loaded): apply them to what's already in the list. */
function applySettings(s, { initial = false } = {}) {
  const before = cfg;
  cfg = resolve(s);
  if (initial) return;
  if (before.thumbnails === 'off' && cfg.thumbnails !== 'off') {
    for (const [url, el] of thumbCache) if (el == null) thumbCache.delete(url); // posters skipped while Off
  }
  if (cfg.onLimit !== 'stop') for (const h of hosts.values()) h.stopped = false;
  render();
  for (const it of state.items) {
    queueSize(it);
    queueProbe(it);
  }
  for (const h of hosts.values()) pumpHost(h);
  renderNetNote();
}

/**
 * The background worker sees the status of every response, including the
 * page's own and the thumbnails' (which media elements hide), and reports
 * sites that answer "too many requests".
 */
async function listenForRateLimits() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'rateLimited' && msg.host) rateLimit(hostEntry(msg.host), msg.ms ?? null);
  });
  try {
    const limits = await chrome.runtime.sendMessage({ type: 'getRateLimits' });
    for (const [host, l] of Object.entries(limits || {})) {
      if (!(l.until > Date.now())) continue;
      const h = hostEntry(host);
      h.until = l.until;
      h.slowUntil = l.until + NET.slowForMs;
      h.strikes = Math.max(h.strikes, l.strikes || 1);
    }
    startNetTicker();
  } catch {
    /* background not ready: it will still send new notices */
  }
}

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------

function startLiveUpdates() {
  // Background worker: a new video showed up in network traffic, or the tab navigated.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!state.tab || msg?.tabId !== state.tab.id) return;
    if (msg.type === 'networkUpdate') requestScan();
    else if (msg.type === 'tabNavigated') {
      resetItems();
      requestScan(600);
    }
  });

  // Watchers injected into the page's frames: DOM / media / resource changes.
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'video-explorer-watch') return;
    if (port.sender?.tab?.id !== state.tab?.id) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener(() => requestScan());
  });

  // Page finished loading (or a frame did): rescan and re-install watchers.
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== state.tab?.id) return;
    if (info.title) {
      state.tab.title = info.title;
      const host = safeURL(state.tab.url || '')?.hostname;
      els.pageInfo.textContent = [info.title, host].filter(Boolean).join(' — ');
    }
    if (info.url) state.tab.url = info.url;
    if (info.status === 'complete') requestScan();
  });

  // Safety net for things nothing else notices (e.g. changes inside shadow DOM).
  setInterval(() => {
    if (!document.hidden) requestScan(0);
  }, POLL_MS);
}

// ---------------------------------------------------------------------------
// Hover preview
// ---------------------------------------------------------------------------

const pv = {
  el: $('#preview'),
  video: $('#pv-video'),
  img: $('#pv-img'),
  msg: $('#pv-msg'),
  name: $('#pv-name'),
  meta: $('#pv-meta'),
  id: null,
  showTimer: null,
  hideTimer: null,
  muted: true, // remembered: unmute once and later previews play with sound
};

function stopPreviewVideo() {
  pv.video.pause();
  pv.video.removeAttribute('src');
  pv.video.removeAttribute('poster');
  delete pv.video.dataset.url;
  pv.video.load();
}

function stopPreviewImage() {
  pv.img.removeAttribute('src');
  delete pv.img.dataset.url;
}

function previewMeta(it) {
  return metaLine(it, [FORMAT_LABEL[it.format] || it.format, sizeText(it), formatRes(it), formatDuration(it.duration)]);
}

function setPreviewMessage(text, poster) {
  pv.el.classList.add('has-msg');
  pv.el.classList.remove('loading');
  pv.msg.textContent = text;
  pv.msg.style.backgroundImage = poster
    ? `linear-gradient(rgba(0,0,0,.6), rgba(0,0,0,.6)), url(${JSON.stringify(poster)})`
    : '';
}

function showPreview(it, anchor) {
  clearTimeout(pv.hideTimer);
  pv.id = it.id;
  pv.name.textContent = it.name;
  pv.name.title = it.url;
  pv.meta.textContent = previewMeta(it);
  pv.el.classList.remove('has-msg', 'loading');
  pv.el.classList.toggle('is-gif', it.kind === 'gif');
  pv.msg.textContent = '';
  pv.msg.style.backgroundImage = '';

  if (it.kind === 'gif' && !it.isBlob) {
    stopPreviewVideo();
    if (pv.img.dataset.url !== it.url) {
      pv.img.dataset.url = it.url;
      pv.el.classList.add('loading');
      pv.img.src = it.url;
      if (pv.img.complete && pv.img.naturalWidth) pv.el.classList.remove('loading');
    }
  } else if (it.isBlob) {
    stopPreviewImage();
    stopPreviewVideo();
    setPreviewMessage(
      it.blobKind === 'stream'
        ? 'This is a live MediaSource stream. It can only play inside the page itself.'
        : `This ${it.kind === 'gif' ? 'GIF' : 'video'} lives in the page’s memory (blob:) and can only be shown inside the page. You can still download it.`,
      it.poster
    );
  } else {
    stopPreviewImage();
    if (pv.video.dataset.url !== it.url) {
      stopPreviewVideo();
      pv.video.dataset.url = it.url;
      if (it.poster) pv.video.poster = it.poster;
      pv.video.src = it.url;
      pv.el.classList.add('loading');
    }
    pv.video.muted = pv.muted;
    pv.video.play().catch(() => {});
  }

  pv.el.hidden = false;
  positionPreview(anchor);
  requestAnimationFrame(() => pv.el.classList.add('show'));
}

function hidePreview() {
  clearTimeout(pv.showTimer);
  clearTimeout(pv.hideTimer);
  if (!pv.id && pv.el.hidden) return;
  pv.id = null;
  pv.el.classList.remove('show');
  pv.el.hidden = true;
  stopPreviewVideo();
  stopPreviewImage();
}

function scheduleHide() {
  clearTimeout(pv.hideTimer);
  pv.hideTimer = setTimeout(hidePreview, 250);
}

/** Place the window beside the hovered element, keeping it inside the popup. */
function positionPreview(anchor) {
  const r = anchor.getBoundingClientRect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const w = pv.el.offsetWidth;
  const h = pv.el.offsetHeight;
  const gap = 10;
  const m = 6;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const midY = r.top + r.height / 2 - h / 2;
  const midX = r.left + r.width / 2 - w / 2;
  let x;
  let y;
  if (r.right + gap + w <= W - m) [x, y] = [r.right + gap, midY];
  else if (r.left - gap - w >= m) [x, y] = [r.left - gap - w, midY];
  else if (r.bottom + gap + h <= H - m) [x, y] = [midX, r.bottom + gap];
  else if (r.top - gap - h >= m) [x, y] = [midX, r.top - gap - h];
  else [x, y] = [W - w - m, midY];
  pv.el.style.left = `${clamp(x, m, W - w - m)}px`;
  pv.el.style.top = `${clamp(y, m, H - h - m)}px`;
}

pv.video.addEventListener('playing', () => pv.el.classList.remove('loading'));
pv.video.addEventListener('loadeddata', () => pv.el.classList.remove('loading'));
pv.video.addEventListener('waiting', () => pv.video.dataset.url && pv.el.classList.add('loading'));
pv.video.addEventListener('volumechange', () => {
  if (pv.video.dataset.url) pv.muted = pv.video.muted;
});
pv.video.addEventListener('loadedmetadata', () => {
  const it = state.items.find((x) => x.id === pv.id);
  if (!it || pv.video.dataset.url !== it.url) return;
  const changed = applyMeta(it, {
    width: pv.video.videoWidth || null,
    height: pv.video.videoHeight || null,
    duration: Number.isFinite(pv.video.duration) ? pv.video.duration : null,
  });
  pv.meta.textContent = previewMeta(it);
  if (changed) scheduleRender();
});
pv.img.addEventListener('load', () => {
  pv.el.classList.remove('loading');
  const it = state.items.find((x) => x.id === pv.id);
  if (!it || pv.img.dataset.url !== it.url) return;
  if (applyMeta(it, { width: pv.img.naturalWidth || null, height: pv.img.naturalHeight || null, duration: null })) {
    scheduleRender();
  }
  pv.meta.textContent = previewMeta(it);
});
pv.img.addEventListener('error', () => {
  if (!pv.img.dataset.url) return;
  const it = state.items.find((x) => x.id === pv.id);
  setPreviewMessage('Couldn’t load this GIF here. The site may block it outside its own pages.', it?.poster);
});

pv.video.addEventListener('error', () => {
  if (!pv.video.dataset.url) return; // error from clearing src
  const it = state.items.find((x) => x.id === pv.id);
  setPreviewMessage(
    it?.playlist
      ? 'Streaming playlists can’t be played here. Copy the link and open it in a player like VLC.'
      : it?.segment
      ? 'This is one piece of a DASH stream. Pieces usually can’t play on their own because they need the stream’s init segment, but you can still download it.'
      : 'Couldn’t play this video here. The site may block playback outside its own pages.',
    it?.poster
  );
});

// Which file the mouse is on, tracked from events. (Right after a redraw
// Chrome may not have updated :hover yet, so don't rely on it for this.)
let hoverId = null;
let hoverThumbId = null;

els.content.addEventListener('mouseover', (e) => {
  const anchor = e.target.closest('[data-preview]');
  hoverId = anchor?.dataset.preview ?? null;
  hoverThumbId = e.target.closest('[data-thumb]')?.dataset.thumb ?? null;
  if (!anchor) return;
  const id = anchor.dataset.preview;
  clearTimeout(pv.hideTimer);
  if (pv.id === id) return;
  clearTimeout(pv.showTimer);
  pv.showTimer = setTimeout(
    () => {
      // A live re-render may have replaced the element under the cursor.
      const cur = anchor.isConnected ? anchor : els.content.querySelector(`[data-preview="${id}"]`);
      const it = state.items.find((x) => x.id === id);
      if (it && cur && hoverId === id && cmdMenu.el.hidden) showPreview(it, cur);
    },
    pv.id ? 120 : 350
  );
});

els.content.addEventListener('mouseout', (e) => {
  const anchor = e.target.closest('[data-preview]');
  if (!anchor || (e.relatedTarget && anchor.contains(e.relatedTarget))) return;
  if (hoverId === anchor.dataset.preview) hoverId = null;
  if (hoverThumbId === anchor.dataset.thumb) hoverThumbId = null;
  clearTimeout(pv.showTimer);
  if (pv.id) scheduleHide();
});

els.content.addEventListener('mouseleave', () => {
  hoverId = hoverThumbId = null;
});

// GIF thumbnails animate only while hovered.
els.content.addEventListener('mouseover', (e) => {
  const slot = e.target.closest('[data-thumb]');
  if (slot) setGifPlaying(slot, true);
});
els.content.addEventListener('mouseout', (e) => {
  const slot = e.target.closest('[data-thumb]');
  if (slot && !(e.relatedTarget && slot.contains(e.relatedTarget))) setGifPlaying(slot, false);
});

els.content.addEventListener('scroll', () => pv.id && hidePreview(), { passive: true });
pv.el.addEventListener('mouseenter', () => clearTimeout(pv.hideTimer));
pv.el.addEventListener('mouseleave', scheduleHide);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && pv.id) {
    e.preventDefault();
    hidePreview();
  }
});

init();
