/**
 * Pack the forum index into batches the pipeline can chew through on a schedule.
 *
 *   node scripts/murha-batches.mjs [options]
 *
 * Options:
 *   --index data/forum-index.json
 *   --plan  data/batch-plan.json     read and rewritten in place
 *   --max-pages 600                  viewtopic fetches per batch (crawl cost)
 *   --max-topics 60                  threads per batch (review cost)
 *   --dry-run                        print the plan, write nothing
 *
 * Two budgets, because the two expensive stages scale on different things. The
 * crawl costs one HTTP fetch per 15 posts, so it is bounded by `--max-pages`.
 * The review reads one thread per agent, so it is bounded by `--max-topics`.
 * A batch closes when it hits either.
 *
 * Threads bigger than `--max-pages` on their own (murha.info has a 18 659-post
 * thread) become single-topic batches rather than being split — a case is
 * reviewed whole or not at all.
 *
 * Batch assignment is STABLE. Topics already assigned keep their batch id, and
 * a re-run after the forum has grown only appends new batches. That is what
 * makes the schedule resumable across weeks: batch 007 means the same threads
 * in October as it did in August.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { arg, flag } from "./lib/forum.mjs";

const INDEX = arg("index", "data/forum-index.json");
const PLAN = arg("plan", "data/batch-plan.json");
const MAX_PAGES = Number(arg("max-pages", "600"));
const MAX_TOPICS = Number(arg("max-topics", "60"));
const DRY = flag("dry-run");

const index = JSON.parse(await readFile(INDEX, "utf8"));
const byId = new Map(index.topics.map((t) => [t.topic_id, t]));

/** Existing plan, if any — its assignments are preserved. */
let previous = { batches: [] };
try {
  previous = JSON.parse(await readFile(PLAN, "utf8"));
} catch {
  /* first run */
}

const assigned = new Set();
for (const b of previous.batches) for (const id of b.topics) assigned.add(id);

/** Recompute a batch's cost from the index, so index refreshes flow through. */
const cost = (topicIds) => {
  const topics = topicIds.map((id) => byId.get(id)).filter(Boolean);
  return {
    topic_count: topicIds.length,
    est_posts: topics.reduce((a, t) => a + t.post_count, 0),
    est_pages: topics.reduce((a, t) => a + t.est_pages, 0),
  };
};

const batches = previous.batches.map((b) => ({ ...b, ...cost(b.topics) }));

// Anything in the index that no batch claims yet — on a first run, everything.
const pending = index.topics
  .filter((t) => !assigned.has(t.topic_id))
  .sort((a, b) => a.topic_id - b.topic_id);

let nextId = batches.reduce((a, b) => Math.max(a, Number(b.id)), 0) + 1;
const open = () => ({ id: String(nextId++).padStart(3, "0"), topics: [], pages: 0 });
let cur = open();

const close = () => {
  if (!cur.topics.length) return;
  batches.push({
    id: cur.id,
    oversized: cur.topics.length === 1 && cur.pages > MAX_PAGES,
    topics: cur.topics,
    ...cost(cur.topics),
  });
  cur = open();
};

for (const t of pending) {
  // A thread that cannot fit any batch gets one to itself.
  if (t.est_pages > MAX_PAGES) {
    close();
    cur.topics.push(t.topic_id);
    cur.pages = t.est_pages;
    close();
    continue;
  }
  if (cur.pages + t.est_pages > MAX_PAGES || cur.topics.length + 1 > MAX_TOPICS) close();
  cur.topics.push(t.topic_id);
  cur.pages += t.est_pages;
}
close();

const plan = {
  generated_at: new Date().toISOString(),
  index: INDEX,
  index_generated_at: index.generated_at,
  max_pages: MAX_PAGES,
  max_topics: MAX_TOPICS,
  batches,
};

const total = (fn) => batches.reduce((a, b) => a + fn(b), 0);
const added = batches.length - previous.batches.length;
console.log(
  `${batches.length} batches (${added} new) covering ${total((b) => b.topic_count)} topics, ` +
    `${total((b) => b.est_posts)} posts, ${total((b) => b.est_pages)} page fetches.`
);
const oversized = batches.filter((b) => b.oversized);
if (oversized.length)
  console.log(
    `${oversized.length} oversized single-thread batch(es): ` +
      oversized.map((b) => `${b.id} (${b.est_pages}p)`).join(", ")
  );
const mins = batches.map((b) => (b.est_pages * 1.2) / 60).sort((a, b) => a - b);
console.log(
  `crawl minutes per batch @1.2s — median ${mins[mins.length >> 1].toFixed(0)}, ` +
    `max ${mins[mins.length - 1].toFixed(0)}`
);

if (DRY) {
  console.log("\n--dry-run: nothing written.");
} else {
  await mkdir(dirname(PLAN), { recursive: true });
  await writeFile(PLAN, JSON.stringify(plan, null, 2) + "\n");
  console.log(`\nWrote ${PLAN}`);
}
