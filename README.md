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
