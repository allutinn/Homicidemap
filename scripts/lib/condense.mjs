/**
 * Reduce a crawled thread to what a case review actually needs to read.
 *
 * The corpus does not need this uniformly: 87% of threads are under 150 posts
 * and can be read whole. But 32 threads hold 43% of all posts — Kirkkonummi
 * alone is 9 507 posts, ~2.3M tokens — and no review reads those in full.
 *
 * Three reductions, in increasing order of how much they can cost you:
 *
 *   1. De-duplicating quotes. `text` is the post's textContent, so it
 *      *contains* the quoted material inline, and `quotes` then holds the same
 *      text again. Measured across the crawl, 35-38% of all text is quotation.
 *
 *      Note what this does NOT mean: quoted text is not noise. Back-testing
 *      against the 26 curated Kajaani cases showed that discarding it loses
 *      37% of the location evidence — posters establish where a killing
 *      happened by pasting the police bulletin or news article, and the street
 *      name is inside the blockquote. So quotes are rendered once, marked as
 *      quoted, and kept out of the poster's own words. The saving is the
 *      duplicate copy, not the content.
 *
 *   2. Reaction filtering. Sub-120-character posts with nothing but agreement.
 *      ~10% of posts, a much smaller share of the text.
 *
 *   3. Relevance selection. Only for threads too big to read. This is the one
 *      that can lose something, so it is scored to favour exactly what the map
 *      needs — addresses, dates, court and police reporting — and every
 *      selected post keeps its permalink so the original can be pulled back.
 */

/** Finnish street-name endings, so "Vuorimiehentie 4" outranks a chat post. */
const ADDRESS =
  /\b[A-ZÄÖÅ][a-zäöå]+(?:katu|kadun|tie|tien|kuja|polku|väylä|raitti|kaari|rinne|mäki|mäen|ranta|rannan|aukio|tori|puisto|kylä)\b/;
const HOUSE_NUMBER = /\b[A-ZÄÖÅ][a-zäöå]+\w*\s+\d{1,4}\s*[A-Za-z]?\b/;
const COURT =
  /tuomi|käräjäoikeu|hovioikeu|korkein oikeus|\bKKO\b|syyte|syyttäj|pidätet|vangit|epäilty|esitutkin|rikosnimik|elinkautin|todistaj|kuulustel|\bDNA\b|oikeudenkäyn|poliisi tiedott/i;
const NEWS =
  /yle\.fi|hs\.fi|is\.fi|iltalehti|iltasanomat|mtv|poliisi\.fi|kaleva|aamulehti|ksml|savonsanomat|turunsanomat|oikeus\.fi|finlex|krp\./i;
const DATE = /\b\d{1,2}\.\d{1,2}\.(?:19|20)\d{2}\b/;
const VICTIM = /uhri|vainaj|ruumi|löyty|surmat|murhat|kuoli|menehty|katosi/i;

/**
 * A post's own words: `text` with each quote's substring removed.
 *
 * Uses indexOf rather than a regex so quoted text containing regex
 * metacharacters is handled, and removes each quote once — a post that
 * genuinely repeats a quoted phrase in its own reply keeps the second copy.
 */
export const ownWords = (m) => {
  let s = m.text || "";
  for (const q of m.quotes || []) {
    if (!q) continue;
    const i = s.indexOf(q);
    if (i !== -1) s = s.slice(0, i) + s.slice(i + q.length);
  }
  return s.replace(/\s+/g, " ").trim();
};

/** Everything readable on a post: its own words plus what it quotes. */
export const readable = (m) => [ownWords(m), ...(m.quotes || [])].filter(Boolean).join(" ");

/**
 * What rendering this post will actually cost, in characters.
 *
 * Must mirror the renderer exactly. The cap applies to each quote and to the
 * poster's own words *separately*, so a post with three quotes emits up to four
 * capped blocks — charging it one cap's worth would let a budget of 500k render
 * 830k, which is what an earlier version did.
 */
export const renderCost = (m, cap) => {
  const HEADER = 90; // "--- #N author date permalink"
  const own = ownWords(m);
  const quotes = (m.quotes || []).filter(Boolean);
  const links = (m.links || []).filter((l) => l.href && !/murha\.info/.test(l.href));
  return (
    HEADER +
    Math.min(own.length, cap) +
    quotes.reduce((a, q) => a + Math.min(q.length, cap) + 11, 0) + // "> [quoted] "
    links.reduce((a, l) => a + l.href.length + 8, 0) // "[link] "
  );
};

/**
 * How much a post is worth reading, for a reviewer whose questions are "is this
 * one homicide case?" and "where did it happen?".
 *
 * Scored on own words *and* quotes: a post whose only contribution is pasting
 * the police bulletin is often the post that names the street.
 */
export const score = (m, words) => {
  const w = words ?? readable(m);
  let s = 0;

  if (m.index === 1) s += 100; // the opening post states the case
  if (ADDRESS.test(w)) s += 30; // the map lives or dies on these
  if (HOUSE_NUMBER.test(w)) s += 10;
  if ((m.links || []).some((l) => NEWS.test(l.href))) s += 25;
  if (COURT.test(w)) s += 12;
  if (DATE.test(w)) s += 8;
  if (VICTIM.test(w)) s += 6;
  s += Math.min(8, w.length / 400); // substance, capped so essays cannot dominate

  // Reactions are judged on the poster's own contribution, not on how much
  // they quoted — otherwise "^Juuri näin" under a long quote scores as content.
  const own = ownWords(m);
  if (own.length < 120 && !(m.quotes || []).length) s -= 10;
  if ((m.quotes || []).length && own.length < 120) s -= 4;
  return s;
};

/**
 * Which posts to keep.
 *
 * Selection is half by score and half stratified across the thread's timeline.
 * Score alone clusters: these cases run for years — crime, investigation,
 * arrest, trial, appeal — and the highest-scoring posts bunch around whichever
 * period generated the most news links, leaving whole phases unrepresented.
 * The stratified half guarantees every window contributes something.
 */
export const select = (messages, charBudget, cap) => {
  const scored = messages.map((m) => {
    const words = readable(m);
    return { m, words, s: score(m, words), cost: renderCost(m, cap) };
  });

  const total = scored.reduce((a, x) => a + x.cost, 0);
  if (total <= charBudget) return { picked: scored, byScore: scored.length, byWindow: 0 };

  const keep = new Set([1]); // the opening post is never optional
  let spent = scored.find((x) => x.m.index === 1)?.cost ?? 0;

  const take = (x) => {
    if (keep.has(x.m.index) || spent + x.cost > charBudget) return false;
    keep.add(x.m.index);
    spent += x.cost;
    return true;
  };

  // Half the budget on merit, thread-wide.
  let byScore = 0;
  for (const x of [...scored].sort((a, b) => b.s - a.s)) {
    if (spent >= charBudget / 2) break;
    if (take(x)) byScore++;
  }

  // The rest spread evenly over the timeline, best-in-window first. Score alone
  // clusters: these cases run for years — crime, investigation, arrest, trial,
  // appeal — and the top-scoring posts bunch around whichever period generated
  // the most news links, leaving whole phases unrepresented.
  const windows = 20;
  const size = Math.ceil(scored.length / windows);
  const perWindowBudget = (charBudget - spent) / windows;
  let byWindow = 0;
  for (let w = 0; w < windows; w++) {
    let windowSpent = 0;
    const slice = scored
      .slice(w * size, (w + 1) * size)
      .filter((x) => !keep.has(x.m.index))
      .sort((a, b) => b.s - a.s);
    for (const x of slice) {
      if (windowSpent >= perWindowBudget) break;
      if (take(x)) {
        windowSpent += x.cost;
        byWindow++;
      }
    }
  }

  return { picked: scored.filter((x) => keep.has(x.m.index)), byScore, byWindow };
};

/**
 * Tier by size. Thread length is known from the forum index before a single
 * post is fetched, so the treatment can be decided up front.
 */
export const tierFor = (postCount) =>
  postCount <= 150 ? "whole" : postCount <= 1500 ? "trimmed" : "selected";

/**
 * How many characters a reviewer should be handed for one thread.
 *
 * ~500k characters is roughly 125k tokens — a thread one agent can hold and
 * still reason across. Tiering on post count alone missed this: a 1 257-post
 * thread that only had its reactions dropped still came to 268k tokens.
 */
export const CHAR_BUDGET = 500_000;

/**
 * Render a thread as the text a reviewer reads.
 *
 * `maxPostChars` truncates individual posts — the long ones are almost always
 * a pasted news article, where the first part carries the facts. Truncation is
 * marked, and the permalink is right there, so nothing is silently shortened.
 */
export const condense = (thread, { charBudget = CHAR_BUDGET, maxPostChars = null } = {}) => {
  const all = thread.messages;
  const totalWords = all.reduce((a, m) => a + readable(m).length, 0);
  // Tier on what a reviewer must actually read, not on post count. A thread of
  // 1 257 short posts and one of 300 essays cost very different amounts. The
  // uncapped render cost is the honest measure of "would this fit".
  const wholeCost = all.reduce((a, m) => a + renderCost(m, Infinity), 0);
  const tier = wholeCost <= charBudget ? "whole" : tierFor(thread.message_count);
  // A thread short enough to read whole is never truncated: there is nothing to
  // buy with the characters, and a 11 598-char post carrying the only mention
  // of a village is exactly what a cap would have cost us.
  const cap = maxPostChars ?? { whole: Infinity, trimmed: 4000, selected: 1500 }[tier];

  // A post is droppable only if it adds nothing of its own AND quotes nothing.
  let pool = all;
  if (tier !== "whole")
    pool = all.filter((m) => m.index === 1 || ownWords(m).length >= 120 || (m.quotes || []).length);

  const { picked } =
    tier === "whole"
      ? { picked: pool.map((m) => ({ m, words: readable(m), s: 0 })) }
      : select(pool, charBudget, cap);
  picked.sort((a, b) => a.m.index - b.m.index);

  const keptWords = picked.reduce((a, x) => a + renderCost(x.m, cap), 0);

  const lines = [
    `# ${thread.topic}`,
    thread.link,
    `${thread.forum} — ${thread.message_count} posts total, ${picked.length} shown ` +
      `(${((keptWords / (totalWords || 1)) * 100).toFixed(1)}% of the thread's own words, tier: ${tier})`,
    "",
  ];
  if (tier === "selected")
    lines.push(
      `> NOTE: this thread was too large to read in full. Posts were selected by ` +
        `relevance and spread across the thread's timeline. Post numbers below are ` +
        `original indices, so gaps are expected. Any post can be retrieved in full ` +
        `with: murha-batch-read.mjs --batch ${thread.batch} --topic ${thread.topic_id}`,
      ""
    );

  /**
   * Truncate, but rescue what the map needs.
   *
   * Long posts are nearly always a pasted article, and the facts lead. But
   * back-testing found the street name sitting past the cut in 12 of 115
   * known locations — a news story names the district up front and the exact
   * address three paragraphs down. So sentences beyond the cut that carry an
   * address, house number or date are carried over rather than dropped.
   */
  const cut = (s, n) => {
    if (s.length <= n) return s;
    const rescued = s
      .slice(n)
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => ADDRESS.test(sentence) || HOUSE_NUMBER.test(sentence) || DATE.test(sentence))
      .slice(0, 8)
      .join(" ");
    return s.slice(0, n) + " […truncated]" + (rescued ? ` […address/date lines kept: ${rescued}]` : "");
  };

  for (const { m } of picked) {
    const own = ownWords(m);
    const quotes = (m.quotes || []).filter(Boolean);
    if (!own && !quotes.length) continue;

    lines.push(`--- #${m.index} ${m.author} ${(m.date || m.date_text || "").slice(0, 10)} ${m.permalink ?? ""}`);
    // Quoted material first and explicitly marked: it is usually the source
    // being discussed, and it must not read as the poster's own assertion.
    for (const q of quotes) lines.push(`> [quoted] ${cut(q, cap)}`);
    if (own) lines.push(cut(own, cap));
    // Every outbound link, not just recognised outlets. A location's cited
    // source is sometimes the URL itself, and the list of Finnish news domains
    // will never be complete — kainuunsanomat.fi was missing from it.
    const out = (m.links || []).filter((l) => l.href && !/murha\.info/.test(l.href));
    for (const l of out) lines.push(`[link] ${l.href}`);
    lines.push("");
  }

  return {
    tier,
    text: lines.join("\n"),
    shown: picked.length,
    total: thread.message_count,
    chars: keptWords,
    total_chars: totalWords,
  };
};
