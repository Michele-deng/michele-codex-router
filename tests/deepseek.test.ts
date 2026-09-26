import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDeepSeekHeaders,
  chatCompletionToResponses,
  chatSseToResponsesSse,
  resolveDeepSeekEndpoints,
  responsesToChatRequest,
  type SseEvent
} from "@jev-router/provider-deepseek";

describe("resolveDeepSeekEndpoints", () => {
  it("builds both wire URLs from a /v1 base", () => {
    const endpoints = resolveDeepSeekEndpoints("http://127.0.0.1:10100/v1");
    assert.equal(endpoints.wireApi, "responses");
    assert.equal(endpoints.responsesUrl, "http://127.0.0.1:10100/v1/responses");
    assert.equal(endpoints.chatUrl, "http://127.0.0.1:10100/v1/chat/completions");
  });

  it("infers the chat wire from a full chat URL", () => {
    const endpoints = resolveDeepSeekEndpoints("https://api.deepseek.com/v1/chat/completions");
    assert.equal(endpoints.wireApi, "chat");
    assert.equal(endpoints.chatUrl, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(endpoints.responsesUrl, "https://api.deepseek.com/v1/responses");
  });

  it("adds /v1 to a bare origin", () => {
    const endpoints = resolveDeepSeekEndpoints("https://api.deepseek.com/");
    assert.equal(endpoints.responsesUrl, "https://api.deepseek.com/v1/responses");
  });
});

describe("buildDeepSeekHeaders", () => {
  it("keeps incoming auth when no DeepSeek key is configured", () => {
    const headers = buildDeepSeekHeaders(new Headers({ authorization: "Bearer inherited" }));
    assert.equal(headers.get("authorization"), "Bearer inherited");
  });

  it("isolates the DeepSeek key when one is configured", () => {
    const headers = buildDeepSeekHeaders(
      new Headers({ authorization: "Bearer openai-or-chatgpt" }),
      "deepseek-key"
    );
    assert.equal(headers.get("authorization"), "Bearer deepseek-key");
    assert.equal(headers.has("content-length"), false);
  });
});

describe("responsesToChatRequest", () => {
  it("rebuilds the conversation, tools and tool results", () => {
    const chat = responsesToChatRequest({
      model: "deepseek/deepseek-flash",
      stream: true,
      instructions: "be terse",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        {
          type: "function_call",
          name: "exec_command",
          call_id: "call_1",
          arguments: "{\"cmd\":\"ls\"}"
        },
        { type: "function_call_output", call_id: "call_1", output: "file.ts" },
        { type: "reasoning", summary: [] }
      ],
      tools: [{ type: "function", name: "exec_command", parameters: { type: "object" } }],
      tool_choice: { type: "function", name: "exec_command" },
      max_output_tokens: 4096
    });

    assert.equal(chat.model, "deepseek/deepseek-flash");
    assert.equal(chat.stream, true);
    assert.deepEqual(chat.stream_options, { include_usage: true });
    assert.equal(chat.max_tokens, 4096);
    const messages = chat.messages as Array<Record<string, any>>;
    assert.deepEqual(
      messages.map((message) => message.role),
      ["system", "user", "assistant", "tool"]
    );
    assert.equal(messages[1]?.content, "hi");
    assert.equal(messages[3]?.content, "file.ts");
    const tools = chat.tools as Array<Record<string, any>>;
    assert.equal(tools[0]?.function.name, "exec_command");
    assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "exec_command" } });
  });
});

describe("chatCompletionToResponses", () => {
  it("converts text, tool calls and usage", () => {
    const responses = chatCompletionToResponses({
      id: "chatcmpl-1",
      model: "deepseek/deepseek-flash",
      choices: [{
        message: {
          content: "hello",
          tool_calls: [{ id: "call_9", function: { name: "exec_command", arguments: "{}" } }]
        }
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }, "deepseek/deepseek-flash");

    assert.equal(responses.status, "completed");
    const output = responses.output as Array<Record<string, any>>;
    assert.equal(output[0]?.type, "message");
    assert.equal(output[0]?.content[0].text, "hello");
    assert.equal(output[1]?.type, "function_call");
    assert.equal(output[1]?.call_id, "call_9");
    assert.deepEqual(responses.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  });
});

describe("chatSseToResponsesSse", () => {
  it("converts a chat stream into ordered Responses events", async () => {
    const encoder = new TextEncoder();
    const chatEvents = [
      'data: {"id":"chatcmpl-1","model":"deepseek/deepseek-flash","choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"lo"}}]}',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
      "data: [DONE]",
      ""
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of chatEvents) {
          controller.enqueue(encoder.encode(event + "\n\n"));
        }
        controller.close();
      }
    });

    const converted = chatSseToResponsesSse(source, "deepseek/deepseek-flash");
    const text = await new Response(converted).text();
    const events = parseSse(text);

    assert.equal(events[0]?.event, "response.created");
    const deltas = events.filter((event) => event.event === "response.output_text.delta");
    assert.deepEqual(
      deltas.map((event) => (event.data as { delta: string }).delta),
      ["Hel", "lo"]
    );
    const completed = events.at(-1);
    assert.equal(completed?.event, "response.completed");
    const response = (completed?.data as { response: any }).response;
    assert.equal(response.status, "completed");
    assert.equal(response.output[0]?.content[0].text, "Hello");
    assert.equal(response.usage.total_tokens, 5);
  });

  it("emits function-call argument deltas and a final tool item", async () => {
    const encoder = new TextEncoder();
    const first = "data: " + JSON.stringify({
      id: "c2",
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            function: { name: "exec_command", arguments: '{"cmd"' }
          }]
        }
      }]
    });
    const second = "data: " + JSON.stringify({
      id: "c2",
      choices: [{
        delta: { tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }] },
        finish_reason: "tool_calls"
      }]
    });
    const chatEvents = [
      first,
      second,
      "data: [DONE]",
      ""
    ];
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of chatEvents) controller.enqueue(encoder.encode(event + "\n\n"));
        controller.close();
      }
    });

    const text = await new Response(chatSseToResponsesSse(source, "m")).text();
    const events = parseSse(text);
    const argDeltas = events.filter((event) => event.event === "response.function_call_arguments.delta");
    assert.equal(argDeltas.length, 2);
    const completed = events.at(-1);
    assert.equal(completed?.event, "response.completed");
    const item = (completed?.data as { response: any }).response.output[0];
    assert.equal(item.type, "function_call");
    assert.equal(item.arguments, '{"cmd":"ls"}');
    assert.equal(item.name, "exec_command");
  });
});

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (!eventLine || !dataLine) continue;
    events.push({
      event: eventLine.slice("event: ".length),
      data: JSON.parse(dataLine.slice("data: ".length))
    });
  }
  return events;
}
