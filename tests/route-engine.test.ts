import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RouteEngine } from "@jev-router/core";
import { StubDecisionProvider, judgment, profile } from "./fixtures.js";

describe("RouteEngine", () => {
  it("includes the provider id in every decision", async () => {
    const engine = new RouteEngine(new StubDecisionProvider(judgment("mid-model")));
    const decision = await engine.route({
      request: "x",
      candidates: [profile("mid-model", "medium", { providerId: "deepseek" })]
    });
    assert.equal(decision.providerId, "deepseek");
  });

  it("fails open when the decision provider exceeds the hard timeout", async () => {
    const hanging = {
      async decide(): Promise<never> {
        return new Promise<never>(() => undefined);
      }
    };
    const engine = new RouteEngine(hanging, "mid-model", 0.55, 50);
    const startedAt = performance.now();
    const decision = await engine.route({
      request: "x",
      candidates: [profile("mid-model", "medium"), profile("high-model", "high")]
    });
    const elapsed = performance.now() - startedAt;

    assert.equal(decision.modelId, "mid-model");
    assert.match(decision.fallback?.reason ?? "", /timed out after 50ms/);
    assert.ok(elapsed < 1_000, "decision must not block Codex, took " + elapsed + "ms");
  });

  it("honours an explicit model without consulting the decision provider", async () => {
    const provider = new StubDecisionProvider(judgment("high-model"));
    const engine = new RouteEngine(provider);

    const decision = await engine.route({
      request: "explain this function",
      candidates: [profile("low-model", "low"), profile("high-model", "high")],
      preferences: { explicitModelId: "low-model" }
    });

    assert.equal(decision.modelId, "low-model");
    assert.equal(decision.confidence, 1);
    assert.equal(provider.calls, 0);
  });

  it("rejects an explicit model that is not configured", async () => {
    const engine = new RouteEngine(new StubDecisionProvider());
    await assert.rejects(
      engine.route({
        request: "x",
        candidates: [profile("low-model", "low")],
        preferences: { explicitModelId: "missing-model" }
      }),
      /not available/
    );
  });

  it("uses the configured fallback model when the decision provider fails", async () => {
    const engine = new RouteEngine(new StubDecisionProvider(new Error("typesafe unreachable")), "mid-model");
    const decision = await engine.route({
      request: "x",
      candidates: [profile("mid-model", "medium"), profile("high-model", "high")]
    });

    assert.equal(decision.modelId, "mid-model");
    assert.match(decision.fallback?.reason ?? "", /typesafe unreachable/);
  });

  it("does not downgrade the current model on low confidence", async () => {
    const engine = new RouteEngine(new StubDecisionProvider(judgment("low-model", 0.2)));
    const decision = await engine.route({
      request: "x",
      candidates: [profile("low-model", "low"), profile("high-model", "high")],
      preferences: { currentModelId: "high-model" }
    });

    assert.equal(decision.modelId, "high-model");
    assert.match(decision.fallback?.reason ?? "", /Low confidence/);
  });

  it("excludes frontier models unless long-tier routing is enabled", async () => {
    const engine = new RouteEngine(new StubDecisionProvider(judgment("frontier-model")));
    const candidates = [profile("frontier-model", "frontier"), profile("mid-model", "medium")];

    const decision = await engine.route({ request: "x", candidates });
    assert.equal(decision.modelId, "mid-model");

    const allowed = await engine.route({
      request: "x",
      candidates,
      preferences: { longTierEnabled: true }
    });
    assert.equal(allowed.modelId, "frontier-model");
  });

  it("skips candidates whose runtime reports them unavailable", async () => {
    const engine = new RouteEngine(new StubDecisionProvider(judgment("mid-model")));
    const decision = await engine.route({
      request: "x",
      candidates: [
        profile("mid-model", "medium", { runtime: { available: false } }),
        profile("low-model", "low")
      ]
    });

    assert.equal(decision.modelId, "low-model");
  });

  it("excludes candidates smaller than the estimated input", async () => {
    const small = profile("small-model", "low");
    small.static.contextLimit = 100;
    const big = profile("big-model", "medium");
    big.static.contextLimit = 10_000;
    const engine = new RouteEngine(new StubDecisionProvider(judgment("small-model")));

    const decision = await engine.route({
      request: "x",
      candidates: [small, big],
      preferences: { estimatedInputTokens: 500 }
    });

    assert.equal(decision.modelId, "big-model");
    assert.match(decision.fallback?.reason ?? "", /no longer eligible/);
  });
});
