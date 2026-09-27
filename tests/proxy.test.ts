import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DecisionLogger,
  classifyHttpFailure,
  ModelHealthStore,
  RouteEngine,
  type CapabilityProfile
} from "@jev-router/core";
import {
  startCodexProxy,
  type CodexProxy,
  type CodexResponsesRequest,
  type ExecutionProvider
} from "@jev-router/adapter-codex";
import { ScriptedJudge, StubDecisionProvider, judgment, profile } from "./fixtures.js";

interface ProviderCall {
  request: CodexResponsesRequest;
  headers: Headers;
}

type Step = Response | Error | (() => Response) | { delayMs: number; response: Response };

class ScriptedProvider implements ExecutionProvider {
  readonly calls: ProviderCall[] = [];

  constructor(readonly providerId: string, private readonly steps: Step[]) {}

  async execute(
    request: CodexResponsesRequest,
    options: { headers: Headers; signal?: AbortSignal }
  ): Promise<Response> {
    this.calls.push({ request, headers: options.headers });
    const step = this.steps.shift();
    if (!step) throw new Error("unexpected extra call for provider " + this.providerId);
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step();
    if (typeof step === "object" && "delayMs" in step) {
      const { delayMs, response } = step;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        options.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(options.signal?.reason ?? new Error("aborted"));
          },
          { once: true }
        );
      });
      return response;
    }
    return step;
  }
}

interface Harness {
  proxy: CodexProxy;
  directory: string;
  health: ModelHealthStore;
  judge: { calls: number };
  readLog(): Array<Record<string, any>>;
  waitForLog(count: number, timeoutMs?: number): Promise<Array<Record<string, any>>>;
  close(): Promise<void>;
}

async function createHarness(args: {
  candidates: CapabilityProfile[];
  providers: ExecutionProvider[];
  judgeModelId?: string;
  fallbackModelId?: string;
  health?: ModelHealthStore;
  sentinelModels?: string[];
  adjustReasoning?: boolean;
  judgeTierScore?: number;
  headerTimeoutMs?: number;
  decisionPolicy?: "auto" | "always" | "rules";
  judgeProvider?: ScriptedJudge;
}): Promise<Harness> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "jev-proxy-"));
  const judge = args.judgeProvider ?? new StubDecisionProvider(
    judgment(
      args.judgeModelId ?? args.candidates[0]?.modelId ?? "missing",
      0.9,
      args.judgeTierScore ?? 0.5
    )
  );
  const engine = new RouteEngine(
    judge,
    args.fallbackModelId,
    0.55,
    undefined,
    args.decisionPolicy ?? "always"
  );
  const logger = new DecisionLogger(directory, false);
  const health = args.health ?? new ModelHealthStore();
  const proxy = await startCodexProxy({
    routeEngine: engine,
    routeEngineCandidates: args.candidates,
    logger,
    upstreamUrl: "http://127.0.0.1:9/v1/responses",
    executionProviders: args.providers,
    health,
    ...(args.sentinelModels ? { sentinelModels: args.sentinelModels } : {}),
    ...(args.adjustReasoning !== undefined ? { adjustReasoning: args.adjustReasoning } : {}),
    ...(args.headerTimeoutMs !== undefined ? { headerTimeoutMs: args.headerTimeoutMs } : {}),
    ...(args.fallbackModelId ? { fallbackModelId: args.fallbackModelId } : {})
  });
  const readLog = (): Array<Record<string, any>> => {
    try {
      return readFileSync(path.join(directory, "decisions.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, any>);
    } catch {
      return [];
    }
  };
  return {
    proxy,
    directory,
    health,
    judge,
    readLog,
    async waitForLog(count, timeoutMs = 1_500) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const log = readLog();
        if (log.length >= count || Date.now() > deadline) return log;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async close() {
      await proxy.close();
      // The server may still be appending latest.json after the client read
      // the body; retry briefly instead of racing that write (Node 20's
      // rmSync fails with ENOTEMPTY when a file appears mid-removal).
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          rmSync(directory, { recursive: true, force: true });
          return;
        } catch (error) {
          if (attempt === 9) throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    }
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function sseResponse(chunks: Array<{ delayBeforeMs?: number; text: string }>): Response {
  const encoder = new TextEncoder();
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[index];
      index += 1;
      if (!chunk) {
        controller.close();
        return;
      }
      if (chunk.delayBeforeMs) {
        await new Promise((resolve) => setTimeout(resolve, chunk.delayBeforeMs));
      }
      controller.enqueue(encoder.encode(chunk.text));
    }
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

async function post(
  proxy: CodexProxy,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch("http://127.0.0.1:" + proxy.port + "/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

describe("Codex proxy", () => {
  it("streams the first SSE chunk without waiting for the rest", async () => {
    const openai = new ScriptedProvider("openai", [() => sseResponse([
      { text: 'data: {"chunk":1}\n\n' },
      { delayBeforeMs: 150, text: 'data: {"chunk":2}\n\n' },
      { text: "data: [DONE]\n\n" }
    ])]);
    const harness = await createHarness({
      candidates: [profile("gpt-high", "high", { providerId: "openai" })],
      providers: [openai],
      judgeModelId: "gpt-high"
    });

    try {
      const startedAt = performance.now();
      const response = await post(harness.proxy, {
        model: "jev-router",
        stream: true,
        input: [{ role: "user", content: "hi" }]
      });
      assert.equal(response.status, 200);
      assert.ok(response.body);
      const reader = response.body.getReader();
      const arrivals: number[] = [];
      let text = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        arrivals.push(performance.now() - startedAt);
        text += new TextDecoder().decode(value);
      }

      assert.ok((arrivals[0] ?? Infinity) < 100, "first chunk must not be buffered");
      assert.ok((arrivals.at(-1) ?? 0) - (arrivals[0] ?? 0) >= 100, "later chunks stay later");
      assert.ok(text.indexOf('{"chunk":1}') < text.indexOf('{"chunk":2}'), "event order preserved");
      assert.equal(harness.judge.calls, 1);
    } finally {
      await harness.close();
    }
  });

  it("fails over on a technical failure and keeps the new model for the tool loop", async () => {
    const candidates = [
      profile("gpt-high", "high", { providerId: "openai" }),
      profile("deepseek/deepseek-flash", "medium", { providerId: "deepseek" })
    ];
    const openai = new ScriptedProvider("openai", [
      jsonResponse(429, { error: { message: "rate limited" } })
    ]);
    const deepseek = new ScriptedProvider("deepseek", [
      () => sseResponse([{ text: 'data: {"type":"done"}\n\n' }]),
      () => sseResponse([{ text: 'data: {"type":"done"}\n\n' }])
    ]);
    const health = new ModelHealthStore();
    const harness = await createHarness({
      candidates,
      providers: [openai, deepseek],
      judgeModelId: "gpt-high",
      fallbackModelId: "deepseek/deepseek-flash",
      health
    });

    try {
      const input = [{ role: "user", content: "do work" }];
      const response = await post(
        harness.proxy,
        { model: "jev-router", stream: true, prompt_cache_key: "turn-1", input },
        { authorization: "Bearer forwarded-token" }
      );
      assert.equal(response.status, 200);
      assert.equal(openai.calls.length, 1);
      assert.equal(deepseek.calls.length, 1);
      assert.equal(openai.calls[0]?.request.model, "gpt-high");
      assert.equal(deepseek.calls[0]?.request.model, "deepseek/deepseek-flash");
      assert.deepEqual(deepseek.calls[0]?.request.input, input, "full request context is preserved");
      assert.equal(
        deepseek.calls[0]?.headers.get("authorization"),
        "Bearer forwarded-token",
        "auth headers are forwarded unchanged"
      );

      const log = await harness.waitForLog(1);
      assert.equal(log.length, 1);
      assert.equal(log[0]?.switchReason, "technical_failure");
      assert.equal(log[0]?.attemptChain.length, 2);
      assert.equal(log[0]?.attemptChain[0].failureKind, "rate_limit");
      assert.equal(typeof log[0]?.turnId, "string");
      assert.equal(
        health.get("openai", "gpt-high")?.lastStatusCode,
        429,
        "failed model enters cooldown state"
      );

      const continuation = await post(harness.proxy, {
        model: "jev-router",
        stream: true,
        prompt_cache_key: "turn-1",
        input: [
          ...input,
          { type: "function_call", name: "exec", call_id: "c1", arguments: "{}" },
          { type: "function_call_output", call_id: "c1", output: "result" }
        ]
      });
      assert.equal(continuation.status, 200);
      assert.equal(openai.calls.length, 1, "tool loop must not return to the failed model");
      assert.equal(deepseek.calls.length, 2, "tool loop stays on the model that produced output");
      assert.equal(harness.judge.calls, 1, "one decision per user turn");
      assert.equal(harness.readLog().length, 1, "quiet continuations are not logged");
    } finally {
      await harness.close();
    }
  });

  it("stops after three attempts and returns a diagnostic error", async () => {
    const candidates = [
      profile("gpt-high", "high", { providerId: "openai" }),
      profile("deepseek/deepseek-flash", "medium", { providerId: "deepseek" }),
      profile("gpt-mid", "medium", { providerId: "openai" }),
      profile("gpt-low", "low", { providerId: "openai" })
    ];
    const openai = new ScriptedProvider("openai", [
      jsonResponse(404, { error: { message: "model not found" } }),
      jsonResponse(404, { error: { message: "model not found" } })
    ]);
    const deepseek = new ScriptedProvider("deepseek", [
      jsonResponse(500, { error: { message: "upstream exploded" } })
    ]);
    const harness = await createHarness({
      candidates,
      providers: [openai, deepseek],
      judgeModelId: "gpt-high",
      fallbackModelId: "deepseek/deepseek-flash"
    });

    try {
      const response = await post(harness.proxy, {
        model: "jev-router",
        stream: true,
        input: [{ role: "user", content: "hi" }]
      });
      assert.equal(response.status, 404);
      const body = await response.json() as Record<string, any>;
      assert.equal(body.error.code, "not_found");
      assert.match(body.error.message, /openai\/gpt-high/);
      assert.match(body.error.message, /deepseek\/deepseek-flash/);
      assert.equal(body.attempts.length, 3, "one primary plus at most two alternates");
      assert.equal(openai.calls.length, 2, "fourth candidate is never attempted");
      assert.equal(deepseek.calls.length, 1);

      const log = await harness.waitForLog(1);
      assert.equal(log.length, 1);
      assert.equal(log[0]?.attemptChain.length, 3);
      assert.equal(log[0]?.failureReason?.includes("not_found"), true);
    } finally {
      await harness.close();
    }
  });

  it("manual model selection disables routing and failover", async () => {
    const candidates = [
      profile("gpt-high", "high", { providerId: "openai" }),
      profile("deepseek/deepseek-flash", "medium", { providerId: "deepseek" })
    ];
    const openai = new ScriptedProvider("openai", [jsonResponse(429, { error: { message: "no" } })]);
    const deepseek = new ScriptedProvider("deepseek", []);
    const harness = await createHarness({
      candidates,
      providers: [openai, deepseek],
      judgeModelId: "deepseek/deepseek-flash"
    });

    try {
      const response = await post(harness.proxy, {
        model: "gpt-high",
        stream: true,
        input: [{ role: "user", content: "hi" }]
      });
      assert.equal(response.status, 429);
      assert.equal(harness.judge.calls, 0, "manual selection bypasses the decision provider");
      assert.equal(openai.calls.length, 1, "explicit model never auto-switches");
      assert.equal(deepseek.calls.length, 0);

      await response.text();
      const log = await harness.waitForLog(1);
      assert.equal(log.length, 1);
      assert.equal(log[0]?.switchReason, "manual_override");
      assert.equal(log[0]?.decision.modelId, "gpt-high");
    } finally {
      await harness.close();
    }
  });

  it("binds to loopback and uses a dynamic port", async () => {
    const candidates = [profile("gpt-high", "high", { providerId: "openai" })];
    const first = await createHarness({
      candidates,
      providers: [new ScriptedProvider("openai", [])]
    });
    const second = await createHarness({
      candidates,
      providers: [new ScriptedProvider("openai", [])]
    });
    try {
      const address = first.proxy.server.address();
      assert.ok(address && typeof address !== "string");
      assert.equal(address.address, "127.0.0.1");
      assert.ok(first.proxy.port > 0);
      assert.notEqual(first.proxy.port, second.proxy.port);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("keeps auth headers and upstream key material out of logs and errors", async () => {
    const candidates = [profile("gpt-high", "high", { providerId: "openai" })];
    const openai = new ScriptedProvider("openai", [
      jsonResponse(400, { error: { message: "bad key sk-leaked-abcdef123456" } })
    ]);
    const harness = await createHarness({
      candidates,
      providers: [openai],
      judgeModelId: "gpt-high"
    });

    try {
      const response = await post(
        harness.proxy,
        { model: "jev-router", stream: true, input: [{ role: "user", content: "hi" }] },
        { authorization: "Bearer proxy-secret-token-abc123" }
      );
      const errorText = await response.text();
      assert.equal(errorText.includes("sk-leaked-abcdef123456"), false, "upstream key leak redacted");

      await harness.waitForLog(1);
      const logText =
        readFileSync(path.join(harness.directory, "decisions.jsonl"), "utf8") +
        "\n" +
        readFileSync(path.join(harness.directory, "latest.json"), "utf8");
      assert.equal(logText.includes("proxy-secret-token-abc123"), false, "auth header never logged");
      assert.equal(logText.includes("sk-leaked-abcdef123456"), false, "key material never logged");
    } finally {
      await harness.close();
    }
  });

  it("routes the desktop sentinel and passes concrete models through untouched", async () => {
    const candidates = [
      profile("gpt-high", "high", { providerId: "openai" }),
      profile("deepseek/deepseek-flash", "medium", { providerId: "deepseek" })
    ];
    const openai = new ScriptedProvider("openai", [() => sseResponse([{ text: "data: done\n\n" }])]);
    const deepseek = new ScriptedProvider("deepseek", [() => sseResponse([{ text: "data: done\n\n" }])]);
    const harness = await createHarness({
      candidates,
      providers: [openai, deepseek],
      judgeModelId: "gpt-high",
      sentinelModels: ["jev-router", "jev/auto"]
    });

    try {
      const routed = await post(harness.proxy, {
        model: "jev/auto",
        stream: true,
        input: [{ role: "user", content: "do it" }]
      });
      assert.equal(routed.status, 200);
      await routed.text();
      assert.equal(harness.judge.calls, 1, "sentinel triggers one decision");
      assert.equal(openai.calls[0]?.request.model, "gpt-high", "sentinel is rewritten to the chosen model");

      const passthrough = await post(harness.proxy, {
        model: "deepseek/deepseek-flash",
        stream: true,
        input: [{ role: "user", content: "hello" }]
      });
      assert.equal(passthrough.status, 200);
      await passthrough.text();
      assert.equal(harness.judge.calls, 1, "concrete model must not trigger a decision");
      assert.equal(deepseek.calls[0]?.request.model, "deepseek/deepseek-flash", "model id unchanged");
    } finally {
      await harness.close();
    }
  });

  it("lowers reasoning effort only for simple routed tasks", async () => {
    async function routedReasoning(
      adjustReasoning: boolean,
      includeReasoning = true
    ): Promise<{ effort: unknown; hasReasoning: boolean }> {
      const openai = new ScriptedProvider("openai", [() => sseResponse([{ text: "data: done\n\n" }])]);
      const harness = await createHarness({
        candidates: [profile("gpt-high", "high", { providerId: "openai" })],
        providers: [openai],
        judgeModelId: "gpt-high",
        sentinelModels: ["jev-router", "jev/auto"],
        adjustReasoning
      });
      // Override the judgment so the engine sees the wanted complexity score.
      const body: Record<string, unknown> = {
        model: "jev/auto",
        stream: true,
        input: [{ role: "user", content: "hi" }]
      };
      if (includeReasoning) body.reasoning = { effort: "high", summary: "auto" };
      try {
        const response = await post(harness.proxy, body);
        assert.equal(response.status, 200);
        await response.text();
        const sent = openai.calls[0]?.request as { reasoning?: { effort?: unknown; summary?: unknown } };
        return {
          effort: sent.reasoning?.effort,
          hasReasoning: sent.reasoning !== undefined
        };
      } finally {
        await harness.close();
      }
    }

    // harness judges with tierScore 0.5 by default -> complexity 0.5 <= 1.5
    const simple = await routedReasoning(true);
    assert.equal(simple.effort, "low", "simple task drops to low effort");

    const disabled = await routedReasoning(false);
    assert.equal(disabled.effort, "high", "switch off keeps the request untouched");

    const withoutReasoning = await routedReasoning(true, false);
    assert.equal(withoutReasoning.hasReasoning, false, "never injects a reasoning field");
  });

  it("keeps high reasoning effort for complex routed tasks", async () => {
    const openai = new ScriptedProvider("openai", [() => sseResponse([{ text: "data: done\n\n" }])]);
    const harness = await createHarness({
      candidates: [profile("gpt-high", "high", { providerId: "openai" })],
      providers: [openai],
      judgeModelId: "gpt-high",
      sentinelModels: ["jev-router", "jev/auto"],
      adjustReasoning: true,
      judgeTierScore: 3
    });
    try {
      const response = await post(harness.proxy, {
        model: "jev/auto",
        stream: true,
        reasoning: { effort: "high" },
        input: [{ role: "user", content: "huge architecture task" }]
      });
      assert.equal(response.status, 200);
      await response.text();
      const sent = openai.calls[0]?.request as { reasoning?: { effort?: unknown } };
      assert.equal(sent.reasoning?.effort, "high", "complex task keeps its effort");
    } finally {
      await harness.close();
    }
  });

  it("reuses one decision across prompt_cache_key asymmetry in the tool loop", async () => {
    async function scenario(firstHasCacheKey: boolean): Promise<{ judgeCalls: number; openaiCalls: number; deepseekCalls: number }> {
      const candidates = [
        profile("gpt-high", "high", { providerId: "openai" }),
        profile("deepseek/deepseek-flash", "medium", { providerId: "deepseek" })
      ];
      const openai = new ScriptedProvider("openai", [
        jsonResponse(429, { error: { message: "rate limited" } }),
        () => sseResponse([{ text: "data: done\n\n" }])
      ]);
      const deepseek = new ScriptedProvider("deepseek", [
        () => sseResponse([{ text: "data: done\n\n" }]),
        () => sseResponse([{ text: "data: done\n\n" }])
      ]);
      const harness = await createHarness({
        candidates,
        providers: [openai, deepseek],
        judgeModelId: "gpt-high",
        fallbackModelId: "deepseek/deepseek-flash"
      });
      try {
        const firstBody: Record<string, unknown> = {
          model: "jev-router",
          stream: true,
          input: [{ role: "user", content: "shared question" }]
        };
        if (firstHasCacheKey) firstBody.prompt_cache_key = "pk-shared";
        const first = await post(harness.proxy, firstBody);
        assert.equal(first.status, 200);
        await first.text();

        const secondBody: Record<string, unknown> = {
          model: "jev-router",
          stream: true,
          input: [
            { role: "user", content: "shared question" },
            { type: "function_call", name: "exec", call_id: "c1", arguments: "{}" },
            { type: "function_call_output", call_id: "c1", output: "done" }
          ]
        };
        if (!firstHasCacheKey) secondBody.prompt_cache_key = "pk-shared";
        const second = await post(harness.proxy, secondBody);
        assert.equal(second.status, 200);
        await second.text();

        return {
          judgeCalls: harness.judge.calls,
          openaiCalls: openai.calls.length,
          deepseekCalls: deepseek.calls.length
        };
      } finally {
        await harness.close();
      }
    }

    const withKeyFirst = await scenario(true);
    assert.equal(withKeyFirst.judgeCalls, 1, "cache key on first request only");
    const withKeySecond = await scenario(false);
    assert.equal(withKeySecond.judgeCalls, 1, "cache key on second request only");
  });

  it("aborts a hung upstream at the header deadline and fails over", async () => {
    const candidates = [
      profile("gpt-high", "high", { providerId: "openai" }),
      profile("deepseek/deepseek-flash", "medium", { providerId: "deepseek" })
    ];
    const openai = new ScriptedProvider("openai", [
      { delayMs: 5_000, response: sseResponse([{ text: "data: never\n\n" }]) }
    ]);
    const deepseek = new ScriptedProvider("deepseek", [
      () => sseResponse([{ text: "data: recovered\n\n" }])
    ]);
    const harness = await createHarness({
      candidates,
      providers: [openai, deepseek],
      judgeModelId: "gpt-high",
      fallbackModelId: "deepseek/deepseek-flash",
      headerTimeoutMs: 120
    });

    try {
      const startedAt = performance.now();
      const response = await post(harness.proxy, {
        model: "jev-router",
        stream: true,
        input: [{ role: "user", content: "essay please" }]
      });
      assert.equal(response.status, 200, "fails over to the alternate model");
      const body = await response.text();
      assert.equal(body.includes("recovered"), true);
      const elapsed = performance.now() - startedAt;
      assert.ok(elapsed < 3_000, "must not wait for the hung upstream, took " + elapsed + "ms");

      const log = await harness.waitForLog(1);
      assert.equal(log[0]?.attemptChain[0].failureKind, "timeout");
      assert.equal(log[0]?.attemptChain[1].ok, true);
      assert.equal(openai.calls.length, 1);
    } finally {
      await harness.close();
    }
  });

  it("does not kill a long stream once headers have arrived", async () => {
    const openai = new ScriptedProvider("openai", [
      () => sseResponse([{ delayBeforeMs: 350, text: "data: slow-but-alive\n\n" }])
    ]);
    const harness = await createHarness({
      candidates: [profile("gpt-high", "high", { providerId: "openai" })],
      providers: [openai],
      judgeModelId: "gpt-high",
      headerTimeoutMs: 100
    });

    try {
      const response = await post(harness.proxy, {
        model: "jev-router",
        stream: true,
        input: [{ role: "user", content: "long generation" }]
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.equal(body.includes("slow-but-alive"), true, "body time is unlimited after headers");
    } finally {
      await harness.close();
    }
  });

  it("never calls a permanently disabled model even when Jev picks it", async () => {
    const gptHigh = profile("gpt-high", "high", { providerId: "openai" });
    const health = new ModelHealthStore();
    const failure = classifyHttpFailure(400, "model not supported by account");
    for (let i = 0; i < 3; i += 1) health.recordFailure(gptHigh, failure, 1_000 + i);

    const openai = new ScriptedProvider("openai", []);
    const deepseek = new ScriptedProvider("deepseek", [
      () => sseResponse([{ text: "data: bypassed\n\n" }])
    ]);
    const harness = await createHarness({
      candidates: [gptHigh, profile("deepseek/deepseek-flash", "medium", { providerId: "deepseek" })],
      providers: [openai, deepseek],
      judgeModelId: "gpt-high",
      fallbackModelId: "deepseek/deepseek-flash",
      health
    });

    try {
      const response = await post(harness.proxy, {
        model: "jev-router",
        stream: true,
        input: [{ role: "user", content: "hi" }]
      });
      assert.equal(response.status, 200);
      assert.equal((await response.text()).includes("bypassed"), true);
      assert.equal(openai.calls.length, 0, "disabled model is never dialled");
      assert.equal(deepseek.calls.length, 1);
    } finally {
      await harness.close();
    }
  });

  it("protects the current tier through the real proxy path", async () => {
    const candidates = [
      profile("gpt-low", "low", { providerId: "openai" }),
      profile("gpt-high", "high", { providerId: "openai" })
    ];
    const openai = new ScriptedProvider("openai", [
      () => sseResponse([{ text: "data: one\n\n" }]),
      () => sseResponse([{ text: "data: two\n\n" }])
    ]);
    const judge = new ScriptedJudge([
      judgment("gpt-high", 0.9, 3),
      judgment("gpt-low", 0.2, 0.2)
    ]);
    const harness = await createHarness({
      candidates,
      providers: [openai],
      judgeProvider: judge
    });

    try {
      const first = await post(harness.proxy, {
        model: "jev-router",
        stream: true,
        prompt_cache_key: "turn-a",
        input: [{ role: "user", content: "hard work" }]
      });
      await first.text();
      const second = await post(harness.proxy, {
        model: "jev-router",
        stream: true,
        prompt_cache_key: "turn-b",
        input: [{ role: "user", content: "simple work" }]
      });
      await second.text();

      assert.equal(judge.calls, 2, "one decision per turn");
      assert.equal(openai.calls[0]?.request.model, "gpt-high");
      assert.equal(
        openai.calls[1]?.request.model,
        "gpt-high",
        "low-confidence pick must not downgrade the current tier"
      );
    } finally {
      await harness.close();
    }
  });

  it("switches on request-content errors without blaming the model", async () => {
    const candidates = [
      profile("gpt-high", "high", { providerId: "openai" }),
      profile("deepseek/deepseek-flash", "medium", { providerId: "deepseek" })
    ];
    const openai = new ScriptedProvider("openai", [
      jsonResponse(400, { error: { message: "context length exceeded" } })
    ]);
    const deepseek = new ScriptedProvider("deepseek", [
      () => sseResponse([{ text: "data: recovered\n\n" }])
    ]);
    const health = new ModelHealthStore();
    const harness = await createHarness({
      candidates,
      providers: [openai, deepseek],
      judgeModelId: "gpt-high",
      health
    });

    try {
      const response = await post(harness.proxy, {
        model: "jev-router",
        stream: true,
        input: [{ role: "user", content: "huge context task" }]
      });
      assert.equal(response.status, 200);
      assert.equal((await response.text()).includes("recovered"), true);
      assert.equal(
        health.get("openai", "gpt-high"),
        undefined,
        "content errors never cool down a model"
      );
      const log = await harness.waitForLog(1);
      assert.equal(log[0]?.attemptChain[0].failureKind, "request_invalid");
    } finally {
      await harness.close();
    }
  });
});
