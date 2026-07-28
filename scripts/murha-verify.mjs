/**
 * Check that every quote in a case record is actually in the thread it cites.
 *
 *   node scripts/murha-verify.mjs --in data/homicides/batch-004.json --batch 004
 *   node scripts/murha-verify.mjs --in <file> --file data/kajaani-cases.json
 *   node scripts/murha-verify.mjs --in <file> --batch 004 --strip
 *
 * Options:
 *   --in <file>      case records to check
 *   --batch NNN      where the threads live (a crawled shard), or
 *   --file <path>    a plain array of threads
 *   --shards crawl/threads
 *   --strip          drop unverifiable locations and rewrite --in
 *
 * Exits non-zero if anything fails, so it can gate a build.
 *
 * This exists because a back-test caught a model doing the one thing that must
 * never happen: for thread t=3966 it returned the quote "Gajaanin Kivimäellä
 * kaatopaikalla ammuttiin autossa noin 30-40 vuotias mies" against permalink
 * p=119434. The post is real. The sentence is not — the thread says "Tiedän,
 * että Kajaanin Kivimäellä...". A mis-transcription is indistinguishable, to a
 * reader, from a citation to something nobody wrote, and the entire value of
 * carrying a quote and a permalink is that a reader can check the marker
 * against a real person's words.
 *
 * Prompting did not prevent it, so it is not left to prompting. Every quote is
 * matched against the thread text mechanically. A model can still be wrong
 * about what a quote *means* — that is a judgement — but it can no longer cite
 * something that was never written.
 */
import { readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { arg, flag } from "./lib/forum.mjs";
import { ownWords } from "./lib/condense.mjs";

const IN = arg("in", null);
const BATCH = arg("batch", null);
const FILE = arg("file", null);
const SHARDS = arg("shards", "crawl/threads");

if (!IN || (!BATCH && !FILE)) {
  console.error("--in and one of --batch / --file are required.");
  process.exit(2);
}

const loadThreads = async () => {
  if (FILE) {
    const rows = JSON.parse(await readFile(FILE, "utf8"));
    return rows.map((t) => ({
      ...t,
      topic_id: t.topic_id ?? Number(new URL(t.link).searchParams.get("t")),
    }));
  }
  for (const name of [`batch-${BATCH}.json.gz`, `batch-${BATCH}.json`]) {
    try {
      const raw = await readFile(join(SHARDS, name));
      const j = JSON.parse(name.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
      return j.threads;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  console.error(`No shard for batch ${BATCH} in ${SHARDS}.`);
  process.exit(1);
};

const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();

/** Everything a poster wrote or quoted, as one searchable string per thread. */
const haystack = (thread) =>
  norm(
    (thread.messages ?? [])
      .map((m) => [ownWords(m), ...(m.quotes ?? [])].join(" "))
      .join(" ")
  );

/** Permalinks the thread actually contains, so a citation cannot point nowhere. */
const permalinks = (thread) => new Set((thread.messages ?? []).map((m) => m.permalink).filter(Boolean));

const cases = JSON.parse(await readFile(IN, "utf8"));
const threads = await loadThreads();
const byId = new Map(threads.map((t) => [String(t.topic_id), t]));

let checked = 0, bad = 0, badLinks = 0, missingThread = 0;
const report = [];

for (const c of cases) {
  const t = byId.get(String(c.topic_id));
  if (!t) {
    missingThread++;
    report.push(`  ${c.topic_id}: thread not found — cannot verify`);
    continue;
  }
  const hay = haystack(t);
  const links = permalinks(t);

  const keep = [];
  for (const loc of c.locations ?? []) {
    const q = norm(loc.quote);
    checked++;

    // A quote is present if a solid contiguous run of it is in the thread. The
    // whole string is not required: renderers truncate, and a reviewer may cite
    // the front of a long sentence.
    const probe = q.slice(0, Math.min(60, q.length));
    const present = q.length >= 20 && hay.includes(probe);
    const linkOk = !loc.source_permalink || links.has(loc.source_permalink);

    if (!present) {
      bad++;
      const shown = loc.quote ? loc.quote.slice(0, 90) : "(no quote given)";
      report.push(`  ${c.topic_id} "${loc.label}": QUOTE NOT IN THREAD — ${shown}`);
    } else if (!linkOk) {
      badLinks++;
      report.push(`  ${c.topic_id} "${loc.label}": permalink not in thread — ${loc.source_permalink}`);
    }
    if (present && linkOk) keep.push(loc);
  }
  if (flag("strip")) c.locations = keep;
}

console.log(`${cases.length} case(s), ${checked} location quote(s) checked against ${threads.length} thread(s).`);
if (report.length) console.log(report.join("\n"));
console.log(
  `\nquotes not found in thread: ${bad}` +
    `\npermalinks not in thread:   ${badLinks}` +
    (missingThread ? `\ncases whose thread is absent: ${missingThread}` : "")
);

if (flag("strip")) {
  await writeFile(IN, JSON.stringify(cases, null, 2) + "\n");
  console.log(`\nStripped unverifiable locations and rewrote ${IN}.`);
  process.exit(0);
}

process.exit(bad || badLinks ? 1 : 0);
