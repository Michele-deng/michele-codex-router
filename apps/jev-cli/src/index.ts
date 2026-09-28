#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  appendFileSync,
  readFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DESKTOP_AUTOSTART_FILE,
  DESKTOP_MANAGED_MARKER,
  SENTINEL_MODEL_ID,
  backupConfig,
  catalogHasSentinel,
  configHasManagedMarker,
  installDesktopAutostart,
  desktopPaths,
  desktopAutostartExists,
  discoverProviderWiring,
  fetchModelIds,
  injectDesktopConfig,
  isPortAccepting,
  launchCodex,
  mergeModelCatalog,
  profilesFromModelIds,
  probeProxyHealth,
  readIntegrationRecord,
  readRootConfigLine,
  readRootConfigValue,
  removeDesktopAutostart,
  removeIntegrationRecord,
  restoreDesktopConfig,
  startCodexProxy,
  startServiceDetached,
  stopOwnService,
  waitForProxyHealth,
  writeIntegrationRecord,
  type CodexProxy,
  type ProviderWiring
} from "@jev-router/adapter-codex";
import {
  collectSecretValues,
  describeConfig,
  loadJevConfig,
  redactDeep,
  redactText,
  type JevConfig
} from "@jev-router/config";
import {
  DecisionLogger,
  ModelHealthStore,
  RouteEngine,
  StaticDecisionProvider,
  loadProfileDirectory,
  type CapabilityProfile,
  type RouteInput,
  type TypedDecisionProvider
} from "@jev-router/core";
import { startMcpStdio } from "@jev-router/mcp";
import { DeepSeekExecutionProvider } from "@jev-router/provider-deepseek";
import { LocalRuntimeProbe } from "@jev-router/provider-local";
import { OpenAiCompatibleRuntimeProbe } from "@jev-router/provider-openai";
import { TypesafeDecisionProvider } from "@jev-router/provider-typesafe";
import { UpstreamExecutionProvider, type ExecutionProvider } from "@jev-router/adapter-codex";

const execFileAsync = promisify(execFile);
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "../../..");

async function main(): Promise<number> {
  const config = loadJevConfig({ projectRoot });
  const executable = path.basename(process.argv[1] ?? "jev").toLowerCase();
  const originalArgs = process.argv.slice(2);
  const command = executable.startsWith("jev-codex") ? "codex" : originalArgs.shift() ?? "help";
  switch (command) {
    case "codex": return runCodex(config, originalArgs);
    case "route": return runRoute(config, originalArgs);
    case "profiles": return runProfiles(config);
    case "health": return runHealth(config);
    case "health-reset": return runHealthReset(config, originalArgs);
    case "doctor": return runDoctorCommand(config);
    case "explain": return runExplain(config);
    case "mcp": return runMcp(config);
    case "setup-key": case "setup": return runSetupKey(config);
    case "desktop": return runDesktop(config, originalArgs);
    case "help": case "--help": case "-h": printHelp(); return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      printHelp();
      return 2;
  }
}

async function runCodex(config: JevConfig, args: readonly string[]): Promise<number> {
  const health = new ModelHealthStore(config.dataDirectory);
  await health.load();
  const { wiring, defaultUrl } = await resolveUpstream(config);
  return launchCodex({
    routeEngine: createRouteEngine(config),
    candidates: await loadProfiles(config),
    logger: createLogger(config),
    profilesDirectory: config.profilesDirectory,
    codexBin: resolveCodexBinary(config.codexBin),
    upstreamUrl: defaultUrl,
    allowLongTier: config.allowLongTier,
    executionProviders: buildExecutionProviders(config, wiring, defaultUrl),
    health,
    sentinelModels: config.sentinelModels,
    adjustReasoning: config.adjustReasoning,
    headerTimeoutMs: config.upstreamHeaderTimeoutMs,
    redact: (text) => redactText(text, collectSecretValues()),
    ...(config.fallback.modelId ? { fallbackModelId: config.fallback.modelId } : {})
  }, args);
}

async function resolveUpstream(config: JevConfig): Promise<{ wiring: ProviderWiring; defaultUrl: string }> {
  const deepseekKey = config.readSecret("deepseekApiKey");
  const wiring = await discoverProviderWiring({
    configPath: codexConfigPath(),
    env: {
      ...(config.deepseek.baseUrl ? { DEEPSEEK_BASE_URL: config.deepseek.baseUrl } : {}),
      ...(deepseekKey ? { DEEPSEEK_API_KEY: deepseekKey } : {}),
      ...(config.deepseek.wireApi ? { DEEPSEEK_WIRE_API: config.deepseek.wireApi } : {})
    }
  });
  const defaultUrl = config.codex.upstreamUrl ??
    (wiring.wireApi === "chat"
      ? wiring.baseUrl + "/chat/completions"
      : wiring.baseUrl + "/responses");
  return { wiring, defaultUrl };
}

function buildExecutionProviders(
  config: JevConfig,
  wiring: ProviderWiring,
  defaultUrl: string
): ExecutionProvider[] {
  const deepseekKey = config.readSecret("deepseekApiKey");
  const providers: ExecutionProvider[] = [
    new UpstreamExecutionProvider("openai", defaultUrl),
    wiring.wireApi === "chat"
      ? new DeepSeekExecutionProvider({
          baseUrl: wiring.baseUrl,
          ...(wiring.bearerToken ? { apiKey: wiring.bearerToken } : {}),
          wireApi: "chat",
          providerId: "passthrough"
        })
      : new UpstreamExecutionProvider("passthrough", wiring.baseUrl + "/responses")
  ];
  providers.push(
    new DeepSeekExecutionProvider({
      baseUrl: config.deepseek.baseUrl ?? wiring.baseUrl,
      ...(deepseekKey ?? wiring.bearerToken
        ? { apiKey: (deepseekKey ?? wiring.bearerToken) as string }
        : {}),
      wireApi: config.deepseek.wireApi
    })
  );
  return providers;
}

async function runRoute(config: JevConfig, args: readonly string[]): Promise<number> {
  const explicitIndex = args.findIndex((argument) => argument === "--model" || argument === "-m");
  const explicitModelId = explicitIndex >= 0 ? args[explicitIndex + 1] : undefined;
  const requestArgs = args.filter((_, index) => explicitIndex < 0 || (index !== explicitIndex && index !== explicitIndex + 1));
  const request = requestArgs.length > 0 ? requestArgs.join(" ") : await readStdin();
  if (!request.trim()) {
    process.stderr.write("A non-empty request is required.\n");
    return 2;
  }
  const engine = createRouteEngine(config);
  const startedAt = performance.now();
  const input: RouteInput = {
    request,
    candidates: await loadProfiles(config),
    preferences: {
      ...(explicitModelId ? { explicitModelId } : {}),
      longTierEnabled: config.allowLongTier
    }
  };
  const decision = await engine.route(input);
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
  return 0;
}

async function runProfiles(config: JevConfig): Promise<number> {
  process.stdout.write(`${JSON.stringify(await loadProfiles(config), null, 2)}\n`);
  return 0;
}

async function runHealth(config: JevConfig): Promise<number> {
  const profiles = await loadProfiles(config);
  const healthStore = new ModelHealthStore(config.dataDirectory);
  await healthStore.load();
  const codexBin = resolveCodexBinary(config.codexBin);
  let codexVersion = "not found";
  try {
    codexVersion = (await execFileAsync(codexBin, ["--version"])).stdout.trim();
  } catch {
    codexVersion = "not found";
  }
  const issues: Array<{ level: "error" | "warning"; message: string }> = [];
  if (codexVersion === "not found") {
    issues.push({ level: "error", message: "Codex CLI not found; set JEV_CODEX_BIN in .env" });
  }
  if (profiles.length === 0) {
    issues.push({ level: "error", message: "no model profiles; run: node apps/jev-cli/dist/index.js doctor" });
  }
  if (!config.typesafe.configured) {
    issues.push({ level: "warning", message: "TYPESAFE_API_KEY not set; decisions use local rules" });
  }
  const report = {
    ok: !issues.some((issue) => issue.level === "error"),
    issues,
    node: process.version,
    codex: codexVersion,
    codexExecutable: codexBin,
    profileCount: profiles.length,
    profileIds: profiles.map((profile) => profile.modelId),
    modelHealth: healthStore.snapshot(),
    autoDisabledModels: healthStore.snapshot()
      .filter((record) => record.permanent)
      .map((record) => record.providerId + "/" + record.modelId),
    explicitModelBypass: true,
    ...describeConfig(config)
  };
  process.stdout.write(`${JSON.stringify(redactDeep(report), null, 2)}\n`);
  return 0;
}

async function runHealthReset(config: JevConfig, args: readonly string[]): Promise<number> {
  const target = args[0];
  const store = new ModelHealthStore(config.dataDirectory);
  await store.load();
  const removed = store.reset(target);
  process.stdout.write(
    JSON.stringify({
      ok: true,
      target: target ?? "all",
      removed,
      note: "applies to the running desktop service immediately (hot reload)"
    }, null, 2) + "\n"
  );
  return 0;
}

interface DoctorOutcome {
  ok: boolean;
  issues: string[];
  warnings: string[];
  wiring: ProviderWiring;
  defaultUrl: string;
  report: Record<string, unknown>;
  fetched: Awaited<ReturnType<typeof fetchModelIds>> | undefined;
}

/**
 * Environment doctor: discover the user's upstream wiring, probe its model
 * list, and report what is missing. Never prints secrets. Does not modify
 * anything (enable commits generated profiles after preflight passes).
 */
async function runDoctor(config: JevConfig): Promise<DoctorOutcome> {
  const { wiring, defaultUrl } = await resolveUpstream(config);
  const issues: string[] = [];
  const warnings: string[] = [];
  const report: Record<string, unknown> = {
    wiring: {
      source: wiring.source,
      kind: wiring.kind,
      baseUrl: wiring.baseUrl,
      wireApi: wiring.wireApi,
      authConfigured: Boolean(wiring.bearerToken ?? wiring.requiresOpenaiAuth)
    },
    upstreamUrl: defaultUrl
  };

  let fetched: Awaited<ReturnType<typeof fetchModelIds>> | undefined;
  try {
    fetched = await fetchModelIds(wiring);
  } catch (error) {
    warnings.push(
      "model list probe failed: " + (error instanceof Error ? error.message : String(error)) +
        "; existing profiles will be used and must be verified manually"
    );
  }
  if (fetched && fetched.ids.length === 0) {
    issues.push(
      "upstream model list is empty at " + wiring.modelsUrl +
        "; point JEV_CODEX_UPSTREAM_URL/DEEPSEEK_BASE_URL at a working endpoint"
    );
  }
  const existing = await loadProfiles(config);
  if (existing.length === 0 && !(fetched && fetched.ids.length > 0)) {
    issues.push(
      "no model profiles in " + config.profilesDirectory +
        "; run doctor after the upstream responds, or copy examples from profiles/examples and rename to your model ids"
    );
  }
  report.models = { count: fetched?.ids.length ?? 0, sample: (fetched?.ids ?? []).slice(0, 5) };
  report.profiles = { directory: config.profilesDirectory, existing: existing.length };
  return { ok: issues.length === 0, issues, warnings, wiring, defaultUrl, report, fetched };
}

async function writeGeneratedProfiles(
  config: JevConfig,
  fetched: Awaited<ReturnType<typeof fetchModelIds>>
): Promise<number> {
  const profiles = profilesFromModelIds(fetched);
  await mkdir(config.profilesDirectory, { recursive: true });
  let written = 0;
  for (const profile of profiles) {
    const fileName = profile.modelId.replace(/[\/\\]/g, "__") + ".json";
    // Never overwrite: an existing file may carry manual tier/context
    // calibration (test plan PROF-005). Delete the file to regenerate it.
    if (existsSync(path.join(config.profilesDirectory, fileName))) continue;
    await writeFile(
      path.join(config.profilesDirectory, fileName),
      JSON.stringify(profile, null, 2) + "\n",
      "utf8"
    );
    written += 1;
  }
  return written;
}

async function runDoctorCommand(config: JevConfig): Promise<number> {
  const doctor = await runDoctor(config);
  let generated = 0;
  if (doctor.ok && doctor.fetched) {
    generated = await writeGeneratedProfiles(config, doctor.fetched);
  }
  process.stdout.write(
    JSON.stringify(
      {
        ok: doctor.ok,
        issues: doctor.issues,
        warnings: doctor.warnings,
        profilesGenerated: generated,
        ...doctor.report
      },
      null,
      2
    ) + "\n"
  );
  return doctor.ok ? 0 : 1;
}

/** Adds a value to .env only when the key is absent or empty; never overwrites. */
function ensureEnvValue(envFile: string, key: string, value: string): boolean {
  try {
    const current = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    const lines = current.split(/\r?\n/);
    const pattern = new RegExp("^" + key + "=");
    const index = lines.findIndex((line) => pattern.test(line));
    if (index >= 0) {
      const existingValue = (lines[index] as string).slice(key.length + 1).trim();
      if (existingValue) return false;
      lines[index] = key + "=" + value + "   # auto-detected by jev doctor";
    } else {
      lines.push(key + "=" + value + "   # auto-detected by jev doctor");
    }
    writeFileSync(envFile, lines.join(eol), "utf8");
    return true;
  } catch {
    return false;
  }
}

async function runExplain(config: JevConfig): Promise<number> {
  const latest = await createLogger(config).latest();
  process.stdout.write(`${JSON.stringify(latest ?? { message: "No decision recorded" }, null, 2)}\n`);
  return 0;
}

async function runMcp(config: JevConfig): Promise<number> {
  startMcpStdio({
    routeEngine: createRouteEngine(config),
    candidates: await loadProfiles(config),
    logger: createLogger(config),
    config
  });
  return 0;
}

async function runSetupKey(config: JevConfig): Promise<number> {
  if (existsSync(config.envFile)) {
    process.stdout.write(
      [
        "Configuration file already exists:",
        `  ${config.envFile}`,
        "",
        "Open it, fill in TYPESAFE_API_KEY, save, then run: npm run health",
        ""
      ].join("\n")
    );
    return 0;
  }
  const template = path.join(config.projectRoot, ".env.example");
  mkdirSync(path.dirname(config.envFile), { recursive: true });
  if (existsSync(template)) {
    copyFileSync(template, config.envFile);
  } else {
    writeFileSync(config.envFile, "TYPESAFE_API_KEY=\n", { encoding: "utf8", mode: 0o600 });
  }
  process.stdout.write(
    [
      "Created configuration file:",
      `  ${config.envFile}`,
      "",
      "Open it, fill in TYPESAFE_API_KEY, save, then run: npm run health",
      ""
    ].join("\n")
  );
  return 0;
}

async function loadProfiles(config: JevConfig): Promise<CapabilityProfile[]> {
  let profiles = await loadProfileDirectory(config.profilesDirectory);
  const openaiBaseUrl = config.probes.openaiBaseUrl;
  if (openaiBaseUrl) {
    profiles = await new OpenAiCompatibleRuntimeProbe(openaiBaseUrl, config.readSecret("openaiApiKey")).probe(profiles);
  }
  const ollamaUrl = config.probes.ollamaUrl;
  if (ollamaUrl) {
    profiles = await new LocalRuntimeProbe("ollama", ollamaUrl).probe(profiles);
  }
  const lmstudioUrl = config.probes.lmstudioUrl;
  if (lmstudioUrl) {
    profiles = await new LocalRuntimeProbe("lmstudio", lmstudioUrl).probe(profiles);
  }
  return profiles;
}

function createLogger(config: JevConfig): DecisionLogger {
  return new DecisionLogger(
    config.dataDirectory,
    config.logExcerpt,
    (text) => redactText(text, collectSecretValues())
  );
}

const CODEX_BINARY_CANDIDATES = process.platform === "win32"
  ? ["codex.exe", "codex.cmd", "codex"]
  : ["codex"];

function resolveCodexBinary(configured: string | undefined): string {
  if (configured) return configured;
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const rawDirectory of pathValue.split(path.delimiter)) {
    // Windows PATH entries are sometimes quoted; strip the quotes so the
    // joined path is usable instead of starting with a literal quote.
    const directory = rawDirectory.replace(/^"(.*)"$/, "$1").trim();
    if (!directory) continue;
    for (const name of CODEX_BINARY_CANDIDATES) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  const discovered = discoverCodexBinary();
  if (discovered) return discovered;
  return CODEX_BINARY_CANDIDATES[0] ?? "codex";
}

/**
 * The Codex desktop app only injects its versioned bin directory into the PATH
 * of processes it spawns itself, so a normal shell cannot find codex.exe there.
 * Fall back to the known install location and pick the newest version.
 */
function discoverCodexBinary(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return undefined;
  const binRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  let versionDirectories: string[];
  try {
    versionDirectories = readdirSync(binRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(binRoot, entry.name));
  } catch {
    return undefined;
  }

  const matches: Array<{ executable: string; mtime: number }> = [];
  for (const directory of versionDirectories) {
    for (const name of CODEX_BINARY_CANDIDATES) {
      const executable = path.join(directory, name);
      if (!existsSync(executable)) continue;
      let mtime = 0;
      try {
        mtime = statSync(directory).mtimeMs;
      } catch {
        // Unreadable directory simply ranks last.
      }
      matches.push({ executable, mtime });
      break;
    }
  }
  matches.sort((left, right) => right.mtime - left.mtime);
  return matches[0]?.executable;
}

function createRouteEngine(config: JevConfig): RouteEngine {
  return new RouteEngine(
    createDecisionProvider(config),
    config.fallback.modelId,
    0.55,
    config.routeTimeoutMs,
    config.decisionPolicy
  );
}

function createDecisionProvider(config: JevConfig): TypedDecisionProvider {
  if (config.decisionProvider === "static") return new StaticDecisionProvider();
  if (config.decisionProvider === "local") {
    process.stderr.write("Local decision providers are not implemented yet; using rule-based routing.\n");
    return new StaticDecisionProvider();
  }
  const apiKey = config.readSecret("typesafeApiKey");
  return new TypesafeDecisionProvider({
    ...(apiKey ? { apiKey } : {}),
    endpoint: config.typesafe.endpoint,
    model: config.typesafe.model,
    timeoutMs: config.routeTimeoutMs
  });
}

function codexConfigPath(): string {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.join(codexHome, "config.toml");
}

function cliEntryPath(): string {
  return path.join(moduleDirectory, "index.js");
}

async function runDesktop(config: JevConfig, args: readonly string[]): Promise<number> {
  const subcommand = args[0] ?? "status";
  switch (subcommand) {
    case "run": return runDesktopService(config);
    case "enable": return runDesktopEnable(config);
    case "status": return runDesktopStatus(config);
    case "disable": return runDesktopDisable(config);
    default:
      process.stderr.write(
        "Unknown desktop subcommand: " + subcommand + "\n" +
        "Usage: jev desktop run|enable|status|disable\n"
      );
      return 2;
  }
}

async function resolveCatalogSource(config: JevConfig): Promise<string | undefined> {
  const paths = desktopPaths(config.dataDirectory);
  const configPath = codexConfigPath();
  const record = await readIntegrationRecord(config.dataDirectory);
  const candidates = [
    record?.originalValues.model_catalog_json ?? undefined,
    await readRootConfigValue(configPath, "model_catalog_json"),
    path.join(path.dirname(configPath), "opencodex-catalog.json")
  ];
  for (const candidate of candidates) {
    if (candidate && candidate !== paths.catalogPath && existsSync(candidate)) return candidate;
  }
  return undefined;
}

async function runDesktopService(config: JevConfig): Promise<number> {
  const paths = desktopPaths(config.dataDirectory);
  const log = async (message: string): Promise<void> => {
    try {
      await mkdir(config.dataDirectory, { recursive: true });
      await appendFile(
        paths.serviceLog,
        "[" + new Date().toISOString() + "] " + redactText(message, collectSecretValues()) + "\n",
        "utf8"
      );
    } catch {
      // Service logging is best effort.
    }
  };

  const crashLog = (label: string, error: unknown): void => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    try {
      appendFileSync(
        paths.serviceLog,
        "[" + new Date().toISOString() + "] " + label + ": " +
          redactText(detail, collectSecretValues()).slice(0, 2_000) + "\n",
        "utf8"
      );
    } catch {
      // Last-resort logging must not throw.
    }
  };
  process.on("uncaughtException", (error) => {
    crashLog("uncaughtException", error);
    process.exit(1);
  });
  process.on("unhandledRejection", (error) => {
    crashLog("unhandledRejection", error);
    process.exit(1);
  });
  process.on("exit", (code) => {
    try {
      appendFileSync(
        paths.serviceLog,
        "[" + new Date().toISOString() + "] exit code=" + code + "\n",
        "utf8"
      );
    } catch {
      // Ignore.
    }
  });

  await log("starting on port " + config.proxyPort);
  const probe = await probeProxyHealth(config.proxyPort);
  if (probe.ours) {
    await log("already running; exiting");
    return 0;
  }
  if (probe.reachable) {
    await log("port " + config.proxyPort + " is used by another service; exiting");
    return 1;
  }

  try {
    const source = await resolveCatalogSource(config);
    if (source) {
      const merged = await mergeModelCatalog(source, paths.catalogPath);
      await log("catalog merged: " + merged.entryCount + " entries, sentinel from " + merged.sentinelFrom);
    } else {
      await log("catalog source not found; keeping existing merged catalog");
    }
  } catch (error) {
    await log("catalog merge failed: " + (error instanceof Error ? error.message : String(error)));
  }

  const healthStore = new ModelHealthStore(config.dataDirectory);
  await healthStore.load();
  let proxy: CodexProxy;
  const { wiring, defaultUrl } = await resolveUpstream(config);
  try {
    proxy = await startCodexProxy({
      routeEngine: createRouteEngine(config),
      routeEngineCandidates: await loadProfiles(config),
      logger: createLogger(config),
      upstreamUrl: defaultUrl,
      allowLongTier: config.allowLongTier,
      executionProviders: buildExecutionProviders(config, wiring, defaultUrl),
      health: healthStore,
      port: config.proxyPort,
    sentinelModels: config.sentinelModels,
    adjustReasoning: config.adjustReasoning,
    headerTimeoutMs: config.upstreamHeaderTimeoutMs,
    redact: (text) => redactText(text, collectSecretValues()),
      ...(config.fallback.modelId ? { fallbackModelId: config.fallback.modelId } : {})
    });
  } catch (error) {
    await log("listen failed: " + (error instanceof Error ? error.message : String(error)));
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    return 1;
  }

  await log("listening at http://127.0.0.1:" + proxy.port + "/v1");
  process.stdout.write("Jev Router desktop proxy listening on 127.0.0.1:" + proxy.port + "\n");
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      void proxy.close().finally(() => resolve());
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await log("stopped");
  return 0;
}

async function runDesktopEnable(config: JevConfig): Promise<number> {
  const configPath = codexConfigPath();
  const paths = desktopPaths(config.dataDirectory);
  const steps: string[] = [];
  const issues: string[] = [];

  if (!existsSync(configPath)) {
    process.stderr.write("Codex config not found: " + configPath + "\n");
    return 1;
  }
  const probe = await probeProxyHealth(config.proxyPort);
  if (probe.reachable && !probe.ours) {
    process.stderr.write(
      "Port " + config.proxyPort + " is used by another service. " +
      "Set JEV_PROXY_PORT to a free port and retry.\n"
    );
    return 1;
  }

  const doctor = await runDoctor(config);
  for (const warning of doctor.warnings) steps.push("warning: " + warning);
  if (!doctor.ok) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          refused: true,
          reason: "preflight failed; nothing was modified",
          issues: doctor.issues,
          warnings: doctor.warnings,
          ...doctor.report
        },
        null,
        2
      ) + "\n"
    );
    return 1;
  }
  if (doctor.fetched) {
    const generated = await writeGeneratedProfiles(config, doctor.fetched);
    steps.push("profiles generated: " + generated + " in " + config.profilesDirectory);
  }
  if (
    !config.codex.upstreamUrl &&
    ensureEnvValue(config.envFile, "JEV_CODEX_UPSTREAM_URL", doctor.defaultUrl)
  ) {
    steps.push(".env JEV_CODEX_UPSTREAM_URL auto-filled from your wiring");
  }
  steps.push(
    "doctor: upstream " + doctor.wiring.baseUrl + " (" + doctor.wiring.source + "), models=" +
      String((doctor.report.models as { count?: number } | undefined)?.count ?? 0)
  );

  const backup = await backupConfig(configPath, config.dataDirectory);
  steps.push("config backed up: " + backup);

  const source = await resolveCatalogSource(config);
  if (!source) {
    process.stderr.write(
      "Model catalog source not found. Start opencodex once so it writes " +
      "opencodex-catalog.json, then retry.\n"
    );
    return 1;
  }
  const merged = await mergeModelCatalog(source, paths.catalogPath);
  steps.push("model catalog merged: " + merged.entryCount + " entries (sentinel from " + merged.sentinelFrom + ")");

  const previousRecord = await readIntegrationRecord(config.dataDirectory);
  const injected = await injectDesktopConfig({
    configPath,
    dataDirectory: config.dataDirectory,
    port: config.proxyPort,
    catalogPath: paths.catalogPath,
    auth: {
      requiresOpenaiAuth: doctor.wiring.requiresOpenaiAuth === true,
      ...(doctor.wiring.bearerToken ? { bearerToken: doctor.wiring.bearerToken } : {})
    },
    ...(previousRecord ? { previousRecord } : {})
  });
  await writeIntegrationRecord(config.dataDirectory, injected.record);
  steps.push("config keys updated: " + injected.changedKeys.join(", "));

  const autostartPath = await installDesktopAutostart({
    cliPath: cliEntryPath(),
    dataDirectory: config.dataDirectory,
    nodePath: process.execPath
  });
  steps.push("autostart installed: " + autostartPath);

  if (!probe.ours) {
    startServiceDetached(cliEntryPath(), process.execPath);
  }
  const healthy = await waitForProxyHealth(config.proxyPort, 10_000);
  steps.push(healthy ? "proxy running on port " + config.proxyPort : "proxy FAILED to start");
  if (!healthy) issues.push("proxy is not responding; check " + paths.serviceLog);

  const status = await collectDesktopStatus(config);
  issues.push(...status.issues);
  process.stdout.write(JSON.stringify({ ok: issues.length === 0, steps, ...status }, null, 2) + "\n");
  return issues.length === 0 ? 0 : 1;
}

interface DesktopStatus {
  port: number;
  proxyRunning: boolean;
  config: {
    modelProvider: string | null;
    modelProviderOk: boolean;
    catalogPath: string | null;
    catalogPathOk: boolean;
    managedMarker: boolean;
    legacyOpenAiHijack: boolean;
  };
  catalog: { path: string; sentinelPresent: boolean };
  autostart: { file: string; exists: boolean };
  integrationRecord: { exists: boolean };
  upstream: { url: string; reachable: boolean };
  disabledModels: string[];
  issues: string[];
}

async function collectDesktopStatus(config: JevConfig): Promise<DesktopStatus> {
  const paths = desktopPaths(config.dataDirectory);
  const configPath = codexConfigPath();
  const modelProvider = await readRootConfigValue(configPath, "model_provider");
  const legacyLine = await readRootConfigLine(configPath, "openai_base_url");
  const legacyOpenAiHijack = legacyLine?.includes(DESKTOP_MANAGED_MARKER) ?? false;
  const catalogPath = await readRootConfigValue(configPath, "model_catalog_json");
  const managedMarker = await configHasManagedMarker(configPath);
  const sentinelPresent = await catalogHasSentinel(paths.catalogPath);
  const autostartInstalled = await desktopAutostartExists();
  const record = await readIntegrationRecord(config.dataDirectory);
  const proxy = await probeProxyHealth(config.proxyPort);
  const { defaultUrl: effectiveUpstreamUrl } = await resolveUpstream(config);
  const upstream = await upstreamReachable(effectiveUpstreamUrl);
  const healthStore = new ModelHealthStore(config.dataDirectory);
  await healthStore.load();
  const disabledModels = healthStore.snapshot()
    .filter((entry) => entry.permanent)
    .map((entry) => entry.providerId + "/" + entry.modelId);

  const issues: string[] = [];
  if (!proxy.ours) {
    issues.push("proxy is not running on port " + config.proxyPort + " (run: jev desktop enable)");
  }
  if (modelProvider !== "jev_router" || !managedMarker) {
    issues.push("model_provider does not select the Jev Router provider (run: jev desktop enable)");
  }
  if (legacyOpenAiHijack) {
    issues.push("legacy managed openai_base_url present (run: jev desktop enable to migrate)");
  }
  if (catalogPath !== paths.catalogPath) {
    issues.push("model_catalog_json does not point at the Jev merged catalog (run: jev desktop enable)");
  }
  if (!sentinelPresent) {
    issues.push("merged catalog is missing the " + SENTINEL_MODEL_ID + " entry (run: jev desktop enable)");
  }
  if (!autostartInstalled) {
    issues.push("startup entry " + DESKTOP_AUTOSTART_FILE + " is missing (run: jev desktop enable)");
  }
  if (!record) {
    issues.push("integration record is missing (run: jev desktop enable)");
  }
  if (!upstream.reachable) {
    issues.push("upstream " + config.codex.upstreamUrl + " is not reachable");
  }

  return {
    port: config.proxyPort,
    proxyRunning: proxy.ours,
    config: {
      modelProvider,
      modelProviderOk: modelProvider === "jev_router",
      catalogPath,
      catalogPathOk: catalogPath === paths.catalogPath,
      managedMarker,
      legacyOpenAiHijack
    },
    catalog: { path: paths.catalogPath, sentinelPresent },
    autostart: { file: DESKTOP_AUTOSTART_FILE, exists: autostartInstalled },
    integrationRecord: { exists: Boolean(record) },
    upstream: { url: effectiveUpstreamUrl, reachable: upstream.reachable },
    disabledModels,
    issues
  };
}

async function upstreamReachable(url: string): Promise<{ reachable: boolean }> {
  try {
    const parsed = new URL(url);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
    return { reachable: await isPortAccepting(port, 1_200) };
  } catch {
    return { reachable: false };
  }
}

async function runDesktopStatus(config: JevConfig): Promise<number> {
  const status = await collectDesktopStatus(config);
  process.stdout.write(JSON.stringify({ ok: status.issues.length === 0, ...status }, null, 2) + "\n");
  return status.issues.length === 0 ? 0 : 1;
}

async function runDesktopDisable(config: JevConfig): Promise<number> {
  const configPath = codexConfigPath();
  const paths = desktopPaths(config.dataDirectory);
  const steps: string[] = [];
  const issues: string[] = [];

  const autostart = await removeDesktopAutostart();
  steps.push(autostart.existed ? "startup entry removed" : "startup entry was not present");

  const stopped = await stopOwnService(config.proxyPort);
  if (stopped.stoppedPids.length > 0) {
    steps.push("proxy stopped (pid " + stopped.stoppedPids.join(", ") + ")");
  } else if (!stopped.stillRunning) {
    steps.push("proxy was not running");
  }
  if (stopped.foreign) {
    issues.push("port " + config.proxyPort + " is still held by a non-Jev process; left untouched");
  }
  if (stopped.stillRunning) {
    issues.push(
      "proxy still answers on port " + config.proxyPort +
        " after stop attempts; kill it manually with taskkill /PID <pid> /F"
    );
  }

  const record = await readIntegrationRecord(config.dataDirectory);
  if (record) {
    const restored = await restoreDesktopConfig(configPath, record);
    await removeIntegrationRecord(config.dataDirectory);
    steps.push("config keys restored: " + restored.join(", "));
  } else if (await configHasManagedMarker(configPath)) {
    issues.push(
      "managed config marker present but the integration record is missing; " +
      "restore manually from " + paths.backupPath
    );
  } else {
    steps.push("config was not managed; nothing to restore");
  }

  process.stdout.write(
    JSON.stringify({ ok: issues.length === 0, steps, issues, backup: paths.backupPath }, null, 2) + "\n"
  );
  return issues.length === 0 ? 0 : 1;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function printHelp(): void {
  process.stdout.write(
    [
      "Jev Router",
      "",
      "Usage:",
      "  jev codex [codex args...]       Launch Codex through the Jev router",
      "  jev route [--model ID] REQUEST  Print the routing decision for one request",
      "  jev profiles                    List configured model profiles",
      "  jev health                      Report configuration status without secrets",
      "  jev health-reset [modelId]      Clear auto-disabled model health records",
      "  jev doctor                      Detect your upstream and generate model profiles",
      "  jev explain                     Show the most recent routing decision",
      "  jev mcp                         Run the MCP stdio server",
      "  jev setup-key                   Create or locate the .env file",
      "  jev desktop enable              Wire Codex desktop to the Jev proxy",
      "  jev desktop status              Check the desktop integration",
      "  jev desktop disable             Remove the desktop integration",
      "  jev desktop run                 Run the fixed-port proxy (scheduled task)",
      ""
    ].join("\n")
  );
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
