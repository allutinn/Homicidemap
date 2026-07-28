/**
 * Read a crawled batch shard — the handoff from the crawl to the review passes.
 *
 *   node scripts/murha-batch-read.mjs --batch 007            # list its threads
 *   node scripts/murha-batch-read.mjs --batch 007 --topic 43 # one thread, full
 *   node scripts/murha-batch-read.mjs --batch 007 --topic 43 --condense
 *
 * Options:
 *   --batch 007      required, unless --file is given
 *   --file <path>    read threads from a plain JSON array of threads instead of
 *                    a batch shard — the curated data/kajaani-cases.json, whose
 *                    threads predate the batch pipeline, is the reason this
 *                    exists. Lets the same condensing and the same review path
 *                    run against threads whose extracted answers are already
 *                    known, which is how the pipeline gets back-tested.
 *   --topic <id>     dump one thread instead of listing the batch
 *   --text           render that thread as plain text rather than JSON
 *   --condense       render it reduced to what a review needs to read — the
 *                    default way to read anything large (see lib/condense.mjs)
 *   --candidates     list every sentence in the thread that names a place, with
 *                    its permalink. Machine-extracted, so a reviewer can cite
 *                    one without transcribing it by hand — see lib/candidates.mjs
 *   --budget 500000  character budget for --condense
 *   --shards crawl/threads
 *   --state data/pipeline-state.json
 *
 * The shards are gzipped and up to tens of MB, so a review agent should not be
 * asked to open them directly. This prints one thread at a time, which is the
 * unit the review works in: one thread, one verdict.
 */
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { arg, flag } from "./lib/forum.mjs";
import { condense, CHAR_BUDGET } from "./lib/condense.mjs";
import { placeCandidates } from "./lib/candidates.mjs";

const BATCH = arg("batch", null);
const FILE = arg("file", null);
const SHARDS = arg("shards", "crawl/threads");
const TOPIC = arg("topic", null);

if (!BATCH && !FILE) {
  console.error("--batch or --file is required.");
  process.exit(2);
}

/** Topic id from a viewtopic link, for threads that predate the topic_id field. */
const idFromLink = (link) => Number(new URL(link).searchParams.get("t")) || null;

/** Shards are written gzipped by default, but --no-gzip runs leave plain JSON. */
const load = async (batch) => {
  for (const name of [`batch-${batch}.json.gz`, `batch-${batch}.json`]) {
    const path = join(SHARDS, name);
    try {
      const raw = await readFile(path);
      return JSON.parse(name.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  console.error(
    `No shard for batch ${batch} in ${SHARDS}. ` +
      `Crawl it first: node scripts/murha-crawl-batch.mjs --batch ${batch}`
  );
  process.exit(1);
};

/** A plain array of threads, shaped like a shard so the rest of this is shared. */
const loadFile = async (path) => {
  const threads = JSON.parse(await readFile(path, "utf8")).map((t) => ({
    ...t,
    topic_id: t.topic_id ?? idFromLink(t.link),
    batch: t.batch ?? "-",
  }));
  return {
    batch: path,
    crawled_at: null,
    topic_count: threads.length,
    message_count: threads.reduce((a, t) => a + (t.message_count ?? t.messages?.length ?? 0), 0),
    threads,
  };
};

const shard = FILE ? await loadFile(FILE) : await load(BATCH);

if (!TOPIC) {
  console.log(
    JSON.stringify(
      {
        batch: shard.batch,
        crawled_at: shard.crawled_at,
        topic_count: shard.topic_count,
        message_count: shard.message_count,
        threads: shard.threads.map((t) => ({
          topic_id: t.topic_id,
          topic: t.topic,
          link: t.link,
          forum: t.forum,
          message_count: t.message_count,
          expected_message_count: t.expected_message_count,
          truncated: t.truncated,
          // The opening post is usually the case summary; enough to triage on.
          opening_post: t.messages[0]?.text.slice(0, 800) ?? "",
        })),
      },
      null,
      2
    )
  );
  process.exit(0);
}

const thread = shard.threads.find((t) => String(t.topic_id) === String(TOPIC));
if (!thread) {
  console.error(`Batch ${BATCH} has no topic ${TOPIC}.`);
  process.exit(1);
}

if (flag("candidates")) {
  const c = placeCandidates(thread);
  process.stderr.write(`[candidates] ${thread.message_count} posts -> ${c.length} place-sentences\n`);
  console.log(`# ${thread.topic}\n${thread.link}\n${c.length} candidate place-sentences\n`);
  for (const x of c)
    console.log(
      `--- #${x.index} ${x.permalink}${x.quoted ? " [quoted material]" : ""} [${x.signals.join(",")}]\n${x.sentence}\n`
    );
  process.exit(0);
}

if (flag("condense")) {
  const r = condense(thread, { charBudget: Number(arg("budget", String(CHAR_BUDGET))) });
  process.stderr.write(
    `[condense] ${thread.message_count} posts -> ${r.shown} shown, ` +
      `${(r.total_chars / 1000).toFixed(0)}k -> ${(r.chars / 1000).toFixed(0)}k chars (tier: ${r.tier})\n`
  );
  console.log(r.text);
  process.exit(0);
}

if (!flag("text")) {
  console.log(JSON.stringify(thread, null, 2));
  process.exit(0);
}

console.log(`# ${thread.topic}\n${thread.link}\n${thread.forum} — ${thread.message_count} messages\n`);
for (const m of thread.messages) {
  console.log(`--- #${m.index} ${m.author} ${m.date ?? m.date_text} ${m.permalink ?? ""}`);
  for (const q of m.quotes) console.log(`> ${q}`);
  console.log(m.text);
  for (const l of m.links) console.log(`[link] ${l.text} ${l.href}`);
  for (const i of m.images) console.log(`[image] ${i}`);
  console.log();
}
