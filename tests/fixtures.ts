import type { CapabilityProfile, ModelTier, RawRoutingJudgment, RouteInput, TypedDecisionProvider } from "@jev-router/core";
export function profile(modelId: string, tier: ModelTier, overrides: Partial<CapabilityProfile> = {}): CapabilityProfile {
  return { modelId, profileVersion: "test.1", updatedAt: "2026-09-25T00:00:00.000Z", static: { tier, contextLimit: 128000, supportsTools: true, strengths: ["coding"], constraints: [] }, ...overrides };
}
export class StubDecisionProvider implements TypedDecisionProvider {
  calls = 0;
  constructor(private readonly result: RawRoutingJudgment | Error = judgment("medium-model")) {}
  async decide(_input: RouteInput, _candidates: CapabilityProfile[]): Promise<RawRoutingJudgment> {
    this.calls += 1;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}
export function judgment(selectedModelId: string, confidence = 0.9, tierScore = 0.5): RawRoutingJudgment {
  return { selectedModelId, confidence, probabilities: { [selectedModelId]: confidence }, factors: { taskType: "code_edit", complexity: tierScore, reasoningRequired: tierScore, toolComplexity: tierScore } };
}
