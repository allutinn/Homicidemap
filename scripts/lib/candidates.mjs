/**
 * Pull candidate place-sentences out of a thread, mechanically.
 *
 * Back-testing a Haiku extraction pass showed it inventing quotes: for thread
 * t=3966 it returned "Gajaanin Kivimäellä kaatopaikalla ammuttiin autossa noin
 * 30-40 vuotias mies" attached to permalink p=119434 — a real post, a sentence
 * nobody ever wrote. A fabricated citation that looks correctly sourced is the
 * worst thing this pipeline can produce, because the whole point of carrying a
 * quote and a permalink is that a reader can check the marker against what a
 * person actually said.
 *
 * So the model is taken out of the quoting business. Code finds every sentence
 * that might name a place and hands them over with their permalinks; the model
 * only chooses which ones matter and what they mean. A quote can then be wrong
 * about the world — a poster can be mistaken — but it cannot be something the
 * thread does not contain.
 */
import { ownWords } from "./condense.mjs";

/** Finnish street-name endings. */
const STREET =
  /\b[A-ZÄÖÅ][a-zäöå]+(?:katu|kadun|kadulla|tie|tien|tiellä|kuja|kujalla|polku|polulla|väylä|raitti|kaari|rinne|mäki|mäen|mäellä|ranta|rannan|rannassa|aukio|tori|torilla|puisto|puistossa|kylä|kylän|kylässä)\b/;

/** "Vuorimiehentie 4", "Kumputie 30 A" — a name followed by a number. */
const HOUSE = /\b[A-ZÄÖÅ][a-zäöå]{3,}\w*\s+\d{1,4}\s*[A-Za-z]?\b/;

/**
 * A capitalised word carrying a Finnish locative ending — "Kajaanissa",
 * "Otanmäestä", "Teppanalla", "Lehtikankaalle". This is how Finnish names a
 * place in running text, and it is what catches districts and villages that no
 * street-name list would know.
 */
const LOCATIVE =
  /\b[A-ZÄÖÅ][a-zäöå]{3,}(?:ssa|ssä|sta|stä|lla|llä|lta|ltä|lle|iin|aan|ään|een|ille|illa|illä)\b/;

/** Venues and structures that anchor a place even without a name ending. */
const VENUE =
  /\b(?:kaupunginosa|kaupunginosas|kylä|taajama|asuinalue|kerrostalo|omakotitalo|rivitalo|asunto|osoite|osoitteessa|kaatopaikka|sairaala|keskussairaala|käräjäoikeus|raastuvanoikeus|kihlakunnanoikeus|hovioikeus|koulu|ravintola|baari|pizzeria|kauppa|huoltoasema|rautatieasema|linja-autoasema|mökki|kesämökki|leirintä)\w*/i;

/** Split into sentences without losing the Finnish abbreviation dots entirely. */
const split = (text) =>
  text
    .split(/(?<=[.!?])\s+(?=[A-ZÄÖÅ0-9"„”])/)
    .map((s) => s.trim())
    .filter(Boolean);

const ALL_PLACE = new RegExp(
  [STREET.source, HOUSE.source, LOCATIVE.source, VENUE.source].join("|"),
  "gi"
);

/**
 * Sentences, but never losing a long one.
 *
 * Pasted news stories often arrive as a single block with no sentence break the
 * splitter recognises, so a whole article can come back as one 4 000-character
 * "sentence". Dropping those for being too long threw away exactly the passages
 * that carry addresses — measured, it cost a fifth of the known locations. So an
 * over-long segment is not discarded but cut into windows around each place
 * match, which keeps the address and its immediate context and nothing else.
 */
const sentences = (text, max = 600) =>
  split(text).flatMap((s) => {
    if (s.length <= max) return [s];
    const windows = [];
    for (const m of s.matchAll(ALL_PLACE)) {
      const from = Math.max(0, m.index - 180);
      const to = Math.min(s.length, m.index + m[0].length + 220);
      const w = s.slice(from, to).trim();
      if (w.length >= 25) windows.push(w);
      if (windows.length >= 40) break;
    }
    return windows;
  });

/**
 * Candidate place-sentences for one thread.
 *
 * Returns [{ index, permalink, author, date, quoted, sentence, signals }] —
 * `quoted` says whether the sentence came from a blockquote (usually a pasted
 * police bulletin or news story) rather than the poster's own words, which is
 * most of what `credibility` turns on.
 */
export const placeCandidates = (thread, { maxPerThread = 400, minLength = 25 } = {}) => {
  const out = [];

  for (const m of thread.messages ?? []) {
    const parts = [
      { text: ownWords(m), quoted: false },
      ...(m.quotes ?? []).filter(Boolean).map((q) => ({ text: q, quoted: true })),
    ];

    for (const { text, quoted } of parts) {
      for (const s of sentences(text)) {
        if (s.length < minLength || s.length > 600) continue;
        const signals = [];
        if (STREET.test(s)) signals.push("street");
        if (HOUSE.test(s)) signals.push("house_number");
        if (LOCATIVE.test(s)) signals.push("locative");
        if (VENUE.test(s)) signals.push("venue");
        if (!signals.length) continue;

        out.push({
          index: m.index,
          permalink: m.permalink,
          author: m.author,
          date: (m.date || m.date_text || "").slice(0, 10),
          quoted,
          sentence: s,
          signals,
        });
      }
    }
  }

  // Rank so that, when a thread offers more candidates than fit, the ones most
  // likely to carry an actual address survive the cut.
  const weight = (c) =>
    (c.signals.includes("house_number") ? 4 : 0) +
    (c.signals.includes("street") ? 3 : 0) +
    (c.signals.includes("venue") ? 2 : 0) +
    (c.signals.includes("locative") ? 1 : 0) +
    (c.quoted ? 1 : 0);

  const seen = new Set();
  return out
    .filter((c) => {
      const k = c.sentence.slice(0, 120);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => weight(b) - weight(a) || a.index - b.index)
    .slice(0, maxPerThread)
    .sort((a, b) => a.index - b.index);
};
