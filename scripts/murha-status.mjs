/**
 * Where is the pipeline, and what should the next run do?
 *
 *   node scripts/murha-status.mjs [--next classify] [--json]
 *
 * Options:
 *   --plan  data/batch-plan.json
 *   --state data/pipeline-state.json
 *   --next <stage>   print just the id of the next batch ready for that stage,
 *                    or nothing at all if the queue is empty. Meant for the
 *                    scheduled runs: `--next classify` tells the review session
 *                    which batch to pick up, with no parsing on its side.
 *   --json           machine-readable progress
 *
 * This is the control surface for running the crawl in intervals: it is the one
 * command that answers "are we done yet, and if not, what is next".
 */
import { readFile } from "node:fs/promises";
import { arg, flag } from "./lib/forum.mjs";
import { loadState, readyFor, progress, orphanedCrawls, STAGES } from "./lib/state.mjs";

const PLAN = arg("plan", "data/batch-plan.json");
const STATE = arg("state", "data/pipeline-state.json");
const SHARDS = arg("shards", "crawl/threads");
const NEXT = arg("next", null);

const plan = JSON.parse(await readFile(PLAN, "utf8"));
const state = await loadState(STATE);

if (NEXT) {
  if (!STAGES.includes(NEXT)) {
    console.error(`Unknown stage "${NEXT}". Known: ${STAGES.join(", ")}`);
    process.exit(2);
  }
  const next = readyFor(state, plan, NEXT, SHARDS)[0];
  // Exit 1 with no output when the queue is empty, so a scheduled job can
  // simply stop rather than run a stage against nothing.
  if (!next) process.exit(1);
  process.stdout.write(next.id + "\n");
  process.exit(0);
}

const rows = progress(state, plan);

if (flag("json")) {
  console.log(
    JSON.stringify(
      {
        plan_batches: plan.batches.length,
        plan_topics: plan.batches.reduce((a, b) => a + b.topic_count, 0),
        updated_at: state.updated_at,
        progress: rows,
        next: Object.fromEntries(STAGES.map((s) => [s, readyFor(state, plan, s, SHARDS)[0]?.id ?? null])),
      },
      null,
      2
    )
  );
  process.exit(0);
}

const bar = (done, total) => {
  const w = 28;
  const n = total ? Math.round((done / total) * w) : 0;
  return "█".repeat(n) + "·".repeat(w - n);
};

console.log(`plan: ${plan.batches.length} batches / ${rows[0].topics_total} topics`);
console.log(`state: ${state.updated_at ?? "nothing run yet"}\n`);

for (const r of rows) {
  const pct = r.total ? ((r.done / r.total) * 100).toFixed(0) : "0";
  console.log(
    `${r.stage.padEnd(9)} ${bar(r.done, r.total)} ${String(r.done).padStart(3)}/${r.total} batches ` +
      `(${pct}%)  ${r.topics}/${r.topics_total} topics`
  );
}

console.log("\nnext up:");
for (const stage of STAGES) {
  const next = readyFor(state, plan, stage, SHARDS);
  console.log(
    `  ${stage.padEnd(9)} ${next.length ? `batch ${next[0].id} (${next.length} queued)` : "— queue empty"}`
  );
}

// Incomplete crawls are worth surfacing every run: a thread short of phpBB's
// own post total means the review will read a partial case.
const short = Object.entries(state.batches)
  .filter(([, b]) => b.crawl?.incomplete?.length)
  .map(([id, b]) => `${id} (${b.crawl.incomplete.length})`);
if (short.length) console.log(`\nbatches with incomplete threads: ${short.join(", ")}`);

// State travels through git; shards do not. Say so plainly rather than letting
// the bars above imply data that is not on this machine.
const orphans = orphanedCrawls(state, plan, SHARDS);
if (orphans.length)
  console.log(
    `\n${orphans.length} batch(es) recorded as crawled but with no shard in ${SHARDS}: ` +
      `${orphans.map((b) => b.id).join(", ")}\n` +
      `  They will be crawled again. If the shards exist elsewhere, point --shards at them.`
  );
