# Covering murha.info, batch by batch

The Kajaani pass proved the method on 109 threads. This is the plan for running
the same method over the whole homicide corpus, a batch at a time, on a
schedule, until there is nothing left to cover.

## What "all the cases" actually is

Counted from the forum itself on 2026-07-28 (`npm run census` regenerates it):

| Forum | Aiheet | Viestit | Page fetches |
| --- | ---: | ---: | ---: |
| Henkirikokset – kotimaa (`f=2`) | 2 313 | 263 673 | 18 776 |
| Henkirikokset kotimaa – selvittämättömät (`f=15`) | 162 | 60 237 | 4 098 |
| **In scope** | **2 475** | **323 910** | **22 874** |

Both figures match phpBB's own topic counters exactly, so the census is
complete rather than a sample. For context, the whole board is 34 319 topics
and ~1.9 M posts across 24 forums; the other 22 forums are foreign cases,
missing persons, other crimes, or off-topic chat, and are out of scope. That
decision is recorded here rather than in code so it can be revisited: widening
scope means re-running the census with more `--forums` ids and re-running the
planner, nothing else.

Two facts shape everything below:

- **The corpus is heavy-tailed.** Median thread is 21 posts; p99 is 1 755, and
  one thread ("Helsinki Ullanlinna", `t=57027`) holds 18 659 posts — 5.8% of
  the corpus on its own. The top 5 threads are 18.3% of all posts. Batching by
  topic count would produce batches whose cost varied by three orders of
  magnitude.
- **The crawl is the cheap stage.** 22 874 fetches at a 1.2 s delay is ~7.6
  hours of wall clock, once. The expensive stage is review: 2 475 threads
  read in full, twice — that is 23× the Kajaani pass, and it is what the
  schedule actually paces.

## The unit of work

A **batch** is a set of topics bounded by *both* budgets, because the two
expensive stages scale on different things:

- `--max-pages 600` — crawl cost, one fetch per 15 posts.
- `--max-topics 60` — review cost, one agent per thread.

A batch closes when it hits either. Threads too big for a batch on their own
become single-topic batches — a case is reviewed whole or not at all.

That yields **55 batches**: median 8 minutes of crawling, max 25 (the
Ullanlinna thread). Five are oversized singletons (002, 039, 045, 047, 049).

Batch assignment is **stable**. Topics are packed in ascending `topic_id` order
and `murha-batches.mjs` preserves existing assignments, so re-running the
planner after the forum has grown only *appends* batches. Batch 007 means the
same three threads in October as it did in July — which is the property that
makes a months-long schedule resumable.

## The four stages

Each batch moves through them in order; `data/pipeline-state.json` records where
every batch has got to, and a batch cannot enter a stage until the previous one
is done.

| Stage | What runs it | Output |
| --- | --- | --- |
| `crawl` | `murha-crawl-batch.mjs`, on GitHub Actions cron | `threads/batch-NNN.json.gz` on the `crawl-data` branch |
| `classify` | model review, one agent per thread | `data/classification/batch-NNN.json` |
| `extract` | model review of confirmed cases only | `data/homicides/batch-NNN.json` |
| `map` | `build-cases.mjs` | `data/cases.js` |

`classify` and `extract` are the two passes the Kajaani work already defined —
"is this one singular homicide case?" and "what does the thread say?" — run
against the same rubrics, so results are comparable across the whole corpus.

### Where the crawled posts live

On an orphan `crawl-data` branch, never on a branch that deploys. `deploy.yml`
publishes the repo root to GitHub Pages, so committing 324 000 verbatim forum
posts to `main` would republish every named victim, suspect and pseudonymous
poster under a different domain than the one they were written for. `crawl/`
and `crawl-data/` are gitignored on the pipeline branch for the same reason.

Gzipped, the full corpus is ~114 MB (measured: 369 bytes/message), which an
orphan branch carries comfortably.

## Running it in intervals

### Crawl — automated

`.github/workflows/crawl-batch.yml` runs daily at 03:17 UTC, crawls one batch,
pushes the shard to `crawl-data` and the state to the pipeline branch. At one
batch a day the crawl finishes in **55 days**; `count: 2` on the cron halves
that. `workflow_dispatch` takes `count`, `batch` and `delay` for manual runs.

The job is `concurrency`-grouped, so a long batch can never overlap the next
day's run and clobber the state file.

### Review — a Claude Code Routine

The two review stages are model work, so they run as a scheduled session rather
than a script. Each firing does exactly this:

```sh
git fetch origin crawl-data && git worktree add crawl-data origin/crawl-data
node scripts/murha-status.mjs                          # where are we
BATCH=$(node scripts/murha-status.mjs --next classify) # exits 1 if nothing ready
node scripts/murha-batch-read.mjs --batch $BATCH --shards crawl-data/threads
```

`--next` prints one batch id and nothing else, exiting 1 when the queue is
empty — so a firing with nothing to do stops instead of reviewing air. Then,
per thread in the batch:

```sh
node scripts/murha-batch-read.mjs --batch $BATCH --topic <id> --text \
  --shards crawl-data/threads
```

…apply the rubric, write `data/classification/batch-NNN.json`, and close the
stage:

```sh
node scripts/murha-mark.mjs --batch $BATCH --stage classify \
  --count reviewed=60 --count homicides=14
```

`extract` then opens for that batch on the next firing, and runs the same way
over the confirmed cases only.

### Map — when enough has accumulated

`build-cases.mjs` is cheap and idempotent, but it geocodes at Nominatim's
1 req/s limit, so run it over accumulated extractions rather than per batch —
say every tenth batch, and once at the end.

## Expected yield

Kajaani: 109 threads → 26 single homicide cases (24%). But that pass started
from a *keyword* search across the whole board, so it was full of threads that
merely mentioned Kajaani. This crawl starts from the homicide forums
themselves, so the confirmed-case rate should be far higher — the exclusions
will be duplicate threads about the same case, news round-ups and general
discussion rather than "wrong crime entirely".

Two consequences worth planning for:

- **Deduplication becomes a real stage.** 2 475 topics is not 2 475 cases;
  murha.info has several threads per notable case. The Kajaani pass never had
  to solve this at 26 cases. The `extract` output should carry a case key
  (victim + date + municipality) so threads can be merged before they reach the
  map.
- **The geocode guards will be exercised much harder.** They were tuned against
  one municipality where the district names were known. Nationwide, street
  names repeat across hundreds of municipalities, so expect the "within 6 km of
  the named district" guard to reject more and downgrade more markers to
  municipality precision. That is the correct failure — a coarse marker in the
  right place beats an exact one in the wrong place.

## Checking progress

```sh
npm run status              # per-stage bars, next batch, incomplete crawls
npm run status -- --json    # same, machine-readable
```

`status` also lists any batch whose threads came up short — a partial crawl
means the review would read a partial case, so those should be re-crawled with
`--batch NNN --force` before being reviewed.

"Short" is judged on **pages served**, not posts kept. phpBB sometimes renders
the same post on two consecutive pages: thread `t=65` serves `p1222751` at both
`start=420` and `start=435`, so the thread yields 845 distinct posts against a
reported total of 846 while being completely captured. Each thread therefore
records `rendered_count` (slots served) next to `message_count` (distinct posts
kept), and only `rendered_count < expected_message_count` counts as incomplete.

Judging on `message_count` alone — as the first version did — would have raised
a false alarm on the very first batch containing such a thread, and at 2 475
threads that noise would hide the real truncations it exists to catch.
