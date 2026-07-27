/**
 * Fetch every message of each selected topic from the murha.info Rikosfoorumi.
 *
 *   node scripts/murha-threads.mjs [options]
 *
 * Reads the topic list produced by scripts/murha-search.mjs, keeps the topics
 * that passed prefiltering, then walks each thread's pagination and captures
 * every post: author, date, text, links and images.
 *
 * Options:
 *   --in data/kajaani-topics.json     topic list from murha-search.mjs
 *   --out data/kajaani-cases.json     output path
 *   --limit 30                        max topics to fetch (default 30)
 *   --all                             include topics prefiltered as invalid
 *   --base https://murha.info/rikosfoorumi
 *   --max-pages 40                    post pages per thread
 *   --delay 1500                      ms between requests
 *   --headed                          show the browser
 *
 * Output: JSON array of
 *   { topic, link, forum, valid, reasoning, message_count, messages: [
 *       { index, author, date, text, links: [{text, href}], images: [src] } ] }
 *
 * Every field is read from the page — nothing is inferred or invented.
 */
import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const IN = arg("in", "data/kajaani-topics.json");
const OUT = arg("out", "data/kajaani-cases.json");
const LIMIT = Number(arg("limit", "30"));
const BASE = arg("base", "https://murha.info/rikosfoorumi").replace(/\/$/, "");
const MAX_PAGES = Number(arg("max-pages", "40"));
const DELAY = Number(arg("delay", "1500"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const topics = JSON.parse(await readFile(IN, "utf8"));
const selected = (flag("all") ? topics : topics.filter((t) => t.valid)).slice(0, LIMIT);

console.log(
  `${topics.length} topics in ${IN}; ` +
    `${selected.length} selected${flag("all") ? " (--all)" : " (valid only)"}, limit ${LIMIT}.`
);
if (!selected.length) {
  console.warn("Nothing to fetch — run scripts/murha-search.mjs first.");
  process.exit(1);
}

/** Extract every post on the current viewtopic page. */
const extractPosts = (page, base) =>
  page.evaluate((base) => {
    const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
    const abs = (href) => {
      try {
        return new URL(href.replace(/^\.\//, ""), base + "/").href;
      } catch {
        return href;
      }
    };
    return [...document.querySelectorAll(".post")].map((post) => {
      const content = post.querySelector(".content");
      return {
        author: clean(
          post.querySelector(".postprofile a, a[href*='memberlist.php']")?.textContent
        ),
        date: clean(post.querySelector(".author, .postbody .author")?.textContent),
        text: clean(content?.textContent),
        links: [...(content?.querySelectorAll("a[href]") ?? [])]
          .map((a) => ({ text: clean(a.textContent), href: abs(a.getAttribute("href")) }))
          .filter((l) => l.href && !l.href.includes("memberlist.php")),
        images: [...(content?.querySelectorAll("img[src]") ?? [])].map((i) =>
          abs(i.getAttribute("src"))
        ),
      };
    });
  }, base);

const browser = await chromium.launch({ headless: !flag("headed") });
const context = await browser.newContext({
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  locale: "fi-FI",
});
const page = await context.newPage();

const cases = [];

for (const [n, topic] of selected.entries()) {
  const messages = [];
  const seen = new Set();
  let start = 0;

  for (let p = 0; p < MAX_PAGES; p++) {
    const url = `${topic.link}${topic.link.includes("?") ? "&" : "?"}start=${start}`;
    let res;
    try {
      res = await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch (e) {
      console.warn(`  [${topic.link}] navigation failed: ${e.message.split("\n")[0]}`);
      break;
    }
    if (!res || !res.ok()) {
      console.warn(`  HTTP ${res?.status()} on ${url} — stopping this thread.`);
      break;
    }

    const posts = await extractPosts(page, BASE);
    // Stop when a page repeats content (phpBB clamps out-of-range start values).
    const fresh = posts.filter((p) => {
      const key = `${p.author}|${p.date}|${p.text.slice(0, 120)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) break;

    messages.push(...fresh);
    start += posts.length;
    await sleep(DELAY);
  }

  cases.push({
    topic: topic.topic,
    link: topic.link,
    forum: topic.forum ?? null,
    valid: topic.valid,
    reasoning: topic.reasoning,
    needs_review: topic.needs_review ?? true,
    message_count: messages.length,
    messages: messages.map((m, i) => ({ index: i + 1, ...m })),
  });

  console.log(`[${n + 1}/${selected.length}] ${topic.topic} — ${messages.length} messages`);
  await sleep(DELAY);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(cases, null, 2) + "\n");

const totalMsgs = cases.reduce((a, c) => a + c.message_count, 0);
const totalImgs = cases.reduce(
  (a, c) => a + c.messages.reduce((b, m) => b + m.images.length, 0),
  0
);
const totalLinks = cases.reduce(
  (a, c) => a + c.messages.reduce((b, m) => b + m.links.length, 0),
  0
);
console.log(
  `\nWrote ${cases.length} cases / ${totalMsgs} messages ` +
    `(${totalLinks} links, ${totalImgs} images) to ${OUT}`
);

await browser.close();
