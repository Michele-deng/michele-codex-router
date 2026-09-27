import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  classifyHttpFailure,
  classifyThrownFailure,
  rankProfiles,
  type AttemptRecord,
  type CapabilityProfile,
  type DecisionLogger,
  type ExecutionFailure,
  type ModelHealthStore,
  type RouteDecision,
  type RouteEngine
} from "@jev-router/core";
import { UpstreamExecutionProvider, type ExecutionProvider } from "./execution.js";
import { ModelLeaseStore } from "./lease-store.js";
import { rewriteModel, summarizeCodexRequest, type CodexResponsesRequest } from "./request.js";

const MAX_ATTEMPTS = 3;

export interface CodexProxyOptions {
  routeEngine: RouteEngine;
  routeEngineCandidates: CapabilityProfile[];
  logger: DecisionLogger;
  upstreamUrl: string;
  fallbackModelId?: string;
  allowLongTier?: boolean;
  fetchImpl?: typeof fetch;
  executionProviders?: ExecutionProvider[];
  health?: ModelHealthStore;
  /** Deadline until response HEADERS arrive; streaming time is unlimited. */
  headerTimeoutMs?: number;
  /** Fixed listen port; omit (or 0) for an ephemeral port. */
  port?: number;
  /** Model ids that trigger automatic routing. */
  sentinelModels?: string[];
  /** Lower reasoning effort for simple routed tasks. */
  adjustReasoning?: boolean;
  /** Optional redactor applied to anything written to errors and logs. */
  redact?: (text: string) => string;
}

export interface CodexProxy {
  server: Server;
  port: number;
  close(): Promise<void>;
}

export async function startCodexProxy(options: CodexProxyOptions): Promise<CodexProxy> {
  const leases = new ModelLeaseStore();
  const fetchImpl = options.fetchImpl ?? fetch;
  const providers: ExecutionProvider[] = options.executionProviders ?? [
    new UpstreamExecutionProvider("openai", options.upstreamUrl, fetchImpl)
  ];
  const resolved: CodexProxyOptions = { ...options, executionProviders: providers };
  const manualTurns = new Map<string, number>();

  const server = createServer((request, response) => {
    void handleRequest(request, response, resolved, leases, manualTurns).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: { message: redact(options, error instanceof Error ? error.message : "Jev Router proxy failed") }
        });
      } else {
        response.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE"
        ? new Error("Jev Router port " + (options.port ?? 0) + " is already in use")
        : error);
    };
    server.once("error", onError);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to determine the Jev Router proxy port");
  }

  return {
    server,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      leases.clear();
      manualTurns.clear();
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: CodexProxyOptions,
  leases: ModelLeaseStore,
  manualTurns: Map<string, number>
): Promise<void> {
  if (request.method === "GET" && request.url === "/health") {
    const cooling = (options.health?.snapshot() ?? [])
      .filter((record) => !record.available && (record.cooldownUntil ?? 0) > Date.now())
      .map((record) => record.providerId + "/" + record.modelId);
    sendJson(response, 200, {
      ok: true,
      service: "jev-router",
      upstream: options.upstreamUrl,
      cooling
    });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/responses") {
    sendJson(response, 404, { error: { message: "Not found" } });
    return;
  }

  const parsed = JSON.parse((await readBody(request)).toString("utf8")) as CodexResponsesRequest;
  const summary = summarizeCodexRequest(parsed);
  await options.health?.syncFromDisk();
  const turnId = createHash("sha256").update(summary.turnKey).digest("hex").slice(0, 16);
  const startedAt = performance.now();
  const sentinelSet = new Set(options.sentinelModels ?? ["jev-router"]);
  const requestedModel =
    typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : undefined;
  const routed = requestedModel === undefined || sentinelSet.has(requestedModel);
  const manualModelId = routed ? undefined : requestedModel;
  const nowMs = Date.now();
  for (const [key, expiry] of manualTurns) {
    if (expiry <= nowMs) manualTurns.delete(key);
  }
  const manualFirst = manualModelId !== undefined && !manualTurns.has(turnId);
  if (manualModelId !== undefined && manualFirst) {
    manualTurns.set(turnId, nowMs + 30 * 60 * 1_000);
  }

  if (routed && options.routeEngineCandidates.length === 0) {
    sendJson(response, 500, {
      error: {
        message: "Jev Router: no model profiles configured. Run: jev doctor",
        type: "model_router_error",
        param: null,
        code: "no_model_profiles"
      }
    });
    return;
  }

  let decision: RouteDecision | undefined;
  let decisionLatencyMs = 0;
  let primaryProfile: CapabilityProfile | undefined;

  if (manualModelId) {
    primaryProfile = findCandidate(options.routeEngineCandidates, manualModelId) ?? adHocProfile(manualModelId);
    for (const key of summary.turnKeys) leases.set(key, manualModelId);
  } else {
    const leaseModelId = summary.continuation
      ? summary.turnKeys.map((key) => leases.get(key)).find((value) => value !== undefined)
      : undefined;
    primaryProfile = leaseModelId
      ? findCandidate(options.routeEngineCandidates, leaseModelId)
      : undefined;
    if (!primaryProfile) {
      const previousModelId = leaseModelId ?? leases.lastUsed();
      decision = await options.routeEngine.route({
        request: summary.request,
        contextSummary: summary.contextSummary,
        candidates: options.routeEngineCandidates,
        preferences: {
          ...(previousModelId ? { currentModelId: previousModelId } : {}),
          estimatedInputTokens: summary.estimatedInputTokens,
          conversationItems: summary.conversationItems,
          toolCalls: summary.toolCalls,
          requiresTools: summary.hasTools,
          longTierEnabled: options.allowLongTier === true
        }
      });
      decisionLatencyMs = Math.round(performance.now() - startedAt);
      primaryProfile =
        findCandidate(options.routeEngineCandidates, decision.modelId) ?? adHocProfile(decision.modelId);
      for (const key of summary.turnKeys) leases.set(key, decision.modelId);
    }
  }

  const outboundSource =
    decision && options.adjustReasoning === true && decision.factors.complexity <= 1.5
      ? withSimpleReasoning(parsed)
      : parsed;

  const attemptOrder = buildAttemptOrder({
    primary: primaryProfile,
    candidates: options.routeEngineCandidates,
    ...(options.health ? { health: options.health } : {}),
    allowLongTier: options.allowLongTier === true,
    hasTools: summary.hasTools,
    ...(options.fallbackModelId ? { fallbackModelId: options.fallbackModelId } : {}),
    manual: Boolean(manualModelId),
    maxAttempts: MAX_ATTEMPTS
  });

  const attemptChain: AttemptRecord[] = [];
  let lastFailure: ExecutionFailure | undefined;
  let clientGone = false;
  let activeController: AbortController | undefined;
  response.once("close", () => {
    if (!response.writableFinished) {
      clientGone = true;
      activeController?.abort(new Error("client disconnected"));
    }
  });

  for (const profile of attemptOrder) {
    if (clientGone) break;
    const provider = resolveExecutionProvider(options, profile.providerId ?? "openai");
    if (!provider) {
      const failure: ExecutionFailure = {
        kind: "config",
        retryable: true,
        message: "No execution provider is configured for " + (profile.providerId ?? "openai")
      };
      options.health?.recordFailure(profile, failure);
      attemptChain.push({
        providerId: profile.providerId ?? "openai",
        modelId: profile.modelId,
        ok: false,
        failureKind: failure.kind,
        detail: failure.message
      });
      lastFailure = failure;
      continue;
    }

    const outbound = rewriteModel(outboundSource, profile.modelId);
    const outboundBody = JSON.stringify(outbound);
    const headers = forwardHeaders(request.headers);
    headers.set("content-type", "application/json");
    headers.set("content-length", String(Buffer.byteLength(outboundBody)));

    const controller = new AbortController();
    activeController = controller;
    const headerTimer = setTimeout(
      () => controller.abort(new Error("upstream header timeout")),
      options.headerTimeoutMs ?? 60_000
    );
    try {
      const upstream = await provider.execute(outbound, {
        headers,
        signal: controller.signal
      });
      clearTimeout(headerTimer);
      activeController = undefined;
      if (clientGone) break;

      if (!upstream.ok) {
        const errorText = await upstream.text().catch(() => "");
        const failure = classifyHttpFailure(upstream.status, errorText);
        if (failure.kind !== "request_invalid") options.health?.recordFailure(profile, failure);
        attemptChain.push({
          providerId: provider.providerId,
          modelId: profile.modelId,
          ok: false,
          status: upstream.status,
          failureKind: failure.kind,
          detail: failure.message
        });
        lastFailure = failure;
        if (!failure.retryable || attemptChain.length >= MAX_ATTEMPTS) break;
        continue;
      }

      options.health?.recordSuccess(profile);
      attemptChain.push({
        providerId: provider.providerId,
        modelId: profile.modelId,
        ok: true,
        status: upstream.status
      });
      // Once this point is reached no other model may be tried: the response
      // has started and silent switching would corrupt the output.
      if (!manualModelId) {
        for (const key of summary.turnKeys) leases.set(key, profile.modelId);
      }
      const streamResult = await pipeUpstream(upstream, response, startedAt);
      await logOutcome({
        options,
        summary,
        decision,
        decisionLatencyMs,
        primaryProfile,
        turnId,
        manual: Boolean(manualModelId),
        manualFirst,
        attemptChain,
        ...(streamResult.ttftMs !== undefined ? { ttftMs: streamResult.ttftMs } : {}),
        ...(streamResult.failureReason !== undefined ? { failureReason: streamResult.failureReason } : {})
      });
      return;
    } catch (error) {
      clearTimeout(headerTimer);
      activeController = undefined;
      if (clientGone) {
        attemptChain.push({
          providerId: provider.providerId,
          modelId: profile.modelId,
          ok: false,
          failureKind: "network",
          detail: "client disconnected"
        });
        break;
      }
      const failure = classifyThrownFailure(error);
      options.health?.recordFailure(profile, failure);
      attemptChain.push({
        providerId: provider.providerId,
        modelId: profile.modelId,
        ok: false,
        failureKind: failure.kind,
        detail: failure.message
      });
      lastFailure = failure;
      if (!failure.retryable || attemptChain.length >= MAX_ATTEMPTS) break;
    } finally {
      clearTimeout(headerTimer);
    }
  }

  if (clientGone) {
    await logOutcome({
      options,
      summary,
      decision,
      decisionLatencyMs,
      primaryProfile,
      turnId,
      manual: Boolean(manualModelId),
      manualFirst,
      attemptChain,
      failureReason: "client disconnected before response completed"
    });
    return;
  }

  const failureDetail = attemptChain
    .map((attempt) =>
      attempt.providerId + "/" + attempt.modelId + ": " +
      (attempt.status !== undefined ? "HTTP " + attempt.status + " " : "") +
      (attempt.failureKind ?? "failed")
    )
    .join("; ");
  const failureReason = lastFailure
    ? lastFailure.kind + ": " + lastFailure.message
    : "No candidate model could be attempted";
  await logOutcome({
    options,
    summary,
    decision,
    decisionLatencyMs,
    primaryProfile,
    turnId,
    manual: Boolean(manualModelId),
    manualFirst,
    attemptChain,
    failureReason
  });
  const status = lastFailure?.status ?? 502;
  sendJson(response, status, {
    error: {
      message: redact(options, "Jev Router: all candidate models failed. " + (failureDetail || failureReason)),
      type: "model_router_error",
      param: null,
      code: lastFailure?.kind ?? "all_candidates_failed"
    },
    attempts: attemptChain.map((attempt) => ({
      ...attempt,
      detail: attempt.detail ? redact(options, attempt.detail) : attempt.detail
    }))
  });
}

interface LogOutcomeOptions {
  options: CodexProxyOptions;
  summary: ReturnType<typeof summarizeCodexRequest>;
  decision?: RouteDecision | undefined;
  decisionLatencyMs: number;
  primaryProfile: CapabilityProfile;
  turnId: string;
  manual: boolean;
  manualFirst: boolean;
  attemptChain: AttemptRecord[];
  ttftMs?: number;
  failureReason?: string;
}

async function logOutcome(args: LogOutcomeOptions): Promise<void> {
  const failedOver = args.attemptChain.some((attempt) => !attempt.ok);
  const notable =
    args.decision !== undefined || failedOver || args.failureReason !== undefined || args.manualFirst;
  if (!notable) return;

  const switchReason = failedOver && args.attemptChain.some((attempt) => attempt.ok)
    ? "technical_failure"
    : args.manual
      ? "manual_override"
      : args.decision?.fallback
        ? "fallback"
        : args.decision
          ? "new_task"
          : "same_turn";

  const loggedDecision: RouteDecision = args.decision
    ? { ...args.decision, turnId: args.turnId, switchReason }
    : {
        providerId: args.primaryProfile.providerId ?? "openai",
        modelId: args.primaryProfile.modelId,
        tier: args.primaryProfile.static.tier,
        confidence: 1,
        probabilities: { [args.primaryProfile.modelId]: 1 },
        factors: { taskType: "continuation", complexity: 0, reasoningRequired: 0, toolComplexity: 0 },
        profileVersion: args.primaryProfile.profileVersion,
        ...(args.manual ? { decisionSource: "manual" as const } : {}),
        turnId: args.turnId,
        switchReason
      };

  try {
    await args.options.logger.append({
      request: args.summary.request,
      decision: loggedDecision,
      latencyMs: args.decisionLatencyMs,
      turnId: args.turnId,
      switchReason,
      attemptChain: args.attemptChain.map((attempt) => ({
        ...attempt,
        ...(attempt.detail ? { detail: redact(args.options, attempt.detail) } : {})
      })),
      ...(args.ttftMs !== undefined ? { ttftMs: args.ttftMs } : {}),
      ...(args.failureReason !== undefined
        ? { failureReason: redact(args.options, args.failureReason) }
        : {})
    });
  } catch {
    // Logging must never break a request that otherwise succeeded.
  }
}

interface AttemptOrderOptions {
  primary: CapabilityProfile;
  candidates: CapabilityProfile[];
  health?: ModelHealthStore;
  allowLongTier: boolean;
  hasTools: boolean;
  fallbackModelId?: string;
  manual: boolean;
  maxAttempts: number;
}

function buildAttemptOrder(args: AttemptOrderOptions): CapabilityProfile[] {
  if (args.manual || args.maxAttempts <= 1) return [args.primary];

  let alternates = rankProfiles(
    args.candidates.filter((candidate) =>
      candidate.modelId !== args.primary.modelId &&
      candidate.runtime?.available !== false &&
      (args.allowLongTier || candidate.static.tier !== "frontier") &&
      (!args.hasTools || candidate.static.supportsTools)
    )
  );
  if (args.fallbackModelId) {
    const preferredIndex = alternates.findIndex((candidate) => candidate.modelId === args.fallbackModelId);
    if (preferredIndex > 0) {
      const preferred = alternates[preferredIndex] as CapabilityProfile;
      alternates = [preferred, ...alternates.filter((_candidate, index) => index !== preferredIndex)];
    }
  }

  const health = args.health;
  const healthy = health
    ? alternates.filter((candidate) => !health.isCoolingDown(candidate))
    : alternates;
  const usable = healthy.length > 0
    ? healthy
    : alternates.filter((candidate) => !health || !health.isPermanentlyDisabled(candidate));

  // A primary model in cooldown is skipped when a healthy alternate exists.
  if (health && health.isCoolingDown(args.primary)) {
    if (health.isPermanentlyDisabled(args.primary)) {
      return usable.slice(0, args.maxAttempts);
    }
    if (usable.length > 0) return usable.slice(0, args.maxAttempts);
  }
  return [args.primary, ...usable.slice(0, args.maxAttempts - 1)];
}

function resolveExecutionProvider(
  options: CodexProxyOptions,
  providerId: string
): ExecutionProvider | undefined {
  const providers = options.executionProviders ?? [];
  return providers.find((provider) => provider.providerId === providerId);
}

function findCandidate(candidates: CapabilityProfile[], modelId: string): CapabilityProfile | undefined {
  return candidates.find((candidate) => candidate.modelId === modelId);
}

function adHocProfile(modelId: string): CapabilityProfile {
  return {
    providerId: "passthrough",
    modelId,
    profileVersion: "adhoc",
    updatedAt: new Date().toISOString(),
    static: {
      tier: "medium",
      contextLimit: 128_000,
      supportsTools: true,
      strengths: [],
      constraints: ["selected outside the configured profile directory"]
    }
  };
}

/**
 * Simple routed tasks keep moving: when Jev rates complexity at or below 1.5
 * (of its 0-4 scale) and the request already carries a reasoning effort, drop
 * it to "low". Requests without a reasoning field are never modified.
 */
function withSimpleReasoning(request: CodexResponsesRequest): CodexResponsesRequest {
  const reasoning = request.reasoning;
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) return request;
  const effort = (reasoning as { effort?: unknown }).effort;
  if (typeof effort !== "string") return request;
  return {
    ...request,
    reasoning: { ...(reasoning as Record<string, unknown>), effort: "low" }
  };
}

async function pipeUpstream(
  upstream: Response,
  response: ServerResponse,
  startedAt: number
): Promise<{ ttftMs?: number; failureReason?: string }> {
  response.statusCode = upstream.status;
  for (const name of ["content-type", "x-request-id", "openai-processing-ms", "retry-after"]) {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  }
  if (!upstream.body) {
    response.end();
    return {};
  }

  let ttftMs: number | undefined;
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      if (ttftMs === undefined) ttftMs = Math.round(performance.now() - startedAt);
      callback(null, chunk);
    }
  });
  const stream = Readable.fromWeb(upstream.body as never);
  try {
    await pipeline(stream, tap, response);
    return ttftMs !== undefined ? { ttftMs } : {};
  } catch (error) {
    return {
      ...(ttftMs !== undefined ? { ttftMs } : {}),
      failureReason: "stream interrupted: " + (error instanceof Error ? error.message : String(error))
    };
  }
}

function forwardHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();
  const skip = new Set([
    "host",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection"
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (skip.has(name.toLowerCase())) continue;
    if (typeof value === "string") result.set(name, value);
    else if (Array.isArray(value)) for (const entry of value) result.append(name, entry);
  }
  return result;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(body));
}

function redact(options: CodexProxyOptions, text: string): string {
  const scrubbed = text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, "***")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, "$1***");
  return options.redact ? options.redact(scrubbed) : scrubbed;
}
