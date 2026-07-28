/**
 * Enumerate every topic in one or more murha.info forums.
 *
 *   node scripts/murha-forums.mjs [options]
 *
 * Where murha-search.mjs asks "which topics mention X?", this asks "what is in
 * this forum, all of it?" — it walks `viewforum.php` page by page and records
 * every topic with the reply count the forum itself reports. That count is the
 * crawl cost of the thread (phpBB renders 15 posts per page), so the output is
 * both the census of what exists and the input to batch planning.
 *
 * Options:
 *   --forums 2,15          forum ids to enumerate (default: the homicide ones)
 *   --base https://murha.info/rikosfoorumi
 *   --max-pages 400        viewforum pages per forum
 *   --delay 1200           ms between requests
 *   --out data/forum-index.json
 *   --summary <file>       print a census of an existing index; no network
 *
 * Output: JSON { generated_at, base, forums: [...], topics: [...] } where each
 * topic is { topic_id, topic, link, forum, forum_id, author, date, replies,
 *            post_count, est_pages }
 *
 * `post_count` is replies + 1 (phpBB counts the opening post separately) and
 * `est_pages` is the number of viewtopic fetches the thread will cost.
 * Every field comes from the page — nothing is inferred beyond that arithmetic.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchDoc, sleep, clean, arg, canonicalTopic, topicId } from "./lib/forum.mjs";

/** phpBB renders this many posts per viewtopic page. */
export const POSTS_PER_PAGE = 15;

/**
 * The forums the map draws on. Finnish homicides are the subject matter; the
 * rest of the board is other crimes, other countries, or off-topic chat.
 */
export const DEFAULT_FORUMS = [2, 15];

const BASE = arg("base", "https://murha.info/rikosfoorumi").replace(/\/$/, "");
const MAX_PAGES = Number(arg("max-pages", "400"));
const DELAY = Number(arg("delay", "1200"));
const OUT = arg("out", "data/forum-index.json");
const FORUMS = arg("forums", DEFAULT_FORUMS.join(","))
  .split(",")
  .map((s) => Number(s.trim()))
  .filter(Boolean);

/**
 * Census of an index: topics, posts and fetch cost per forum. Reported on every
 * run and available on its own via --summary, so the numbers behind a batch
 * plan can be re-checked without touching the forum.
 */
export const summarise = (index) => {
  const byForum = new Map();
  for (const t of index.topics) {
    const key = `${t.forum_id}|${t.forum ?? ""}`;
    const row = byForum.get(key) ?? { forum_id: t.forum_id, forum: t.forum, topics: 0, posts: 0, pages: 0 };
    row.topics++;
    row.posts += t.post_count;
    row.pages += t.est_pages;
    byForum.set(key, row);
  }
  const rows = [...byForum.values()].sort((a, b) => b.topics - a.topics);
  const total = rows.reduce(
    (a, r) => ({ topics: a.topics + r.topics, posts: a.posts + r.posts, pages: a.pages + r.pages }),
    { topics: 0, posts: 0, pages: 0 }
  );
  return { rows, total };
};

const printSummary = (index) => {
  const { rows, total } = summarise(index);
  const pad = (s, n) => String(s).padStart(n);
  console.log(`\n${"forum".padEnd(46)} ${pad("aiheet", 7)} ${pad("viestit", 9)} ${pad("sivut", 7)}`);
  for (const r of rows)
    console.log(
      `${`${r.forum ?? "?"} (f=${r.forum_id})`.slice(0, 46).padEnd(46)} ` +
        `${pad(r.topics, 7)} ${pad(r.posts, 9)} ${pad(r.pages, 7)}`
    );
  console.log(
    `${"TOTAL".padEnd(46)} ${pad(total.topics, 7)} ${pad(total.posts, 9)} ${pad(total.pages, 7)}`
  );

  // The distribution matters more than the mean: a handful of threads carry a
  // large share of the posts, so a batch of N topics is not a fixed cost.
  const sorted = [...index.topics].sort((a, b) => b.post_count - a.post_count);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]?.post_count ?? 0;
  console.log(
    `\nposts per topic — p50 ${at(0.5)}, p90 ${at(0.1)}, p99 ${at(0.01)}, max ${sorted[0]?.post_count ?? 0}`
  );
  const top = sorted.slice(0, 5);
  const topShare = ((top.reduce((a, t) => a + t.post_count, 0) / (total.posts || 1)) * 100).toFixed(1);
  console.log(`top 5 threads hold ${topShare}% of all posts:`);
  for (const t of top) console.log(`  ${pad(t.post_count, 6)}  ${t.topic.slice(0, 80)}`);
};

const SUMMARY = arg("summary", null);
if (SUMMARY) {
  printSummary(JSON.parse(await readFile(SUMMARY, "utf8")));
  process.exit(0);
}

/** Topic rows on a viewforum page, skipping announcements and global stickies. */
const extractTopics = (document, forumId, forumName) => {
  const out = [];
  for (const a of document.querySelectorAll("a.topictitle")) {
    const row = a.closest("li.row") || a.closest("li") || a.parentElement;
    // Announcements and global stickies repeat on every page of every forum and
    // are board furniture ("Palstan säännöt"), not cases.
    const cls = row?.getAttribute("class") ?? "";
    if (/\bglobal-announce|\bannounce\b/.test(cls)) continue;

    const meta = row?.querySelector(".responsive-hide.left-box");
    const replies = Number(clean(row?.querySelector("dd.posts")?.textContent).match(/\d+/)?.[0] ?? 0);
    const link = canonicalTopic(a.getAttribute("href"), BASE);
    const postCount = replies + 1; // phpBB reports replies, excluding the opener
    out.push({
      topic_id: Number(topicId(link)),
      topic: clean(a.textContent),
      link,
      forum: forumName,
      forum_id: forumId,
      author: clean(meta?.querySelector(".username")?.textContent) || null,
      date: meta?.querySelector("time")?.getAttribute("datetime") ?? null,
      replies,
      post_count: postCount,
      est_pages: Math.ceil(postCount / POSTS_PER_PAGE),
    });
  }
  return out;
};

const topics = new Map();
const forums = [];

for (const f of FORUMS) {
  let start = 0;
  let previousFirst = null;
  let name = null;
  let reported = null;
  let found = 0;

  for (let p = 0; p < MAX_PAGES; p++) {
    // sk=t&sd=a sorts by topic start time ascending, which is stable: new
    // threads land at the end instead of shuffling every existing page.
    const url = `${BASE}/viewforum.php?f=${f}&sk=t&sd=a${start ? `&start=${start}` : ""}`;
    const { ok, status, document } = await fetchDoc(url);
    if (!ok) {
      console.warn(`[f=${f}] HTTP ${status} on page ${p + 1} — stopping this forum.`);
      break;
    }

    if (name === null) {
      name = clean(document.querySelector("h2 a, h2")?.textContent) || `f=${f}`;
      reported = Number(
        clean(document.querySelector(".pagination")?.textContent).match(/([\d\s]+)\s*viestiketju/i)?.[1]
          ?.replace(/\s/g, "") ?? 0
      ) || null;
    }

    const rows = extractTopics(document, f, name);
    if (!rows.length) break;

    // phpBB clamps an out-of-range `start` and re-serves the last page, so the
    // walk ends when a page repeats the previous page's first topic.
    if (rows[0].topic_id === previousFirst) break;
    previousFirst = rows[0].topic_id;

    let fresh = 0;
    for (const r of rows) {
      if (topics.has(r.topic_id)) continue;
      topics.set(r.topic_id, r);
      fresh++;
      found++;
    }
    console.log(`[f=${f}] page ${p + 1}: ${rows.length} rows, ${fresh} new (${found} in forum)`);

    start += rows.length;
    await sleep(DELAY);
  }

  forums.push({ forum_id: f, forum: name, reported_topics: reported, collected_topics: found });
  if (reported && found !== reported)
    console.warn(`[f=${f}] collected ${found} topics but the forum reports ${reported}.`);
}

const index = {
  generated_at: new Date().toISOString(),
  base: BASE,
  posts_per_page: POSTS_PER_PAGE,
  forums,
  topics: [...topics.values()].sort((a, b) => a.topic_id - b.topic_id),
};

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(index, null, 2) + "\n");
console.log(`\nWrote ${index.topics.length} topics to ${OUT}`);
printSummary(index);
