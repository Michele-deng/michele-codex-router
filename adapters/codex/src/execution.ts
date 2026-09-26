import type { CodexResponsesRequest } from "./request.js";

export interface ExecutionRequestOptions {
  headers: Headers;
  signal?: AbortSignal;
}

/**
 * Executes one Responses API request against one provider. The proxy only
 * swaps the model and delegates transport, auth and protocol details here.
 */
export interface ExecutionProvider {
  readonly providerId: string;
  execute(request: CodexResponsesRequest, options: ExecutionRequestOptions): Promise<Response>;
}

/** Default provider: forwards the Responses API request unchanged. */
export class UpstreamExecutionProvider implements ExecutionProvider {
  constructor(
    readonly providerId: string,
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async execute(request: CodexResponsesRequest, options: ExecutionRequestOptions): Promise<Response> {
    return this.fetchImpl(this.url, {
      method: "POST",
      headers: options.headers,
      body: JSON.stringify(request),
      redirect: "manual",
      ...(options.signal ? { signal: options.signal } : {})
    });
  }
}
