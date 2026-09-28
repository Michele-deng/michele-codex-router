import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  ModelHealthStore,
  classifyHttpFailure,
  classifyThrownFailure
} from "@jev-router/core";
import { profile } from "./fixtures.js";

describe("failure classification", () => {
  it("classifies the technical statuses from the first-version plan", () => {
    assert.equal(classifyHttpFailure(401).kind, "auth");
    assert.equal(classifyHttpFailure(402).kind, "quota");
    assert.equal(classifyHttpFailure(403).kind, "auth");
    assert.equal(classifyHttpFailure(404).kind, "not_found");
    assert.equal(classifyHttpFailure(429).kind, "rate_limit");
    assert.equal(classifyHttpFailure(529).kind, "unavailable");
    for (const status of [401, 402, 403, 404, 429, 529, 500, 400]) {
      assert.equal(classifyHttpFailure(status).retryable, true, "status " + status);
    }
  });

  it("detects model_not_found from the body regardless of status", () => {
    const failure = classifyHttpFailure(400, '{"error":{"message":"model_not_found: gpt-x"}}');
    assert.equal(failure.kind, "not_found");
    assert.equal(failure.retryable, true);
  });

  it("detects quota errors from the body", () => {
    const failure = classifyHttpFailure(403, "Insufficient balance");
    assert.equal(failure.kind, "quota");
  });

  it("keeps unrelated client errors non-retryable", () => {
    const failure = classifyHttpFailure(418, "teapot");
    assert.equal(failure.retryable, false);
  });

  it("classifies timeouts and network failures", () => {
    const timeout = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    assert.equal(classifyThrownFailure(timeout).kind, "timeout");
    assert.equal(classifyThrownFailure(new TypeError("fetch failed")).kind, "network");
    assert.equal(classifyThrownFailure(new Error("weird")).retryable, false);
  });
});

describe("ModelHealthStore", () => {
  it("cools a model down after a retryable failure and recovers on success", () => {
    const store = new ModelHealthStore();
    const model = profile("bad-model", "medium", { providerId: "deepseek" });
    const now = 1_000_000;

    store.recordFailure(model, classifyHttpFailure(429), now);
    assert.equal(store.isCoolingDown(model, now + 1_000), true);
    const record = store.get("deepseek", "bad-model");
    assert.equal(record?.lastStatusCode, 429);
    assert.equal(record?.failureKind, "rate_limit");
    assert.equal(record?.consecutiveFailures, 1);

    store.recordSuccess(model, now + 2_000);
    assert.equal(store.isCoolingDown(model, now + 3_000), false);
    assert.equal(store.get("deepseek", "bad-model")?.consecutiveFailures, 0);
  });

  it("grows the cooldown with consecutive failures", () => {
    const store = new ModelHealthStore();
    const model = profile("bad-model", "medium", { providerId: "openai" });
    const now = 5_000;
    store.recordFailure(model, classifyHttpFailure(429), now);
    const first = store.get("openai", "bad-model")?.cooldownUntil ?? 0;
    store.recordFailure(model, classifyHttpFailure(429), now);
    const second = store.get("openai", "bad-model")?.cooldownUntil ?? 0;
    assert.ok(second - now > first - now, "second cooldown should be longer");
  });

  it("uses the maximum cooldown for account-level rejections", () => {
    const store = new ModelHealthStore();
    const model = profile("unsupported-model", "medium");
    const now = 1_000;
    store.recordFailure(model, classifyHttpFailure(400, "model not supported"), now);
    const record = store.get("openai", "unsupported-model");
    assert.equal(record?.failureKind, "config");
    assert.equal(
      (record?.cooldownUntil ?? 0) - now,
      10 * 60 * 1_000,
      "unsupported models must not be retried every 30 seconds"
    );
  });

  it("permanently disables an account-level model after three strikes", () => {
    const store = new ModelHealthStore();
    const model = profile("bad-gpt", "high", { providerId: "openai" });
    const failure = classifyHttpFailure(400, "model not supported by account");
    store.recordFailure(model, failure, 1_000);
    store.recordFailure(model, failure, 2_000);
    store.recordFailure(model, failure, 3_000);

    const record = store.get("openai", "bad-gpt");
    assert.equal(record?.permanent, true, "three account-level strikes");
    assert.equal(store.isPermanentlyDisabled(model), true);
    assert.equal(
      store.isCoolingDown(model, 1_000 + 365 * 24 * 3600 * 1_000),
      true,
      "never auto-released by time alone"
    );
  });

  it("a success re-enables a permanently disabled model", () => {
    const store = new ModelHealthStore();
    const model = profile("bad-gpt", "high", { providerId: "openai" });
    const failure = classifyHttpFailure(400, "model not supported by account");
    for (let i = 0; i < 3; i += 1) store.recordFailure(model, failure, 1_000 + i);
    assert.equal(store.isPermanentlyDisabled(model), true);

    store.recordSuccess(model, 5_000);
    assert.equal(store.isPermanentlyDisabled(model), false);
    assert.equal(store.isCoolingDown(model, 6_000), false);
  });

  it("reset removes one model or everything and persists", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jev-health-reset-"));
    try {
      const failure = classifyHttpFailure(400, "model not supported");
      const modelA = profile("model-a", "medium");
      const modelB = profile("model-b", "medium");
      const store = new ModelHealthStore(directory);
      for (let i = 0; i < 3; i += 1) store.recordFailure(modelA, failure, 1_000 + i);
      for (let i = 0; i < 3; i += 1) store.recordFailure(modelB, failure, 2_000 + i);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const restored = new ModelHealthStore(directory);
      await restored.load();
      assert.equal(restored.isPermanentlyDisabled(modelA), true);
      assert.equal(restored.isPermanentlyDisabled(modelB), true);

      assert.equal(restored.reset("model-a"), 1);
      assert.equal(restored.isPermanentlyDisabled(modelA), false);
      assert.equal(restored.isPermanentlyDisabled(modelB), true);
      assert.equal(restored.reset(), 1);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const third = new ModelHealthStore(directory);
      await third.load();
      assert.equal(third.snapshot().length, 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never counts request-content errors as model faults", () => {
    const store = new ModelHealthStore();
    const model = profile("content-error-model", "medium");
    const failure = classifyHttpFailure(400, "context length exceeded");
    assert.equal(failure.kind, "request_invalid");
    for (let i = 0; i < 10; i += 1) store.recordFailure(model, failure, 1_000 + i);
    assert.equal(store.isPermanentlyDisabled(model), false);
    assert.equal(store.isCoolingDown(model, 10_000), false);
    assert.equal(store.get("openai", "content-error-model"), undefined);
  });

  it("hot reloads health state written by other processes", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jev-health-hot-"));
    try {
      const service = new ModelHealthStore(directory);
      const model = profile("hot-model", "medium");
      const failure = classifyHttpFailure(400, "model not supported");
      for (let i = 0; i < 3; i += 1) service.recordFailure(model, failure, 1_000 + i);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await service.syncFromDisk();
      assert.equal(service.isPermanentlyDisabled(model), true);

      const cli = new ModelHealthStore(directory);
      await cli.load();
      assert.equal(cli.reset(), 1);
      await new Promise((resolve) => setTimeout(resolve, 30));

      await service.syncFromDisk();
      assert.equal(service.isPermanentlyDisabled(model), false, "reset applies to the running service");
      assert.equal(service.isCoolingDown(model), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a cooled model to the pool after the cooldown expires (FAIL-015)", () => {
    const store = new ModelHealthStore();
    const model = profile("retry-model", "medium");
    store.recordFailure(model, classifyHttpFailure(429), 1_000);
    assert.equal(store.isCoolingDown(model, 1_001), true);
    assert.equal(
      store.isCoolingDown(model, 1_000 + 30_001),
      false,
      "base cooldown expires without a restart"
    );
    assert.equal(store.isPermanentlyDisabled(model), false);
  });

  it("re-initializes when model-health.json is corrupted (REC-001)", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jev-health-corrupt-"));
    try {
      writeFileSync(path.join(directory, "model-health.json"), "{ not json", "utf8");
      const store = new ModelHealthStore(directory);
      await store.load();
      assert.equal(store.snapshot().length, 0, "corrupt state starts fresh");
      const model = profile("after-corruption", "medium");
      store.recordFailure(model, classifyHttpFailure(429), 1_000);
      assert.equal(store.isCoolingDown(model, 1_001), true, "tracking still works");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists and reloads health state", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "jev-health-"));
    try {
      const store = new ModelHealthStore(directory);
      store.recordFailure(profile("m", "low"), classifyHttpFailure(500), 7_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const raw = readFileSync(path.join(directory, "model-health.json"), "utf8");
      assert.equal(raw.includes("server_error"), true);

      const restored = new ModelHealthStore(directory);
      await restored.load();
      assert.equal(restored.get("openai", "m")?.failureKind, "server_error");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
