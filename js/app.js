/* Homicide Map — mobile-first map with in-page bottom-sheet overview */

const map = L.map("map", { zoomControl: false }).setView([60.1755, 24.9342], 13);

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

function openSheet(c, marker) {
  if (activeMarker) activeMarker.getElement().classList.remove("active");
  activeMarker = marker;
  marker.getElement().classList.add("active");

  document.getElementById("sheet-kicker").textContent =
    "Case #" + String(c.id).padStart(3, "0");
  document.getElementById("sheet-title").textContent = c.title;

  document.getElementById("sheet-facts").innerHTML = [
    ["Date", c.date],
    ["Status", c.status],
    ["Location", c.location],
    ["Coordinates", c.coords[0].toFixed(4) + ", " + c.coords[1].toFixed(4)]
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("");

  document.getElementById("sheet-body").innerHTML =
    `<p>${c.summary}</p>` + c.details.map((p) => `<p>${p}</p>`).join("");

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
