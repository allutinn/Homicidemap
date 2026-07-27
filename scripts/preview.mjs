/**
 * Open the app in a mobile-sized Chromium via Playwright and capture screenshots.
 *
 *   node scripts/preview.mjs [url]        # default http://localhost:8000
 *
 * Start a server first:  python3 -m http.server 8000
 * Screenshots are written to screenshots/ (git-ignored).
 *
 * Pass --tiles to load real OpenStreetMap tiles. By default tiles are stubbed
 * with a placeholder grid so the run works on networks that block tile servers.
 */
import { chromium, devices } from "playwright";
import { mkdir } from "node:fs/promises";

const url = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:8000";
const realTiles = process.argv.includes("--tiles");
const outDir = "screenshots";

const placeholderTile = (z, x, y) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
     <rect width="256" height="256" fill="#e8e8e8"/>
     <path d="M0 64h256M0 128h256M0 192h256M64 0v256M128 0v256M192 0v256"
           stroke="#cfcfcf" stroke-width="6"/>
     <text x="8" y="20" font-size="12" fill="#bbb" font-family="sans-serif">${z}/${x}/${y}</text>
   </svg>`;

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext(devices["iPhone 13"]);
const page = await context.newPage();

page.on("pageerror", (e) => console.error("[page error]", e.message));

if (!realTiles) {
  await page.route(/tile\.openstreetmap\.org\/(\d+)\/(\d+)\/(\d+)\.png/, (route) => {
    const [, z, x, y] = route.request().url().match(/(\d+)\/(\d+)\/(\d+)\.png/);
    route.fulfill({ contentType: "image/svg+xml", body: placeholderTile(z, x, y) });
  });
}

console.log("Opening", url);
await page.goto(url, { waitUntil: "load" });
await page.waitForTimeout(3000);
await page.screenshot({ path: `${outDir}/1-map.png` });

const markers = page.locator(".case-marker");
console.log("markers rendered:", await markers.count());

// Tap a marker and capture the case overview sheet.
await markers.first().tap();
await page.waitForTimeout(600);
await page.screenshot({ path: `${outDir}/2-sheet.png` });

// Expand the sheet to full height and scroll its content.
await page.evaluate(() => {
  document.getElementById("sheet").classList.add("expanded");
  document.getElementById("sheet-content").scrollTop = 150;
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/3-sheet-expanded.png` });

console.log(`Wrote 3 screenshots to ${outDir}/`);
await browser.close();
