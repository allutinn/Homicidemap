/**
 * Fold an extraction workflow's output into a batch's case records.
 *
 *   node scripts/murha-merge-workflow.mjs --batch 004 --journal <run>/journal.jsonl
 *
 * Options:
 *   --batch 004    which data/homicides/batch-NNN.json to write into
 *   --journal      the workflow run's journal.jsonl (one {"type":"result"} per agent)
 *   --dry-run      report, write nothing
 *
 * The workflow returns two kinds of object per thread: an evidence pack from the
 * Haiku pass and a written record from the Opus pass. This joins them on
 * topic_id and produces the schema build-cases.mjs consumes.
 *
 * Deliberately additive: a case already present is left alone rather than
 * overwritten, so re-running a workflow after a partial failure cannot quietly
 * replace a record that was checked by hand.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { arg, flag } from "./lib/forum.mjs";

const BATCH = arg("batch", null);
const JOURNAL = arg("journal", null);

if (!BATCH || !JOURNAL) {
  console.error("--batch and --journal are required.");
  process.exit(2);
}

const lines = (await readFile(JOURNAL, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const evidence = new Map();
const records = new Map();
for (const j of lines) {
  if (j.type !== "result" || !j.result) continue;
  const r = j.result;
  if (!r.topic_id) continue;
  // The two passes are told apart by shape: evidence carries facts and
  // locations, a written record carries the bilingual overview.
  if (r.facts && r.locations) evidence.set(String(r.topic_id), r);
  else if (r.overview) records.set(String(r.topic_id), r);
}

const OUT = `data/homicides/batch-${BATCH}.json`;
let existing = [];
try {
  existing = JSON.parse(await readFile(OUT, "utf8"));
} catch {
  /* first extraction for this batch */
}
const have = new Set(existing.map((c) => String(c.topic_id)));

const out = [...existing];
const added = [];
const skipped = [];

for (const [id, rec] of records) {
  if (have.has(id)) {
    skipped.push(`${id} (already present)`);
    continue;
  }
  const e = evidence.get(id);
  if (!e) {
    skipped.push(`${id} (written but no evidence pack)`);
    continue;
  }
  out.push({
    topic_id: id,
    batch: BATCH,
    title: rec.title,
    link: `https://murha.info/rikosfoorumi/viewtopic.php?t=${id}`,
    municipality: rec.municipality,
    incident_date: rec.incident_date || e.incident_date || "",
    ...(rec.incident_date_note || e.incident_date_note
      ? { incident_date_note: rec.incident_date_note || e.incident_date_note }
      : {}),
    solved_status: rec.solved_status || e.solved_status || "unclear",
    outcome: rec.outcome || e.outcome || null,
    overview: rec.overview,
    victims: e.victims ?? [],
    suspects: e.suspects ?? [],
    // is_killing_site guided the ordering during extraction; the map only needs
    // the order itself, which build-cases walks in turn.
    locations: (e.locations ?? []).map(({ is_killing_site, ...l }) => l),
    key_sources: [...new Set((e.facts ?? []).map((f) => f.source_permalink))].slice(0, 6),
    classification: { verdict: "single_homicide", confidence: "high", reasoning: e.reasoning },
  });
  added.push(id);
}

// Threads the evidence pass rejected: worth surfacing, since the earlier
// classification thought they were cases and one of the two is wrong.
const rejected = [...evidence.values()].filter((e) => !e.is_single_homicide);

console.log(
  `${evidence.size} evidence pack(s), ${records.size} written record(s) in the journal.\n` +
    `added ${added.length}: ${added.join(", ") || "-"}`
);
if (skipped.length) console.log(`skipped ${skipped.length}: ${skipped.join(", ")}`);
if (rejected.length)
  console.log(
    `\n${rejected.length} thread(s) the evidence pass called NOT a single homicide — ` +
      `these were classified as cases earlier, so one of the two judgements is wrong:\n` +
      rejected.map((r) => `  ${r.topic_id}: ${r.reasoning.slice(0, 100)}`).join("\n")
  );

if (flag("dry-run")) {
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`\n${OUT} now has ${out.length} case(s).`);
