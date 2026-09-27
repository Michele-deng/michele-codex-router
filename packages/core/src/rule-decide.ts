import type { CapabilityProfile, RouteDecision, RouteInput } from "./types.js";

export type DecisionPolicy = "auto" | "always" | "rules";

export function heuristicTaskType(request: string): string {
  const normalized = request.toLowerCase();
  if (/\b(test|spec|coverage)\b/.test(normalized)) return "test";
  if (/\b(debug|fix|bug|error|fail)\b/.test(normalized)) return "debug";
  if (/\b(refactor|rename|cleanup)\b/.test(normalized)) return "refactor";
  if (/\b(architecture|design|plan)\b/.test(normalized)) return "architecture";
  if (/\b(implement|add|create|edit)\b/.test(normalized)) return "code_edit";
  return "chat";
}

const HARD_KEYWORDS =
  /refactor|architect|concurren|race condition|deadlock|migrat|performance|root cause|优化|重构|架构|并发|竞态|死锁|迁移|性能|根因/i;
const EASY_KEYWORDS =
  /explain|translate|summar|comment|format|typo|rename|解释|翻译|摘要|注释|格式|润色|改写标题/i;

/**
 * Complexity score on the same 0-4 scale Jev uses, so both decision sources
 * share one meaning. Kept deliberately crude: it is only trusted for pools of
 * at most two tiers where a wrong call costs at most one tier.
 */
export function scoreRuleRequest(
  request: string,
  signals: {
    estimatedInputTokens?: number | undefined;
    conversationItems?: number | undefined;
    toolCalls?: number | undefined;
  } = {}
): number {
  let score = 0;
  if ((signals.estimatedInputTokens ?? 0) > 50_000) score += 1.5;
  if ((signals.conversationItems ?? 0) > 30 || (signals.toolCalls ?? 0) > 5) score += 1;
  if (HARD_KEYWORDS.test(request)) score += 1.5;
  if (EASY_KEYWORDS.test(request)) score -= 1;

  const looksLikeCodeOrCrash = /\u0060{3}|traceback|\bat .+\(.+:\d+|堆栈|调用栈|error:|exception/i.test(request);
  if (looksLikeCodeOrCrash) score += 0.5;
  else if (request.trim().length < 200) score -= 0.5;
  return score;
}

const tierRank: Record<string, number> = { low: 0, medium: 1, high: 2, frontier: 3 };

/**
 * Rule-based routing for small candidate pools (at most 2 distinct tiers) and
 * for fail-open when the decision provider is unavailable. Zero cost, zero
 * network calls. Hysteresis: scores within 0.25 of the upgrade threshold keep
 * the current model instead of ping-ponging.
 */
export function decideWithRules(
  input: RouteInput,
  eligible: CapabilityProfile[],
  currentModelId?: string
): RouteDecision {
  if (eligible.length === 0) {
    throw new Error("rule decision requires at least one eligible candidate");
  }
  const score = scoreRuleRequest(input.request, {
    estimatedInputTokens: input.preferences?.estimatedInputTokens,
    conversationItems: input.preferences?.conversationItems,
    toolCalls: input.preferences?.toolCalls
  });

  const byTierAsc = [...eligible].sort(
    (left, right) => (tierRank[left.static.tier] ?? 0) - (tierRank[right.static.tier] ?? 0)
  );
  const cheap = byTierAsc[0] as CapabilityProfile;
  const expensive = byTierAsc[byTierAsc.length - 1] as CapabilityProfile;

  let upgrade = score >= 1.5;
  const estimate = input.preferences?.estimatedInputTokens;
  if (estimate !== undefined && estimate > cheap.static.contextLimit) upgrade = true;
  if (input.preferences?.requiresTools && !cheap.static.supportsTools) upgrade = true;

  const current = currentModelId
    ? eligible.find((candidate) => candidate.modelId === currentModelId)
    : undefined;
  const inHysteresisBand = Math.abs(score - 1.5) <= 0.25;

  const chosen = current && inHysteresisBand ? current : upgrade ? expensive : cheap;
  return {
    providerId: chosen.providerId ?? "passthrough",
    modelId: chosen.modelId,
    tier: chosen.static.tier,
    confidence: 0.9,
    probabilities: { [chosen.modelId]: 1 },
    factors: {
      taskType: heuristicTaskType(input.request),
      complexity: score,
      reasoningRequired: Math.max(0, Math.min(1, score / 4)),
      toolComplexity: input.preferences?.requiresTools ? 0.8 : 0.2
    },
    profileVersion: chosen.profileVersion,
    decisionSource: "rules"
  };
}

export function distinctTierCount(candidates: CapabilityProfile[]): number {
  return new Set(candidates.map((candidate) => candidate.static.tier)).size;
}
