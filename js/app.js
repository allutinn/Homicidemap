/* Homicide Map — mobile-first map with in-page bottom-sheet overview */

const map = L.map("map", { zoomControl: false }).setView([64.2273, 27.7285], 12);

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);

const sheet = document.getElementById("sheet");
const backdrop = document.getElementById("sheet-backdrop");
const grab = document.getElementById("sheet-grab");
const closeBtn = document.getElementById("sheet-close");
const content = document.getElementById("sheet-content");

/* --- Language ---------------------------------------------------------------

   Every case carries its overview in both Finnish and English. Finnish is the
   default: these are Finnish cases, described in Finnish sources.

   Fields outside the overview — outcomes, location details, the descriptions
   of victims and suspects — are still in the language they were extracted in,
   and are shown unchanged in both modes. */

const LANGS = ["fi", "en"];
const DEFAULT_LANG = "fi";
const STORED_LANG = "homicidemap.lang";

const UI = {
  fi: {
    cases: "TAPAUSTA",
    caseNo: "Tapaus #",
    date: "Tapahtui",
    status: "Tilanne",
    outcome: "Lopputulos",
    marker: "Karttamerkki",
    coords: "Koordinaatit",
    notStated: "Ei kerrottu",
    victims: "Uhrit",
    suspects: "Epäillyt",
    locations: "Ilmoitetut paikat",
    sources: "Lähteet",
    notNamed: "Ei nimetty",
    source: "lähde",
    sourceMessage: "lähdeviesti",
    link: "linkki",
    thread: "Koko keskusteluketju →",
    share: "Jaa",
    shareLabel: "Jaa tämä tapaus",
    close: "Sulje",
    copied: "Linkki kopioitu",
    copyPrompt: "Kopioi tämä linkki:",
    langLabel: "Vaihda kieli englanniksi",
    status_solved: "Selvitetty",
    status_unsolved: "Selvittämättä",
    status_in_investigation: "Tutkinnassa",
    status_unclear: "Epäselvä",
    support_court_or_news: "raportoitu",
    support_forum_claim: "foorumiväite",
    cred_official: "poliisi",
    cred_news: "uutislähde",
    cred_forum_claim: "foorumiväite",
    cred_rumour: "huhu",
    cred_editor: "ylläpitäjä",
    cred_fallback: "paikkaa ei kerrottu",
    markerTag: "karttamerkki",
    noPreciseLocation: "Kajaani (ketjussa ei tarkempaa paikkaa)",
    downgraded: "sijoitettu kaupunginosaan, tarkkaa pistettä ei saatu",
    precision_address: "osoite",
    precision_street: "katu",
    precision_district: "kaupunginosa",
    precision_area: "alue",
    precision_town: "kaupunki"
  },
  en: {
    cases: "CASES",
    caseNo: "Case #",
    date: "Date",
    status: "Status",
    outcome: "Outcome",
    marker: "Marker",
    coords: "Coordinates",
    notStated: "Not stated",
    victims: "Victims",
    suspects: "Suspects",
    locations: "Locations reported",
    sources: "Sources",
    notNamed: "Not named",
    source: "source",
    sourceMessage: "source message",
    link: "link",
    thread: "Full forum thread →",
    share: "Share",
    shareLabel: "Share this case",
    close: "Close",
    copied: "Link copied",
    copyPrompt: "Copy this link:",
    langLabel: "Switch language to Finnish",
    status_solved: "Solved",
    status_unsolved: "Unsolved",
    status_in_investigation: "Under investigation",
    status_unclear: "Unclear",
    support_court_or_news: "reported",
    support_forum_claim: "forum claim",
    cred_official: "police",
    cred_news: "news",
    cred_forum_claim: "forum claim",
    cred_rumour: "rumour",
    cred_editor: "maintainer",
    cred_fallback: "no location given",
    markerTag: "map marker",
    noPreciseLocation: "Kajaani (no more precise location in the thread)",
    downgraded: "placed on the district, exact point not resolvable",
    precision_address: "address",
    precision_street: "street",
    precision_district: "district",
    precision_area: "area",
    precision_town: "town"
  }
};

/** Fall back to the key itself, so an unmapped value still reads as something. */
const t = (key, fallback) => UI[lang][key] ?? fallback ?? key;

/* The URL wins over the stored preference: following a link someone shared in
   English should show English, whatever this visitor last chose. */
const initialLang = () => {
  const asked = new URLSearchParams(location.search).get("lang");
  if (LANGS.includes(asked)) return asked;
  try {
    const saved = localStorage.getItem(STORED_LANG);
    if (LANGS.includes(saved)) return saved;
  } catch {
    /* storage can be blocked; the default is fine */
  }
  return DEFAULT_LANG;
};

let lang = initialLang();
document.documentElement.lang = lang;

const langBtn = document.getElementById("lang-toggle");

function renderChrome() {
  document.getElementById("case-count").textContent = CASES.length + " " + t("cases");
  langBtn.textContent = lang === "fi" ? "EN" : "FI";
  langBtn.setAttribute("aria-label", t("langLabel"));
  shareBtn.textContent = t("share");
  shareBtn.setAttribute("aria-label", t("shareLabel"));
  closeBtn.setAttribute("aria-label", t("close"));
}

function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(STORED_LANG, lang);
  } catch {
    /* preference just won't persist */
  }
  renderChrome();
  // Keep the address bar honest, so the link in it shares what is on screen.
  history.replaceState(history.state, "", activeCase ? caseUrl(activeCase) : baseUrl());
  if (activeCase) fillSheet(activeCase);
}

const markerIcon = L.divIcon({
  className: "case-marker",
  html: "<span></span>",
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});

let activeMarker = null;

/* Markers by the case's forum topic id. That id is stable across rebuilds;
   the positional `id` is not, so a shared link must not be built from it. */
const markers = new Map();

CASES.forEach((c) => {
  const marker = L.marker(c.coords, { icon: markerIcon }).addTo(map);
  marker.on("click", () => openSheet(c, marker));
  markers.set(String(c.topic_id), { case: c, marker });
});

/* --- Deep links -------------------------------------------------------------

   A case is addressable as ?case=<topic_id>. Opening a case writes that into
   the address bar, so copying the URL while the sheet is open shares that
   case, and following such a link opens straight onto it.

   A query string is used rather than a path segment because the site is served
   as static files: the server never sees the parameter, so no rewrite rule is
   needed and no link can 404. */

/* The language rides along only when it is not the default, so the ordinary
   Finnish link stays short and a link shared from the English view stays
   English for whoever opens it. */
const withLang = (params) => {
  if (lang !== DEFAULT_LANG) params.set("lang", lang);
  const query = params.toString();
  return query ? `?${query}` : "";
};

const caseUrl = (c) => {
  const url = new URL(location.href);
  url.search = withLang(new URLSearchParams({ case: String(c.topic_id) }));
  url.hash = "";
  return url.toString();
};

const baseUrl = () => {
  const url = new URL(location.href);
  url.search = withLang(new URLSearchParams());
  url.hash = "";
  return url.toString();
};

/** Case named by the current URL, if any. Also accepts #case=… for links that
    have been through a client which mangles query strings. */
const caseFromUrl = () => {
  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const id = search.get("case") ?? hash.get("case");
  return id ? markers.get(String(id)) : null;
};

/* Open whatever the URL asks for, without touching history — used on first
   load and when the user navigates back or forward. */
function syncFromUrl({ initial = false } = {}) {
  const target = caseFromUrl();
  if (target) {
    openSheet(target.case, target.marker, { pushUrl: false });
    // A shared link should land on the case, not on the whole-municipality view.
    map.setView(target.case.coords, Math.max(map.getZoom(), 14), { animate: !initial });
    return true;
  }
  if (!initial) closeSheet({ pushUrl: false });
  return false;
}

/* Frame every case, rather than a fixed view of the town centre. Kajaani is a
   large municipality: Otanmäki and Vuolijoki sit ~15 km southwest of the
   centre, so a centre-anchored view silently hides those markers entirely.

   Skipped when the URL already names a case: fitBounds zooms with a CSS
   animation, which would land after the deep link's setView and quietly undo
   it, dropping the visitor on the whole-municipality view instead of the case
   they followed a link to. */
if (CASES.length && !caseFromUrl()) {
  map.fitBounds(L.latLngBounds(CASES.map((c) => c.coords)), {
    padding: [48, 48],
    maxZoom: 14 // don't zoom into the street when cases happen to cluster
  });
}

/* Text from the forum is untrusted: escape everything before it reaches HTML. */
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );

/* How well a claim is supported. Shown next to every name and place, because
   a poster's assertion and a court's finding must not look the same. */
const badge = (kind, label) =>
  `<span class="tag tag-${esc(kind)}">${esc(label)}</span>`;

/** How well a claim is supported, and how exact a place is, in the UI language. */
const support = (s) => t("support_" + s, s);
const cred = (c) => t("cred_" + c, c);
const precision = (p) => t("precision_" + p, p);

const person = (p) =>
  `<li>${p.name ? `<strong>${esc(p.name)}</strong>` : `<em>${esc(t("notNamed"))}</em>`}` +
  (p.status ? ` ${badge("status", p.status.replace(/_/g, " "))}` : "") +
  ` ${badge(p.support === "court_or_news" ? "ok" : "weak", support(p.support))}` +
  (p.description ? `<span class="muted">${esc(p.description)}</span>` : "") +
  (p.source_permalinks?.length
    ? ` <a href="${esc(p.source_permalinks[0])}" target="_blank" rel="noopener">${esc(t("source"))}</a>`
    : "") +
  `</li>`;

const place = (l) =>
  `<li${l.used_for_marker ? ' class="is-marker"' : ""}><strong>${esc(l.label)}</strong> ` +
  (l.used_for_marker ? badge("marker", t("markerTag")) : "") +
  badge(["official", "news", "editor"].includes(l.credibility) ? "ok" : "weak", cred(l.credibility)) +
  badge("status", precision(l.precision)) +
  (l.detail ? `<span class="muted">${esc(l.detail)}</span>` : "") +
  (l.quote ? `<blockquote>${esc(l.quote)}</blockquote>` : "") +
  (l.source_permalink
    ? ` <a href="${esc(l.source_permalink)}" target="_blank" rel="noopener">${esc(t("sourceMessage"))}</a>`
    : "") +
  `</li>`;

const section = (heading, items, render) =>
  items?.length
    ? `<h3>${esc(heading)}</h3><ul class="sheet-list">${items.map(render).join("")}</ul>`
    : "";

let activeCase = null;

/** What the marker sits on, and how faithful that is to what a source said. */
const markerFact = (c) => {
  if (c.coords_note === "fallback")
    return `${esc(t("noPreciseLocation"))} ${badge("weak", cred("fallback"))}`;
  return (
    `${esc(c.coords_label)} ` +
    badge(["official", "news", "editor"].includes(c.coords_credibility) ? "ok" : "weak",
          cred(c.coords_credibility)) +
    badge("status", precision(c.coords_precision)) +
    (c.coords_note === "downgraded" ? `<span class="muted">${esc(t("downgraded"))}</span>` : "")
  );
};

/* Rendered separately from opening, so switching language redraws the sheet
   in place without touching the map, the marker or the history entry. */
function fillSheet(c) {
  const overview = c.summary[lang] ?? c.summary[DEFAULT_LANG];

  document.getElementById("sheet-kicker").textContent =
    t("caseNo") + String(c.id).padStart(3, "0");
  document.getElementById("sheet-title").textContent = c.title;

  document.getElementById("sheet-facts").innerHTML = [
    [t("date"), esc(c.date ?? t("notStated"))],
    [t("status"), esc(t("status_" + c.status, c.status))],
    [t("outcome"), esc(c.outcome ?? "—")],
    [t("marker"), markerFact(c)],
    [t("coords"), esc(c.coords[0].toFixed(4) + ", " + c.coords[1].toFixed(4))]
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
    .join("");

  document.getElementById("sheet-body").innerHTML =
    // The lead says what happened; the detail gives the full account below it.
    `<p class="sheet-lead">${esc(overview.lead)}</p>` +
    overview.detail
      .split(/\n\n+/)
      .map((p) => `<p>${esc(p)}</p>`)
      .join("") +
    section(t("victims"), c.victims, person) +
    section(t("suspects"), c.suspects, person) +
    section(t("locations"), c.locations, place) +
    section(
      t("sources"),
      c.sources,
      (s) =>
        `<li><strong>${esc(s.outlet)}</strong>` +
        (s.what ? `<span class="muted">${esc(s.what)}</span>` : "") +
        (s.url
          ? ` <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(t("link"))}</a>`
          : "") +
        `</li>`
    ) +
    `<p class="sheet-thread"><a href="${esc(c.thread)}" target="_blank" rel="noopener">${esc(t("thread"))}</a></p>`;
}

function openSheet(c, marker, { pushUrl = true } = {}) {
  if (activeMarker) activeMarker.getElement().classList.remove("active");
  activeMarker = marker;
  activeCase = c;
  marker.getElement().classList.add("active");

  // Put the case in the address bar so copying the URL shares this case.
  if (pushUrl) history.pushState({ case: c.topic_id }, "", caseUrl(c));

  fillSheet(c);

  content.scrollTop = 0;
  sheet.classList.remove("expanded");
  sheet.classList.add("open");
  backdrop.classList.add("visible");

  // keep the tapped marker visible above the sheet
  map.panTo(c.coords, { animate: true });
}

function closeSheet({ pushUrl = true } = {}) {
  sheet.classList.remove("open", "expanded");
  backdrop.classList.remove("visible");
  if (activeMarker) {
    activeMarker.getElement().classList.remove("active");
    activeMarker = null;
  }
  activeCase = null;
  // Drop the case from the URL, so a link copied after closing is the map.
  if (pushUrl && caseFromUrl()) history.pushState({}, "", baseUrl());
}

closeBtn.addEventListener("click", () => closeSheet());
backdrop.addEventListener("click", () => closeSheet());

/* --- Share ---------------------------------------------------------------- */

const shareBtn = document.getElementById("sheet-share");
const toast = document.getElementById("sheet-toast");

let toastTimer = null;
function flash(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 1800);
}

shareBtn.addEventListener("click", async () => {
  if (!activeCase) return;
  const url = caseUrl(activeCase);

  // Native share sheet where there is one (phones); clipboard everywhere else.
  if (navigator.share) {
    try {
      await navigator.share({ title: activeCase.title, url });
      return;
    } catch (e) {
      if (e && e.name === "AbortError") return; // user dismissed the share sheet
      // otherwise fall through to copying
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    flash(t("copied"));
  } catch {
    // Clipboard access can be refused (insecure context, permissions policy).
    // Selecting the text lets the user copy it by hand rather than failing mute.
    prompt(t("copyPrompt"), url);
  }
});

langBtn.addEventListener("click", () => setLang(lang === "fi" ? "en" : "fi"));

/* --- Drag the sheet between open / expanded / closed --- */
let dragStartY = null;
let dragStartTransform = 0;

function sheetOffset() {
  // current translateY in px
  return new DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42;
}

function onDragStart(e) {
  dragStartY = (e.touches ? e.touches[0] : e).clientY;
  dragStartTransform = sheetOffset();
  sheet.classList.add("dragging");
}

function onDragMove(e) {
  if (dragStartY === null) return;
  const y = (e.touches ? e.touches[0] : e).clientY;
  const next = Math.max(0, dragStartTransform + (y - dragStartY));
  sheet.style.transform = `translateY(${next}px)`;
}

function onDragEnd(e) {
  if (dragStartY === null) return;
  const y = (e.changedTouches ? e.changedTouches[0] : e).clientY;
  const delta = y - dragStartY;
  dragStartY = null;
  sheet.classList.remove("dragging");
  sheet.style.transform = "";

  if (delta < -40) {
    sheet.classList.add("expanded"); // dragged up -> full height
  } else if (delta > 80) {
    if (sheet.classList.contains("expanded")) sheet.classList.remove("expanded");
    else closeSheet(); // dragged down from half -> close
  }
}

grab.addEventListener("touchstart", onDragStart, { passive: true });
grab.addEventListener("touchmove", onDragMove, { passive: true });
grab.addEventListener("touchend", onDragEnd);
grab.addEventListener("mousedown", (e) => {
  onDragStart(e);
  const move = (ev) => onDragMove(ev);
  const up = (ev) => {
    onDragEnd(ev);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

/* Tapping the sheet content while half-open expands it for reading */
content.addEventListener("click", () => {
  if (sheet.classList.contains("open") && !sheet.classList.contains("expanded")) {
    sheet.classList.add("expanded");
  }
});

/* Run last: both of these touch state declared with `let` and `const` further
   up this file. Calling either any earlier hits the temporal dead zone. */
renderChrome();
syncFromUrl({ initial: true });
window.addEventListener("popstate", () => {
  // Back/forward can cross a language change as well as a case change.
  setLang(initialLang());
  syncFromUrl();
});
