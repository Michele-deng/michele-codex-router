import { createHash } from "node:crypto";

export interface CodexResponsesRequest {
  model: string;
  input?: unknown;
  previous_response_id?: string;
  prompt_cache_key?: string;
  stream?: boolean;
  [key: string]: unknown;
}

export interface CodexRequestSummary {
  request: string;
  contextSummary: string;
  turnKey: string;
  turnKeys: string[];
  continuation: boolean;
  estimatedInputTokens: number;
  hasTools: boolean;
  conversationItems: number;
  toolCalls: number;
}

export function summarizeCodexRequest(body: CodexResponsesRequest): CodexRequestSummary {
  const items = Array.isArray(body.input) ? body.input : [];
  const userPrompts = items
    .map((item) => extractUserPrompt(item))
    .filter((value): value is string => Boolean(value));
  const request = userPrompts.at(-1) ?? extractString(body.input) ?? "";
  const firstPrompt = userPrompts[0] ?? request;
  const toolOutputCount = items.filter((item) => isToolOutput(item)).length;
  const functionCallCount = items.filter((item) => isFunctionCall(item)).length;
  const estimatedCharacters = JSON.stringify(body.input ?? "").length;

  const firstPromptKey = createHash("sha256").update(firstPrompt).digest("hex");
  const turnKeys = [...new Set(
    body.prompt_cache_key ? [body.prompt_cache_key, firstPromptKey] : [firstPromptKey]
  )];

  return {
    request,
    contextSummary: [
      `${items.length} conversation items`,
      `${functionCallCount} tool calls`,
      `${toolOutputCount} tool outputs`,
      `approximately ${Math.ceil(estimatedCharacters / 4)} input tokens`,
      "Raw tool outputs are intentionally omitted from the routing decision"
    ].join("; "),
    turnKey: turnKeys[0] as string,
    turnKeys,
    continuation: Boolean(body.previous_response_id) || isToolOutput(items.at(-1)),
    estimatedInputTokens: Math.ceil(estimatedCharacters / 4),
    hasTools: Array.isArray(body.tools) && body.tools.length > 0,
    conversationItems: items.length,
    toolCalls: functionCallCount
  };
}

export function rewriteModel(body: CodexResponsesRequest, modelId: string): CodexResponsesRequest {
  return { ...body, model: modelId };
}

function extractUserPrompt(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const candidate = item as { role?: unknown; content?: unknown };
  if (candidate.role !== "user") return undefined;
  return extractString(candidate.content);
}

function extractString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const strings = value.map((entry) => extractString(entry)).filter((entry): entry is string => Boolean(entry));
    return strings.length > 0 ? strings.join("\n") : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const object = value as { text?: unknown; type?: unknown };
  if (typeof object.text === "string" && (!object.type || String(object.type).includes("text"))) {
    return object.text;
  }
  return undefined;
}

function isToolOutput(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const type = String((item as { type?: unknown }).type ?? "");
  return type === "function_call_output" || type === "custom_tool_call_output";
}

function isFunctionCall(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const type = String((item as { type?: unknown }).type ?? "");
  return type === "function_call" || type === "custom_tool_call";
}
