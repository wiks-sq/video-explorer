# Video Explorer (Chrome extension)

Click the toolbar icon to see every video file and GIF on the current page. Each one has its link, a download button, a copy-link button and an open-in-tab button.

<p align="center">
  <a href="https://buymeacoffee.com/marginnotes" target="_blank">
    <img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-ffdd00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee">
  </a>
</p>


## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this folder.
4. Pin **Video Explorer** from the puzzle-piece menu so it's always visible.

## Views (like a file explorer)

| View | What you get |
|---|---|
| **Large icons** | Thumbnail grid with format and duration overlays |
| **Tiles** | Thumbnail on the left; name, title, full link and all metadata on the right |
| **List** | One compact row per file: name, link, size |
| **Details** | Table with Name, Type, Size, Resolution, Length, Found via and Link. Click a column header to sort |

- **All / Videos / GIFs:** the switch at the top right picks what to show and how many of each were found. Download all and Copy all links only use what's shown.
- **Formats:** the Formats button next to the search box opens a checklist of every format found on the page (MP4, WebM, GIF, M4S, M3U8…) with how many of each there are. Untick a format to hide it, use **Only** to show just one, or **Show all** to reset. Hidden formats are remembered, so hiding M4S once keeps segments out of the list on every site. When something is hidden, the button turns blue and shows how many formats are hidden. Download all and Copy all links only use what's shown.
- **Files never move on their own:** the list is sorted and grouped only when you choose a sort, flip its direction, click a column header in Details, choose a grouping, or press **Sort again**. While the page loads more files, everything already shown keeps its place. Details such as size and length fill in where they are, and new files are added at the bottom. With grouping on, new files go in a **New** group at the end, so no group above them moves. When the list no longer matches the chosen sort, a **Sort again** button appears in the footer. Searching, the All / Videos / GIFs switch and the Formats menu only hide or show files; they don't re-sort.
- **Group by:** None, Type (MP4/WebM/GIF/HLS…), Domain, Found via (video tag, link, network…), Size range. Click a group header to collapse it.
- **Sort by:** Page order, Name, Size, Type, Duration, Resolution, Domain, ascending or descending.
- **Filter:** type to search names, links, titles and formats. Press `/` to jump to the filter box.
- Your view, grouping and sort choices are saved between uses.
- **Download commands:** the small ▾ next to every Download button opens a menu that copies a ready-to-paste command for that file. Pick **macOS / Linux** or **Windows** at the top (it's remembered, and it starts on the system you're using):
  - **macOS / Linux:** `curl` (built in), `wget` (most Linux; `brew install wget` on macOS), `yt-dlp`, `aria2c` (8 connections at once, often much faster).
  - **Windows** (PowerShell / Windows Terminal): `curl.exe` (built into Windows 10 and 11), PowerShell `Invoke-WebRequest` (nothing to install), `yt-dlp`, `aria2c`.
  - **Streaming playlists (M3U8 / MPD)** list `ffmpeg` and `yt-dlp` first, because they download the whole stream into one MP4; curl/wget would only save the playlist file.
  - By default the commands send the page as `Referer` and your browser's `User-Agent`, which many sites require. Untick the box in the menu to leave them out. Cookies are never included; if a site needs you to be logged in, try `yt-dlp --cookies-from-browser chrome <link>`.
  - **Download all** has the same ▾. It copies commands for every file currently shown, so search, the All / Videos / GIFs switch and the Formats menu decide what's included. curl, wget, PowerShell and yt-dlp get one line per file, run one after another. aria2c gets the whole list at once and downloads 4 files at a time. Streaming playlists in the list get an ffmpeg line (or yt-dlp) automatically. Files that would end up with the same name are numbered (`episode10.mp4`, `episode10 (2).mp4`) so nothing gets overwritten. `blob:` files can't be included, and the menu says how many were left out.
  - Everything is single-quoted for the chosen shell, so links with `&`, `$`, spaces or quotes paste safely. `blob:` and inline items have no link a command could use, so their ▾ is disabled.
- **Hover preview:** hold the mouse over a thumbnail (or over a file name in List and Details) and a small window plays the video or GIF. It starts muted. If you move the mouse into the window you can use its controls, including unmuting and full screen. Once you unmute, later previews keep the sound on. Press `Esc` to close it. 
- **Live updates:** while the popup is open, the list keeps updating. New videos are added as the page inserts them, as a player loads them, or as they show up in network traffic. Each one gets a short highlight and a "new video found" message, and the footer shows a green **LIVE** dot. Navigating to a new page starts the list fresh.
- **Download all** downloads every file that matches the current filter. It asks you to confirm when there are more than 3. **Copy all links** copies them as one link per line.

## How videos and GIFs are found

- `<video>` and `<source>` elements, including inside open shadow DOM and iframes
- Links (`<a href>`) to video files (`.mp4 .webm .mov .mkv .m3u8 .mpd …`)
- `og:video` / `twitter:player:stream` meta tags and JSON-LD `VideoObject`
- Resources the page has already loaded (Resource Timing API)
- **GIFs:** `<img>` tags, including lazy-load attributes like `data-src` and `srcset`; `<picture>` sources; inline `background-image` styles; links to `.gif` files; `og:image` tags; and `image/gif` network responses. Tracking pixels and spacers, meaning anything under 16×16 pixels or 2 KB, are skipped. GIF thumbnails show a still first frame and only play while the mouse is over them.
- **Duplicates:** many sites serve one file under several links, such as resized previews with `?width=…` parameters, or a name with a descriptive slug in front of the file id (`gif-heaven-v0-tbpo5on1810i1.gif` and `tbpo5on1810i1.gif`). These are shown as one item. The plain, original-looking link is kept as the main one, and the item keeps the most descriptive name. Tiles view shows "+N other links", and the link's tooltip lists them.
- **Network traffic:** the background worker records video and GIF responses for each tab, including ones a player fetches via script. If a list looks empty, press play and then click **Rescan**.

Sizes come from response headers, using a HEAD request or a 1-byte range request when needed. Resolution and duration come from loading each video's metadata.

## Limitations

- **`blob:` MediaSource streams** (YouTube, Netflix, most big platforms) are tagged **STREAM** and can't be downloaded directly, because the video only exists as chunks inside the player.
- **HLS (`.m3u8`) / DASH (`.mpd`)** items are tagged **PLAYLIST**. Downloading one saves the playlist file, not the video. To get the actual video, copy the link and use a tool such as `ffmpeg -i "<link>" -c copy out.mp4` or `yt-dlp`.
- **DASH segments (`.m4s`)** are listed and tagged **SEGMENT**. Each one is a few seconds of a stream, and they usually can't play on their own because they need the stream's init segment. Downloading one saves just that piece. A playing stream can add hundreds of them, up to 400 per tab, and that cap is separate from the one for regular videos. Group by **Type** to keep them in one collapsible "DASH segment (M4S)" group. HLS `.ts` segments are still skipped.
- Files that check the `Referer` header or need special auth may not download, or preview, outside the page.
- `blob:` videos can't be previewed in the popup, because they only exist inside the page. They can still be downloaded unless they're streams.
- Chrome blocks extensions on `chrome://` pages and the Chrome Web Store.

## Files

- `manifest.json`: Manifest V3 config
- `background.js`: per-tab network capture of video and GIF responses
- `scanner.js`: functions injected into the page: the scanner, the live-change watcher (which stops when the popup closes) and the in-page blob download helper
- `popup.html / popup.css / popup.js`: the explorer UI
- `icons/`: toolbar icons

## License

[MIT](LICENSE)
