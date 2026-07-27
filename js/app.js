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

document.getElementById("case-count").textContent = CASES.length + " CASES";

const markerIcon = L.divIcon({
  className: "case-marker",
  html: "<span></span>",
  iconSize: [24, 24],
  iconAnchor: [12, 12]
});

let activeMarker = null;

CASES.forEach((c) => {
  const marker = L.marker(c.coords, { icon: markerIcon }).addTo(map);
  marker.on("click", () => openSheet(c, marker));
});

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

const SUPPORT_LABEL = { court_or_news: "reported", forum_claim: "forum claim" };
const CRED_LABEL = {
  official: "police",
  news: "news",
  forum_claim: "forum claim",
  rumour: "rumour",
  editor: "maintainer", // supplied outside the thread, not found in any source
  fallback: "no location given"
};

const person = (p) =>
  `<li>${p.name ? `<strong>${esc(p.name)}</strong>` : "<em>Not named</em>"}` +
  (p.status ? ` ${badge("status", p.status.replace(/_/g, " "))}` : "") +
  ` ${badge(p.support === "court_or_news" ? "ok" : "weak", SUPPORT_LABEL[p.support] ?? p.support)}` +
  (p.description ? `<span class="muted">${esc(p.description)}</span>` : "") +
  (p.source_permalinks?.length
    ? ` <a href="${esc(p.source_permalinks[0])}" target="_blank" rel="noopener">source</a>`
    : "") +
  `</li>`;

const place = (l) =>
  `<li><strong>${esc(l.label)}</strong> ` +
  badge(["official", "news", "editor"].includes(l.credibility) ? "ok" : "weak",
        CRED_LABEL[l.credibility] ?? l.credibility) +
  badge("status", l.precision) +
  (l.detail ? `<span class="muted">${esc(l.detail)}</span>` : "") +
  (l.quote ? `<blockquote>${esc(l.quote)}</blockquote>` : "") +
  (l.source_permalink
    ? ` <a href="${esc(l.source_permalink)}" target="_blank" rel="noopener">source message</a>`
    : "") +
  `</li>`;

const section = (heading, items, render) =>
  items?.length
    ? `<h3>${esc(heading)}</h3><ul class="sheet-list">${items.map(render).join("")}</ul>`
    : "";

function openSheet(c, marker) {
  if (activeMarker) activeMarker.getElement().classList.remove("active");
  activeMarker = marker;
  marker.getElement().classList.add("active");

  document.getElementById("sheet-kicker").textContent =
    "Case #" + String(c.id).padStart(3, "0");
  document.getElementById("sheet-title").textContent = c.title;

  document.getElementById("sheet-facts").innerHTML = [
    ["Date", c.date ?? "Not stated"],
    ["Status", c.status],
    ["Outcome", c.outcome ?? "—"],
    ["Marker", `${esc(c.coords_label)} (${CRED_LABEL[c.coords_credibility] ?? c.coords_credibility}, ${esc(c.coords_precision)})`],
    ["Coordinates", c.coords[0].toFixed(4) + ", " + c.coords[1].toFixed(4)]
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${k === "Marker" ? v : esc(v)}</dd>`)
    .join("");

  document.getElementById("sheet-body").innerHTML =
    `<p>${esc(c.summary)}</p>` +
    section("Victims", c.victims, person) +
    section("Suspects", c.suspects, person) +
    section("Locations reported", c.locations, place) +
    section(
      "Sources",
      c.sources,
      (s) =>
        `<li><strong>${esc(s.outlet)}</strong>` +
        (s.what ? `<span class="muted">${esc(s.what)}</span>` : "") +
        (s.url ? ` <a href="${esc(s.url)}" target="_blank" rel="noopener">link</a>` : "") +
        `</li>`
    ) +
    `<p class="sheet-thread"><a href="${esc(c.thread)}" target="_blank" rel="noopener">Full forum thread →</a></p>`;

  content.scrollTop = 0;
  sheet.classList.remove("expanded");
  sheet.classList.add("open");
  backdrop.classList.add("visible");

  // keep the tapped marker visible above the sheet
  map.panTo(c.coords, { animate: true });
}

function closeSheet() {
  sheet.classList.remove("open", "expanded");
  backdrop.classList.remove("visible");
  if (activeMarker) {
    activeMarker.getElement().classList.remove("active");
    activeMarker = null;
  }
}

closeBtn.addEventListener("click", closeSheet);
backdrop.addEventListener("click", closeSheet);

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
