import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityProfile, ModelTier } from "@jev-router/core";
import { validateProfile } from "@jev-router/core";
import { DESKTOP_MANAGED_MARKER } from "./desktop.js";

export interface ProviderWiring {
  kind: "provider-block" | "openai-base-url" | "deepseek-env" | "vanilla-openai";
  source: string;
  providerName?: string;
  baseUrl: string;
  modelsUrl: string;
  wireApi: "responses" | "chat";
  bearerToken?: string;
  requiresOpenaiAuth?: boolean;
}

/**
 * Finds the upstream the user's Codex was already wired to BEFORE our
 * injection: their custom provider block first, then the opencodex-style root
 * openai_base_url, then DeepSeek env config, and only as a documented last
 * resort the vanilla OpenAI endpoint for ChatGPT-login users.
 */
export async function discoverProviderWiring(options: {
  configPath: string;
  env?: { DEEPSEEK_BASE_URL?: string; DEEPSEEK_API_KEY?: string; DEEPSEEK_WIRE_API?: string };
}): Promise<ProviderWiring> {
  let lines: string[] = [];
  try {
    lines = (await readFile(options.configPath, "utf8")).split(/\r?\n/);
  } catch {
    lines = [];
  }

  const providerName = await resolveOriginalProviderName(lines);
  if (providerName) {
    const section = readTomlSection(lines, "[model_providers." + providerName + "]");
    if (section && !section.__managed) {
      const rawBase = section.base_url;
      if (rawBase) {
        return {
          kind: "provider-block",
          source: "config.toml [model_providers." + providerName + "]",
          providerName,
          baseUrl: normalizeBase(rawBase),
          modelsUrl: modelsUrlFrom(rawBase),
          wireApi: section.wire_api === "chat" ? "chat" : "responses",
          ...(section.experimental_bearer_token
            ? { bearerToken: section.experimental_bearer_token }
            : {}),
          ...(section.requires_openai_auth !== undefined
            ? { requiresOpenaiAuth: section.requires_openai_auth === "true" }
            : {})
        };
      }
    }
  }

  const rootBase = rootValue(lines, "openai_base_url");
  if (rootBase) {
    return {
      kind: "openai-base-url",
      source: "config.toml openai_base_url",
      baseUrl: normalizeBase(rootBase),
      modelsUrl: modelsUrlFrom(rootBase),
      wireApi: "responses",
      requiresOpenaiAuth: false
    };
  }

  const env = options.env ?? {};
  if (env.DEEPSEEK_BASE_URL) {
    return {
      kind: "deepseek-env",
      source: ".env DEEPSEEK_BASE_URL",
      baseUrl: normalizeBase(env.DEEPSEEK_BASE_URL),
      modelsUrl: modelsUrlFrom(env.DEEPSEEK_BASE_URL),
      wireApi: env.DEEPSEEK_WIRE_API === "chat" ? "chat" : "responses",
      ...(env.DEEPSEEK_API_KEY ? { bearerToken: env.DEEPSEEK_API_KEY } : {})
    };
  }

  return {
    kind: "vanilla-openai",
    source: "default (no custom wiring found in config.toml/.env)",
    baseUrl: "https://api.openai.com/v1",
    modelsUrl: "https://api.openai.com/v1/models",
    wireApi: "responses",
    requiresOpenaiAuth: true
  };
}

async function resolveOriginalProviderName(lines: string[]): Promise<string | undefined> {
  const line = findRootLine(lines, "model_provider");
  if (!line) return undefined;
  const value = valueOfStringLine(line);
  if (!value) return undefined;
  // After our injection the managed line points at jev_router; the pre-Jev
  // provider name is recorded in the integration record's original value.
  if (line.includes(DESKTOP_MANAGED_MARKER)) {
    try {
      const recordPath = path.join(
        process.env.JEV_DATA_DIR ?? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".jev-router"),
        "desktop-integration.json"
      );
      const record = JSON.parse(await readFile(recordPath, "utf8")) as {
        originalValues?: Record<string, string | null>;
      };
      return record.originalValues?.model_provider ?? undefined;
    } catch {
      return undefined;
    }
  }
  return value;
}

function findRootLine(lines: string[], key: string): string | undefined {
  const rootEnd = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = rootEnd >= 0 ? rootEnd : lines.length;
  const pattern = new RegExp("^\\s*" + key + "\\s*=");
  for (let index = 0; index < limit; index += 1) {
    const line = lines[index] as string;
    if (pattern.test(line)) return line;
  }
  return undefined;
}

function rootValue(lines: string[], key: string): string | undefined {
  const line = findRootLine(lines, key);
  return line ? valueOfStringLine(line) : undefined;
}

function valueOfStringLine(line: string): string | undefined {
  const match = line.match(/^\s*[^=]+=\s*"(.*)"\s*(#.*)?$/);
  return match ? match[1] : undefined;
}

function readTomlSection(
  lines: string[],
  header: string
): Record<string, string> | undefined {
  const index = lines.findIndex((line) => line.trim() === header);
  if (index < 0) return undefined;
  let end = index + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] as string)) end += 1;
  const span = lines.slice(index, end);
  const result: Record<string, string> = {};
  if (span.some((line) => line.includes(DESKTOP_MANAGED_MARKER))) {
    result.__managed = "true";
    return result;
  }
  for (const line of span) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*(#.*)?$/);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] as string).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
}

function normalizeBase(url: string): string {
  let base = url.trim().replace(/\/+$/, "");
  if (base.endsWith("/responses")) base = base.slice(0, -"/responses".length);
  if (base.endsWith("/chat/completions")) base = base.slice(0, -"/chat/completions".length);
  return base;
}

function modelsUrlFrom(url: string): string {
  const base = normalizeBase(url);
  return base.endsWith("/v1") ? base + "/models" : base + "/v1/models";
}

export function tierFromModelName(modelId: string): ModelTier {
  const id = modelId.toLowerCase();
  if (/pro|high|max|ultra/.test(id)) return "high";
  if (/flash|mini|nano/.test(id)) return "low";
  return "medium";
}

export interface FetchedModels {
  ids: string[];
  contextLengths: Map<string, number>;
}

export async function fetchModelIds(
  wiring: ProviderWiring,
  fetchImpl: typeof fetch = fetch
): Promise<FetchedModels> {
  const headers = new Headers({ accept: "application/json" });
  if (wiring.bearerToken) headers.set("authorization", "Bearer " + wiring.bearerToken);
  const response = await fetchImpl(wiring.modelsUrl, {
    headers,
    signal: AbortSignal.timeout(8_000)
  });
  if (!response.ok) {
    throw new Error("model list request failed with HTTP " + response.status + " at " + wiring.modelsUrl);
  }
  const body = await response.json() as {
    data?: Array<{
      id?: unknown;
      context_length?: unknown;
      capabilities?: { context_length?: unknown };
    }>;
    models?: Array<{ name?: unknown; context_length?: unknown }>;
  };
  const entries = [...(body.data ?? []), ...(body.models ?? [])] as Array<Record<string, any>>;
  const ids: string[] = [];
  const contextLengths = new Map<string, number>();
  for (const entry of entries) {
    const id = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : undefined;
    if (!id) continue;
    ids.push(id);
    const context =
      typeof entry.capabilities?.context_length === "number"
        ? entry.capabilities.context_length
        : typeof entry.context_length === "number"
          ? entry.context_length
          : undefined;
    if (context !== undefined && Number.isFinite(context) && context > 0) {
      contextLengths.set(id, context);
    }
  }
  return { ids, contextLengths };
}

/** Generates one profile per detected model. Values are conservative and
 *  editable: tier comes from the name, context defaults to 128k. */
export function profilesFromModelIds(
  fetched: FetchedModels,
  providerId = "passthrough"
): CapabilityProfile[] {
  const profileVersion = "auto-" + new Date().toISOString().slice(0, 10);
  return fetched.ids.map((modelId) =>
    validateProfile({
      providerId,
      modelId,
      profileVersion,
      updatedAt: new Date().toISOString(),
      static: {
        tier: tierFromModelName(modelId),
        contextLimit: fetched.contextLengths.get(modelId) ?? 128_000,
        supportsTools: true,
        strengths: ["auto-detected from the upstream model list"],
        constraints: ["auto-generated; edit this profile to calibrate tier/context limits"]
      }
    })
  );
}
