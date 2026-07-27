/**
 * Shared Playwright launch/context setup for the murha.info scripts.
 *
 * Chromium does not read HTTPS_PROXY from the environment, so when the session
 * routes egress through a proxy it has to be passed explicitly at launch —
 * otherwise every navigation fails with ERR_CONNECTION_RESET.
 */
import { chromium } from "playwright";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

/** Launch Chromium and open a context/page ready for the forum. */
export const openBrowser = async ({ headed = false } = {}) => {
  const proxyServer =
    process.env.HTTPS_PROXY || process.env.https_proxy || undefined;

  const browser = await chromium.launch({
    headless: !headed,
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
  });
  const context = await browser.newContext({ userAgent: UA, locale: "fi-FI" });
  const page = await context.newPage();
  return { browser, context, page };
};
