import {
  buildDeepSeekHeaders,
  resolveDeepSeekEndpoints,
  type DeepSeekWireApi
} from "./endpoint.js";
import {
  chatCompletionToResponses,
  chatSseToResponsesSse,
  responsesToChatRequest,
  type ResponsesRequestLike
} from "./convert.js";

export interface DeepSeekExecutionOptions {
  baseUrl: string;
  apiKey?: string;
  wireApi?: DeepSeekWireApi;
  providerId?: string;
  fetchImpl?: typeof fetch;
}

export interface ExecuteOptions {
  headers: Headers;
  signal?: AbortSignal;
}

/**
 * Execution provider for DeepSeek-compatible endpoints. It never talks to the
 * OpenAI upstream: endpoint, auth and protocol conversion are all isolated
 * here so a DeepSeek request cannot be misrouted to OpenAI.
 */
export class DeepSeekExecutionProvider {
  readonly providerId: string;
  readonly endpoints: ReturnType<typeof resolveDeepSeekEndpoints>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: DeepSeekExecutionOptions) {
    this.providerId = options.providerId ?? "deepseek";
    this.endpoints = resolveDeepSeekEndpoints(options.baseUrl, options.wireApi);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute(request: ResponsesRequestLike, executeOptions: ExecuteOptions): Promise<Response> {
    const headers = buildDeepSeekHeaders(executeOptions.headers, this.options.apiKey);
    headers.set("content-type", "application/json");
    const init: RequestInit = {
      method: "POST",
      headers,
      redirect: "manual",
      ...(executeOptions.signal ? { signal: executeOptions.signal } : {})
    };

    if (this.endpoints.wireApi === "responses") {
      return this.fetchImpl(this.endpoints.responsesUrl, {
        ...init,
        body: JSON.stringify(request)
      });
    }

    const upstream = await this.fetchImpl(this.endpoints.chatUrl, {
      ...init,
      body: JSON.stringify(responsesToChatRequest(request))
    });
    if (!upstream.ok || !upstream.body) return upstream;

    if (request.stream !== true) {
      const body = await upstream.json();
      return new Response(JSON.stringify(chatCompletionToResponses(body, request.model)), {
        status: upstream.status,
        headers: { "content-type": "application/json" }
      });
    }

    const stream = chatSseToResponsesSse(upstream.body, request.model);
    return new Response(stream, {
      status: upstream.status,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
    });
  }
}
