/**
 * Search murha.info/rikosfoorumi (phpBB) for topics and emit a JSON list.
 *
 *   node scripts/murha-search.mjs [options]
 *
 * Options:
 *   --keywords "kajaani henkirikos"   search terms (default: "kajaani henkirikos")
 *   --terms all|any                   require all words (default) or any
 *   --base https://murha.info/rikosfoorumi   forum base URL
 *   --max-pages 10                    result pages to walk (default 10)
 *   --overview                        open each topic and pull the first post as overview
 *   --delay 1500                      ms between requests when using --overview
 *   --out data/kajaani-topics.json    output path
 *   --headed                          show the browser
 *
 * Only TOPICS are requested (phpBB `sr=topics`), never individual posts.
 *
 * Output: JSON array of { topic, link, forum, author, date, overview,
 *                         valid, reasoning }
 *
 * `valid` is set by a keyword heuristic and is NOT authoritative — every item
 * is emitted with `needs_review: true` so a human (or a model) can confirm
 * whether the topic is a specific Kajaani homicide case rather than general
 * discussion. Nothing here invents data: every field comes from the page.
 */
import { chromium } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const KEYWORDS = arg("keywords", "kajaani henkirikos");
const TERMS = arg("terms", "all");
const BASE = arg("base", "https://murha.info/rikosfoorumi").replace(/\/$/, "");
const MAX_PAGES = Number(arg("max-pages", "10"));
const DELAY = Number(arg("delay", "1500"));
const OUT = arg("out", "data/kajaani-topics.json");
const WANT_OVERVIEW = flag("overview");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** phpBB search URL. sr=topics restricts results to topics, not single posts. */
const searchUrl = (start) => {
  const p = new URLSearchParams({
    keywords: KEYWORDS,
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

/** Pull topic rows out of a phpBB search-results page (3.0 and 3.2/3.3 markup). */
const extractTopics = (page) =>
  page.evaluate(() => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const out = [];
    for (const a of document.querySelectorAll("a.topictitle")) {
      const box =
        a.closest(".search") ||
        a.closest(".post") ||
        a.closest("li") ||
        a.closest("tr") ||
        a.parentElement;
      out.push({
        topic: clean(a.textContent),
        href: a.getAttribute("href"),
        forum: clean(box?.querySelector("a[href*='viewforum.php']")?.textContent),
        author: clean(box?.querySelector("a[href*='memberlist.php'], .author a")?.textContent),
        date: clean(box?.querySelector(".author, .responsive-hide")?.textContent),
        snippet: clean(box?.querySelector(".content, .postbody .content")?.textContent),
      });
    }
    return out;
  });

/** Absolute, canonical topic URL; phpBB emits "./viewtopic.php?f=5&t=123&hilit=x". */
const normalise = (href) => {
  const url = new URL(href.replace(/^\.\//, ""), `${BASE}/`);
  const t = url.searchParams.get("t");
  return t ? `${BASE}/viewtopic.php?t=${t}` : url.href;
};

const topicId = (link) => new URL(link).searchParams.get("t") ?? link;

/**
 * Heuristic pre-classification. Deliberately conservative: it flags what looks
 * like a specific case, and everything is marked needs_review.
 */
const classify = ({ topic, snippet, overview }) => {
  const hay = `${topic} ${snippet} ${overview}`.toLowerCase();
  const title = topic.toLowerCase();

  if (!hay.includes("kajaani") && !hay.includes("kajaanin")) {
    return [false, "No mention of Kajaani in the title, snippet or overview."];
  }

  const caseWords = [
    "murha", "henkirikos", "surma", "puukot", "tapp", "kuolem",
    "katosi", "kadonnut", "epäilty", "syyte", "tuomio", "uhri",
  ];
  const generalWords = [
    "yleinen keskustelu", "yleistä", "mitä mieltä", "spekulaatio",
    "kysymys", "ohje", "säännöt", "tervetuloa", "esittely", "media",
  ];

  const hits = caseWords.filter((w) => hay.includes(w));
  const general = generalWords.filter((w) => hay.includes(w));
  const datedTitle = /\b(19|20)\d{2}\b/.test(title);

  if (general.length && !hits.length) {
    return [false, `Reads as general discussion (matched: ${general.join(", ")}).`];
  }
  if (hits.length) {
    return [
      true,
      `Mentions Kajaani and case terms (${hits.join(", ")})${
        datedTitle ? "; title carries a year, typical of a specific case" : ""
      }.`,
    ];
  }
  return [false, "Mentions Kajaani but no homicide-case indicators found."];
};

const browser = await chromium.launch({ headless: !flag("headed") });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  locale: "fi-FI",
});
const page = await context.newPage();

const seen = new Map();

let start = 0;
for (let p = 0; p < MAX_PAGES; p++) {
  const url = searchUrl(start);
  console.log(`[search] page ${p + 1}: ${url}`);
  const res = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (!res || !res.ok()) {
    console.warn(`[search] HTTP ${res?.status()} — stopping.`);
    break;
  }

  const rows = await extractTopics(page);
  if (!rows.length) {
    console.log("[search] no more topic results.");
    break;
  }

  let fresh = 0;
  for (const r of rows) {
    const link = normalise(r.href);
    const id = topicId(link);
    if (seen.has(id)) continue;
    seen.set(id, { ...r, link });
    fresh++;
  }
  console.log(`[search] ${rows.length} rows, ${fresh} new (total ${seen.size})`);
  if (!fresh) break;

  // Advance by however many results this page actually returned, so the walk
  // works whatever the forum's per-page setting is.
  start += rows.length;
  await sleep(DELAY);
}

// Optionally open each topic to capture a fuller overview (the first post).
if (WANT_OVERVIEW) {
  for (const [id, item] of seen) {
    try {
      await page.goto(item.link, { waitUntil: "domcontentloaded" });
      item.overview = await page.evaluate(() => {
        const first = document.querySelector(".postbody .content, .post .content");
        return (first?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1200);
      });
      console.log(`[overview] ${id} ${item.overview ? "ok" : "empty"}`);
    } catch (e) {
      console.warn(`[overview] ${id} failed: ${e.message}`);
    }
    await sleep(DELAY);
  }
}

const results = [...seen.values()].map((item) => {
  const overview = item.overview || item.snippet || "";
  const [valid, reasoning] = classify({ ...item, overview });
  return {
    topic: item.topic,
    link: item.link,
    forum: item.forum || null,
    author: item.author || null,
    date: item.date || null,
    overview,
    valid,
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

await browser.close();
