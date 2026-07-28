/**
 * The pipeline's memory.
 *
 * `data/pipeline-state.json` records, per batch, which stages have run and what
 * they produced. It is the only thing a scheduled run needs in order to work
 * out what to do next, and it is committed — so a run in October can pick up
 * exactly where the run in August stopped, on a fresh machine.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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
