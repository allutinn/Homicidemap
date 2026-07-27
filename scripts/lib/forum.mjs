/**
 * Shared HTTP + parsing helpers for the murha.info Rikosfoorumi (phpBB 3.3).
 *
 * The forum is entirely server-rendered, so plain HTTP plus a DOM parser is
 * enough — no browser is needed. (It is also the only option in sandboxes that
 * route egress through an HTTPS proxy Chromium cannot use.)
 */
import { parseHTML } from "linkedom";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/120 Safari/537.36";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Collapse whitespace; tolerate null/undefined. */
export const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

/** Simple CLI helpers shared by the scripts. */
export const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")
    ? process.argv[i + 1]
    : fallback;
};
export const flag = (name) => process.argv.includes(`--${name}`);

/**
 * GET a page and return its parsed `document`.
 * Retries on network errors and 5xx with exponential backoff.
 */
export const fetchDoc = async (url, { retries = 4, timeout = 45000 } = {}) => {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, "accept-language": "fi-FI,fi;q=0.9" },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) return { ok: false, status: res.status, document: null };
      const { document } = parseHTML(await res.text());
      return { ok: true, status: res.status, document };
    } catch (e) {
      lastError = e;
    }
  }
  return { ok: false, status: 0, document: null, error: lastError };
};

/** Resolve a phpBB relative href ("./viewtopic.php?...") against the forum base. */
export const absolute = (href, base) => {
  if (!href) return null;
  try {
    return new URL(href.replace(/^\.\//, ""), `${base}/`).href;
  } catch {
    return href;
  }
};

/** Canonical topic URL, with phpBB's session id and search highlighting dropped. */
export const canonicalTopic = (href, base) => {
  const abs = absolute(href, base);
  if (!abs) return null;
  const url = new URL(abs);
  const t = url.searchParams.get("t");
  return t ? `${base}/viewtopic.php?t=${t}` : abs;
};

export const topicId = (link) => {
  try {
    return new URL(link).searchParams.get("t") ?? link;
  } catch {
    return link;
  }
};
