/**
 * Crawl one forum thread in full.
 *
 * Extracted from murha-threads.mjs so the keyword-driven crawler and the
 * batch-driven crawler capture posts identically — a thread fetched by one must
 * be byte-for-byte comparable with the same thread fetched by the other.
 */
import { fetchDoc, sleep, clean, absolute } from "./forum.mjs";

/** Total post count, read from phpBB's "N viestiä" pagination header. */
export const readTotal = (document) => {
  const text = clean(document.querySelector(".pagination")?.textContent);
  return Number(text.match(/(\d+)\s*viesti/i)?.[1] ?? 0);
};

/** Extract every post on the current viewtopic page. */
export const extractPosts = (document, base) =>
  [...document.querySelectorAll("div.post")].map((post) => {
    const content = post.querySelector(".content");

    // phpBB renders quoted text as blockquote; keep it, but also record the
    // post's own words separately so quotes are not mistaken for new content.
    const quotes = [...(content?.querySelectorAll("blockquote") ?? [])].map((q) =>
      clean(q.textContent)
    );

    return {
      post_id: post.getAttribute("id")?.replace(/^p/, "") ?? null,
      permalink: null, // filled by the caller, needs the base
      // `.username` must be tried on its own first: a comma-separated selector
      // resolves in document order, and for posters with an avatar the empty
      // `a.avatar` precedes the username link and would win.
      author: clean(
        post.querySelector(".postprofile .username")?.textContent ||
          post.querySelector("p.author .username")?.textContent ||
          post.querySelector(".postprofile a:not(.avatar)")?.textContent
      ),
      date: post.querySelector("p.author time")?.getAttribute("datetime") ?? null,
      date_text: clean(post.querySelector("p.author time")?.textContent),
      text: clean(content?.textContent),
      quotes,
      links: [...(content?.querySelectorAll("a[href]") ?? [])]
        .map((a) => ({ text: clean(a.textContent), href: absolute(a.getAttribute("href"), base) }))
        .filter((l) => l.href && !l.href.includes("memberlist.php")),
      images: [...(content?.querySelectorAll("img[src]") ?? [])]
        .map((i) => absolute(i.getAttribute("src"), base))
        .filter(Boolean),
    };
  });

/**
 * Walk a thread's pagination and return every post.
 *
 * Returns { messages, expected, truncated, failed } — `expected` is phpBB's own
 * post total so the caller can tell a short thread from a short crawl.
 */
export const crawlThread = async (link, { base, maxPages = 2000, delay = 1200 } = {}) => {
  const messages = [];
  const seen = new Set();
  let start = 0;
  let expected = null;
  let truncated = false;
  let failed = false;

  for (let p = 0; p < maxPages; p++) {
    const { ok, status, document } = await fetchDoc(`${link}&start=${start}`);
    if (!ok) {
      console.warn(`  HTTP ${status} on ${link}&start=${start} — stopping this thread.`);
      truncated = true;
      failed = true;
      break;
    }

    if (expected === null) expected = readTotal(document) || null;

    const posts = extractPosts(document, base);
    // phpBB clamps an out-of-range `start` and re-serves the last page, so the
    // walk ends when a page yields nothing new.
    const fresh = posts.filter((post) => {
      const key = post.post_id || `${post.author}|${post.date}|${post.text.slice(0, 120)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!fresh.length) break;

    messages.push(...fresh);
    start += posts.length;

    if (p === maxPages - 1) truncated = true;
    await sleep(delay);
  }

  return {
    messages: messages.map((m, i) => ({
      ...m,
      index: i + 1,
      permalink: m.post_id ? `${base}/viewtopic.php?p=${m.post_id}#p${m.post_id}` : null,
    })),
    expected,
    truncated,
    failed,
  };
};
