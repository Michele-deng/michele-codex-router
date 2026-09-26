import { applyRuntimeSnapshot, type CapabilityProfile } from "@jev-router/core";

export type LocalProviderKind = "ollama" | "lmstudio";

export class LocalRuntimeProbe {
  constructor(
    private readonly kind: LocalProviderKind,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async probe(profiles: CapabilityProfile[]): Promise<CapabilityProfile[]> {
    const startedAt = performance.now();
    try {
      const url = new URL(this.kind === "ollama" ? "api/tags" : "v1/models", ensureTrailingSlash(this.baseUrl));
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(1_500) });
      const latencyMs = Math.round(performance.now() - startedAt);
      if (!response.ok) throw new Error(`Local provider returned ${response.status}`);
      const body = await response.json() as {
        models?: Array<{ name?: unknown; id?: unknown }>;
        data?: Array<{ id?: unknown }>;
      };
      const entries = [...(body.models ?? []), ...(body.data ?? [])] as Array<{ name?: unknown; id?: unknown }>;
      const ids = new Set(
        entries
          .map((model) => model.name ?? model.id)
          .filter((id): id is string => typeof id === "string")
      );
      return profiles.map((profile) =>
        applyRuntimeSnapshot(profile, {
          available: ids.size === 0 || ids.has(profile.modelId),
          latencyMs,
          cacheState: "unknown"
        })
      );
    } catch {
      return profiles.map((profile) => applyRuntimeSnapshot(profile, { available: false }));
    }
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
