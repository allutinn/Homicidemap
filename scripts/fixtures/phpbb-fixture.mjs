/**
 * Minimal phpBB-shaped fixture server used to test the murha.info scripts
 * offline (and on networks where the real forum is unreachable).
 *
 *   node scripts/fixtures/phpbb-fixture.mjs 8200
 *   node scripts/murha-search.mjs --base http://localhost:8200/rikosfoorumi \
 *       --overview --delay 0 --out /tmp/out.json
 *
 * It reproduces the phpBB 3.3 markup the scrapers rely on: `a.topictitle`
 * inside `li.row` with a `.responsive-hide.left-box` meta line, `div.post#pNNN`
 * with `.postprofile .username`, `p.author time[datetime]` and `.content`,
 * a `.pagination` post total, and `start=` pagination that clamps like phpBB.
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] || 8200);

const TOPICS = [
  {
    t: 101,
    title: "Kajaanin henkirikos 2019 – puukotus keskustassa",
    snippet:
      "Kajaanissa tapahtui elokuussa 2019 henkirikos, jossa uhri kuoli puukotuksen seurauksena. Epäilty otettiin kiinni samana yönä.",
    author: "kayttaja1",
    forum: "Henkirikokset",
  },
  {
    t: 102,
    title: "Kajaani: kadonnut mies 2015",
    snippet:
      "Mies katosi Kajaanissa kesäkuussa 2015. Poliisi epäilee henkirikosta, uhria ei ole löydetty.",
    author: "kayttaja2",
    forum: "Kadonneet",
  },
  {
    t: 103,
    title: "Yleistä keskustelua Kajaanin seudusta",
    snippet:
      "Yleistä keskustelua Kajaanin alueesta ja foorumin säännöistä. Mitä mieltä olette?",
    author: "kayttaja3",
    forum: "Yleinen keskustelu",
  },
  {
    t: 104,
    title: "Oulun murha 2020",
    snippet: "Oulussa tapahtunut henkirikos, ei liity Kainuuseen.",
    author: "kayttaja4",
    forum: "Henkirikokset",
  },
  {
    t: 105,
    title: "Surma 1998 – ratkaisematon",
    snippet:
      "Vuonna 1998 Kajaanissa tapahtunut surma on yhä ratkaisematta. Tuomiota ei ole annettu.",
    author: "kayttaja5",
    forum: "Vanhat tapaukset",
  },
];

const PER_PAGE = 3;

const resultsPage = (start) => {
  // phpBB clamps an out-of-range start to the last page rather than 404ing.
  const clamped = Math.min(start, Math.max(0, TOPICS.length - 1));
  const rows = TOPICS.slice(clamped, clamped + PER_PAGE)
    .map(
      (t) => `
    <li class="row bg1">
      <dl>
        <dd><div class="list-inner">
          <a href="./viewtopic.php?f=5&amp;t=${t.t}&amp;hilit=kajaani&amp;sid=abc"
             class="topictitle">${t.title}</a>
          <div class="responsive-hide left-box">
            Kirjoittaja <span class="username">${t.author}</span> &raquo;
            <time datetime="2020-01-12T10:00:00+00:00">Su Tammi 12, 2020 10:00 am</time>
            &raquo; Sijainti: <a href="./viewforum.php?f=5&amp;sid=abc">${t.forum}</a>
          </div>
        </div></dd>
        <dd class="posts">${postsFor(t).length - 1} <dfn>Vastaukset</dfn></dd>
      </dl>
    </li>`
    )
    .join("\n");

  return `<!DOCTYPE html><html lang="fi"><head><meta charset="utf-8">
  <title>Haku – Rikosfoorumi</title></head><body>
  <div id="page-body"><ul class="topiclist topics">${
    rows || "<p>Haku ei tuottanut tuloksia.</p>"
  }</ul></div>
  </body></html>`;
};

/** Two posts per topic page, so pagination is exercised. */
const POSTS_PER_PAGE = 2;

const postsFor = (topic) => [
  {
    id: topic.t * 1000 + 1,
    author: topic.author,
    iso: "2020-01-12T10:00:00+00:00",
    date: "Su Tammi 12, 2020 10:00 am",
    html: `${topic.snippet} Lisätietoja aiheesta ketjun ensimmäisessä viestissä.
           <a href="https://yle.fi/uutiset/3-1234567" class="postlink">Ylen uutinen</a>
           <img src="./download/file.php?id=11" class="postimage" alt="kartta">`,
  },
  {
    id: topic.t * 1000 + 2,
    author: "kommentoija",
    iso: "2020-01-13T09:30:00+00:00",
    date: "Ma Tammi 13, 2020 9:30 am",
    html: `<blockquote><div>Aiempi viesti lainattuna</div></blockquote>
           Poliisin tiedote asiasta:
           <a href="https://poliisi.fi/tiedote/999" class="postlink">poliisi.fi</a>`,
  },
  {
    id: topic.t * 1000 + 3,
    author: "kolmas",
    iso: "2020-01-14T20:15:00+00:00",
    date: "Ti Tammi 14, 2020 8:15 pm",
    html: `Oikeuden päätös tuli tänään.
           <img src="https://example.org/kuva.jpg" class="postimage" alt="kuva">`,
  },
];

const topicPage = (t, start) => {
  const topic = TOPICS.find((x) => String(x.t) === String(t));
  if (!topic) return `<!DOCTYPE html><html><body><p>Not found</p></body></html>`;

  const all = postsFor(topic);
  const clamped = Math.min(start, Math.max(0, all.length - 1));
  const posts = all
    .slice(clamped, clamped + POSTS_PER_PAGE)
    .map(
      (p) => `
    <div id="p${p.id}" class="post has-profile bg2">
      <dl class="postprofile" id="profile${p.id}">
        <dt><strong><span class="username">${p.author}</span></strong></dt>
      </dl>
      <div class="postbody">
        <p class="author">
          <span class="responsive-hide">Kirjoittaja
            <strong><span class="username">${p.author}</span></strong> &raquo; </span>
          <time datetime="${p.iso}">${p.date}</time>
        </p>
        <div class="content">${p.html}</div>
      </div>
    </div>`
    )
    .join("\n");

  return `<!DOCTYPE html><html lang="fi"><head><meta charset="utf-8">
  <title>${topic.title}</title></head><body>
  <h2 class="topic-title">${topic.title}</h2>
  <div class="pagination">${all.length} viestiä</div>
  <div id="page-body">${posts}</div>
  </body></html>`;
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  res.setHeader("content-type", "text/html; charset=utf-8");

  if (url.pathname.endsWith("/search.php")) {
    res.end(resultsPage(Number(url.searchParams.get("start") || 0)));
  } else if (url.pathname.endsWith("/viewtopic.php")) {
    res.end(topicPage(url.searchParams.get("t"), Number(url.searchParams.get("start") || 0)));
  } else {
    res.statusCode = 404;
    res.end("<html><body>404</body></html>");
  }
}).listen(port, () =>
  console.log(`phpBB fixture on http://localhost:${port}/rikosfoorumi/search.php`)
);
