import { spawn } from "node:child_process";
import type {
  CapabilityProfile,
  DecisionLogger,
  HostAdapter,
  HostCapabilities,
  RouteDecision,
  RouteEngine
} from "@jev-router/core";
import { loadProfileDirectory } from "@jev-router/core";
import type { ModelHealthStore } from "@jev-router/core";
import type { ExecutionProvider } from "./execution.js";
import { startCodexProxy } from "./proxy.js";

export interface CodexLaunchOptions {
  routeEngine: RouteEngine;
  candidates: CapabilityProfile[];
  logger: DecisionLogger;
  profilesDirectory: string;
  upstreamUrl?: string;
  fallbackModelId?: string;
  allowLongTier?: boolean;
  codexBin?: string;
  executionProviders?: ExecutionProvider[];
  health?: ModelHealthStore;
  sentinelModels?: string[];
  adjustReasoning?: boolean;
  headerTimeoutMs?: number;
  redact?: (text: string) => string;
}

export function hasExplicitModel(args: readonly string[]): boolean {
  return args.some((argument, index) =>
    argument === "-m" || argument === "--model" ||
    (argument.startsWith("--model=") && argument.length > "--model=".length) ||
    (args[index - 1] === "-c" && argument.startsWith("model="))
  );
}

export function buildCodexArgs(proxyPort: number, userArgs: readonly string[]): string[] {
  const provider = `http://127.0.0.1:${proxyPort}/v1`;
  return [
    "-c", 'model_providers.jev_router.name="Jev Router"',
    "-c", `model_providers.jev_router.base_url="${provider}"`,
    "-c", "model_providers.jev_router.requires_openai_auth=true",
    "-c", 'model_providers.jev_router.wire_api="responses"',
    "-c", 'model_provider="jev_router"',
    "-c", 'model="jev-router"',
    ...userArgs
  ];
}

export async function launchCodex(options: CodexLaunchOptions, userArgs: readonly string[]): Promise<number> {
  const codexBin = options.codexBin ?? "codex";
  if (hasExplicitModel(userArgs)) {
    return spawnAndWait(codexBin, [...userArgs]);
  }

  const proxy = await startCodexProxy({
    routeEngine: options.routeEngine,
    routeEngineCandidates: options.candidates,
    logger: options.logger,
    upstreamUrl: options.upstreamUrl ?? process.env.JEV_CODEX_UPSTREAM_URL ?? "https://api.openai.com/v1/responses",
    ...(options.fallbackModelId ? { fallbackModelId: options.fallbackModelId } : {}),
    allowLongTier: options.allowLongTier === true,
    ...(options.executionProviders ? { executionProviders: options.executionProviders } : {}),
    ...(options.health ? { health: options.health } : {}),
    ...(options.sentinelModels ? { sentinelModels: options.sentinelModels } : {}),
    ...(options.adjustReasoning !== undefined ? { adjustReasoning: options.adjustReasoning } : {}),
    ...(options.headerTimeoutMs !== undefined ? { headerTimeoutMs: options.headerTimeoutMs } : {}),
    ...(options.redact ? { redact: options.redact } : {})
  });

  try {
    return await spawnAndWait(codexBin, buildCodexArgs(proxy.port, userArgs));
  } finally {
    await proxy.close();
  }
}

function spawnAndWait(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: "inherit", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (typeof code === "number") resolve(code);
      else reject(new Error(`Codex exited with signal ${String(signal)}`));
    });
  });
}

export class CodexHostAdapter implements HostAdapter {
  readonly id = "codex";
  private currentDecision?: RouteDecision;

  constructor(private readonly profilesDirectory: string) {}

  async detect(): Promise<HostCapabilities> {
    return {
      version: "0.155.0-alpha.16.4",
      supportsCustomProvider: true,
      supportsManualModelSelection: true
    };
  }

  async listModels(): Promise<CapabilityProfile[]> {
    return loadProfileDirectory(this.profilesDirectory);
  }

  async applyDecision(decision: RouteDecision): Promise<void> {
    if (!decision.modelId || !decision.profileVersion) {
      throw new Error("Invalid route decision");
    }
    this.currentDecision = decision;
  }

  async restoreOriginalState(): Promise<void> {
    delete this.currentDecision;
  }

  get decision(): RouteDecision | undefined {
    return this.currentDecision;
  }
}
