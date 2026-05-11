// REQ-6.3: prompt builder for the tiebreak single-judge call. Mirrors
// services/judges/dispatcher.ts's buildUserPrompt but slimmed to the
// fields needed for a race tiebreak. No "PR intent" or "test runner
// output" sections — the racers haven't shipped tests yet.

export const JUDGE_USER_TEMPLATE_HINT = `Return ONLY JSON matching:
{
  "scores": { "correctness": 1-5, "code_review": 1-5, "qa_risk": 1-5 },
  "primary_score": "correctness",
  "primary_reasoning": "...",
  "concerns": [],
  "confidence": 0.0-1.0
}`

export function buildUserPrompt(input: { briefText: string; diff: string }): string {
  const lines: string[] = []
  lines.push('## Brief')
  lines.push(input.briefText.trim())
  lines.push('')
  lines.push('## Diff')
  lines.push('```diff')
  lines.push(input.diff.length > 50_000 ? input.diff.slice(0, 50_000) + '\n\n[...truncated...]' : input.diff)
  lines.push('```')
  lines.push('')
  lines.push(JUDGE_USER_TEMPLATE_HINT)
  return lines.join('\n')
}
