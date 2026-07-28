/**
 * Record that a stage finished for a batch.
 *
 *   node scripts/murha-mark.mjs --batch 007 --stage classify \
 *     --count reviewed=24 --count homicides=5
 *
 * Options:
 *   --batch 007          required
 *   --stage classify     one of crawl | classify | extract | map
 *   --count k=v          repeatable; numbers stored as numbers
 *   --note "..."         free text kept with the entry
 *   --state data/pipeline-state.json
 *   --undo               clear the stage instead of setting it
 *
 * The crawl marks itself. The review passes are model work rather than a
 * script, so they mark themselves with this — which is what keeps the queue
 * moving and stops the next interval from re-reviewing a finished batch.
 */
import { arg, flag } from "./lib/forum.mjs";
import { loadState, saveState, recordStage, STAGES } from "./lib/state.mjs";

const BATCH = arg("batch", null);
const STAGE = arg("stage", null);
const STATE = arg("state", "data/pipeline-state.json");
const NOTE = arg("note", null);

if (!BATCH || !STAGE) {
  console.error("--batch and --stage are required.");
  process.exit(2);
}
if (!STAGES.includes(STAGE)) {
  console.error(`Unknown stage "${STAGE}". Known: ${STAGES.join(", ")}`);
  process.exit(2);
}

/** Collect every --count k=v pair. */
const counts = {};
process.argv.forEach((a, i) => {
  if (a !== "--count") return;
  const pair = process.argv[i + 1];
  if (!pair || !pair.includes("=")) return;
  const [k, v] = pair.split(/=(.*)/);
  counts[k] = Number.isFinite(Number(v)) && v.trim() !== "" ? Number(v) : v;
});

const state = await loadState(STATE);

if (flag("undo")) {
  if (state.batches[BATCH]?.[STAGE]) {
    delete state.batches[BATCH][STAGE];
    await saveState(STATE, state);
    console.log(`Cleared ${STAGE} for batch ${BATCH}.`);
  } else {
    console.log(`Batch ${BATCH} had no ${STAGE} entry.`);
  }
  process.exit(0);
}

recordStage(state, BATCH, STAGE, { ...counts, ...(NOTE ? { note: NOTE } : {}) });
await saveState(STATE, state);
console.log(`batch ${BATCH} ${STAGE}: ${JSON.stringify(state.batches[BATCH][STAGE])}`);
