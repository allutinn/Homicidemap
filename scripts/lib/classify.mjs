/**
 * Is a forum thread *about* Kajaani?
 *
 * Kept separate from the crawler so the heuristic can be retuned and re-applied
 * to an already-collected topic index (`murha-search.mjs --reclassify`) without
 * hitting the forum again.
 */

/**
 * Kajaani and the districts/villages inside the municipality. Vuolijoki and
 * Otanmäki were merged into Kajaani in 2007, so threads about them are Kajaani
 * threads even when the city is never named.
 */
export const PLACES = [
  "kajaan", // kajaani / kajaanin / kajaanissa / kajaanilainen
  "otanmäki", "otanmäe", "vuolijo", "lehtikangas", "lehtikankaa",
  "vimpelinvaara", "jormua", "kuluntalahti", "paltaniemi", "teppana",
  "nakertaja", "huuhkajanvaara", "hauholampi", "kätönlahti", "soidinsuo",
  "kirkkoaho", "komiaho", "purola", "variskangas", "hoikankangas",
];

export const CASE_WORDS = [
  "murha", "henkirikos", "surma", "puukot", "tapp", "kuolem", "kuoli",
  "katosi", "kadonnut", "epäilty", "syyte", "tuomio", "uhri", "raisk",
  "pahoinpitel", "ryöst", "väkival", "ampu",
];

/**
 * Lowercase and strip the soft hyphens and zero-width characters phpBB titles
 * carry, so "Ka­jaa­nis­sa" still matches "kajaan".
 */
export const normalise = (s) =>
  (s || "").toLowerCase().replace(/[­​-‍﻿]/g, "");

/**
 * Returns { valid, kajaani_in_overview, reasoning }.
 *
 * `valid` answers exactly one question — is this thread about Kajaani? — and it
 * is decided on the title alone. That is the only signal that holds up: a
 * search for "kajaani" also returns large threads about other municipalities
 * where the word appears once inside a quoted news story, and those are not
 * Kajaani topics however many crime words they contain.
 *
 * Threads that name Kajaani only in the opening post stay in the index with
 * `valid: false` and `kajaani_in_overview: true`, so the exclusion can be
 * reviewed rather than assumed. `valid` never claims the thread is a homicide
 * case — that judgement is left to review, hence needs_review on every row.
 */
export const classify = ({ topic, overview = "" }) => {
  const title = normalise(topic);
  const body = normalise(overview);

  const titlePlaces = PLACES.filter((p) => title.includes(p));
  const overviewPlaces = PLACES.filter((p) => body.includes(p));
  const hits = CASE_WORDS.filter((w) => `${title} ${body}`.includes(w));
  const datedTitle = /\b(19|20)\d{2}\b/.test(title);

  if (titlePlaces.length) {
    return {
      valid: true,
      kajaani_in_overview: overviewPlaces.length > 0,
      reasoning:
        `Title names a Kajaani-area place (${titlePlaces.join(", ")})` +
        (hits.length ? `; case terms present (${hits.join(", ")})` : "") +
        (datedTitle ? "; title carries a year, typical of a specific case" : "") +
        ".",
    };
  }
  if (overviewPlaces.length) {
    return {
      valid: false,
      kajaani_in_overview: true,
      reasoning:
        `Title is not about Kajaani; the place is named only in the opening ` +
        `post (${overviewPlaces.join(", ")})` +
        (hits.length ? ` alongside case terms (${hits.join(", ")})` : "") +
        ". Kept for review rather than crawled — a mention inside a quoted " +
        "story does not make the thread a Kajaani topic.",
    };
  }
  return {
    valid: false,
    kajaani_in_overview: false,
    reasoning:
      "Neither the title nor the opening post is about Kajaani — the search " +
      "matched a mention somewhere deeper in the thread.",
  };
};
