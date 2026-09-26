import { RouteError } from "./errors.js";
import type { CapabilityProfile, RawRoutingJudgment, RouteInput, TypedDecisionProvider } from "./types.js";

/**
 * Rule-based decision mode. It never contacts a decision service: the route
 * engine catches the marker error and falls back to its own deterministic
 * selection, so routing still works with no key and no network.
 */
export class StaticDecisionProvider implements TypedDecisionProvider {
  async decide(_input: RouteInput, _candidates: CapabilityProfile[]): Promise<RawRoutingJudgment> {
    throw new RouteError("Static decision mode: rule-based selection", "STATIC_DECISION_MODE");
  }
}
