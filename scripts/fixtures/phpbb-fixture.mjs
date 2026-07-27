/**
 * Minimal phpBB-shaped fixture server used to test scripts/murha-search.mjs
 * offline (and on networks where the real forum is unreachable).
 *
 *   node scripts/fixtures/phpbb-fixture.mjs 8200
 *   node scripts/murha-search.mjs --base http://localhost:8200/rikosfoorumi \
 *why     --overview --delay 0 --out /tmp/out.json
 *
 * It reproduces the markup the scraper relies on: a.topictitle links,
 * .content snippets, memberlist author links, and start= pagination.
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
    title: "Kajaanin surma 1998 – ratkaisematon",
    snippet:
      "Vuonna 1998 Kajaanissa tapahtunut surma on yhä ratkaisematta. Tuomiota ei ole annettu.",
    author: "kayttaja5",
    forum: "Vanhat tapaukset",
  },
];

const PER_PAGE = 3;

const resultsPage = (start) => {
  const slice = TOPICS.slice(start, start + PER_PAGE);
  const rows = slice
    .map(
      (t) => `
    <div class="search post">
      <div class="postbody">
        <h3><a href="./viewtopic.php?f=5&amp;t=${t.t}&amp;hilit=kajaani"
               class="topictitle">${t.title}</a></h3>
        <div class="author">
          <a href="./memberlist.php?mode=viewprofile&amp;u=${t.t}">${t.author}</a>
          » 12 Jan 2020, 10:00
        </div>
        <div class="content">${t.snippet}</div>
        <a href="./viewforum.php?f=5">${t.forum}</a>
      </div>
    </div>`
    )
    .join("\n");

  return `<!DOCTYPE html><html lang="fi"><head><meta charset="utf-8">
  <title>Haku – Rikosfoorumi</title></head><body>
  <div id="page-body">${rows || "<p>Haku ei tuottanut tuloksia.</p>"}</div>
  </body></html>`;
};

/** Two posts per topic page, three pages' worth of posts, to test pagination. */
const POSTS_PER_PAGE = 2;

const postsFor = (topic) => [
  {
    author: topic.author,
    date: "12 Jan 2020, 10:00",
    html: `${topic.snippet} Lisätietoja aiheesta ketjun ensimmäisessä viestissä.
           <a href="https://yle.fi/uutiset/3-1234567" class="postlink">Ylen uutinen</a>
           <img src="./download/file.php?id=11" class="postimage" alt="kartta">`,
  },
  {
    author: "kommentoija",
    date: "13 Jan 2020, 09:30",
    html: `Poliisin tiedote asiasta:
           <a href="https://poliisi.fi/tiedote/999" class="postlink">poliisi.fi</a>`,
  },
  {
    author: "kolmas",
    date: "14 Jan 2020, 20:15",
    html: `Oikeuden päätös tuli tänään.
           <img src="https://example.org/kuva.jpg" class="postimage" alt="kuva">`,
  },
];

const topicPage = (t, start) => {
  const topic = TOPICS.find((x) => String(x.t) === String(t));
  if (!topic) return `<!DOCTYPE html><html><body><p>Not found</p></body></html>`;

  const all = postsFor(topic);
  const slice = all.slice(start, start + POSTS_PER_PAGE);
  const posts = slice
    .map(
      (p) => `
    <div class="post has-profile">
      <dl class="postprofile">
        <dt><a href="./memberlist.php?mode=viewprofile&amp;u=1">${p.author}</a></dt>
      </dl>
      <div class="postbody">
        <p class="author">${p.date}</p>
        <div class="content">${p.html}</div>
      </div>
    </div>`
    )
    .join("\n");

  return `<!DOCTYPE html><html lang="fi"><head><meta charset="utf-8">
  <title>${topic.title}</title></head><body>
  <h2 class="topic-title">${topic.title}</h2>
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
}).listen(port, () => console.log(`phpBB fixture on http://localhost:${port}/rikosfoorumi/search.php`));
