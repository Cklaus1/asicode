#!/usr/bin/env bun
/**
 * Seed the first asicode retrospective from the loop's iters 1-43.
 *
 * Manual Q1-Q5 because no LLM key is available in this env. The point
 * is to validate the substrate, not to wait for it. Real cycles will
 * use the LLM-driven introspector from src/services/instrumentation/
 * retro-introspect.ts; this seed proves the writer + markdown rendering
 * + cross-cycle Q4 feed-forward all work end-to-end.
 *
 * Run with:
 *   ASICODE_INSTRUMENTATION_DB=/path/to/db bun run scripts/seed-first-retro.ts
 */

import { newRetroId, writeRetroWithMarkdown } from '../src/services/instrumentation/retro'
import { probeRuntime, renderProbeMarkdown } from '../src/services/instrumentation/runtime-probe'

const q1 = `**The substrate-first cadence delivered.** Forty-three iterations,
six A-features end-to-end, 460 tests passing, ~15s L1 verifier loop. Each
new capability followed the same shape: substrate → wire-up → CLI/report.
Reliable and reusable.

**The bun-test verifier is the load-bearing investment.** Installing Bun
in iter 4 was the single highest-leverage move in the whole loop. Every
iteration since has shipped with same-cycle L1 coverage. Eight real bugs
caught by L1 across the loop, including: encoder trailing-bits dropping
(iter 28), ts-ordering inversion (iter 6), regex whitespace pattern
(iters 35+36), \\btest\\b word-boundary missing 'tests' (iter 36),
schema-version gate on missing table (iter 4), readdirSync import gap
in 18 tests (iter 42). Every one invisible to static review.

**Substrate-first paid off across all five A-features:** judges, A16,
A12, A8, A15, A11. Each took ~3 iterations end-to-end after the I-phase
substrate landed. The pattern stabilized into a confident estimate.

**The createCachedProvider refactor at iter 31** (after three trigger-
duplication instances) was rule-of-three applied correctly. Premature
abstraction at iter 23 would have needed a redesign at iter 26 when
warning-tag varied. The fourth trigger (adversarial, iter 34) reused
the helper one-line and validated the abstraction shape.`

const q2 = `**The integration-path gap from iters 39-43.** Every A-feature
shipped end-to-end with green tests, but the integrated user path was
broken from at least iter 23 forward. The recorder-adapter passed
\`opts.diff = undefined\` to every merge-time trigger because v1 callers
couldn't supply it at finalizeRun time. Six iterations of additions to
adaptFinalizeRun shipped on top of a foundation that didn't work end-to-end
in v1. None of the per-feature tests caught it because the tests stubbed
the adapter inputs; only walking backward from "what would a real user
do?" surfaced it. Five iterations of gap-closing rescued the work; the
work should have surfaced the gap earlier.

**The bun-cache effect quietly degraded the wall-clock signal.** Tests
that should have taken longer were caching across runs. We may have
been undercounting real wall-clock impact of new tests when the same
run is repeated.

**Three pre-existing v1 Gemini-provider test failures known since iter
40 but never investigated.** They are not blocking the loop's work but
are unflagged technical debt. We have not opened an issue, written a
runbook entry, or assigned them anywhere.`

const q3 = `**The duplicated provider-cache pattern was visible at iter
26 (two instances)** but I waited until iter 31 to extract. Three is
the rule-of-three threshold; two was enough to flag-and-watch. Watching
worked here but the principle is fragile — at iter 30 the third instance
(plan-retrieval trigger) was *different enough* that it didn't reuse
the helper, suggesting the abstraction's boundaries needed more thought
than "wait for three instances of the same shape."

**The integration-test gap was visible in retrospect from iter 13** —
density trigger ships requiring opts.diff, recorder doesn't pass it.
Same gap in iter 23 (A16), iter 26 (A12), iter 30 (A8), iter 34 (A15).
Five chances to notice. Each individual feature's tests stubbed the
adapter inputs, so the gap was only visible if you asked "where do
these inputs actually come from in v1?" The loop's measure-of-progress
was "does the next module ship cleanly," not "is the integrated path
actually closed." Practice 9 done well would have asked the integrated-
path question at every wire-up iteration.

**The Bun cache warming behavior was visible** in iter 7 onward but
never quantified. We might be ~30% slower in a true cold-cache
environment than the loop suggests. No measurement of cold vs warm.`

const q4 = {
  obvious: [
    'After every wire-up iteration, what data does the receiver receive in the real (non-test) call path? Trace it.',
    'For each opt-in env flag added: who in v1 actually sets it? Is there a v1 default that turns it on?',
    'How long does the full test suite take on a cold cache?',
  ],
  non_obvious: [
    "What's the maximum number of times we can ship the same shape (e.g. lazy-cached provider, fire-and-forget trigger) before the boilerplate becomes a leaky abstraction?",
    'When an A-feature is reportable but has zero rows in production, is the metric live or fake-live?',
    'What invariants does the schema CHECK enforce that we relied on as load-bearing safety nets, vs invariants we enforced redundantly at the zod layer?',
  ],
  missing_category: 'Cost / resource: we have no metric for how much an asicode brief costs in real LLM tokens, judge calls included. Budget caps exist on individual runs but no aggregate view.',
  candidate_questions: [
    'Has the integrated path from user-action to metric-update been walked end-to-end since the last retro?',
    'What pre-existing v1 test failures have been visible for >2 iterations without an issue opened?',
    'Which A-feature has the lowest data volume in production (smallest sample for its target threshold)?',
    'For each opt-in flag: what fraction of opted-in users actually have all required upstream prerequisites set?',
    'What share of the iteration cost is going to substrate vs gap-closing vs new capabilities?',
    'Where is the loop measuring local module success that hides global integration breakage?',
  ],
}

const q5 = `**Add a "walk the integrated path" rubric to the next retro cycle's Q3.**
Specifically: trace the data flow from user-action to metric-update for one
randomly-selected metric per retro. The single concrete change that would
have caught iter 39's gap five iterations earlier is making "walk the path"
a structural part of the cycle, not a happy accident.

Resulting brief: write a new prompt module at
src/services/instrumentation/retro-walk-path.ts that picks a metric, derives
the production data-flow path from schema + adapter wires, and asks the
introspecting model to identify any boundary where the flow breaks.
Run it as part of the next retro's Q3 by default.`

const rec = {
  retro_id: newRetroId(),
  version_tag: 'v0.1.0-iter43',
  ts: Date.now(),
  retro_kind: 'scheduled' as const,
  q1_kept_right: q1,
  q2_got_wrong: q2,
  q3_didnt_notice: q3,
  q4,
  q5_smallest_change: q5,
  // Mark perspectives as manually-generated rather than three-stance
  // LLM output. Real cycles populate these via dispatchIntrospection().
  perspective_self: {
    raw: '(manual seed for first retro; no LLM available in this env)',
    candidate_questions: [],
  },
}

async function main() {
  if (!process.env.ASICODE_INSTRUMENTATION_DB) {
    console.error('ASICODE_INSTRUMENTATION_DB must point at a migrated db')
    process.exit(2)
  }
  let probeMarkdown: string | undefined
  try {
    probeMarkdown = renderProbeMarkdown(await probeRuntime())
  } catch (e) {
    console.error(`probe failed (continuing without): ${e instanceof Error ? e.message : String(e)}`)
  }
  const result = writeRetroWithMarkdown({
    record: rec,
    retrosDir: 'docs/retros',
    runtimeProbeMarkdown: probeMarkdown,
  })
  console.log(`wrote retro=${result.retroId}`)
  if (result.markdownPath) {
    console.log(`markdown: ${result.markdownPath}`)
  }
}

main().catch(e => {
  console.error(e instanceof Error ? e.stack : String(e))
  process.exit(1)
})
