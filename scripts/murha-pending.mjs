/**
 * Which cases in a batch are classified as homicides but not yet extracted?
 *
 *   node scripts/murha-pending.mjs --batch 004            # human-readable
 *   node scripts/murha-pending.mjs --batch 004 --json     # ["194","213",…]
 *   node scripts/murha-pending.mjs --batch 004 --take 6   # the next N only
 *
 * The extraction workflow takes a topic list as an argument, and working that
 * list out by hand — cross-referencing the classification against the records
 * already written — is exactly the kind of step that goes wrong quietly, by
 * re-extracting a case or silently skipping one. So it is computed.
 */
import { readFile } from "node:fs/promises";
import { arg, flag } from "./lib/forum.mjs";

const BATCH = arg("batch", null);
const TAKE = Number(arg("take", "0"));

if (!BATCH) {
  console.error("--batch is required.");
  process.exit(2);
}

const read = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

const classified = await read(`data/classification/batch-${BATCH}.json`, null);
if (!classified) {
  console.error(`No data/classification/batch-${BATCH}.json — classify the batch first.`);
  process.exit(1);
}
const extracted = await read(`data/homicides/batch-${BATCH}.json`, []);
const done = new Set(extracted.map((c) => String(c.topic_id)));

const pending = classified
  .filter((c) => c.verdict === "single_homicide" && !done.has(String(c.topic_id)))
  .map((c) => ({ topic_id: String(c.topic_id), topic: c.topic, confidence: c.confidence }));

const take = TAKE > 0 ? pending.slice(0, TAKE) : pending;

if (flag("json")) {
  console.log(JSON.stringify(take.map((p) => p.topic_id)));
  process.exit(0);
}

const homicides = classified.filter((c) => c.verdict === "single_homicide").length;
console.log(
  `batch ${BATCH}: ${classified.length} classified, ${homicides} single homicides, ` +
    `${done.size} extracted, ${pending.length} pending`
);
for (const p of take) console.log(`  ${p.topic_id.padEnd(5)} [${p.confidence}] ${p.topic.slice(0, 66)}`);
