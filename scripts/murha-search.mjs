/**
 * Search murha.info/rikosfoorumi (phpBB) for topics and emit a JSON list.
 *
 *   node scripts/murha-search.mjs [options]
 *
 * Options:
 *   --keywords "kajaani"       search terms; repeat the flag to run several
 *                              searches and merge the results
 *   --terms all|any            require all words (default) or any
 *   --base https://murha.info/rikosfoorumi
 *   --max-pages 20             result pages to walk per keyword set
 *   --overview                 open each topic and pull the first post
 *   --delay 1200               ms between requests
 *   --out data/kajaani-topics.json
 *   --reclassify <file>        re-run the heuristic over an existing index and
 *                              rewrite it; no network access at all
 *
 * Only TOPICS are requested (phpBB `sr=topics`), never individual posts.
 *
 * Output: JSON array of { topic, link, forum, author, date, replies,
 *                         matched_keywords, overview, valid,
 *                         kajaani_in_overview, reasoning, needs_review }
 *
 * `valid` is set by the heuristic in lib/classify.mjs and is NOT authoritative
 * — every item carries `needs_review: true` so a human (or a model) can confirm
 * whether the topic is a specific Kajaani case rather than general discussion.
 * Nothing here invents data: every field comes from the page.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { classify } from "./lib/classify.mjs";
import {
  fetchDoc,
  sleep,
  clean,
  arg,
  flag,
  canonicalTopic,
  topicId,
} from "./lib/forum.mjs";

/** Collect every --keywords occurrence, so several searches can be merged. */
const keywordSets = () => {
  const out = [];
  process.argv.forEach((a, i) => {
    if (a === "--keywords" && process.argv[i + 1] && !process.argv[i + 1].startsWith("--"))
      out.push(process.argv[i + 1]);
  });
  return out.length ? out : ["kajaani"];
};

const KEYWORD_SETS = keywordSets();
const TERMS = arg("terms", "all");
const BASE = arg("base", "https://murha.info/rikosfoorumi").replace(/\/$/, "");
const MAX_PAGES = Number(arg("max-pages", "20"));
const DELAY = Number(arg("delay", "1200"));
const OUT = arg("out", "data/kajaani-topics.json");
const WANT_OVERVIEW = flag("overview");

/** phpBB search URL. sr=topics restricts results to topics, not single posts. */
const searchUrl = (keywords, start) => {
  const p = new URLSearchParams({
    keywords,
    terms: TERMS,
    sf: "all", // search titles and message text
    sr: "topics", // TOPICS ONLY
    sk: "t",
    sd: "d",
    st: "0",
    ch: "300",
    submit: "Search",
  });
  if (start) p.set("start", String(start));
  return `${BASE}/search.php?${p}`;
};

/** Pull topic rows out of a phpBB 3.2/3.3 search-results page. */
const extractTopics = (document) => {
  const out = [];
  for (const a of document.querySelectorAll("a.topictitle")) {
    const row = a.closest("li.row") || a.closest("li") || a.parentElement;
    // The "responsive-hide left-box" line carries the topic's own author/date;
    // the "lastpost" cell carries the most recent reply instead.
    const meta = row?.querySelector(".responsive-hide.left-box");
    out.push({
      topic: clean(a.textContent),
      href: a.getAttribute("href"),
      forum: clean(meta?.querySelector("a[href*='viewforum.php']")?.textContent),
      author: clean(meta?.querySelector(".username")?.textContent),
      date: meta?.querySelector("time")?.getAttribute("datetime") ?? null,
      replies: Number(clean(row?.querySelector("dd.posts")?.textContent).match(/\d+/)?.[0] ?? 0),
    });
  }
  return out;
};

/** First post of a topic, used as the overview. */
const extractOverview = (document) => {
  const first = document.querySelector(".post .content, .postbody .content");
  return clean(first?.textContent).slice(0, 1500);
};

const seen = new Map();

/** Rebuild the classification of an existing index without touching the forum. */
const RECLASSIFY = arg("reclassify", null);
if (RECLASSIFY) {
  const existing = JSON.parse(await readFile(RECLASSIFY, "utf8"));
  const rewritten = existing.map((row) => {
    const { valid, kajaani_in_overview, reasoning } = classify(row);
    return { ...row, valid, kajaani_in_overview, reasoning, needs_review: true };
  });
  await writeFile(RECLASSIFY, JSON.stringify(rewritten, null, 2) + "\n");
  const before = existing.filter((r) => r.valid).length;
  const after = rewritten.filter((r) => r.valid).length;
  console.log(
    `Reclassified ${rewritten.length} topics in ${RECLASSIFY}: ` +
      `${before} → ${after} valid.`
  );
  process.exit(0);
}

for (const keywords of KEYWORD_SETS) {
  let start = 0;
  let previousFirst = null;
  for (let p = 0; p < MAX_PAGES; p++) {
    const url = searchUrl(keywords, start);
    console.log(`[search:${keywords}] page ${p + 1}`);
    const { ok, status, document } = await fetchDoc(url);
    if (!ok) {
      console.warn(`[search:${keywords}] HTTP ${status} — stopping.`);
      break;
    }

    const rows = extractTopics(document);
    if (!rows.length) {
      console.log(`[search:${keywords}] no more topic results.`);
      break;
    }

    // phpBB clamps an out-of-range `start` and re-serves the last page, so the
    // walk ends when a page repeats the previous page's first result.
    const first = canonicalTopic(rows[0].href, BASE);
    if (first === previousFirst) {
      console.log(`[search:${keywords}] pagination exhausted.`);
      break;
    }
    previousFirst = first;

    let fresh = 0;
    for (const r of rows) {
      const link = canonicalTopic(r.href, BASE);
      const id = topicId(link);
      const existing = seen.get(id);
      if (existing) {
        if (!existing.matched_keywords.includes(keywords))
          existing.matched_keywords.push(keywords);
        continue;
      }
      seen.set(id, { ...r, link, matched_keywords: [keywords] });
      fresh++;
    }
    console.log(
      `[search:${keywords}] ${rows.length} rows, ${fresh} new (total ${seen.size})`
    );

    // Advance by however many results this page returned, so the walk works
    // whatever the forum's per-page setting is.
    start += rows.length;
    await sleep(DELAY);
  }
}

if (WANT_OVERVIEW) {
  let n = 0;
  for (const [id, item] of seen) {
    n++;
    const { ok, status, document } = await fetchDoc(item.link);
    if (!ok) {
      console.warn(`[overview ${n}/${seen.size}] t=${id} HTTP ${status}`);
    } else {
      item.overview = extractOverview(document);
      console.log(
        `[overview ${n}/${seen.size}] t=${id} ${item.overview ? "ok" : "empty"}`
      );
    }
    await sleep(DELAY);
  }
}

const results = [...seen.values()].map((item) => {
  const overview = item.overview || "";
  const { valid, kajaani_in_overview, reasoning } = classify({ ...item, overview });
  return {
    topic: item.topic,
    link: item.link,
    forum: item.forum || null,
    author: item.author || null,
    date: item.date || null,
    replies: item.replies,
    matched_keywords: item.matched_keywords,
    overview,
    valid,
    kajaani_in_overview,
    reasoning,
    needs_review: true,
  };
});

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(results, null, 2) + "\n");

console.log(
  `\nWrote ${results.length} topics to ${OUT} ` +
    `(${results.filter((r) => r.valid).length} flagged valid, all need review).`
);
