import { applyRuntimeSnapshot, type CapabilityProfile, type RuntimeCapability } from "@jev-router/core";

export class OpenAiCompatibleRuntimeProbe {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async probe(profiles: CapabilityProfile[]): Promise<CapabilityProfile[]> {
    const startedAt = performance.now();
    try {
      const response = await this.fetchImpl(new URL("models", ensureTrailingSlash(this.baseUrl)), {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.timeout(1_500)
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      if (!response.ok) {
        return profiles.map((profile) => applyRuntimeSnapshot(profile, { available: false, latencyMs }));
      }
      const body = await response.json() as { data?: Array<{ id?: unknown }> };
      const available = new Set(
        (body.data ?? [])
          .map((model) => typeof model.id === "string" ? model.id : undefined)
          .filter((id): id is string => Boolean(id))
      );
      return profiles.map((profile) => {
        const runtime: RuntimeCapability = {
          available: available.size === 0 || available.has(profile.modelId),
          latencyMs,
          cacheState: "unknown"
        };
        return applyRuntimeSnapshot(profile, runtime);
      });
    } catch {
      return profiles.map((profile) =>
        applyRuntimeSnapshot(profile, { available: false, cacheState: "unknown" })
      );
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
