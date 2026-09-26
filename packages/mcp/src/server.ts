import { createInterface } from "node:readline";
import type { JevConfig } from "@jev-router/config";
import type { CapabilityProfile, DecisionLogger, RouteEngine, RouteInput } from "@jev-router/core";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpRouterOptions {
  routeEngine: RouteEngine;
  candidates: CapabilityProfile[];
  logger: DecisionLogger;
  config?: JevConfig;
}

export function startMcpStdio(options: McpRouterOptions): void {
  const input = createInterface({ input: process.stdin, terminal: false });
  input.on("line", (line) => {
    if (!line.trim()) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    void handle(request, options).then(write).catch((error) => {
      write({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" }
      });
    });
  });
}

async function handle(request: JsonRpcRequest, options: McpRouterOptions): Promise<unknown> {
  if (request.method === "initialize") {
    return result(request, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "jev-router", version: "0.1.0" }
    });
  }
  if (request.method === "notifications/initialized") return undefined;
  if (request.method === "tools/list") {
    return result(request, { tools: toolDefinitions() });
  }
  if (request.method === "tools/call") {
    const params = request.params ?? {};
    const name = String(params.name ?? "");
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    if (name === "jev_health") {
      return result(request, {
        content: [{ type: "text", text: JSON.stringify({
          ok: true,
          candidates: options.candidates.length,
          typesafeKeyConfigured: options.config?.typesafe.configured ??
            Boolean(process.env.TYPESAFE_API_KEY ?? process.env.JEV_API_KEY),
          envFile: options.config?.envFile,
          envFileFound: options.config?.envFileFound,
          decisionProvider: options.config?.decisionProvider
        }) }]
      });
    }
    if (name === "jev_explain") {
      const latest = await options.logger.latest();
      return result(request, {
        content: [{ type: "text", text: JSON.stringify(latest ?? { message: "No decision recorded" }) }]
      });
    }
    if (name === "jev_route") {
      const input = parseRouteInput(args, options.candidates);
      const startedAt = performance.now();
      const decision = await options.routeEngine.route(input);
      await options.logger.append({
        request: input.request,
        decision,
        latencyMs: Math.round(performance.now() - startedAt)
      });
      return result(request, {
        content: [{ type: "text", text: JSON.stringify(decision) }]
      });
    }
    return result(request, {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true
    });
  }
  throw new Error(`Unsupported method: ${request.method}`);
}

function parseRouteInput(args: Record<string, unknown>, fallbackCandidates: CapabilityProfile[]): RouteInput {
  if (typeof args.request !== "string" || args.request.trim().length === 0) {
    throw new Error("jev_route requires a non-empty request string");
  }
  const candidates = Array.isArray(args.candidates) && args.candidates.length > 0
    ? args.candidates as CapabilityProfile[]
    : fallbackCandidates;
  const preferences = args.preferences && typeof args.preferences === "object"
    ? args.preferences as RouteInput["preferences"]
    : undefined;
  return {
    request: args.request,
    ...(typeof args.contextSummary === "string" ? { contextSummary: args.contextSummary } : {}),
    candidates,
    ...(preferences ? { preferences } : {})
  };
}

function toolDefinitions(): unknown[] {
  return [
    {
      name: "jev_route",
      description: "Select the best available model for one development task",
      inputSchema: {
        type: "object",
        required: ["request"],
        properties: {
          request: { type: "string" },
          contextSummary: { type: "string" },
          candidates: { type: "array", items: { type: "object" } },
          preferences: { type: "object" }
        }
      }
    },
    {
      name: "jev_explain",
      description: "Return the latest local routing decision and its factors",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "jev_health",
      description: "Check local router configuration without exposing secrets",
      inputSchema: { type: "object", properties: {} }
    }
  ];
}

function result(request: JsonRpcRequest, value: unknown): unknown {
  return { jsonrpc: "2.0", id: request.id ?? null, result: value };
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
