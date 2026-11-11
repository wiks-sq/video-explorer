// Settings shared by the popup, the settings page and the background worker.
// Every setting defaults to 'auto'; resolve() turns the stored choices into
// the numbers and switches the code uses.

export const SETTINGS_KEY = 'settings';

export const DEFAULTS = {
  thumbnails: 'auto', // auto | all | off
  sizes: 'auto', // auto | page
  perSite: 'auto', // auto | 1..8   requests at once to one site
  gap: 'auto', // auto | ms         pause between two requests to one site
  onLimit: 'auto', // auto | stop | ignore   when a site answers "too many requests"
  remember: 'auto', // auto | off   keep sizes/lengths until the browser closes
  downloads: 'auto', // auto | 1..8 Download all: files at a time
  downloadRetry: 'auto', // auto | off
  ariaConnections: 'auto', // auto | 1..16
  commandRetry: 'auto', // auto | off
};

/** Stored settings merged over the defaults (unknown keys dropped). */
export function withDefaults(stored) {
  const s = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (stored && stored[k] != null) s[k] = String(stored[k]);
  return s;
}

export async function loadSettings() {
  try {
    const { [SETTINGS_KEY]: stored } = await chrome.storage.local.get(SETTINGS_KEY);
    return withDefaults(stored);
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s) {
  return chrome.storage.local.set({ [SETTINGS_KEY]: withDefaults(s) });
}

/** Call `cb(settings)` whenever they change (from the settings page or anywhere else). */
export function watchSettings(cb) {
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) cb(withDefaults(changes[SETTINGS_KEY].newValue));
  });
}

const num = (v, fallback) => (v === 'auto' || !Number.isFinite(Number(v)) ? fallback : Number(v));

/**
 * What the settings mean in practice. "Auto" values adapt: after a site
 * refuses, Auto drops to one request at a time with longer gaps for a minute;
 * a number you picked yourself stays fixed.
 */
export function resolve(s) {
  return {
    thumbnails: s.thumbnails, // 'auto' (on screen), 'all', 'off'
    lookUpSizes: s.sizes !== 'page',
    perSite: num(s.perSite, 2),
    perSiteAuto: s.perSite === 'auto',
    gapMs: num(s.gap, 250),
    gapAuto: s.gap === 'auto',
    onLimit: s.onLimit, // 'auto' (pause), 'stop', 'ignore'
    remember: s.remember !== 'off',
    downloadsTotal: num(s.downloads, 4),
    downloadsPerSite: s.downloads === 'auto' ? 2 : num(s.downloads, 2),
    downloadRetries: s.downloadRetry === 'off' ? 0 : 2,
    ariaConnections: num(s.ariaConnections, 4),
    ariaBatchConnections: num(s.ariaConnections, 2),
    commandRetry: s.commandRetry !== 'off',
  };
}

// The on/off switch in the popup. Kept apart from the settings above, which
// "Reset all to Auto" puts back; that shouldn't turn the extension on.
export const ENABLED_KEY = 'enabled';

export async function loadEnabled() {
  try {
    const { [ENABLED_KEY]: on } = await chrome.storage.local.get(ENABLED_KEY);
    return on !== false;
  } catch {
    return true;
  }
}

export function setEnabled(on) {
  return chrome.storage.local.set({ [ENABLED_KEY]: !!on });
}

/** Call `cb(on)` when the extension is switched on or off. */
export function watchEnabled(cb) {
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes[ENABLED_KEY]) cb(changes[ENABLED_KEY].newValue !== false);
  });
}
