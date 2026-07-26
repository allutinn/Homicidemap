// DEMO DATA — fictional sample cases for development and layout testing.
// These do not describe real events or real people.
// Replace with real records (e.g. loaded from a JSON API) before publishing.
const CASES = [
  {
    id: 1,
    title: "Sample case — Kallio",
    coords: [60.1841, 24.9494],
    date: "2024-03-14",
    status: "Solved",
    location: "Kallio, Helsinki",
    summary:
      "Placeholder description for a case record. This text demonstrates how a longer " +
      "case overview scrolls inside the bottom sheet on a small screen.",
    details: [
      "This is demonstration copy. Each paragraph here stands in for sections a real dataset might have: circumstances, investigation notes, court outcome, and sources.",
      "The sheet can be dragged up to read more, and the content area scrolls independently once expanded. Closing it returns to the map without opening any new window.",
      "Additional filler paragraph to guarantee overflow on small viewports, so the scrolling behaviour of the overview panel can be verified during development."
    ]
  },
  {
    id: 2,
    title: "Sample case — Töölönlahti",
    coords: [60.1756, 24.9389],
    date: "2023-11-02",
    status: "Open",
    location: "Töölönlahti, Helsinki",
    summary: "Second placeholder record showing a different marker and status value.",
    details: [
      "Demonstration copy only. A real record would include verified, sourced information.",
      "Multiple paragraphs are included so the panel has enough content to scroll on a phone-sized screen."
    ]
  },
  {
    id: 3,
    title: "Sample case — Kamppi",
    coords: [60.1687, 24.9316],
    date: "2022-07-19",
    status: "Solved",
    location: "Kamppi, Helsinki",
    summary: "Third placeholder record near the city centre.",
    details: [
      "Demonstration copy only.",
      "Tap another marker while this sheet is open and the content swaps in place — the sheet stays a single in-page panel."
    ]
  },
  {
    id: 4,
    title: "Sample case — Vallila",
    coords: [60.1949, 24.9631],
    date: "2021-01-30",
    status: "Cold",
    location: "Vallila, Helsinki",
    summary: "Fourth placeholder record demonstrating the 'Cold' status.",
    details: [
      "Demonstration copy only.",
      "Replace this array with data loaded from a file or API; the map and sheet render whatever is provided."
    ]
  },
  {
    id: 5,
    title: "Sample case — Lauttasaari",
    coords: [60.1587, 24.8778],
    date: "2020-09-08",
    status: "Solved",
    location: "Lauttasaari, Helsinki",
    summary: "Fifth placeholder record, west of the centre.",
    details: ["Demonstration copy only."]
  }
];
