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

The forum is phpBB 3.3 and fully server-rendered, so both scrapers use plain
HTTP plus a DOM parser ([linkedom](https://github.com/WebReflection/linkedom)) —
no browser. Shared fetch/parse helpers live in `scripts/lib/forum.mjs`, which
retries network errors and 5xx with exponential backoff.

### 1. Find the topics

`scripts/murha-search.mjs` walks the phpBB search and emits a JSON list of
**topics only** (`sr=topics`, never individual posts). Pass `--keywords` more
than once to run several searches and merge the results — Finnish case endings
are separate index words, so `kajaani`, `kajaanin` and `kajaanissa` each surface
threads the others miss.

```sh
node scripts/murha-search.mjs \
  --keywords kajaani --keywords kajaanin --keywords kajaanissa \
  --keywords kajaanilainen --keywords otanmäki --keywords vuolijoki \
  --terms all --overview --out data/kajaani-topics.json
```

Each entry is `{ topic, link, forum, author, date, replies, matched_keywords,
overview, valid, reasoning, needs_review }`.

`valid` answers one narrow question: **is this thread about Kajaani?** It is
true when the title names Kajaani or a place inside the municipality (Otanmäki,
Vuolijoki, Lehtikangas, Jormua, …), or when the opening post does *and* the
thread carries crime vocabulary. It deliberately does **not** claim the thread
is a homicide case — that judgement is left to review, which is why every row
carries `needs_review: true`.

The distinction matters for scale: a plain `kajaani` search returns hundreds of
threads, but most are large unrelated discussions where the word appears once,
several hundred pages deep. Those are excluded by `valid: false` with the
reasoning spelled out, so the exclusion can be audited rather than assumed.

### 2. Fetch every message

```sh
node scripts/murha-threads.mjs --in data/kajaani-topics.json \
  --out data/kajaani-cases.json --resume
```

Walks each selected thread's full pagination and captures every post:

```
{ topic, link, forum, valid, reasoning, needs_review,
  expected_message_count, message_count, truncated,
  messages: [ { index, post_id, permalink, author, date, date_text,
                text, quotes, links: [{text, href}], images: [src] } ] }
```

`date` is the ISO timestamp from the post's `<time datetime>`; `quotes` holds
the `blockquote` contents separately, so quoted material is not mistaken for a
poster's own words. `expected_message_count` comes from phpBB's own "N viestiä"
header and is compared against what was actually captured — any short or
`truncated` thread is listed at the end of the run.

Only topics prefiltered `valid: true` are fetched unless you pass `--all`.
Output is written after every topic, and `--resume` reuses what is already in
the output file, so an interrupted crawl continues where it stopped.

### Test offline

Both scripts run against a phpBB-shaped fixture, no network needed:

```sh
node scripts/fixtures/phpbb-fixture.mjs 8200 &
node scripts/murha-search.mjs  --base http://localhost:8200/rikosfoorumi \
  --delay 0 --overview --out /tmp/topics.json
node scripts/murha-threads.mjs --base http://localhost:8200/rikosfoorumi \
  --delay 0 --in /tmp/topics.json --out /tmp/cases.json
```

Be considerate when running against the live forum: the default `--delay 1200`
throttles requests, and `--max-pages` bounds the crawl.

> If the environment routes egress through an HTTPS proxy, run the scripts with
> `NODE_USE_ENV_PROXY=1` so Node's `fetch` honours `HTTPS_PROXY`.

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
