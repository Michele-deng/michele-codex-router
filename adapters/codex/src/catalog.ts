import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const SENTINEL_MODEL_ID = "jev/auto";
export const SENTINEL_DISPLAY_NAME = "Jev Auto（自动路由）";

export interface MergeCatalogResult {
  outputPath: string;
  entryCount: number;
  sentinelFrom: string;
}

/**
 * Merges a Jev Auto entry into the catalog Codex reads for its model picker.
 * The source catalog (written by opencodex) stays untouched; our merged copy
 * is regenerated on every service start so upstream additions self-heal.
 */
export async function mergeModelCatalog(
  sourcePath: string,
  outputPath: string
): Promise<MergeCatalogResult> {
  const parsed = JSON.parse(await readFile(sourcePath, "utf8")) as Record<string, unknown>;
  const sourceEntries = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.models)
      ? parsed.models as Array<Record<string, unknown>>
      : undefined;
  if (!sourceEntries || sourceEntries.length === 0) {
    throw new Error("Model catalog source has no entries: " + sourcePath);
  }

  const sentinel = buildSentinelEntry(sourceEntries);
  const sentinelFrom = String(pickTemplate(sourceEntries)?.slug ?? "unknown");
  const merged = sourceEntries.filter((entry) => entry.slug !== SENTINEL_MODEL_ID);
  merged.push(sentinel);

  const output = Array.isArray(parsed) ? merged : { ...parsed, models: merged };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(output), "utf8");
  return {
    outputPath,
    entryCount: merged.length,
    sentinelFrom
  };
}

export async function catalogHasSentinel(catalogPath: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(catalogPath, "utf8")) as Record<string, unknown>;
    const entries = Array.isArray(parsed) ? parsed : (parsed.models as Array<Record<string, unknown>> | undefined);
    return Array.isArray(entries) && entries.some((entry) => entry.slug === SENTINEL_MODEL_ID);
  } catch {
    return false;
  }
}

function buildSentinelEntry(entries: Array<Record<string, unknown>>): Record<string, unknown> {
  const template = pickTemplate(entries);
  if (!template) throw new Error("No template entry available for the Jev Auto model");

  const clone: Record<string, unknown> = { ...template };
  delete clone.opencodex_capability_provenance;

  const levels = Array.isArray(template.supported_reasoning_levels)
    ? (template.supported_reasoning_levels as Array<{ effort?: unknown }>)
        .filter((level) => level && ["low", "high"].includes(String(level.effort)))
    : [];

  const sentinel: Record<string, unknown> = {
    ...clone,
    slug: SENTINEL_MODEL_ID,
    display_name: SENTINEL_DISPLAY_NAME,
    description: "Jev-Router：每轮自动选择最合适的模型；选择具体模型即暂停路由。",
    default_reasoning_level: "low",
    supported_reasoning_levels: levels.length > 0 ? levels : template.supported_reasoning_levels,
    context_window: typeof template.context_window === "number" ? template.context_window : 272_000,
    max_context_window:
      typeof template.max_context_window === "number" ? template.max_context_window : 272_000,
    auto_compact_token_limit:
      typeof template.auto_compact_token_limit === "number"
        ? template.auto_compact_token_limit
        : 258_400,
    supported_in_api: true,
    visibility: "list"
  };
  return sentinel;
}

function pickTemplate(entries: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  return entries.find((entry) => entry.slug === "deepseek/deepseek-flash") ?? entries[0];
}
