/**
 * Fetch every message of each selected topic from the murha.info Rikosfoorumi.
 *
 *   node scripts/murha-threads.mjs [options]
 *
 * Reads the topic list produced by scripts/murha-search.mjs, keeps the topics
 * that passed prefiltering, then walks each thread's pagination and captures
 * every post: author, date, text, quotes, links and images.
 *
 * Options:
 *   --in data/kajaani-topics.json     topic list from murha-search.mjs
 *   --out data/kajaani-cases.json     output path
 *   --limit 0                         max topics to fetch (0 = no limit)
 *   --all                             include topics prefiltered as invalid
 *   --base https://murha.info/rikosfoorumi
 *   --max-pages 400                   post pages per thread
 *   --delay 1200                      ms between requests
 *   --resume                          keep topics already present in --out
 *
 * Output: JSON array of
 *   { topic, link, forum, valid, reasoning, needs_review, message_count,
 *     messages: [ { index, post_id, permalink, author, date, date_text,
 *                   text, quotes, links: [{text, href}], images: [src] } ] }
 *
 * Every field is read from the page — nothing is inferred or invented.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { sleep, arg, flag } from "./lib/forum.mjs";
import { crawlThread } from "./lib/thread.mjs";

const IN = arg("in", "data/kajaani-topics.json");
const OUT = arg("out", "data/kajaani-cases.json");
const LIMIT = Number(arg("limit", "0"));
const BASE = arg("base", "https://murha.info/rikosfoorumi").replace(/\/$/, "");
const MAX_PAGES = Number(arg("max-pages", "400"));
const DELAY = Number(arg("delay", "1200"));

const topics = JSON.parse(await readFile(IN, "utf8"));
let selected = flag("all") ? topics : topics.filter((t) => t.valid);
if (LIMIT > 0) selected = selected.slice(0, LIMIT);

/** Reuse anything already crawled into --out, so an interrupted run can resume. */
const done = new Map();
if (flag("resume")) {
  try {
    for (const c of JSON.parse(await readFile(OUT, "utf8"))) done.set(c.link, c);
    console.log(`Resuming: ${done.size} topics already in ${OUT}.`);
  } catch {
    /* no previous output — start fresh */
  }
}

console.log(
  `${topics.length} topics in ${IN}; ${selected.length} selected` +
    `${flag("all") ? " (--all)" : " (valid only)"}${LIMIT > 0 ? `, limit ${LIMIT}` : ""}.`
);
if (!selected.length) {
  console.warn("Nothing to fetch — run scripts/murha-search.mjs first.");
  process.exit(1);
}

const cases = [];
let failures = 0;

for (const [n, topic] of selected.entries()) {
  const label = `[${n + 1}/${selected.length}]`;

  if (done.has(topic.link)) {
    const cached = done.get(topic.link);
    cases.push(cached);
    console.log(`${label} ${topic.topic} — ${cached.message_count} messages (cached)`);
    continue;
  }

  const { messages, expected, truncated, failed } = await crawlThread(topic.link, {
    base: BASE,
    maxPages: MAX_PAGES,
    delay: DELAY,
  });
  if (failed) failures++;

  const record = {
    topic: topic.topic,
    link: topic.link,
    forum: topic.forum ?? null,
    valid: topic.valid,
    reasoning: topic.reasoning,
    needs_review: topic.needs_review ?? true,
    expected_message_count: expected,
    message_count: messages.length,
    truncated,
    messages, // already carry index and permalink from crawlThread
  };
  cases.push(record);

  const short =
    expected && messages.length < expected ? ` (expected ${expected} — INCOMPLETE)` : "";
  console.log(`${label} ${topic.topic} — ${messages.length} messages${short}`);

  // Write after every topic so a long crawl survives an interruption.
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(cases, null, 2) + "\n");
  await sleep(DELAY);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(cases, null, 2) + "\n");

const sum = (fn) => cases.reduce((a, c) => a + fn(c), 0);
const incomplete = cases.filter(
  (c) => c.truncated || (c.expected_message_count && c.message_count < c.expected_message_count)
);
console.log(
  `\nWrote ${cases.length} cases / ${sum((c) => c.message_count)} messages ` +
    `(${sum((c) => c.messages.reduce((b, m) => b + m.links.length, 0))} links, ` +
    `${sum((c) => c.messages.reduce((b, m) => b + m.images.length, 0))} images) to ${OUT}`
);
if (incomplete.length)
  console.warn(
    `${incomplete.length} thread(s) incomplete (${failures} fetch failure(s)):\n` +
      incomplete.map((c) => `  - ${c.topic} (${c.message_count}/${c.expected_message_count})`).join("\n")
  );
