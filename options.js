import { DEFAULTS, loadSettings, saveSettings, watchSettings } from './settings.js';

const n = (v, label, desc, warn) => ({ value: String(v), label, desc, warn });

/** Each setting: its options and what each one does. The first option is Auto. */
const SECTIONS = [
  {
    title: 'Loading thumbnails and details',
    intro: 'Thumbnails, lengths, resolutions and sizes are loaded from the site’s own servers.',
    settings: [
      {
        key: 'thumbnails',
        label: 'Thumbnails and lengths',
        options: [
          n('auto', 'Auto: as they scroll into view', 'Loads files on screen, and just around it, as you scroll. List view loads none, and Details only loads a file when its resolution or length is missing.'),
          n('all', 'All files when the popup opens', 'Loads every file right away, even ones you never scroll to. Sorting by length or resolution is complete sooner.', 'This makes many requests at once on pages with lots of videos.'),
          n('off', 'Off', 'No thumbnails and no extra requests for lengths or resolutions. You still see what the page itself reveals, and hovering a file still plays its preview.'),
        ],
      },
      {
        key: 'sizes',
        label: 'File sizes',
        options: [
          n('auto', 'Auto: look up missing sizes', 'Sizes the page already revealed are used as they are. The rest are looked up in the background, files on screen first.'),
          n('page', 'Only what the page revealed', 'No requests for sizes. Files the page didn’t reveal a size for show “—”.'),
        ],
      },
      {
        key: 'perSite',
        label: 'Requests at once, per site',
        options: [
          n('auto', 'Auto: 2, or 1 after a refusal', 'Two at a time. After a site says “too many requests”, one at a time for a minute.'),
          n(1, '1', 'One request at a time.'),
          n(2, '2', 'Two requests at a time.'),
          n(3, '3', 'Three requests at a time.'),
          n(4, '4', 'Four requests at a time.'),
          n(6, '6', 'Six requests at a time.', 'Strict sites may answer “too many requests”.'),
          n(8, '8', 'Eight requests at a time.', 'Strict sites may answer “too many requests”.'),
        ],
      },
      {
        key: 'gap',
        label: 'Pause between requests',
        options: [
          n('auto', 'Auto: 0.25 s, or 1.5 s after a refusal', 'A quarter of a second between two requests to one site. After a site says “too many requests”, 1.5 seconds for a minute.'),
          n(0, 'None', 'Requests start as soon as a slot is free.', 'Strict sites may answer “too many requests”.'),
          n(100, '0.1 s', 'A tenth of a second between two requests to one site.'),
          n(250, '0.25 s', 'A quarter of a second between two requests to one site.'),
          n(500, '0.5 s', 'Half a second between two requests to one site.'),
          n(1000, '1 s', 'One second between two requests to one site.'),
          n(2000, '2 s', 'Two seconds between two requests to one site.'),
        ],
      },
      {
        key: 'previewLimit',
        label: 'Largest file to preview',
        options: [
          n('auto', 'Auto: videos up to 1440p, GIFs up to 20 MB', 'Bigger files show “Too large to preview” instead of a thumbnail or hover preview, with a button to download them. Every frame of a 4K video takes 33 MB of memory to show, and a GIF is decoded whole, so many of them can crash the popup.'),
          n('4k', 'Videos up to 4K, GIFs up to 60 MB', 'Thumbnails and previews for 4K videos too.', 'Pages with many 4K videos or huge GIFs may crash the popup or the full tab.'),
          n('none', 'No limit', 'Every file gets a thumbnail and a preview, however big.', 'Pages with large videos or GIFs can crash the popup or the full tab.'),
        ],
      },
      {
        key: 'remember',
        label: 'Remember sizes and lengths',
        options: [
          n('auto', 'Auto: until the browser closes', 'Reopening the popup doesn’t ask the site for them again.'),
          n('off', 'Off', 'Every time the popup opens, sizes and lengths are loaded again.'),
        ],
        button: { id: 'forget', label: 'Forget remembered details' },
      },
    ],
  },
  {
    title: 'When a site says “too many requests”',
    intro: 'Sites answer with HTTP 429 (or 503) when they get more requests than they allow. This includes the page’s own requests.',
    settings: [
      {
        key: 'onLimit',
        label: 'What to do',
        options: [
          n('auto', 'Auto: pause, then go slower', 'Pauses that site for as long as it asks, or else 10 seconds, doubling each time it happens again (up to 2 minutes). Anything refused is tried again after the pause.'),
          n('stop', 'Stop loading from that site', 'No more thumbnails or sizes from that site until you reopen the popup. Download all still waits out the pause and carries on.'),
          n('ignore', 'Keep going', 'Doesn’t pause. Refused thumbnails and sizes are skipped.', 'The site may keep refusing, including the page’s own videos.'),
        ],
      },
    ],
  },
  {
    title: 'Download all',
    settings: [
      {
        key: 'downloads',
        label: 'Files at a time',
        options: [
          n('auto', 'Auto: 4, at most 2 per site', 'The rest wait their turn. Downloads keep going after you close the popup.'),
          n(1, '1', 'One file at a time.'),
          n(2, '2', 'Two files at a time.'),
          n(3, '3', 'Three files at a time.'),
          n(4, '4', 'Four files at a time, even from one site.'),
          n(6, '6', 'Six files at a time, even from one site.', 'Strict sites may refuse some of them.'),
          n(8, '8', 'Eight files at a time, even from one site.', 'Strict sites may refuse some of them.'),
        ],
      },
      {
        key: 'downloadRetry',
        label: 'Retry failed downloads',
        options: [
          n('auto', 'Auto: up to 2 times', 'A download the server refused or the connection dropped is tried again after a pause. Downloads you cancel are never retried.'),
          n('off', 'Off', 'Failed downloads stay failed. You can retry them from Chrome’s downloads page.'),
        ],
      },
    ],
  },
  {
    title: 'Copied download commands',
    intro: 'The curl, wget, PowerShell, yt-dlp and aria2c commands in the Download ▾ menus.',
    settings: [
      {
        key: 'ariaConnections',
        label: 'aria2c connections',
        options: [
          n('auto', 'Auto: 4 per file, 2 for Download all', 'One file uses 4 connections. Download all fetches 2 files at a time with 2 connections each.'),
          n(1, '1', 'One connection per file.'),
          n(2, '2', 'Two connections per file.'),
          n(4, '4', 'Four connections per file.'),
          n(8, '8', 'Eight connections per file.', 'Strict sites may answer “too many requests”.'),
          n(16, '16', 'Sixteen connections per file (aria2c’s maximum).', 'Strict sites may answer “too many requests”.'),
        ],
      },
      {
        key: 'commandRetry',
        label: 'Retry options in commands',
        options: [
          n('auto', 'Auto: on', 'curl, wget and aria2c commands wait and retry when the site says “too many requests”.'),
          n('off', 'Off', 'Shorter commands without retry options.'),
        ],
      },
    ],
  },
];

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let settings = { ...DEFAULTS };
const $ = (sel) => document.querySelector(sel);

function render() {
  $('#sections').innerHTML = SECTIONS.map(
    (sec) => `
    <section class="card">
      <div class="card-head">
        <h2>${esc(sec.title)}</h2>
        ${sec.intro ? `<p>${esc(sec.intro)}</p>` : ''}
      </div>
      ${sec.settings
        .map(
          (st) => `
        <div class="setting" data-key="${st.key}">
          <label for="s-${st.key}">${esc(st.label)}</label>
          <div class="control">
            <select id="s-${st.key}" data-key="${st.key}" aria-describedby="h-${st.key}">
              ${st.options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}
            </select>
            ${st.button ? `<button id="${st.button.id}" class="btn" type="button">${esc(st.button.label)}</button>` : ''}
          </div>
          <div class="help" id="h-${st.key}"></div>
        </div>`
        )
        .join('')}
    </section>`
  ).join('');
  sync();
}

/** Show the stored values, what each choice does, and which ones aren't Auto. */
function sync() {
  for (const sec of SECTIONS) {
    for (const st of sec.settings) {
      const sel = document.getElementById(`s-${st.key}`);
      const value = st.options.some((o) => o.value === settings[st.key]) ? settings[st.key] : 'auto';
      sel.value = value;
      const opt = st.options.find((o) => o.value === value);
      document.getElementById(`h-${st.key}`).innerHTML =
        esc(opt.desc) + (opt.warn ? `<p class="warn">${esc(opt.warn)}</p>` : '');
      sel.closest('.setting').classList.toggle('changed', value !== 'auto');
    }
  }
  $('#reset').disabled = Object.keys(DEFAULTS).every((k) => settings[k] === 'auto');
}

let savedTimer;
function flash(text) {
  const el = $('#saved');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

document.addEventListener('change', async (e) => {
  const key = e.target.dataset?.key;
  if (!key) return;
  settings = { ...settings, [key]: e.target.value };
  sync();
  await saveSettings(settings);
  flash('Saved');
});

$('#reset').addEventListener('click', async () => {
  settings = { ...DEFAULTS };
  sync();
  await saveSettings(settings);
  flash('All settings are back to Auto');
});

document.addEventListener('click', async (e) => {
  if (e.target.id !== 'forget') return;
  try {
    await chrome.storage.session.remove('probeCache');
    flash('Forgot remembered sizes and lengths');
  } catch {
    flash('Couldn’t clear them');
  }
});

// Another settings tab (or a reset elsewhere) changed something.
watchSettings((s) => {
  settings = s;
  sync();
});

loadSettings().then((s) => {
  settings = s;
  render();
});
