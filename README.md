# Homicide Map

Mobile-first, black & white map application. Case coordinates are shown as
markers on the map; tapping a marker opens a scrollable overview bottom sheet
in the same page — no new window or navigation.

Plain HTML/CSS/JS with [Leaflet](https://leafletjs.com) (vendored in
`vendor/leaflet/`, no build step, no dependencies to install). Map tiles come
from OpenStreetMap and are rendered black & white with a CSS filter.

> **Note:** `data/cases.js` contains fictional demo records for layout testing
> only. Replace it with real, sourced data before publishing.

## Run it

Any static file server works. With Python (preinstalled on most systems):

```sh
cd Homicidemap
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

## Open it on your phone

1. Make sure your phone and computer are on the same Wi-Fi network.
2. Find your computer's local IP address:
   - macOS/Linux: `ip addr` or `ifconfig` (look for `192.168.x.x`)
   - Windows: `ipconfig`
3. On the phone's browser, open `http://<that-ip>:8000`.

Alternatively, enable **GitHub Pages** for this repository
(Settings → Pages → deploy from branch, root folder) and open the published
URL directly on the phone — no server needed.

## Preview it with Playwright

A Playwright script opens the app in a mobile-sized Chromium, taps a marker,
and captures screenshots — useful for checking layout without a phone.

```sh
npm install                 # installs playwright (pinned to 1.56.1)
npm run serve &             # or: python3 -m http.server 8000
npm run preview             # screenshots -> screenshots/
npm run preview -- --tiles  # use real OSM tiles instead of placeholders
```

The Playwright CLI is also available directly for one-off checks:

```sh
npx playwright screenshot --viewport-size=390,844 http://localhost:8000 shot.png
npx playwright open --viewport-size=390,844 http://localhost:8000   # interactive
npx playwright codegen http://localhost:8000                        # record actions
```

> Map tiles are stubbed with a placeholder grid by default, so previews also
> work on networks that block tile servers. Pass `--tiles` for the real map.

## Forum topic search (murha.info)

`scripts/murha-search.mjs` drives Playwright over the murha.info Rikosfoorumi
phpBB search and emits a JSON list of **topics only** (`sr=topics`, never
individual posts).

```sh
node scripts/murha-search.mjs \
  --keywords "kajaani henkirikos" --terms all \
  --overview --out data/kajaani-topics.json
```

Each entry is `{ topic, link, forum, author, date, overview, valid, reasoning,
needs_review }`. `valid` comes from a conservative keyword heuristic — it marks
a topic false when it reads as general discussion or lacks a Kajaani mention —
and every row carries `needs_review: true`, because deciding whether a thread
is a *specific case* is a judgement call the script should not make silently.

Then fetch every message of the selected topics — text, links and images —
walking each thread's pagination:

```sh
node scripts/murha-threads.mjs --limit 30 \
  --in data/kajaani-topics.json --out data/kajaani-cases.json
```

Output per case: `{ topic, link, forum, valid, reasoning, message_count,
messages: [{ index, author, date, text, links, images }] }`. Only topics
prefiltered `valid: true` are fetched unless you pass `--all`.

Test both scripts offline against a phpBB-shaped fixture (no network needed):

```sh
node scripts/fixtures/phpbb-fixture.mjs 8200 &
node scripts/murha-search.mjs  --base http://localhost:8200/rikosfoorumi \
  --delay 0 --out /tmp/topics.json
node scripts/murha-threads.mjs --base http://localhost:8200/rikosfoorumi \
  --delay 0 --in /tmp/topics.json --out /tmp/cases.json
```

Be considerate when running against the live forum: the default `--delay 1500`
throttles requests, and `--max-pages` bounds the crawl.

### Status / next session

The scrape has **not** been run yet: `murha.info` is denied by the sandbox's
egress policy (403 on CONNECT), so no data has been collected. Both scripts are
written and verified against the fixture above.

To run it, the environment needs network access to `murha.info` (claude.ai/code
→ environment → **Network access** → *Custom* + allowed domains, or *Full*),
then in a fresh session:

```sh
npm install
node scripts/murha-search.mjs  --keywords "kajaani henkirikos" --terms all --overview
node scripts/murha-threads.mjs --limit 30
```

Then review each `valid` / `reasoning` pair, keep the specific Kajaani cases,
and commit `data/kajaani-topics.json` + `data/kajaani-cases.json`.

Note: `publish_dir: .` in the deploy workflow means anything committed under
`data/` is also served publicly at `https://allutinn.github.io/Homicidemap/`.

## How it works

- `index.html` — single page: header, full-screen map, and a hidden bottom sheet.
- `css/style.css` — black & white theme. The tile layer gets
  `filter: grayscale(1) invert(1)` for a dark monochrome map; UI is pure
  black/white. The sheet has three states (`closed` / `open` ≈ 58% /
  `expanded` ≈ 92%) driven by CSS transforms.
- `js/app.js` — creates a Leaflet marker per record in `data/cases.js`.
  Marker tap fills the sheet and slides it up; the sheet's content area
  scrolls independently, and the grab handle can be dragged to expand,
  collapse, or close it.
- `data/cases.js` — the dataset: `{ id, title, coords, date, status, location, summary, details[] }`.
