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
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { arg, sleep } from "./lib/forum.mjs";

/**
 * Case records come from more than one file now: the original curated Kajaani
 * set, plus one file per pipeline batch. Repeat --in to add more, or point
 * --in-dir at a directory of them.
 */
const inputs = () => {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === "--in" && process.argv[i + 1] && !process.argv[i + 1].startsWith("--"))
      out.push(process.argv[i + 1]);
  });
  return out.length ? out : ["data/kajaani-homicides.json"];
};

const IN = inputs();
const IN_DIR = arg("in-dir", "data/homicides");
const OUT = arg("out", "data/cases.js");
const CACHE = arg("cache", "data/geocode-cache.json");

const UA = "HomicideMap/1.0 (https://github.com/allutinn/Homicidemap)";

/**
 * Where a case's markers may fall back to, and the box its lookups are bounded
 * by, when nothing more precise resolves.
 *
 * The map began as one municipality, so this was a pair of Kajaani constants.
 * Nationwide it has to be per case: a street name repeats across hundreds of
 * Finnish municipalities, and an unbounded search for "Vuorimiehenkatu" will
 * happily answer with the wrong city. Each case therefore carries its own
 * `municipality`, which is geocoded once and used both as the fallback point
 * and as the centre of a bounding box for that case's lookups.
 */
const MUNICIPALITY_BOX_DEG = 0.45; // ~50 km north-south, enough for any municipality

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
const search = async (query, viewbox = null) => {
  const key = viewbox ? `${query}|${viewbox}` : query;
  if (key in cache) return cache[key];

  await sleep(queried++ ? 1100 : 0);
  const url =
    "https://nominatim.openstreetmap.org/search?" +
    new URLSearchParams({
      q: query,
      format: "json",
      limit: "8",
      countrycodes: "fi",
      ...(viewbox ? { viewbox, bounded: "1" } : {}),
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

  cache[key] = results;
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
const geocode = async (loc, { municipality, viewbox }) => {
  const parts = loc.label.split(",").map((s) => s.trim());
  // "<place>, <district>, <municipality>" → district is second-to-last.
  const district = parts.length >= 3 ? `${parts[parts.length - 2]}, ${municipality}` : null;

  let anchor = null;
  if (district) {
    const hits = await search(district, viewbox);
    anchor = hits.find((h) => typeOk("district", h)) ?? null;
  }

  // Try the label as given, then progressively plainer forms. Sources write
  // things like "Nurmikantie / Sarapolku corner" — no gazetteer knows that
  // string, but it does know "Nurmikantie".
  const queries = [loc.label];
  if (parts.length >= 3) {
    for (const name of parts[0].split(/\s*[/&]\s*|\s+ja\s+/))
      queries.push(`${name.trim()}, ${municipality}`);
  }
  // …and then the same again with Finnish case endings taken off.
  //
  // Labels do not always arrive as gazetteer strings. Finnish names a place by
  // inflecting it — "Helsingin Myllypurossa", "Kauppakartanonkadulla",
  // "Vihdin Tervalammen kylässä" — and Nominatim knows Myllypuro and
  // Kauppakartanonkatu but none of those forms. Stripping the endings will not
  // undo consonant gradation, so it is a widening of the search rather than
  // proper morphology: the type and district guards still decide what is
  // acceptable, so a bad de-inflection loses a candidate instead of misplacing
  // a marker.
  for (const q of [...queries]) {
    const plain = q
      .split(/\s*,\s*/)
      .map((seg) =>
        seg
          .split(/\s+/)
          .map((w) =>
            w.replace(
              /(ssa|ssä|sta|stä|lla|llä|lta|ltä|lle|ksi|neen|ineen|ien|ssaan|llaan)$/i,
              ""
            )
          )
          .filter((w) => !/^(kylä|kylässä|rannalla|rannassa|alueella|luona|lähellä|kaupunginosassa)$/i.test(w))
          .join(" ")
          .trim()
      )
      .filter(Boolean)
      .join(", ");
    if (plain && plain !== q) queries.push(plain);
  }

  for (const q of [...new Set(queries)]) {
    const typed = (await search(q, viewbox)).filter((r) => typeOk(loc.precision, r));
    const near = anchor ? typed.filter((r) => km(r, anchor) <= 6) : typed;
    if (near.length) return { hit: near[0], precision: loc.precision, downgraded: false };
  }

  if (anchor) return { hit: anchor, precision: "district", downgraded: true };
  return null;
};

/**
 * A case's municipality: its fallback point and the centre of its search box.
 *
 * Resolved once per distinct municipality name and cached like any other
 * lookup. A case whose municipality cannot be geocoded is a build error — the
 * alternative is a marker in the sea, or worse, silently in another town.
 */
const municipalityCache = new Map();
const resolveMunicipality = async (name) => {
  if (municipalityCache.has(name)) return municipalityCache.get(name);

  const hit = (await search(name)).find((r) => typeOk("town", r));
  if (!hit) throw new Error(`municipality "${name}" did not geocode — cannot place its cases`);

  const d = MUNICIPALITY_BOX_DEG;
  const resolved = {
    municipality: name,
    centre: hit,
    // left,top,right,bottom. Longitude degrees shrink with latitude, and
    // Finland is far enough north that ignoring it makes the box far too
    // narrow east-west.
    viewbox: [
      (hit.lon - d / Math.cos((hit.lat * Math.PI) / 180)).toFixed(4),
      (hit.lat + d).toFixed(4),
      (hit.lon + d / Math.cos((hit.lat * Math.PI) / 180)).toFixed(4),
      (hit.lat - d).toFixed(4),
    ].join(","),
  };
  municipalityCache.set(name, resolved);
  return resolved;
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
const resolveLocation = async (locations, place) => {
  const ranked = locations;

  for (const loc of ranked) {
    const found = await geocode(loc, place);
    if (found)
      return { hit: found.hit, loc, precision: found.precision, downgraded: found.downgraded, fallback: false };
  }
  return { hit: place.centre, loc: ranked[0] ?? null, precision: "town", downgraded: false, fallback: true };
};

/** Languages the map offers. Every case must carry an overview in each. */
const LANGS = ["fi", "en"];

/**
 * Each overview is two-part: a `lead` that says what happened in a few
 * sentences, and a `detail` that gives the full account with its sourcing.
 * Missing or empty text is a build error rather than a blank card on the map.
 */
const checkOverview = (overview, title) => {
  if (!overview || typeof overview !== "object")
    throw new Error(`${title}: overview must be an object of {fi,en}:{lead,detail}`);
  for (const lang of LANGS)
    for (const part of ["lead", "detail"])
      if (!overview[lang]?.[part]?.trim())
        throw new Error(`${title}: overview.${lang}.${part} is missing or empty`);
  return overview;
};

/**
 * Load every case file. The batch files under --in-dir are added automatically
 * so a finished batch reaches the map without anyone editing a command line;
 * a case already present by topic_id is not added twice.
 */
const load = async () => {
  const files = [...IN];
  try {
    for (const f of (await readdir(IN_DIR)).sort())
      if (f.endsWith(".json")) files.push(join(IN_DIR, f));
  } catch {
    /* no batch extractions yet */
  }

  const seen = new Set();
  const all = [];
  for (const f of files) {
    const rows = JSON.parse(await readFile(f, "utf8"));
    let added = 0;
    for (const c of rows) {
      const key = String(c.topic_id);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ ...c, source_file: f });
      added++;
    }
    console.log(`${f}: ${added} case(s)`);
  }
  return all;
};

const cases = await load();
const out = [];
let fallbacks = 0;

for (const [i, c] of cases.entries()) {
  // Kajaani is the default only because the original 26 records predate the
  // field; every new extraction carries its own municipality.
  const place = await resolveMunicipality(c.municipality ?? "Kajaani");
  const { hit, loc, precision, downgraded, fallback } = await resolveLocation(c.locations ?? [], place);
  if (fallback) fallbacks++;

  out.push({
    id: i + 1,
    topic_id: c.topic_id,
    title: c.title,
    coords: [hit.lat, hit.lon],
    coords_precision: precision,
    coords_credibility: fallback ? "fallback" : loc.credibility,
    coords_label: fallback ? null : loc.label,
    // Why the marker is not exactly where the source said, if it isn't. The
    // map spells this out in the chosen language rather than baking in English.
    coords_note: fallback ? "fallback" : downgraded ? "downgraded" : null,
    coords_resolved: fallback ? null : hit.display_name,
    date: c.incident_date,
    date_note: c.incident_date_note ?? null,
    // The key, not a rendered word: the map labels it in the chosen language.
    status: c.solved_status ?? "unclear",
    outcome: c.outcome ?? null,
    location: loc?.detail ?? (c.municipality ?? "Kajaani"),
    municipality: c.municipality ?? "Kajaani",
    summary: checkOverview(c.overview, c.title),
    victims: c.victims ?? [],
    suspects: c.suspects ?? [],
    // Flag which entry the marker was placed from. A case's locations include
    // places that are not the killing site — a shop where a second, surviving
    // victim was shot, an arrest, a courthouse — and without this the list
    // reads as if any of them could be where the death happened.
    locations: (c.locations ?? []).map((l) => ({
      ...l,
      used_for_marker: !fallback && l === loc,
    })),
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
// Generated by scripts/build-cases.mjs from data/kajaani-homicides.json and
// data/homicides/batch-*.json — edit those (or the pipeline behind them), not this.
//
// Every field traces to a forum message; \`locations\` records where each place
// came from and how well it is supported, and \`coords_precision\` /
// \`coords_credibility\` say how exact the marker is. A "town" precision marker
// is the municipality centroid, not the site of the killing.
//
// \`summary\` is bilingual: \`{fi,en}\` each with a short \`lead\` and a full
// \`detail\`. \`status\` is a key (solved / unsolved / in_investigation /
// unclear), not a rendered word — the map labels it in the chosen language.
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
