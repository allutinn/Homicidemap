/**
 * Fold a classify-batch workflow run into data/classification/batch-NNN.json.
 *
 *   node scripts/murha-merge-classify.mjs --batch 006 --journal <run>/journal.jsonl
 *
 * Options:
 *   --batch 006    which classification file to write
 *   --journal      the workflow run's journal.jsonl
 *   --dry-run      report, write nothing
 *
 * Like the extraction merge, this is additive: a verdict already recorded is
 * kept rather than overwritten, so re-running after a partial failure cannot
 * silently flip a judgement that later work has already been built on.
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

// Each classifying agent returns {verdicts:[…]}; the listing agent returns a
// bare array of ids, which has no verdicts and is skipped by the same test.
const incoming = new Map();
for (const j of lines) {
  if (j.type !== "result" || !j.result?.verdicts) continue;
  for (const v of j.result.verdicts) {
    if (v?.topic_id) incoming.set(String(v.topic_id), v);
  }
}

const OUT = `data/classification/batch-${BATCH}.json`;
let existing = [];
try {
  existing = JSON.parse(await readFile(OUT, "utf8"));
} catch {
  /* first classification for this batch */
}
const have = new Set(existing.map((c) => String(c.topic_id)));

const out = [...existing];
const added = [];
for (const [id, v] of incoming) {
  if (have.has(id)) continue;
  out.push({
    topic_id: id,
    topic: v.topic,
    verdict: v.verdict,
    confidence: v.confidence,
    reasoning: v.reasoning,
    ...(v.municipality ? { municipality: v.municipality } : {}),
  });
  added.push(id);
}

out.sort((a, b) => Number(a.topic_id) - Number(b.topic_id));

const counts = {};
for (const c of out) counts[c.verdict] = (counts[c.verdict] ?? 0) + 1;

console.log(
  `${incoming.size} verdict(s) in the journal, ${added.length} new.\n` +
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `  ${k.padEnd(20)} ${n}`)
      .join("\n")
);

if (flag("dry-run")) {
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out, null, 2) + "\n");
console.log(`\n${OUT} now has ${out.length} verdict(s).`);
