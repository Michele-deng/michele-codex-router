import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  describeConfig,
  loadEnvFile,
  loadJevConfig,
  parseBoolean,
  parseInteger,
  redactDeep,
  redactText
} from "@jev-router/config";
import { DecisionLogger } from "@jev-router/core";

const missingEnvFile = (): string => path.join(os.tmpdir(), "jev-router-no-such-file", ".env");

describe("loadEnvFile", () => {
  it("keeps real environment variables ahead of the dotenv file", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jev-router-env-"));
    const envFile = path.join(directory, ".env");
    writeFileSync(envFile, "JEV_TEST_ALPHA=from-file\nJEV_TEST_BETA=from-file\n", "utf8");
    process.env.JEV_TEST_ALPHA = "from-real-env";
    delete process.env.JEV_TEST_BETA;

    try {
      const result = loadEnvFile(envFile);
      assert.equal(process.env.JEV_TEST_ALPHA, "from-real-env");
      assert.equal(process.env.JEV_TEST_BETA, "from-file");
      assert.deepEqual(result.keysApplied, ["JEV_TEST_BETA"]);
      assert.deepEqual(result.keysAlreadySet, ["JEV_TEST_ALPHA"]);
    } finally {
      delete process.env.JEV_TEST_ALPHA;
      delete process.env.JEV_TEST_BETA;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports a missing environment file instead of failing", () => {
    const result = loadEnvFile(missingEnvFile());
    assert.equal(result.found, false);
    assert.deepEqual(result.keysApplied, []);
    assert.deepEqual(result.keysAlreadySet, []);
  });
});

describe("loadJevConfig", () => {
  it("derives typed settings from environment values", () => {
    const config = loadJevConfig({
      projectRoot: os.tmpdir(),
      envFile: missingEnvFile(),
      env: {
        JEV_ROUTE_TIMEOUT_MS: "1500",
        JEV_ALLOW_LONG: "true",
        JEV_FALLBACK_MODEL: "deepseek/deepseek-flash",
        JEV_DECISION_PROVIDER: "static",
        TYPESAFE_API_KEY: "sk-test-0123456789"
      }
    });

    assert.equal(config.routeTimeoutMs, 1500);
    assert.equal(config.allowLongTier, true);
    assert.equal(config.decisionProvider, "static");
    assert.equal(config.typesafe.configured, true);
    assert.equal(config.fallback.modelId, "deepseek/deepseek-flash");
    assert.equal(config.readSecret("typesafeApiKey"), "sk-test-0123456789");
  });

  it("falls back to defaults when nothing is configured", () => {
    const config = loadJevConfig({ projectRoot: os.tmpdir(), envFile: missingEnvFile(), env: {} });
    assert.equal(config.routeTimeoutMs, 800);
    assert.equal(config.allowLongTier, false);
    assert.equal(config.decisionProvider, "typesafe");
    assert.equal(config.typesafe.configured, false);
    assert.equal(config.fallback.modelId, undefined);
    assert.equal(config.codex.upstreamUrl, undefined, "upstream comes from detected user wiring");
  });

  it("never exposes secrets in the safe view or when serialized", () => {
    const typesafeKey = "sk-live-abcdefghijklmnop1234567890";
    const deepseekKey = "ds-live-abcdefghijklmnop1234567890";
    const config = loadJevConfig({
      projectRoot: os.tmpdir(),
      envFile: missingEnvFile(),
      env: { TYPESAFE_API_KEY: typesafeKey, DEEPSEEK_API_KEY: deepseekKey }
    });

    assert.equal(config.typesafe.configured, true);
    const safe = JSON.stringify(describeConfig(config));
    assert.equal(safe.includes(typesafeKey), false);
    assert.equal(safe.includes(deepseekKey), false);
    assert.equal(JSON.stringify(config).includes(typesafeKey), false);
    assert.equal(JSON.stringify(config).includes(deepseekKey), false);
  });
});

describe("redaction", () => {
  it("removes secret values from text and nested objects", () => {
    const secret = "sk-abcdefghijklmnop1234567890";
    const text = redactText(`authorization=Bearer ${secret}`, [secret]);
    assert.equal(text.includes(secret), false);
    assert.ok(text.includes("***"));

    const nested = redactDeep({ headers: { authorization: secret }, note: secret }, [secret]);
    assert.equal(JSON.stringify(nested).includes(secret), false);
  });

  it("redacts values of secret-shaped keys even without a known value list", () => {
    const nested = redactDeep({ DEEPSEEK_API_KEY: "some-new-secret-value" }, []) as Record<string, unknown>;
    assert.equal(nested.DEEPSEEK_API_KEY, "***");
  });
});

describe("parsing", () => {
  it("parses booleans explicitly", () => {
    assert.equal(parseBoolean("1"), true);
    assert.equal(parseBoolean("TRUE"), true);
    assert.equal(parseBoolean("off"), false);
    assert.equal(parseBoolean("maybe", true), true);
    assert.equal(parseBoolean(undefined), false);
  });

  it("only accepts integers inside the allowed range", () => {
    assert.equal(parseInteger("2400", 800), 2400);
    assert.equal(parseInteger("nope", 800), 800);
    assert.equal(parseInteger("5", 800, { min: 50 }), 800);
    assert.equal(parseInteger("90000", 800, { max: 60_000 }), 800);
    assert.equal(parseInteger(undefined, 800), 800);
  });
});

describe("corrupted and bounded outputs", () => {
  it("survives a corrupted .env without touching the file (CFG-003)", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jev-broken-env-"));
    try {
      const envFile = path.join(directory, ".env");
      const garbage = Buffer.from([0x00, 0xff, 0x4b, 0x45, 0x59, 0x3d, 0x00, 0x41]);
      writeFileSync(envFile, garbage);

      const config = loadJevConfig({ projectRoot: directory, envFile });
      assert.equal(config.envFileFound, true);
      assert.deepEqual(readFileSync(envFile), garbage, "the file must not be rewritten");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds and redacts excerpts when enabled (SEC-009)", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jev-excerpt-"));
    try {
      const decision = {
        providerId: "deepseek",
        modelId: "m",
        tier: "low" as const,
        confidence: 1,
        probabilities: { m: 1 },
        factors: { taskType: "chat", complexity: 0, reasoningRequired: 0, toolComplexity: 0 },
        profileVersion: "t"
      };
      const canary = "JEV-CANARY-20260928-LOCAL-ONLY";
      const logger = new DecisionLogger(directory, true, (text) => text.split(canary).join("***"));
      await logger.append({ request: canary + " " + "x".repeat(500), decision, latencyMs: 1 });
      const record = await logger.latest();
      assert.ok((record?.excerpt?.length ?? 0) <= 120, "excerpt is bounded");
      assert.equal(record?.excerpt?.includes(canary), false, "redactor strips the canary");

      const plain = new DecisionLogger(directory, true);
      await plain.append({ request: "leak sk-abcdefghijklmnop123456 tail", decision, latencyMs: 1 });
      const second = await plain.latest();
      assert.equal(
        second?.excerpt?.includes("sk-abcdefghijklmnop123456"),
        false,
        "built-in pattern redaction"
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
