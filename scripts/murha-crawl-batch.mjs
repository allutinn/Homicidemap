/**
 * Crawl the next pending batch (or a named one) and record it in the state file.
 *
 *   node scripts/murha-crawl-batch.mjs [options]
 *
 * Options:
 *   --plan  data/batch-plan.json
 *   --index data/forum-index.json
 *   --state data/pipeline-state.json
 *   --shards crawl/threads          where batch shards are written
 *   --batch 007                     a specific batch (default: next pending)
 *   --count 1                       how many batches this run
 *   --base https://murha.info/rikosfoorumi
 *   --delay 1200                    ms between requests
 *   --no-gzip                       write .json instead of .json.gz
 *   --force                         re-crawl a batch already marked crawled
 *
 * One shard per batch — `crawl/threads/batch-007.json.gz` — so a run writes one
 * new file and never rewrites 400 MB of previously crawled threads. The shards
 * hold the verbatim forum posts and are kept out of the Pages payload; see
 * README for where they live.
 *
 * Every field is read from the page. Nothing is inferred or invented.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { arg, flag, sleep } from "./lib/forum.mjs";
import { crawlThread } from "./lib/thread.mjs";
import { loadState, saveState, recordStage, readyFor, shardPresent } from "./lib/state.mjs";

const PLAN = arg("plan", "data/batch-plan.json");
const INDEX = arg("index", "data/forum-index.json");
const STATE = arg("state", "data/pipeline-state.json");
const SHARDS = arg("shards", "crawl/threads");
const BASE = arg("base", "https://murha.info/rikosfoorumi").replace(/\/$/, "");
const DELAY = Number(arg("delay", "1200"));
const COUNT = Number(arg("count", "1"));
const ONLY = arg("batch", null);
const GZIP = !flag("no-gzip");

const plan = JSON.parse(await readFile(PLAN, "utf8"));
const index = JSON.parse(await readFile(INDEX, "utf8"));
const byId = new Map(index.topics.map((t) => [t.topic_id, t]));
const state = await loadState(STATE);

let queue;
if (ONLY) {
  const batch = plan.batches.find((b) => b.id === ONLY);
  if (!batch) {
    console.error(`No batch ${ONLY} in ${PLAN}.`);
    process.exit(1);
  }
  if (state.batches[ONLY]?.crawl?.at && !flag("force")) {
    console.error(`Batch ${ONLY} was crawled at ${state.batches[ONLY].crawl.at}; pass --force to redo it.`);
    process.exit(1);
  }
  queue = [batch];
} else {
  // A recorded crawl whose shard is missing is not a crawl. This is the normal
  // case for CI picking up state committed from a local run: the entry is
  // there, the posts are not, so the batch is crawled again rather than skipped.
  const pending = plan.batches.filter(
    (b) => !state.batches[b.id]?.crawl?.at || !shardPresent(state, b.id, SHARDS)
  );
  const readopted = pending.filter((b) => state.batches[b.id]?.crawl?.at);
  if (readopted.length)
    console.log(
      `${readopted.length} batch(es) recorded as crawled but missing their shard ` +
        `in ${SHARDS} — re-crawling: ${readopted.map((b) => b.id).join(", ")}`
    );
  queue = pending.slice(0, COUNT);
}

if (!queue.length) {
  console.log("Nothing pending — every batch in the plan has been crawled.");
  process.exit(0);
}

for (const batch of queue) {
  const topics = batch.topics.map((id) => byId.get(id)).filter(Boolean);
  console.log(
    `\n=== batch ${batch.id}: ${topics.length} topics, ~${batch.est_posts} posts, ` +
      `~${batch.est_pages} fetches (~${((batch.est_pages * DELAY) / 60000).toFixed(0)} min) ===`
  );

  const records = [];
  const incomplete = [];

  for (const [n, topic] of topics.entries()) {
    const { messages, expected, rendered, truncated, failed } = await crawlThread(topic.link, {
      base: BASE,
      delay: DELAY,
    });

    // Pages missed, not posts deduplicated — see crawlThread on why the two
    // differ. A thread short only because phpBB double-served a post is whole.
    const missed = expected ? Math.max(0, expected - rendered) : 0;
    const deduped = rendered - messages.length;
    records.push({
      topic_id: topic.topic_id,
      topic: topic.topic,
      link: topic.link,
      forum: topic.forum,
      forum_id: topic.forum_id,
      batch: batch.id,
      expected_message_count: expected,
      rendered_count: rendered,
      message_count: messages.length,
      truncated,
      messages,
    });
    if (truncated || missed)
      incomplete.push({ topic_id: topic.topic_id, got: messages.length, rendered, expected });

    console.log(
      `  [${n + 1}/${topics.length}] t=${topic.topic_id} ${topic.topic.slice(0, 60)} — ` +
        `${messages.length} messages` +
        (missed ? ` (${rendered}/${expected} served — INCOMPLETE)` : "") +
        (deduped ? ` (${deduped} double-served post${deduped > 1 ? "s" : ""} deduped)` : "") +
        (failed ? " [fetch failed]" : "")
    );
    await sleep(DELAY);
  }

  const shard = join(SHARDS, `batch-${batch.id}.json${GZIP ? ".gz" : ""}`);
  const payload =
    JSON.stringify(
      {
        batch: batch.id,
        base: BASE,
        crawled_at: new Date().toISOString(),
        topic_count: records.length,
        message_count: records.reduce((a, r) => a + r.message_count, 0),
        threads: records,
      },
      null,
      GZIP ? 0 : 2
    ) + "\n";

  await mkdir(SHARDS, { recursive: true });
  const bytes = GZIP ? gzipSync(payload) : payload;
  await writeFile(shard, bytes);

  recordStage(state, batch.id, "crawl", {
    shard,
    topics: records.length,
    messages: records.reduce((a, r) => a + r.message_count, 0),
    bytes: Buffer.byteLength(bytes),
    incomplete,
  });
  await saveState(STATE, state);

  console.log(
    `batch ${batch.id} → ${shard} ` +
      `(${records.length} threads, ${records.reduce((a, r) => a + r.message_count, 0)} messages, ` +
      `${(Buffer.byteLength(bytes) / 1048576).toFixed(1)} MB)` +
      (incomplete.length ? ` — ${incomplete.length} incomplete` : "")
  );
}

const remaining = readyFor(state, plan, "crawl").length;
console.log(`\n${remaining} batch(es) still to crawl.`);
