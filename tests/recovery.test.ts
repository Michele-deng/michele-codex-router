import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DecisionLogger } from "@jev-router/core";

const decision = {
  providerId: "deepseek",
  modelId: "m",
  tier: "low" as const,
  confidence: 1,
  probabilities: { m: 1 },
  factors: { taskType: "chat", complexity: 0, reasoningRequired: 0, toolComplexity: 0 },
  profileVersion: "t"
};

describe("log recovery", () => {
  it("explain degrades cleanly when latest.json is corrupted (REC-003)", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jev-recovery-"));
    try {
      writeFileSync(path.join(directory, "latest.json"), "{ broken", "utf8");
      const logger = new DecisionLogger(directory, false);
      assert.equal(await logger.latest(), undefined, "no throw, understandable empty state");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps appending when decisions.jsonl is corrupted (REC-002)", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jev-recovery-"));
    try {
      writeFileSync(path.join(directory, "decisions.jsonl"), "garbage-not-json\n", "utf8");
      const logger = new DecisionLogger(directory, false);
      await logger.append({ request: "x", decision, latencyMs: 1 });
      const latest = await logger.latest();
      assert.equal(latest?.decision.modelId, "m", "new records keep working");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
