import { RouteError } from "./errors.js";
import type {
  CapabilityProfile,
  ModelTier,
  RawRoutingJudgment,
  RouteDecision,
  RouteInput,
  TypedDecisionProvider
} from "./types.js";

const tierRank: Record<ModelTier, number> = { low: 0, medium: 1, high: 2, frontier: 3 };

export class RouteEngine {
  constructor(
    private readonly decisionProvider: TypedDecisionProvider,
    private readonly fallbackModelId?: string,
    private readonly lowConfidenceThreshold = 0.55,
    private readonly decisionTimeoutMs?: number
  ) {}

  async route(input: RouteInput): Promise<RouteDecision> {
    const explicitModelId = input.preferences?.explicitModelId;
    if (explicitModelId) {
      const explicit = input.candidates.find((candidate) => candidate.modelId === explicitModelId);
      if (!explicit) {
        throw new RouteError(`Explicit model is not available: ${explicitModelId}`, "MODEL_UNAVAILABLE");
      }
      return this.staticDecision(explicit, input, 1);
    }

    const eligible = this.eligibleCandidates(input);
    if (eligible.length === 0) {
      const fallback = this.resolveFallback(input);
      return {
        ...this.staticDecision(fallback, input, 0),
        fallback: { reason: "No eligible candidates" }
      };
    }

    let judgment: RawRoutingJudgment;
    try {
      judgment = await this.decideWithinBudget(input, eligible);
    } catch (error) {
      const fallback = this.resolveFallback(input, eligible);
      return {
        ...this.staticDecision(fallback, input, 0),
        fallback: {
          reason: error instanceof RouteError && error.code === "DECISION_TIMEOUT"
            ? "Decision timed out after " + this.decisionTimeoutMs + "ms"
            : error instanceof Error ? error.message : "Decision provider failed"
        }
      };
    }

    const selected = eligible.find((candidate) => candidate.modelId === judgment.selectedModelId);
    if (!selected) {
      const fallback = this.resolveFallback(input, eligible);
      return {
        ...this.staticDecision(fallback, input, judgment.confidence),
        factors: judgment.factors,
        probabilities: judgment.probabilities,
        fallback: {
          reason: "Jev selected a model that is no longer eligible",
          originalModelId: judgment.selectedModelId
        }
      };
    }

    const safeDecision = this.enforceSafety(input, selected, eligible, judgment);
    return safeDecision;
  }

  /**
   * Hard deadline for one decision. The underlying provider keeps its own
   * retry policy, but the route must fail open instead of blocking Codex.
   */
  private async decideWithinBudget(
    input: RouteInput,
    eligible: CapabilityProfile[]
  ): Promise<RawRoutingJudgment> {
    const budget = this.decisionTimeoutMs;
    if (!budget || budget <= 0) return this.decisionProvider.decide(input, eligible);

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.decisionProvider.decide(input, eligible),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new RouteError("Decision exceeded " + budget + "ms", "DECISION_TIMEOUT")),
            budget
          );
          timer.unref?.();
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private eligibleCandidates(input: RouteInput): CapabilityProfile[] {
    const preferences = input.preferences;
    return input.candidates.filter((candidate) => {
      if (candidate.runtime?.available === false) return false;
      if (preferences?.requiresTools && !candidate.static.supportsTools) {
        return false;
      }
      if (preferences?.minTier && tierRank[candidate.static.tier] < tierRank[preferences.minTier]) {
        return false;
      }
      if (!preferences?.longTierEnabled && candidate.static.tier === "frontier") {
        return false;
      }
      if (
        preferences?.estimatedInputTokens !== undefined &&
        candidate.runtime?.contextRemaining !== undefined &&
        preferences.estimatedInputTokens > candidate.runtime.contextRemaining
      ) {
        return false;
      }
      if (
        preferences?.estimatedInputTokens !== undefined &&
        preferences.estimatedInputTokens > candidate.static.contextLimit
      ) {
        return false;
      }
      if (
        preferences?.maxCost !== undefined &&
        candidate.static.inputPrice !== undefined &&
        candidate.static.inputPrice > preferences.maxCost
      ) {
        return false;
      }
      return true;
    });
  }

  private enforceSafety(
    input: RouteInput,
    selected: CapabilityProfile,
    eligible: CapabilityProfile[],
    judgment: RawRoutingJudgment
  ): RouteDecision {
    const current = input.preferences?.currentModelId
      ? eligible.find((candidate) => candidate.modelId === input.preferences?.currentModelId)
      : undefined;

    let final = selected;
    let fallback: RouteDecision["fallback"];

    if (
      judgment.confidence < this.lowConfidenceThreshold &&
      current &&
      tierRank[selected.static.tier] < tierRank[current.static.tier]
    ) {
      final = current;
      fallback = {
        reason: "Low confidence cannot downgrade the current model",
        originalModelId: selected.modelId
      };
    } else if (
      current?.runtime?.cacheState === "hot" &&
      tierRank[selected.static.tier] < tierRank[current.static.tier]
    ) {
      final = current;
      fallback = {
        reason: "Kept the current hot-cache model to avoid reprocessing context",
        originalModelId: selected.modelId
      };
    }

    return {
      providerId: final.providerId ?? "openai",
      modelId: final.modelId,
      tier: final.static.tier,
      confidence: judgment.confidence,
      probabilities: judgment.probabilities,
      factors: judgment.factors,
      profileVersion: final.profileVersion,
      ...(fallback ? { fallback } : {})
    };
  }

  private resolveFallback(input: RouteInput, candidates = input.candidates): CapabilityProfile {
    const byId = this.fallbackModelId
      ? candidates.find((candidate) => candidate.modelId === this.fallbackModelId)
      : undefined;
    if (byId) return byId;

    const available = candidates.filter((candidate) => candidate.runtime?.available !== false);
    const pool = available.length > 0 ? available : candidates;
    const sorted = [...pool].sort(
      (left, right) => tierRank[right.static.tier] - tierRank[left.static.tier]
    );
    const result = sorted[0];
    if (!result) {
      throw new RouteError("No model candidates are configured", "NO_CANDIDATES");
    }
    return result;
  }

  private staticDecision(
    profile: CapabilityProfile,
    input: RouteInput,
    confidence: number
  ): RouteDecision {
    return {
      providerId: profile.providerId ?? "openai",
      modelId: profile.modelId,
      tier: profile.static.tier,
      confidence,
      probabilities: { [profile.modelId]: 1 },
      factors: {
        taskType: heuristicTaskType(input.request),
        complexity: profile.static.tier === "low" ? 1 : profile.static.tier === "medium" ? 2 : 4,
        reasoningRequired: profile.static.tier === "low" ? 0.2 : 0.8,
        toolComplexity: profile.static.supportsTools ? 0.5 : 0
      },
      profileVersion: profile.profileVersion
    };
  }
}

function heuristicTaskType(request: string): string {
  const normalized = request.toLowerCase();
  if (/\b(test|spec|coverage)\b/.test(normalized)) return "test";
  if (/\b(debug|fix|bug|error|fail)\b/.test(normalized)) return "debug";
  if (/\b(refactor|rename|cleanup)\b/.test(normalized)) return "refactor";
  if (/\b(architecture|design|plan)\b/.test(normalized)) return "architecture";
  if (/\b(implement|add|create|edit)\b/.test(normalized)) return "code_edit";
  return "chat";
}
