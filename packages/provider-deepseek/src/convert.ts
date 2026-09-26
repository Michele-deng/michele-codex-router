export interface ResponsesRequestLike {
  model: string;
  stream?: boolean;
  [key: string]: unknown;
}

interface ChatToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: ChatToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/**
 * Converts a Codex Responses API request into an OpenAI-compatible chat
 * completion request. The full conversation is rebuilt from Responses input
 * items; reasoning and server-side state fields are intentionally dropped.
 */
export function responsesToChatRequest(request: ResponsesRequestLike): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof request.instructions === "string" && request.instructions.trim()) {
    messages.push({ role: "system", content: request.instructions });
  }

  const items = Array.isArray(request.input)
    ? request.input
    : typeof request.input === "string"
      ? [{ role: "user", content: request.input }]
      : [];

  for (const raw of items as unknown[]) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (item.type === "message" || typeof item.role === "string") {
      const role = String(item.role ?? "user");
      if (!["user", "assistant", "system", "developer"].includes(role)) continue;
      const content = textContent(item.content);
      if (content) messages.push({ role: role === "developer" ? "system" : role, content });
      continue;
    }
    if (item.type === "function_call") {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: String(item.call_id ?? item.id ?? "call_0"),
          type: "function",
          function: {
            name: String(item.name ?? ""),
            arguments: String(item.arguments ?? "")
          }
        }]
      });
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id ?? ""),
        content: textContent(item.output) ?? ""
      });
      continue;
    }
    // reasoning and item_reference entries have no chat equivalent
  }

  const chat: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: request.stream === true
  };
  if (request.stream === true) chat.stream_options = { include_usage: true };
  if (typeof request.temperature === "number") chat.temperature = request.temperature;
  if (typeof request.top_p === "number") chat.top_p = request.top_p;
  if (typeof request.max_output_tokens === "number") chat.max_tokens = request.max_output_tokens;
  if (typeof request.parallel_tool_calls === "boolean") chat.parallel_tool_calls = request.parallel_tool_calls;
  const tools = convertTools(request.tools);
  if (tools) chat.tools = tools;
  const toolChoice = convertToolChoice(request.tool_choice);
  if (toolChoice !== undefined) chat.tool_choice = toolChoice;
  return chat;
}

function convertTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  return tools.map((raw) => {
    if (!raw || typeof raw !== "object") return raw;
    const tool = raw as Record<string, unknown>;
    if (tool.type === "function" && tool.function) return tool;
    if (tool.type === "function" && typeof tool.name === "string") {
      const fn: Record<string, unknown> = { name: tool.name };
      if (tool.description !== undefined) fn.description = tool.description;
      if (tool.parameters !== undefined) fn.parameters = tool.parameters;
      if (tool.strict !== undefined) fn.strict = tool.strict;
      return { type: "function", function: fn };
    }
    return raw;
  });
}

function convertToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === undefined) return undefined;
  if (typeof toolChoice === "string") return toolChoice;
  if (toolChoice && typeof toolChoice === "object") {
    const choice = toolChoice as Record<string, unknown>;
    if (choice.type === "function" && typeof choice.name === "string") {
      return { type: "function", function: { name: choice.name } };
    }
  }
  return undefined;
}

function textContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join("") : undefined;
  }
  if (value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string") {
    return (value as { text: string }).text;
  }
  return undefined;
}

/** Converts a non-streaming chat completion into a Responses API object. */
export function chatCompletionToResponses(chat: unknown, fallbackModel: string): Record<string, unknown> {
  const body = chat && typeof chat === "object" ? chat as Record<string, any> : {};
  const choice = body.choices?.[0];
  const output: Array<Record<string, unknown>> = [];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  if (text) {
    output.push({
      type: "message",
      id: "msg_" + String(body.id ?? "jev"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }]
    });
  }
  const toolCalls = Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : [];
  for (let index = 0; index < toolCalls.length; index += 1) {
    const call = toolCalls[index];
    const id = String(call?.id ?? "fc_" + index);
    output.push({
      type: "function_call",
      id,
      call_id: id,
      name: String(call?.function?.name ?? ""),
      arguments: String(call?.function?.arguments ?? ""),
      status: "completed"
    });
  }
  const usage = body.usage
    ? {
        input_tokens: body.usage.prompt_tokens ?? 0,
        output_tokens: body.usage.completion_tokens ?? 0,
        total_tokens: body.usage.total_tokens ?? 0
      }
    : undefined;
  return {
    id: String(body.id ?? "resp_jev"),
    object: "response",
    status: "completed",
    model: String(body.model ?? fallbackModel),
    output,
    ...(usage ? { usage } : {})
  };
}

interface MessageState {
  itemId: string;
  outputIndex: number;
  added: boolean;
  finished: boolean;
  text: string;
}

interface ToolState {
  itemId: string;
  outputIndex: number;
  callId: string;
  name: string;
  argumentsText: string;
  finished: boolean;
}

interface StreamState {
  responseId?: string;
  model: string;
  createdSent: boolean;
  nextOutputIndex: number;
  message?: MessageState;
  tools: Map<number, ToolState>;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  completed: boolean;
}

/**
 * Transforms a chat-completions SSE stream into Responses API SSE events.
 * Each upstream event is converted and emitted immediately; nothing waits
 * for the full response.
 */
export function chatSseToResponsesSse(
  source: ReadableStream<Uint8Array>,
  fallbackModel: string
): ReadableStream<Uint8Array> {
  const state: StreamState = {
    model: fallbackModel,
    createdSent: false,
    nextOutputIndex: 0,
    tools: new Map(),
    completed: false
  };
  const encoder = new TextEncoder();
  const events = transformEvents(sseLines(source), state);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await events.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(
          encoder.encode("event: " + next.value.event + "\ndata: " + JSON.stringify(next.value.data) + "\n\n")
        );
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await events.return?.(undefined);
      await source.cancel(reason).catch(() => undefined);
    }
  });
}

async function* transformEvents(
  lines: AsyncGenerator<string>,
  state: StreamState
): AsyncGenerator<SseEvent> {
  for await (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data === "[DONE]") {
      yield* finishEvents(state);
      return;
    }
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(data) as ChatChunk;
    } catch {
      continue;
    }
    yield* chunkEvents(chunk, state);
  }
  yield* finishEvents(state);
}

function* chunkEvents(chunk: ChatChunk, state: StreamState): Generator<SseEvent> {
  if (!state.createdSent) {
    state.createdSent = true;
    state.responseId = typeof chunk.id === "string" ? chunk.id : "resp_jev";
    if (typeof chunk.model === "string") state.model = chunk.model;
    yield {
      event: "response.created",
      data: {
        response: {
          id: state.responseId,
          object: "response",
          status: "in_progress",
          model: state.model,
          output: []
        }
      }
    };
  }
  if (chunk.usage) {
    state.usage = {
      inputTokens: chunk.usage.prompt_tokens ?? 0,
      outputTokens: chunk.usage.completion_tokens ?? 0,
      totalTokens: chunk.usage.total_tokens ?? 0
    };
  }

  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  if (typeof delta?.content === "string" && delta.content.length > 0) {
    if (!state.message) {
      state.message = {
        itemId: "msg_" + String(state.responseId ?? "jev"),
        outputIndex: state.nextOutputIndex++,
        added: false,
        finished: false,
        text: ""
      };
    }
    const message = state.message;
    if (!message.added) {
      message.added = true;
      yield {
        event: "response.output_item.added",
        data: {
          output_index: message.outputIndex,
          item: { type: "message", id: message.itemId, role: "assistant", status: "in_progress", content: [] }
        }
      };
      yield {
        event: "response.content_part.added",
        data: {
          item_id: message.itemId,
          output_index: message.outputIndex,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] }
        }
      };
    }
    message.text += delta.content;
    yield {
      event: "response.output_text.delta",
      data: {
        item_id: message.itemId,
        output_index: message.outputIndex,
        content_index: 0,
        delta: delta.content
      }
    };
  }

  for (const call of delta?.tool_calls ?? []) {
    const index = call.index ?? 0;
    let tool = state.tools.get(index);
    if (!tool) {
      tool = {
        itemId: "fc_" + index,
        outputIndex: state.nextOutputIndex++,
        callId: call.id ?? "call_" + index,
        name: call.function?.name ?? "",
        argumentsText: "",
        finished: false
      };
      state.tools.set(index, tool);
      yield {
        event: "response.output_item.added",
        data: {
          output_index: tool.outputIndex,
          item: {
            type: "function_call",
            id: tool.itemId,
            call_id: tool.callId,
            name: tool.name,
            arguments: "",
            status: "in_progress"
          }
        }
      };
    }
    if (call.id) tool.callId = call.id;
    if (call.function?.name) tool.name = call.function.name;
    const argsDelta = call.function?.arguments;
    if (typeof argsDelta === "string" && argsDelta.length > 0) {
      tool.argumentsText += argsDelta;
      yield {
        event: "response.function_call_arguments.delta",
        data: { item_id: tool.itemId, output_index: tool.outputIndex, delta: argsDelta }
      };
    }
  }

  if (choice?.finish_reason && state.message && !state.message.finished) {
    yield* finishMessage(state.message);
  }
}

function* finishMessage(message: MessageState): Generator<SseEvent> {
  message.finished = true;
  yield {
    event: "response.output_text.done",
    data: { item_id: message.itemId, output_index: message.outputIndex, content_index: 0, text: message.text }
  };
  yield {
    event: "response.content_part.done",
    data: {
      item_id: message.itemId,
      output_index: message.outputIndex,
      content_index: 0,
      part: { type: "output_text", text: message.text, annotations: [] }
    }
  };
  yield {
    event: "response.output_item.done",
    data: {
      output_index: message.outputIndex,
      item: {
        type: "message",
        id: message.itemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: message.text, annotations: [] }]
      }
    }
  };
}

function* finishEvents(state: StreamState): Generator<SseEvent> {
  if (state.completed) return;
  state.completed = true;
  const output: Array<Record<string, unknown>> = [];
  if (state.message) {
    if (!state.message.finished) yield* finishMessage(state.message);
    output.push({
      type: "message",
      id: state.message.itemId,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: state.message.text, annotations: [] }]
    });
  }
  const tools = [...state.tools.values()].sort((a, b) => a.outputIndex - b.outputIndex);
  for (const tool of tools) {
    if (!tool.finished) {
      tool.finished = true;
      yield {
        event: "response.function_call_arguments.done",
        data: { item_id: tool.itemId, output_index: tool.outputIndex, arguments: tool.argumentsText }
      };
      yield {
        event: "response.output_item.done",
        data: {
          output_index: tool.outputIndex,
          item: {
            type: "function_call",
            id: tool.itemId,
            call_id: tool.callId,
            name: tool.name,
            arguments: tool.argumentsText,
            status: "completed"
          }
        }
      };
    }
    output.push({
      type: "function_call",
      id: tool.itemId,
      call_id: tool.callId,
      name: tool.name,
      arguments: tool.argumentsText,
      status: "completed"
    });
  }
  yield {
    event: "response.completed",
    data: {
      response: {
        id: state.responseId ?? "resp_jev",
        object: "response",
        status: "completed",
        model: state.model,
        output,
        ...(state.usage
          ? {
              usage: {
                input_tokens: state.usage.inputTokens,
                output_tokens: state.usage.outputTokens,
                total_tokens: state.usage.totalTokens
              }
            }
          : {})
      }
    }
  };
}

async function* sseLines(source: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) yield line;
        newlineIndex = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}
