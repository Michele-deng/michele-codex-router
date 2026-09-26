import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rewriteModel, summarizeCodexRequest } from "@jev-router/adapter-codex";

describe("summarizeCodexRequest", () => {
  it("keeps raw tool output out of the routing summary", () => {
    const summary = summarizeCodexRequest({
      model: "jev-router",
      input: [
        { role: "user", content: [{ type: "input_text", text: "fix the failing test" }] },
        { type: "function_call", name: "exec_command", call_id: "call_1" },
        { type: "function_call_output", call_id: "call_1", output: "private repository contents" }
      ]
    });

    assert.equal(summary.request, "fix the failing test");
    assert.equal(summary.continuation, true);
    assert.equal(summary.contextSummary.includes("private repository contents"), false);
    assert.match(summary.contextSummary, /1 tool calls/);
    assert.match(summary.contextSummary, /1 tool outputs/);
  });

  it("treats a request with previous_response_id as a continuation", () => {
    const summary = summarizeCodexRequest({
      model: "jev-router",
      previous_response_id: "resp_123",
      input: [{ role: "user", content: "carry on" }]
    });
    assert.equal(summary.continuation, true);
  });
});

describe("rewriteModel", () => {
  it("changes only the model field", () => {
    const original = {
      model: "jev-router",
      stream: true,
      prompt_cache_key: "cache-key",
      input: [{ role: "user", content: "hi" }]
    };

    const rewritten = rewriteModel(original, "deepseek/deepseek-flash");
    assert.equal(rewritten.model, "deepseek/deepseek-flash");
    assert.equal(rewritten.stream, true);
    assert.equal(rewritten.prompt_cache_key, "cache-key");
    assert.deepEqual(rewritten.input, original.input);
  });
});
