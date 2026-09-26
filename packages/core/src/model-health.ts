import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CapabilityProfile } from "./types.js";

export type FailureKind =
  | "auth"
  | "quota"
  | "not_found"
  | "rate_limit"
  | "unavailable"
  | "server_error"
  | "timeout"
  | "network"
  | "config"
  | "unknown";

export interface ExecutionFailure {
  kind: FailureKind;
  retryable: boolean;
  status?: number;
  message: string;
}

export interface ModelHealthRecord {
  providerId: string;
  modelId: string;
  available: boolean;
  failureReason?: string;
  failureKind?: FailureKind;
  lastStatusCode?: number;
  consecutiveFailures: number;
  cooldownUntil?: number;
  /** Account-level rejection repeated 3x without a success: never auto-released. */
  permanent?: boolean;
  lastCheckedAt: string;
}

const BASE_COOLDOWN_MS = 30_000;
const MAX_COOLDOWN_MS = 10 * 60_000;

/**
 * Classifies an upstream failure so the proxy knows whether switching models
 * can plausibly help. Retryable categories match the first-version plan:
 * 401/402/403/404/429/529, model_not_found, quota, timeout, network and
 * configuration errors.
 */
export function classifyHttpFailure(status: number, bodyText = ""): ExecutionFailure {
  const body = bodyText.slice(0, 2_000);
  const lower = body.toLowerCase();
  const message = extractErrorMessage(body) ?? "Upstream returned HTTP " + status;

  if (/model[_ ]?not[_ ]?found|unknown model|model .* does not exist|no such model/.test(lower)) {
    return { kind: "not_found", retryable: true, status, message };
  }
  if (
    /insufficient|quota|balance|billing|payment required|credit/.test(lower) &&
    (status === 402 || status === 400 || status === 403)
  ) {
    return { kind: "quota", retryable: true, status, message };
  }
  if (status === 401 || status === 403) {
    return { kind: "auth", retryable: true, status, message };
  }
  if (status === 402) {
    return { kind: "quota", retryable: true, status, message };
  }
  if (status === 404) {
    return { kind: "not_found", retryable: true, status, message };
  }
  if (status === 429) {
    return { kind: "rate_limit", retryable: true, status, message };
  }
  if (status === 529) {
    return { kind: "unavailable", retryable: true, status, message };
  }
  if (status === 408 || status >= 500) {
    return { kind: "server_error", retryable: true, status, message };
  }
  if (status === 400 || status === 422) {
    if (/api[_ ]?key|unauthorized|authentication|permission|forbidden/.test(lower)) {
      return { kind: "auth", retryable: true, status, message };
    }
    return { kind: "config", retryable: true, status, message };
  }
  return { kind: "unknown", retryable: false, status, message };
}

export function classifyThrownFailure(error: unknown): ExecutionFailure {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "";
  const lower = message.toLowerCase();
  if (name === "TimeoutError" || name === "AbortError" || /timed? ?out|timeout|abort/.test(lower)) {
    return { kind: "timeout", retryable: true, message };
  }
  if (/fetch failed|econnrefused|econnreset|enotfound|epipe|socket|network|eai_again|und_err/.test(lower)) {
    return { kind: "network", retryable: true, message };
  }
  return { kind: "unknown", retryable: false, message };
}

function extractErrorMessage(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === "string" && message.trim()) return message.slice(0, 400);
  } catch {
    // Body may be HTML or plain text; fall through.
  }
  const plain = bodyText.replace(/\s+/g, " ").trim();
  return plain ? plain.slice(0, 400) : undefined;
}

/**
 * Tracks technical availability per model. Cooldowns grow exponentially with
 * consecutive failures and reset after one success. When a directory is
 * supplied the state survives process restarts.
 */
export class ModelHealthStore {
  private readonly records = new Map<string, ModelHealthRecord>();

  constructor(private readonly directory?: string) {}

  static key(providerId: string, modelId: string): string {
    return providerId + "\\" + modelId;
  }

  async load(): Promise<void> {
    if (!this.directory) return;
    try {
      const raw = await readFile(this.healthPath, "utf8");
      const parsed = JSON.parse(raw) as ModelHealthRecord[];
      for (const record of parsed) {
        if (record && typeof record.providerId === "string" && typeof record.modelId === "string") {
          this.records.set(ModelHealthStore.key(record.providerId, record.modelId), record);
        }
      }
    } catch {
      // Missing or corrupt state simply starts fresh.
    }
  }

  recordFailure(profile: CapabilityProfile, failure: ExecutionFailure, now = Date.now()): ModelHealthRecord {
    const providerId = profile.providerId ?? "openai";
    const key = ModelHealthStore.key(providerId, profile.modelId);
    const previous = this.records.get(key);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    // "config"/"not_found" means the account or channel cannot serve this
    // model at all; retrying every 30s only wastes attempts, so start at the
    // maximum cooldown. Transient failures keep the exponential schedule.
    const baseMs =
      failure.kind === "config" || failure.kind === "not_found"
        ? MAX_COOLDOWN_MS
        : BASE_COOLDOWN_MS;
    const cooldownMs = Math.min(baseMs * 2 ** (consecutiveFailures - 1), MAX_COOLDOWN_MS);
    const permanent = previous?.permanent === true ||
      ((failure.kind === "config" || failure.kind === "not_found") && consecutiveFailures >= 3);
    const record: ModelHealthRecord = {
      providerId,
      modelId: profile.modelId,
      available: false,
      failureReason: failure.message,
      failureKind: failure.kind,
      ...(failure.status !== undefined ? { lastStatusCode: failure.status } : {}),
      consecutiveFailures,
      cooldownUntil: failure.retryable ? now + cooldownMs : now,
      ...(permanent ? { permanent: true } : {}),
      lastCheckedAt: new Date(now).toISOString()
    };
    this.records.set(key, record);
    void this.persist();
    return record;
  }

  recordSuccess(profile: CapabilityProfile, now = Date.now()): ModelHealthRecord {
    const providerId = profile.providerId ?? "openai";
    const key = ModelHealthStore.key(providerId, profile.modelId);
    const record: ModelHealthRecord = {
      providerId,
      modelId: profile.modelId,
      available: true,
      consecutiveFailures: 0,
      lastCheckedAt: new Date(now).toISOString()
    };
    this.records.set(key, record);
    void this.persist();
    return record;
  }

  isCoolingDown(profile: CapabilityProfile, now = Date.now()): boolean {
    const record = this.records.get(ModelHealthStore.key(profile.providerId ?? "openai", profile.modelId));
    if (!record || record.available) return false;
    if (record.permanent) return true;
    if (record.cooldownUntil === undefined) return true;
    return record.cooldownUntil > now;
  }

  isPermanentlyDisabled(profile: CapabilityProfile): boolean {
    return this.records.get(ModelHealthStore.key(profile.providerId ?? "openai", profile.modelId))
      ?.permanent === true;
  }

  /** Removes one model's record (or all records) and persists the result. */
  reset(modelId?: string): number {
    let removed = 0;
    for (const [key, record] of this.records) {
      if (modelId === undefined || record.modelId === modelId) {
        this.records.delete(key);
        removed += 1;
      }
    }
    void this.persist();
    return removed;
  }

  get(providerId: string, modelId: string): ModelHealthRecord | undefined {
    return this.records.get(ModelHealthStore.key(providerId, modelId));
  }

  snapshot(): ModelHealthRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  private async persist(): Promise<void> {
    if (!this.directory) return;
    try {
      await mkdir(this.directory, { recursive: true });
      await writeFile(this.healthPath, JSON.stringify(this.snapshot(), null, 2), {
        encoding: "utf8",
        mode: 0o600
      });
    } catch {
      // Health persistence is best effort; routing must not fail because of it.
    }
  }

  private get healthPath(): string {
    return path.join(this.directory as string, "model-health.json");
  }
}
