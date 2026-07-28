/**
 * The pipeline's memory.
 *
 * `data/pipeline-state.json` records, per batch, which stages have run and what
 * they produced. It is the only thing a scheduled run needs in order to work
 * out what to do next, and it is committed — so a run in October can pick up
 * exactly where the run in August stopped, on a fresh machine.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";

/** In pipeline order. A batch may only enter a stage once the previous is done. */
export const STAGES = ["crawl", "classify", "extract", "map"];

export const emptyState = () => ({
  updated_at: null,
  stages: STAGES,
  batches: {},
});

export const loadState = async (path) => {
  try {
    const state = JSON.parse(await readFile(path, "utf8"));
    return { ...emptyState(), ...state, batches: state.batches ?? {} };
  } catch {
    return emptyState();
  }
};

export const saveState = async (path, state) => {
  state.updated_at = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n");
};

/** Record that `stage` completed for `batchId`, with whatever it counted. */
export const recordStage = (state, batchId, stage, fields = {}) => {
  const batch = (state.batches[batchId] ??= {});
  batch[stage] = { at: new Date().toISOString(), ...fields };
  return state;
};

export const stageDone = (state, batchId, stage) => Boolean(state.batches[batchId]?.[stage]?.at);

/**
 * Is the shard a `crawl` entry refers to actually there?
 *
 * The state file is committed but the shards are not — they are gitignored and
 * live on the `crawl-data` branch. So a state entry can outlive its data: crawl
 * a batch locally, commit the state, and CI will skip that batch forever while
 * its posts exist nowhere. The hole is silent, because the state says "done".
 *
 * Treating a crawl as done only when its shard is present closes that off. The
 * lookup is by basename against `shardsDir` and nowhere else: the same shard
 * sits under `crawl/threads` locally and `crawl-data/threads` in CI, so the
 * path recorded in the state is not authoritative — the directory being asked
 * about is. Falling back to the recorded path would let a stale entry find an
 * unrelated file and report data as present that this run cannot read.
 */
export const shardPresent = (state, batchId, shardsDir) => {
  const shard = state.batches[batchId]?.crawl?.shard;
  if (!shard) return false;
  return existsSync(join(shardsDir, basename(shard)));
};

/** Batches whose crawl is recorded but whose shard is gone. */
export const orphanedCrawls = (state, plan, shardsDir) =>
  plan.batches.filter((b) => stageDone(state, b.id, "crawl") && !shardPresent(state, b.id, shardsDir));

/**
 * The batches ready for `stage`: the previous stage is done (or this is the
 * first stage) and this one is not. Returned in plan order, so the queue is
 * drained front to back and progress is a simple prefix of the plan.
 */
export const readyFor = (state, plan, stage) => {
  const i = STAGES.indexOf(stage);
  const previous = i > 0 ? STAGES[i - 1] : null;
  return plan.batches.filter(
    (b) => !stageDone(state, b.id, stage) && (!previous || stageDone(state, b.id, previous))
  );
};

/** Per-stage counts, for status reporting. */
export const progress = (state, plan) =>
  STAGES.map((stage) => {
    const done = plan.batches.filter((b) => stageDone(state, b.id, stage));
    return {
      stage,
      done: done.length,
      total: plan.batches.length,
      topics: done.reduce((a, b) => a + b.topic_count, 0),
      topics_total: plan.batches.reduce((a, b) => a + b.topic_count, 0),
    };
  });
