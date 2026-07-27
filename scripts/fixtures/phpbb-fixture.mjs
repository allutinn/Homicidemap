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

const topicPage = (t) => {
  const topic = TOPICS.find((x) => String(x.t) === String(t));
  if (!topic) return `<!DOCTYPE html><html><body><p>Not found</p></body></html>`;
  return `<!DOCTYPE html><html lang="fi"><head><meta charset="utf-8">
  <title>${topic.title}</title></head><body>
  <div class="post"><div class="postbody">
    <h3>${topic.title}</h3>
    <div class="content">${topic.snippet} Lisätietoja aiheesta ketjun ensimmäisessä viestissä.</div>
  </div></div></body></html>`;
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  res.setHeader("content-type", "text/html; charset=utf-8");

  if (url.pathname.endsWith("/search.php")) {
    res.end(resultsPage(Number(url.searchParams.get("start") || 0)));
  } else if (url.pathname.endsWith("/viewtopic.php")) {
    res.end(topicPage(url.searchParams.get("t")));
  } else {
    res.statusCode = 404;
    res.end("<html><body>404</body></html>");
  }
}).listen(port, () => console.log(`phpBB fixture on http://localhost:${port}/rikosfoorumi/search.php`));
