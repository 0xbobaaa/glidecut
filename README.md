# glidecut

Screen Studio-style screen recordings, free, in a browser tab.

**Try it:** https://glidecut.vercel.app

- record your screen (desktop Chrome / Edge)
- auto-zoom: zooms in where you click and type, pulls back on scroll or a page change
- 16:9, 9:16, 1:1, 4:5 — in vertical formats the frame follows the action
- backgrounds, padding, rounded corners, shadow
- edit zooms on a timeline: drag, resize, Delete, double-click to add, click the video to aim
- export MP4 1080p 60 fps with sound
- no install, no account, no upload: the video never leaves your tab

## How auto-zoom works without seeing your mouse

A web page can't see the cursor outside its own tab, so glidecut reads the pixels. It decodes the recording 12 times a second at 320 px wide and diffs each frame against the previous one.

- small changing spots (a click, typing, a button changing) → zoom in there
- most of the screen changing (scroll, new page, window switch) → zoom out
- the cursor itself is in the pixels too. Changes are split into connected blobs; 1–3 cursor-sized blobs that travel more than 6% of the screen width in half a second are a mouse move, not action, and are ignored

A critically damped spring turns the zoom targets into smooth camera motion. It is simulated once, so preview and export match.

## Run it locally

It's static files, no build step:

```
python3 -m http.server 8000
```

then open http://localhost:8000. `?demo=<url>` loads a video straight into the editor.

## Files

- `js/analyze.js` — frame diffing, cursor filter, zoom segments
- `js/camera.js` — spring camera
- `js/render.js` — layout, crop/fit, drawing a frame
- `js/export.js` — MP4 encoding with WebCodecs
- `js/timeline.js` — the editable timeline
- `js/app.js` — recording, loading, UI

## Credits

Built with Claude Code on Opus 5.5. Video decoding and MP4 muxing by [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0, `vendor/mediabunny.min.mjs`, unmodified, license in `vendor/mediabunny.LICENSE`).

glidecut itself is MIT.
