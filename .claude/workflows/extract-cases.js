export const meta = {
  name: 'extract-cases',
  description: 'Haiku gathers evidence from each murha.info thread, Opus writes the bilingual case record',
  whenToUse: 'Turning classified murha.info threads into map-ready case records. Pass {batch, topics[]}.',
  phases: [
    { title: 'Evidence', detail: 'Haiku: read the condensed thread and the machine-extracted place-sentences' },
    { title: 'Write', detail: 'Opus: turn the evidence into a map-ready bilingual case record' },
  ],
}

// Parameterised: Workflow({name:'extract-cases', args:{batch:'004', topics:['199','227']}})
// Falls back to nothing rather than guessing — a run with no topics is a no-op,
// not a run over the whole batch.
// args can arrive as an object or as a JSON string depending on how the caller
// passes it; a string would otherwise silently yield no batch and no topics,
// and the run would report success having done nothing.
let a = args
if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = null } }

const BATCH = (a && a.batch) || ''
const TOPICS = (a && a.topics) || []

if (!BATCH || !TOPICS.length) {
  log('extract-cases needs args {batch, topics[]} — nothing to do')
  return []
}
log(`batch ${BATCH}: ${TOPICS.length} thread(s) to extract`)

const EVIDENCE = {
  type: 'object', additionalProperties: false,
  required: ['topic_id', 'is_single_homicide', 'reasoning', 'municipality', 'locations', 'facts'],
  properties: {
    topic_id: { type: 'string' },
    is_single_homicide: { type: 'boolean' },
    reasoning: { type: 'string' },
    municipality: { type: 'string' },
    incident_date: { type: 'string', description: 'ISO or partial (YYYY / YYYY-MM / YYYY-MM-DD); empty if unknown' },
    incident_date_note: { type: 'string' },
    solved_status: { type: 'string', enum: ['solved', 'unsolved', 'in_investigation', 'unclear'] },
    outcome: { type: 'string', description: 'Court outcome in English: who was convicted of what, by which court, when, and the sentence. Empty if none.' },
    facts: {
      type: 'array',
      description: '8-20 sourced facts about the case, each with the permalink it came from and whether a court/news source or a poster said it. This is what the writer will work from.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['fact', 'source_permalink', 'support'],
        properties: {
          fact: { type: 'string' },
          source_permalink: { type: 'string' },
          support: { type: 'string', enum: ['court_or_news', 'forum_claim'] },
        },
      },
    },
    victims: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'description', 'support', 'source_permalinks'],
        properties: {
          name: { type: 'string' }, description: { type: 'string' },
          support: { type: 'string', enum: ['court_or_news', 'forum_claim'] },
          source_permalinks: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    suspects: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'description', 'status', 'support', 'source_permalinks'],
        properties: {
          name: { type: 'string' }, description: { type: 'string' },
          status: { type: 'string', enum: ['convicted', 'acquitted', 'charged', 'suspected', 'unknown'] },
          support: { type: 'string', enum: ['court_or_news', 'forum_claim'] },
          source_permalinks: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    locations: {
      type: 'array',
      description: 'Every place the case involves, KILLING SITE FIRST.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['label', 'detail', 'quote', 'source_permalink', 'precision', 'credibility', 'is_killing_site'],
        properties: {
          label: { type: 'string', description: 'geocodable, e.g. "Kuurnantie 10, Teppana, Kajaani"' },
          detail: { type: 'string', description: 'what happened here, in English' },
          quote: { type: 'string', description: 'COPIED VERBATIM from the thread. Prefer pasting a candidate sentence exactly as given.' },
          source_permalink: { type: 'string' },
          precision: { type: 'string', enum: ['address', 'street', 'district', 'town', 'area'] },
          credibility: { type: 'string', enum: ['official', 'news', 'editor', 'forum_claim', 'rumour'] },
          is_killing_site: { type: 'boolean' },
        },
      },
    },
  },
}

const CASE = {
  type: 'object', additionalProperties: false,
  required: ['topic_id', 'title', 'municipality', 'solved_status', 'overview'],
  properties: {
    topic_id: { type: 'string' },
    title: { type: 'string', description: 'Finnish, e.g. "Volkan Ünsalin palkkamurha, Helsinki 16.10.2003"' },
    municipality: { type: 'string' },
    incident_date: { type: 'string' },
    incident_date_note: { type: 'string' },
    solved_status: { type: 'string', enum: ['solved', 'unsolved', 'in_investigation', 'unclear'] },
    outcome: { type: 'string' },
    overview: {
      type: 'object', additionalProperties: false,
      required: ['fi', 'en'],
      properties: {
        fi: {
          type: 'object', additionalProperties: false, required: ['lead', 'detail'],
          properties: { lead: { type: 'string' }, detail: { type: 'string' } },
        },
        en: {
          type: 'object', additionalProperties: false, required: ['lead', 'detail'],
          properties: { lead: { type: 'string' }, detail: { type: 'string' } },
        },
      },
    },
  },
}

const results = await pipeline(
  TOPICS,

  // ---- Stage 1: Haiku gathers evidence -------------------------------------
  (id) =>
    agent(
      `Gather evidence from one thread of the Finnish crime forum murha.info, for a homicide map.
Work from /home/user/Homicidemap. Run BOTH of these:

    node scripts/murha-batch-read.mjs --batch ${BATCH} --topic ${id} --condense
    node scripts/murha-batch-read.mjs --batch ${BATCH} --topic ${id} --candidates

The first is the thread (posts as "--- #N author date permalink"; "> [quoted]" lines are
material the poster pasted, usually a police bulletin or news story; "[link]" lines are
outbound sources). The second is every sentence in the thread that names a place, already
extracted for you with its permalink.

Return evidence, not prose.

CRITICAL — quotes must be REAL. Every 'quote' you return is checked mechanically against the
thread text, and anything not found is discarded. So do not retype, paraphrase, translate or
tidy a sentence: COPY IT EXACTLY, preferably straight from the --candidates output, which is
machine-extracted and therefore always exact. Getting a quote wrong loses the location.

- is_single_homicide: did a person die, caused by another person, in ONE identifiable incident
  this thread is substantively about?
  ONE INCIDENT, NOT ONE VICTIM. A couple killed together, a family killed together, or three
  people killed in one night's events are all TRUE — one incident with several victims. What
  is FALSE is several SEPARATE killings: the same offender killing in 1980 and again in 1983,
  a series of unconnected victims, or a thread about an offender's career rather than an event.
  Also false: attempted killings where nobody died, missing persons with no established crime,
  and other crimes.
- municipality: the Finnish municipality of the incident (e.g. "Oulu", "Loppi").
- locations: every place the case involves — where the killing happened, where a body was
  found, an arrest, a courthouse — KILLING SITE FIRST. Give each a geocodable label, the exact
  quote, its permalink, precision (address/street/district/town/area) and credibility
  (official = police/court, news, editor = a magazine or book quoted in the thread,
  forum_claim = a poster asserting it, rumour = a poster hedging it).
  If the thread names nothing more precise than the municipality, return one town-precision
  location. Never invent detail.
- facts: 8-20 sourced statements covering what happened, to whom, and how it ended — each with
  its permalink and whether a court/news source or a poster is behind it. The writer sees only
  these, so include everything that matters, and keep court reporting and forum talk distinct.
- victims / suspects: names ONLY where the thread gives them. Mark court_or_news only when a
  court or a news report is the source; a poster's assertion is forum_claim.`,
      { model: 'haiku', schema: EVIDENCE, label: `evidence:t=${id}`, phase: 'Evidence' }
    ),

  // ---- Stage 2: Opus writes the record -------------------------------------
  (ev, id) => {
    if (!ev || !ev.is_single_homicide) {
      log(`t=${id}: not a single homicide (${ev ? ev.reasoning.slice(0, 80) : 'no evidence returned'}) — skipped`)
      return null
    }
    return agent(
      `Write a case record for a Finnish homicide map, from the evidence below. It was gathered
from one murha.info forum thread. You are NOT reading the thread — work only from this.

EVIDENCE:
${JSON.stringify(ev, null, 1)}

Write 'overview' with all four texts, and make the Finnish genuinely written rather than a
translation — Finnish is the site's default language and these are Finnish cases in Finnish
sources:

  fi.lead / en.lead     ~40-70 words. What happened, to whom, how it ended. Must stand alone:
                        this is all most readers will get through.
  fi.detail / en.detail ~230-450 words, in paragraphs separated by blank lines. The full
                        account. State plainly which claims come from a court or a news report
                        and which are forum talk — the evidence marks each fact's support, and
                        that distinction must survive into the prose.

Rules:
 - Assert nothing the evidence does not contain. No inferred motives, no filled-in detail.
 - If the only location is the municipality, say so in the detail: that the thread gives
   nothing more precise, so the marker is not the site of the killing.
 - Name people only as the evidence names them, and where a name rests on a poster's claim
   rather than a court or news report, say so.
 - Do not repeat posters' speculation about identities, and do not name anyone the evidence
   does not name.
 - title: Finnish, naming the victim (if known), the municipality and the date.
 - outcome: English, the court result — who was convicted of what, by which court, when, and
   the sentence. If unsolved, say no one has been charged.`,
      { model: 'opus', schema: CASE, label: `write:t=${id}`, phase: 'Write' }
    ).then((rec) => (rec ? { record: rec, evidence: ev } : null))
  }
)

const done = results.filter(Boolean)
log(`${done.length}/${TOPICS.length} cases written`)
return done
