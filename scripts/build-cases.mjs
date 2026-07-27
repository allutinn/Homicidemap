/**
 * Turn the curated case records into the map's dataset.
 *
 *   node scripts/build-cases.mjs [--in data/kajaani-homicides.json]
 *                               [--out data/cases.js]
 *                               [--cache data/geocode-cache.json]
 *
 * Each case carries a ranked `locations` array extracted from the forum thread,
 * most precise first, each tagged with how well it is supported (official /
 * news / forum_claim / rumour). This picks the best one that geocodes, resolves
 * it through OpenStreetMap Nominatim, and writes `data/cases.js` for the map.
 *
 * The marker therefore only ever sits where a source actually said it did, and
 * the record keeps `coords_precision` and `coords_credibility` so the UI can
 * say how exact the pin is. Cases whose only location is "Kajaani" land on the
 * town centroid and are marked `precision: "town"` — an area, not an address.
 *
 * Geocoding results are cached in --cache so reruns are offline and Nominatim
 * is queried at most once per distinct place string (1 req/s, as its usage
 * policy requires).
 */
import { readFile, writeFile } from "node:fs/promises";
import { arg, sleep } from "./lib/forum.mjs";

const IN = arg("in", "data/kajaani-homicides.json");
const OUT = arg("out", "data/cases.js");
const CACHE = arg("cache", "data/geocode-cache.json");

const UA = "HomicideMap/1.0 (https://github.com/allutinn/Homicidemap)";

/** Kajaani town centre — the fallback when nothing more precise resolves. */
const KAJAANI = { lat: 64.2273, lon: 27.7285, display_name: "Kajaani, Kainuu, Suomi" };

/**
 * Kajaani municipality bounding box. Searches are bounded to it so a street
 * name that also exists elsewhere in Finland cannot win.
 */
const VIEWBOX = "26.90,64.45,28.45,63.90"; // left,top,right,bottom

/**
 * Nominatim returns *something* for almost any string, and that something is
 * often the wrong kind of thing — "Laajakangas, Kajaani" matches a bus stop
 * 15 km out in Vuottolahti before it matches the residential district.
 *
 * Rather than enumerate every acceptable OSM type (venues alone run to
 * hospital, restaurant, fuel, pharmacy, bus_station, …), each precision level
 * just says which side of one line the result must fall on: is it a named
 * place on the ground, or an administrative area?
 */
const AREA_TYPES = new Set([
  "town", "city", "village", "hamlet", "suburb", "neighbourhood", "quarter",
  "city_district", "municipality", "locality", "administrative", "region",
  "county", "state", "isolated_dwelling",
]);

/** A result is acceptable when its kind matches what the precision implies. */
const typeOk = (precision, r) => {
  const t = r.addresstype ?? r.type;
  const isArea = AREA_TYPES.has(t);
  // A district or town must be an area; an address or street must not be.
  // (A bus stop is neither an area nor an address, so it fails both.)
  if (precision === "district" || precision === "town" || precision === "area") return isArea;
  return !isArea && t !== "bus_stop";
};

const cache = await readFile(CACHE, "utf8")
  .then(JSON.parse)
  .catch(() => ({}));

let queried = 0;

/** Raw Nominatim query, cached and rate-limited (policy: max 1 request/second). */
const search = async (query) => {
  if (query in cache) return cache[query];

  await sleep(queried++ ? 1100 : 0);
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "json",
      limit: "8",
      countrycodes: "fi",
      viewbox: VIEWBOX,
      bounded: "1",
      addressdetails: "1",
    });

  let results = [];
  try {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (res.ok) {
      results = (await res.json()).map((r) => ({
        lat: Number(r.lat),
        lon: Number(r.lon),
        display_name: r.display_name,
        type: r.type,
        addresstype: r.addresstype,
        address: r.address,
      }));
    } else {
      console.warn(`  geocode HTTP ${res.status} for "${query}"`);
    }
  } catch (e) {
    console.warn(`  geocode failed for "${query}": ${e.message}`);
  }

  cache[query] = results;
  return results;
};

const km = (a, b) => {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/**
 * Geocode one location entry.
 *
 * Three guards beyond a plain lookup:
 *
 *  - **Type.** The result must be the kind of OSM object the precision implies.
 *    A wrong-typed match is rejected outright, never accepted as a last resort:
 *    "Laajakangas, Kajaani" matches a bus stop 15 km out in Vuottolahti before
 *    it matches the residential district, and a bus stop is not a district.
 *  - **District anchor.** When the label names a district
 *    ("Vuorimiehentie, Otanmäki, Kajaani"), the result must sit near it. Street
 *    names repeat across the municipality, so without this the marker silently
 *    lands in the town centre instead of the village.
 *  - **Cascade.** The full label is tried first, then simpler forms, because
 *    Nominatim will not match a label that carries a venue name it has never
 *    heard of ("Nurmikantie / Sarapolku corner, Laajakangas, Kajaani").
 *
 * If only the district resolves, its centroid is used and the precision is
 * downgraded: a coarse marker in the right place beats an exact one in the
 * wrong place.
 */
const geocode = async (loc) => {
  const parts = loc.label.split(",").map((s) => s.trim());
  // "<place>, <district>, Kajaani" → district is the second-to-last part.
  const district = parts.length >= 3 ? `${parts[parts.length - 2]}, Kajaani` : null;

  let anchor = null;
  if (district) {
    const hits = await search(district);
    anchor = hits.find((h) => typeOk("district", h)) ?? null;
  }

  // Try the label as given, then progressively plainer forms. Sources write
  // things like "Nurmikantie / Sarapolku corner" — no gazetteer knows that
  // string, but it does know "Nurmikantie".
  const queries = [loc.label];
  if (parts.length >= 3) {
    for (const name of parts[0].split(/\s*[/&]\s*|\s+ja\s+/))
      queries.push(`${name.trim()}, Kajaani`);
  }

  for (const q of [...new Set(queries)]) {
    const typed = (await search(q)).filter((r) => typeOk(loc.precision, r));
    const near = anchor ? typed.filter((r) => km(r, anchor) <= 6) : typed;
    if (near.length) return { hit: near[0], precision: loc.precision, downgraded: false };
  }

  if (anchor) return { hit: anchor, precision: "district", downgraded: true };
  return null;
};

/**
 * First location in the extraction's own order that resolves.
 *
 * The order is deliberately NOT recomputed here. `locations` lists the killing
 * site first and other places connected to the case (an arrest, a bus station,
 * a courthouse) after it. Re-ranking by precision alone would promote a
 * street-address bus station over the district where the body was actually
 * found, and put the marker on the wrong event.
 */
const resolveLocation = async (locations) => {
  const ranked = locations;

  for (const loc of ranked) {
    const found = await geocode(loc);
    if (found)
      return { hit: found.hit, loc, precision: found.precision, downgraded: found.downgraded, fallback: false };
  }
  return { hit: KAJAANI, loc: ranked[0] ?? null, precision: "town", downgraded: false, fallback: true };
};

/** Status shown on the map, from the case's legal outcome. */
const STATUS = {
  solved: "Solved",
  unsolved: "Unsolved",
  in_investigation: "Under investigation",
  unclear: "Unclear",
};

const cases = JSON.parse(await readFile(IN, "utf8"));
const out = [];
let fallbacks = 0;

for (const [i, c] of cases.entries()) {
  const { hit, loc, precision, downgraded, fallback } = await resolveLocation(c.locations ?? []);
  if (fallback) fallbacks++;

  out.push({
    id: i + 1,
    topic_id: c.topic_id,
    title: c.title,
    coords: [hit.lat, hit.lon],
    coords_precision: precision,
    coords_credibility: fallback ? "fallback" : loc.credibility,
    coords_label: fallback
      ? "Kajaani (no more precise location in the thread)"
      : downgraded
        ? `${loc.label} — placed on the district, exact point not resolvable`
        : loc.label,
    coords_resolved: fallback ? null : hit.display_name,
    date: c.incident_date,
    date_note: c.incident_date_note ?? null,
    status: STATUS[c.solved_status] ?? "Unclear",
    outcome: c.outcome ?? null,
    location: loc?.detail ?? "Kajaani",
    summary: c.overview,
    victims: c.victims ?? [],
    suspects: c.suspects ?? [],
    locations: c.locations ?? [],
    sources: c.key_sources ?? [],
    thread: c.link,
  });

  console.log(
    `[${i + 1}/${cases.length}] ${c.title.slice(0, 50)} → ` +
      `${hit.lat.toFixed(4)},${hit.lon.toFixed(4)} ` +
      `(${fallback ? "town fallback" : `${precision}/${loc.credibility}${downgraded ? ", downgraded" : ""}`})` +
      (fallback ? "" : ` — ${hit.display_name.split(",").slice(0, 3).join(",")}`)
  );
}

await writeFile(CACHE, JSON.stringify(cache, null, 2) + "\n");

const banner = `// Kajaani homicide cases, derived from murha.info Rikosfoorumi threads.
//
// Generated by scripts/build-cases.mjs from data/kajaani-homicides.json — edit
// that file (or the pipeline behind it), not this one.
//
// Every field traces to a forum message; \`locations\` records where each place
// came from and how well it is supported, and \`coords_precision\` /
// \`coords_credibility\` say how exact the marker is. A "town" precision marker
// is the Kajaani centroid, not the site of the killing.
//
// Forum discussion is not a court record. Names carried here as
// \`support: "forum_claim"\` were asserted by posters, not established by a
// court or a news report, and should be treated accordingly.
`;

await writeFile(OUT, `${banner}const CASES = ${JSON.stringify(out, null, 2)};\n`);

console.log(
  `\nWrote ${out.length} cases to ${OUT} ` +
    `(${out.length - fallbacks} placed from a stated location, ${fallbacks} on the town centroid). ` +
    `${queried} Nominatim lookups.`
);
