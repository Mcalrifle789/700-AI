// Reasoning acceleration (spec 2.2). Three client-side orchestration layers:
//
//   Speculative Routing   — simple intent queries go to a smaller, faster model;
//                           complex multi-step reasoning stays on the primary.
//   CoT Scaffolding       — a system instruction demanding explicit step-by-step
//                           logic before final code/answers, for complex asks.
//   (RAG caching lives in pipeline/cache.js — unchanged files skip reprocessing.)
//
// Routing only activates when the user has configured a small model, so default
// behaviour is unchanged until they opt in via /route.

// Chain-of-Thought scaffolding, injected for complex requests.
export const COT_SYSTEM =
  'Before giving the final answer or code, reason step by step: restate the goal, ' +
  'list the constraints, outline the approach, then produce the result. Keep the ' +
  'reasoning concise. Emit the final code only after the reasoning, in a fenced block ' +
  'with an explicit language tag.';

// Signals that a request is "complex" and worth the primary model + CoT.
const COMPLEX_HINTS = /\b(refactor|architect|design|debug|optimi[sz]e|prove|derive|migrat|algorithm|concurren|distributed|trade-?off|step by step|explain why|plan|multi-?step|end to end)\b/i;
const CODE_HINTS = /```|\bfunction\b|\bclass\b|\bdef \b|=>|\bimport \b|\bSELECT \b/i;

// Classify a user turn as 'simple' or 'complex' from cheap heuristics.
export function classifyComplexity(text, { staged = 0 } = {}) {
  const t = String(text || '');
  const words = t.split(/\s+/).filter(Boolean).length;
  const score =
    (words > 40 ? 2 : words > 18 ? 1 : 0) +
    (COMPLEX_HINTS.test(t) ? 2 : 0) +
    (CODE_HINTS.test(t) ? 1 : 0) +
    ((t.match(/\?/g) || []).length > 1 ? 1 : 0) +
    (staged > 0 ? 1 : 0);
  return score >= 2 ? 'complex' : 'simple';
}

// Decide which model handles this turn.
//   cfg.routing = { enabled, small }  — `small` is a model id on the same provider
// Returns { model, tier: 'small'|'primary', complexity, cot }.
export function route(text, cfg, { staged = 0 } = {}) {
  const complexity = classifyComplexity(text, { staged });
  const primary = cfg.provider?.model;
  const r = cfg.routing;
  const useSmall = r?.enabled && r?.small && complexity === 'simple';
  return {
    model: useSmall ? r.small : primary,
    tier: useSmall ? 'small' : 'primary',
    complexity,
    cot: complexity === 'complex',
  };
}

// Build the final message array: optionally prepend CoT scaffolding as an extra
// system instruction (does not replace skill/system messages already present).
export function withScaffold(messages, { cot }) {
  if (!cot) return messages;
  return [{ role: 'system', content: COT_SYSTEM }, ...messages];
}
