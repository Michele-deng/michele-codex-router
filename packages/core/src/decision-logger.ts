import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RouteDecision } from "./types.js";

export interface DecisionRecord {
  decisionId: string;
  timestamp: string;
  taskHash: string;
  excerpt?: string;
  decision: RouteDecision;
  latencyMs: number;
  turnId?: string;
  switchReason?: string;
  attemptChain?: AttemptRecord[];
  failureReason?: string;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
}

export interface AttemptRecord {
  providerId: string;
  modelId: string;
  ok: boolean;
  status?: number;
  failureKind?: string;
  detail?: string;
}

export class DecisionLogger {
  constructor(
    private readonly directory: string,
    private readonly includeExcerpt = process.env.JEV_LOG_EXCERPT === "1",
    private readonly redact?: (text: string) => string
  ) {}

  async append(record: Omit<DecisionRecord, "decisionId" | "timestamp" | "taskHash" | "excerpt"> & {
    request: string;
  }): Promise<DecisionRecord> {
    await mkdir(this.directory, { recursive: true });
    const now = new Date();
    const taskHash = createHash("sha256").update(record.request).digest("hex");
    const clean: DecisionRecord = {
      decisionId: createHash("sha256")
        .update(`${now.toISOString()}:${taskHash}:${record.decision.modelId}`)
        .digest("hex")
        .slice(0, 20),
      timestamp: now.toISOString(),
      taskHash,
      ...(this.includeExcerpt ? { excerpt: this.safeExcerpt(record.request) } : {}),
      decision: record.decision,
      latencyMs: record.latencyMs,
      ...(record.turnId !== undefined ? { turnId: record.turnId } : {}),
      ...(record.switchReason !== undefined ? { switchReason: record.switchReason } : {}),
      ...(record.attemptChain !== undefined ? { attemptChain: record.attemptChain } : {}),
      ...(record.failureReason !== undefined ? { failureReason: record.failureReason } : {}),
      ...(record.ttftMs !== undefined ? { ttftMs: record.ttftMs } : {}),
      ...(record.inputTokens !== undefined ? { inputTokens: record.inputTokens } : {}),
      ...(record.outputTokens !== undefined ? { outputTokens: record.outputTokens } : {}),
      ...(record.estimatedCost !== undefined ? { estimatedCost: record.estimatedCost } : {})
    };
    await appendFile(this.logPath, `${JSON.stringify(clean)}\n`, { encoding: "utf8", mode: 0o600 });
    await this.writeLatest(clean);
    return clean;
  }

  private safeExcerpt(request: string): string {
    const bounded = request.slice(0, 120).replace(/\s+/g, " ");
    const patternRedacted = bounded.replace(
      /\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,})/g,
      "***"
    );
    return this.redact ? this.redact(patternRedacted) : patternRedacted;
  }

  async latest(): Promise<DecisionRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.latestPath, "utf8")) as DecisionRecord;
    } catch {
      return undefined;
    }
  }

  private async writeLatest(record: DecisionRecord): Promise<void> {
    await writeFile(this.latestPath, JSON.stringify(record, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }

  private get logPath(): string {
    return path.join(this.directory, "decisions.jsonl");
  }

  private get latestPath(): string {
    return path.join(this.directory, "latest.json");
  }
}
