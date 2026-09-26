export type DeepSeekWireApi = "responses" | "chat";

export interface DeepSeekEndpoints {
  wireApi: DeepSeekWireApi;
  responsesUrl: string;
  chatUrl: string;
}

/**
 * Accepts a base URL such as "http://127.0.0.1:10100/v1", a full
 * ".../responses" or ".../chat/completions" URL, or a bare origin.
 */
export function resolveDeepSeekEndpoints(
  baseUrl: string,
  wireApi?: DeepSeekWireApi
): DeepSeekEndpoints {
  let base = baseUrl.trim().replace(/\/+$/, "");
  let inferred: DeepSeekWireApi | undefined;
  if (base.endsWith("/responses")) {
    inferred = "responses";
    base = base.slice(0, -"/responses".length);
  } else if (base.endsWith("/chat/completions")) {
    inferred = "chat";
    base = base.slice(0, -"/chat/completions".length);
  }
  if (base.endsWith("/v1")) {
    return {
      wireApi: wireApi ?? inferred ?? "responses",
      responsesUrl: base + "/responses",
      chatUrl: base + "/chat/completions"
    };
  }
  return {
    wireApi: wireApi ?? inferred ?? "responses",
    responsesUrl: base + "/v1/responses",
    chatUrl: base + "/v1/chat/completions"
  };
}

/**
 * DeepSeek keeps its own key separate from the OpenAI/Jev keys. When no key
 * is configured the incoming headers are forwarded unchanged, which is what
 * a local router that handles authentication itself expects.
 */
export function buildDeepSeekHeaders(incoming: Headers, apiKey?: string): Headers {
  const headers = new Headers(incoming);
  headers.delete("host");
  headers.delete("content-length");
  if (apiKey && apiKey.trim()) {
    headers.set("authorization", "Bearer " + apiKey.trim());
  }
  return headers;
}
