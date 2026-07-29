export const meta = {
  name: 'classify-batch',
  description: 'Haiku reads each crawled thread\'s opening post and decides whether it is one homicide',
  whenToUse: 'Triaging a freshly crawled murha.info batch before extraction. Pass {batch}.',
  phases: [{ title: 'Classify', detail: 'Haiku: opening posts -> single_homicide / other' }],
}

// Batches 004 and 005 were classified from thread TITLES by hand, and the
// evidence pass later overruled two of those verdicts — both times correctly
// (t=360 covers two separate 1971 killings, t=368 several). A title says too
// little: "Teisko 1990-luku" cannot tell you whether it is one incident or five.
// So classification reads the opening post, which is normally the case summary.
//
// Chunked rather than one agent per thread: the judgement is cheap, the
// expensive part is spawning, and a 60-topic batch would otherwise be 60 agents.
let a = args
if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = null } }

const BATCH = (a && a.batch) || ''
const CHUNK = (a && a.chunk) || 8

if (!BATCH) {
  log('classify-batch needs args {batch} — nothing to do')
  return []
}

const VERDICTS = {
  type: 'object', additionalProperties: false,
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['topic_id', 'topic', 'verdict', 'confidence', 'reasoning'],
        properties: {
          topic_id: { type: 'string' },
          topic: { type: 'string' },
          verdict: {
            type: 'string',
            enum: ['single_homicide', 'multiple_incidents', 'not_a_homicide', 'unclear'],
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          reasoning: { type: 'string', description: 'One sentence.' },
          municipality: { type: 'string', description: 'Finnish municipality if the opening post names one; empty otherwise.' },
        },
      },
    },
  },
}

// Each agent sees the whole batch listing but answers only for the ids it is
// given, which keeps the slices disjoint regardless of listing order.
//
// The ids come in through args rather than from an agent that reads the shard:
// a free-text agent returning JSON wraps it in a code fence sooner or later, and
// a fence at this point kills the whole run before any classifying happens. The
// caller has a shell and can produce the list exactly.
let ids = (a && a.topics) || []
if (!ids.length) {
  log(`classify-batch needs args {batch, topics[]} — get them with:\n` +
      `  node scripts/murha-batch-read.mjs --batch ${BATCH} | jq -c '[.threads[].topic_id|tostring]'`)
  return []
}
ids = ids.map(String)

log(`batch ${BATCH}: ${ids.length} topics to classify in chunks of ${CHUNK}`)

const chunks = []
for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK))

const results = await parallel(
  chunks.map((slice, n) => () =>
    agent(
      `Triage threads from the Finnish crime forum murha.info for a homicide map.
Work from /home/user/Homicidemap. Run:

    node scripts/murha-batch-read.mjs --batch ${BATCH}

That prints every thread in the batch with its topic_id, title and the first 800 characters
of its opening post. Classify ONLY these topic_ids, and return one verdict for each:

${slice.join(', ')}

Judge from the opening post, not the title — a title like "Teisko 1990-luku" cannot tell you
whether the thread is about one killing or five, and the opening post usually can.

  single_homicide     A person died, caused by another person, in ONE identifiable incident
                      that this thread is substantively about.
                      ONE INCIDENT, NOT ONE VICTIM: a couple killed together, a family killed
                      together, or several people killed in one night's events all count as
                      single_homicide — one incident, several victims.
  multiple_incidents  Several SEPARATE killings: one offender killing in 1980 and again in
                      1983, a series of unconnected victims, or a thread about an offender's
                      career rather than about one event.
  not_a_homicide      Nobody died, or nobody was killed by another person: attempted killings,
                      accidents, suicides, missing persons with no established crime, other
                      crimes, discussion threads.
  unclear             The opening post genuinely does not say enough to tell.

Prefer 'unclear' over a guess. Set confidence honestly: 'high' only when the opening post
states plainly what happened.

Return the topic title exactly as the listing gives it.`,
      { model: 'haiku', schema: VERDICTS, label: `classify:${BATCH}#${n + 1}`, phase: 'Classify' }
    )
  )
)

const all = results.filter(Boolean).flatMap((r) => r.verdicts ?? [])
const counts = {}
for (const v of all) counts[v.verdict] = (counts[v.verdict] ?? 0) + 1
log(`${all.length}/${ids.length} classified: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(', ')}`)

return all
