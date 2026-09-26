import type {
  CapabilityProfile,
  RawRoutingJudgment,
  RouteInput,
  TypedDecisionProvider
} from "@jev-router/core";
import type { TypesafeAnswer, TypesafeRequest, TypesafeResponse } from "./types.js";

export interface TypesafeClientOptions {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class TypesafeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody?: unknown
  ) {
    super(message);
    this.name = "TypesafeApiError";
  }
}

export class TypesafeDecisionProvider implements TypedDecisionProvider {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TypesafeClientOptions = {}) {
    this.endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
    this.model = options.model ?? "jev-latest";
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async decide(input: RouteInput, candidates: CapabilityProfile[]): Promise<RawRoutingJudgment> {
    const apiKey = this.options.apiKey ?? process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY;
    if (!apiKey) {
      throw new TypesafeApiError("TYPESAFE_API_KEY or JEV_API_KEY is not configured", 401);
    }

    const request = this.buildRequest(input, candidates);
    const response = await this.requestWithRetry(request, apiKey);
    return parseJudgment(response, candidates);
  }

  buildRequest(input: RouteInput, candidates: CapabilityProfile[]): TypesafeRequest {
    const candidateCriteria = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.modelId,
        compactCandidateDescription(candidate)
      ])
    );

    return {
      state: {
        task: truncate(input.request, 8_000),
        ...(input.contextSummary ? { context: truncate(input.contextSummary, 4_000) } : {}),
        candidates: candidates.map((candidate) => ({
          model: candidate.modelId,
          tier: candidate.static.tier,
          strengths: candidate.static.strengths,
          constraints: candidate.static.constraints,
          context_limit: candidate.static.contextLimit,
          runtime: candidate.runtime,
          calibration: summarizeCalibration(candidate)
        }))
      },
      model: this.model,
      questions: {
        task_type: {
          type: "choice",
          instructions: "What kind of development task is `task`?",
          criteria: {
            chat: "Questions, explanations, or documentation that do not edit code",
            code_edit: "A bounded implementation or code change",
            refactor: "Structural cleanup or behavior-preserving restructuring",
            debug: "Diagnosing or fixing a defect or failing test",
            architecture: "System design, cross-service planning, or high-impact tradeoffs",
            test: "Writing, fixing, or evaluating tests"
          }
        },
        complexity: {
          type: "score",
          instructions: "How complex is the task in `task`, considering the available `context`?",
          criteria: [
            "Trivial mechanical work",
            "Simple bounded work",
            "Moderate multi-step work",
            "Complex cross-file or cross-domain work",
            "Exceptionally difficult architecture or reasoning work"
          ]
        },
        reasoning_required: {
          type: "score",
          instructions: "How much sustained reasoning does `task` require?",
          criteria: [
            "No material reasoning",
            "Light local reasoning",
            "Moderate reasoning",
            "Deep reasoning",
            "Frontier-level reasoning"
          ]
        },
        tool_complexity: {
          type: "score",
          instructions: "How complex are the likely tool, repository, and execution interactions for `task`?",
          criteria: [
            "No tools required",
            "Simple local tool use",
            "Several repository tools",
            "Complex multi-step tool orchestration",
            "High-risk or highly complex tool orchestration"
          ]
        },
        recommended_model: {
          type: "choice",
          instructions:
            "Which candidate in `candidates` best balances capability, context, runtime state, calibration, and cost for `task`?",
          criteria: candidateCriteria
        }
      }
    };
  }

  private async requestWithRetry(request: TypesafeRequest, apiKey: string): Promise<TypesafeResponse> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json"
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.timeoutMs)
        });
        const body = await response.json() as unknown;
        if (!response.ok) {
          const error = new TypesafeApiError(
            `TypeSafe request failed with ${response.status}`,
            response.status,
            body
          );
          if (response.status !== 429 && response.status !== 529) throw error;
          lastError = error;
        } else {
          return validateResponse(body);
        }
      } catch (error) {
        lastError = error;
        if (error instanceof TypesafeApiError && error.status !== 429 && error.status !== 529) {
          throw error;
        }
      }
      await delay(150 * 2 ** attempt);
    }
    if (lastError instanceof Error) throw lastError;
    throw new TypesafeApiError("TypeSafe request failed", 500, lastError);
  }
}

export function parseJudgment(
  response: TypesafeResponse,
  candidates: CapabilityProfile[]
): RawRoutingJudgment {
  const taskType = getChoice(response.answers.task_type);
  const complexity = getScore(response.answers.complexity);
  const reasoning = getScore(response.answers.reasoning_required);
  const tools = getScore(response.answers.tool_complexity);
  const model = getChoice(response.answers.recommended_model);
  const allowed = new Set(candidates.map((candidate) => candidate.modelId));
  const selectedModelId = allowed.has(model.choice) ? model.choice : candidates[0]?.modelId;
  if (!selectedModelId) {
    throw new TypesafeApiError("TypeSafe returned no usable model choice", 502, response);
  }

  return {
    selectedModelId,
    confidence: model.confidence,
    probabilities: model.probabilities,
    factors: {
      taskType: taskType.choice,
      complexity: complexity.score,
      reasoningRequired: normalizeScore(reasoning.score, reasoning.legend),
      toolComplexity: normalizeScore(tools.score, tools.legend)
    }
  };
}

function compactCandidateDescription(candidate: CapabilityProfile): string {
  const calibration = summarizeCalibration(candidate);
  return [
    `tier=${candidate.static.tier}`,
    `context=${candidate.static.contextLimit}`,
    `tools=${candidate.static.supportsTools}`,
    `strengths=${candidate.static.strengths.join(", ")}`,
    `constraints=${candidate.static.constraints.join(", ")}`,
    calibration ? `calibration=${JSON.stringify(calibration)}` : "calibration=unavailable",
    candidate.runtime ? `runtime=${JSON.stringify(candidate.runtime)}` : "runtime=unknown"
  ].join("; ");
}

function summarizeCalibration(candidate: CapabilityProfile): Record<string, unknown> | undefined {
  return candidate.calibration
    ? {
        sample_count: candidate.calibration.sampleCount,
        task_success_rate: candidate.calibration.taskSuccessRate,
        correction_rate: candidate.calibration.correctionRate,
        cost_per_completed_task: candidate.calibration.costPerCompletedTask
      }
    : undefined;
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n[truncated]`;
}

function getChoice(answer: TypesafeAnswer | undefined): Extract<TypesafeAnswer, { type: "choice" }> {
  if (!answer || answer.type !== "choice") {
    throw new TypesafeApiError("TypeSafe response is missing a Choice answer", 502, answer);
  }
  return answer;
}

function getScore(answer: TypesafeAnswer | undefined): Extract<TypesafeAnswer, { type: "score" }> {
  if (!answer || answer.type !== "score") {
    throw new TypesafeApiError("TypeSafe response is missing a Score answer", 502, answer);
  }
  return answer;
}

function normalizeScore(score: number, legend: Record<string, string>): number {
  const maximum = Math.max(0, Object.keys(legend).length - 1);
  return maximum > 0 ? Math.max(0, Math.min(1, score / maximum)) : 0;
}

function validateResponse(value: unknown): TypesafeResponse {
  if (!value || typeof value !== "object") {
    throw new TypesafeApiError("TypeSafe returned a non-object response", 502, value);
  }
  const response = value as Partial<TypesafeResponse>;
  if (!response.answers || typeof response.answers !== "object") {
    throw new TypesafeApiError("TypeSafe response is missing answers", 502, value);
  }
  return response as TypesafeResponse;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
