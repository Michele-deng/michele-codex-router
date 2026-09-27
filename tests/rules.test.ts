import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tierFromModelName } from "@jev-router/adapter-codex";
import { decideWithRules, scoreRuleRequest } from "@jev-router/core";
import { profile } from "./fixtures.js";

describe("rule scoring", () => {
  it("scores every signal on the shared 0-4 scale", () => {
    assert.equal(scoreRuleRequest("hi"), -0.5, "short question is lighter than the baseline");
    const hardWork = "refactor the architecture for the concurrency migration".repeat(5);
    assert.equal(scoreRuleRequest(hardWork, { estimatedInputTokens: 100 }), 1.5);
    assert.equal(scoreRuleRequest(hardWork, { estimatedInputTokens: 60_000 }), 3);
    assert.equal(scoreRuleRequest("do work", { conversationItems: 40 }), 0.5);
    assert.equal(scoreRuleRequest("do work", { toolCalls: 9 }), 0.5);
    assert.equal(
      scoreRuleRequest("explain this and translate the summary ".repeat(8), { estimatedInputTokens: 100 }),
      -1
    );
    assert.equal(
      scoreRuleRequest("fix it Traceback (most recent call last): boom", { estimatedInputTokens: 100 }),
      0.5,
      "crash output adds half a point"
    );
  });

  it("upgrades at 1.5 and keeps the current model inside the hysteresis band", () => {
    const cheap = profile("cheap", "low");
    const expensive = profile("expensive", "high");

    const upgraded = decideWithRules(
      { request: "refactor the architecture for the concurrency migration".repeat(5), candidates: [cheap, expensive] },
      [cheap, expensive]
    );
    assert.equal(upgraded.modelId, "expensive");
    assert.equal(upgraded.decisionSource, "rules");

    const simple = decideWithRules(
      { request: "explain this small function", candidates: [cheap, expensive] },
      [cheap, expensive],
      "cheap"
    );
    assert.equal(simple.modelId, "cheap");

    // Band case: items>30 (+1) plus crash output (+0.5) lands exactly on 1.5.
    const band = decideWithRules(
      {
        request: "fix this Traceback (most recent call last): boom",
        candidates: [cheap, expensive],
        preferences: { conversationItems: 40 }
      },
      [cheap, expensive],
      "expensive"
    );
    assert.equal(band.modelId, "expensive", "band keeps the current model");
  });

  it("hard-upgrades outside the score when the cheap tier cannot fit the work", () => {
    const tiny = profile("tiny", "low");
    tiny.static.contextLimit = 1000;
    const big = profile("big", "high");
    const noTools = profile("no-tools", "low");
    noTools.static.supportsTools = false;
    const tools = profile("tools", "high");

    const byContext = decideWithRules(
      {
        request: "hi",
        candidates: [tiny, big],
        preferences: { estimatedInputTokens: 5000 }
      },
      [tiny, big]
    );
    assert.equal(byContext.modelId, "big", "context overflow upgrades");

    const byTools = decideWithRules(
      {
        request: "hi",
        candidates: [noTools, tools],
        preferences: { requiresTools: true }
      },
      [noTools, tools]
    );
    assert.equal(byTools.modelId, "tools", "tool requirement upgrades");
  });
});

describe("tierFromModelName", () => {
  it("maps name families to tiers conservatively", () => {
    assert.equal(tierFromModelName("deepseek-v4-pro"), "high");
    assert.equal(tierFromModelName("deepseek-v4-flash"), "low");
    assert.equal(tierFromModelName("deepseek-v4-mini"), "low");
    assert.equal(tierFromModelName("llama-3-70b"), "medium");
  });
});
