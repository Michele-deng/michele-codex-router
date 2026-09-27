export type ModelTier = "low" | "medium" | "high" | "frontier";

export interface StaticCapability {
  tier: ModelTier;
  contextLimit: number;
  inputPrice?: number;
  outputPrice?: number;
  supportsTools: boolean;
  strengths: string[];
  constraints: string[];
}

export interface RuntimeCapability {
  available: boolean;
  latencyMs?: number;
  contextRemaining?: number;
  cacheState?: "hot" | "warming" | "cold" | "unknown";
  recentFailureRate?: number;
}

export interface CalibrationResult {
  taskSuccessRate?: number;
  correctionRate?: number;
  costPerCompletedTask?: number;
  sampleCount: number;
  evaluatedProfileVersion?: string;
}

export interface CapabilityProfile {
  /** Which execution provider serves this model, e.g. "openai" or "deepseek". */
  providerId?: string;
  modelId: string;
  profileVersion: string;
  updatedAt: string;
  static: StaticCapability;
  runtime?: RuntimeCapability;
  calibration?: CalibrationResult;
}

export interface RoutePreferences {
  maxCost?: number;
  preferLocal?: boolean;
  requiresTools?: boolean;
  minTier?: ModelTier;
  explicitModelId?: string;
  currentModelId?: string;
  estimatedInputTokens?: number;
  conversationItems?: number;
  toolCalls?: number;
  longTierEnabled?: boolean;
}

export interface RouteInput {
  request: string;
  contextSummary?: string;
  candidates: CapabilityProfile[];
  preferences?: RoutePreferences;
}

export interface RoutingFactors {
  taskType: string;
  complexity: number;
  reasoningRequired: number;
  toolComplexity: number;
}

export interface RouteDecision {
  providerId: string;
  modelId: string;
  tier: ModelTier;
  confidence: number;
  probabilities: Record<string, number>;
  factors: RoutingFactors;
  profileVersion: string;
  /** Lease id of the user turn this decision belongs to. */
  turnId?: string;
  /** Why the route changed: new_task, technical_failure, manual_override or fallback. */
  switchReason?: string;
  /** Who made the pick: the rules engine, Jev, or an explicit user choice. */
  decisionSource?: "rules" | "jev" | "manual";
  fallback?: {
    reason: string;
    originalModelId?: string;
  };
}

export interface RawRoutingJudgment {
  selectedModelId: string;
  confidence: number;
  probabilities: Record<string, number>;
  factors: RoutingFactors;
}

export interface TypedDecisionProvider {
  decide(input: RouteInput, candidates: CapabilityProfile[]): Promise<RawRoutingJudgment>;
}

export interface HostCapabilities {
  version: string;
  supportsCustomProvider: boolean;
  supportsManualModelSelection: boolean;
}

export interface HostAdapter {
  readonly id: string;
  detect(): Promise<HostCapabilities>;
  listModels(): Promise<CapabilityProfile[]>;
  applyDecision(decision: RouteDecision): Promise<void>;
  restoreOriginalState(): Promise<void>;
}
