import os from "node:os";
import path from "node:path";
import { loadEnvFile, type LoadEnvFileResult } from "./load-env.js";
import { optionalString, parseBoolean, parseEnum, parseInteger, parseList } from "./parse.js";
import { redactText } from "./secrets.js";

export type DecisionProviderKind = "typesafe" | "local" | "static";
export type PrivacyMode = "cloud" | "local-routing" | "local-only";

export type SecretName = "typesafeApiKey" | "deepseekApiKey" | "openaiApiKey";

export interface JevConfig {
  projectRoot: string;
  envFile: string;
  envFileFound: boolean;
  envKeysApplied: string[];
  envKeysAlreadySet: string[];
  envFileError?: string;
  decisionProvider: DecisionProviderKind;
  routeTimeoutMs: number;
  upstreamHeaderTimeoutMs: number;
  fallback: { providerId: string; modelId: string | undefined };
  typesafe: { configured: boolean; endpoint: string; model: string };
  deepseek: {
    configured: boolean;
    baseUrl: string | undefined;
    wireApi: "responses" | "chat";
  };
  codex: { upstreamUrl: string };
  codexBin: string | undefined;
  probes: {
    openaiBaseUrl: string | undefined;
    ollamaUrl: string | undefined;
    lmstudioUrl: string | undefined;
  };
  privacyMode: PrivacyMode;
  localDecision: { url: string | undefined; modelId: string | undefined };
  allowLongTier: boolean;
  logExcerpt: boolean;
  proxyPort: number;
  sentinelModels: string[];
  adjustReasoning: boolean;
  profilesDirectory: string;
  dataDirectory: string;
  readSecret(name: SecretName): string | undefined;
}

export interface JevConfigOptions {
  projectRoot?: string;
  envFile?: string;
  env?: NodeJS.ProcessEnv;
}

export function loadJevConfig(options: JevConfigOptions = {}): JevConfig {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const envFile = options.envFile ?? optionalString(process.env.JEV_ENV_FILE) ?? path.join(projectRoot, ".env");
  const envInfo: LoadEnvFileResult = loadEnvFile(envFile);
  const env = options.env ?? process.env;

  const typesafeApiKey = optionalString(env.TYPESAFE_API_KEY) ?? optionalString(env.JEV_API_KEY);
  const deepseekBaseUrl = optionalString(env.DEEPSEEK_BASE_URL);
  const profilesDirectory =
    optionalString(env.JEV_PROFILES_DIR) ?? path.join(projectRoot, "profiles", "models");
  const dataDirectory = optionalString(env.JEV_DATA_DIR) ?? path.join(os.homedir(), ".jev-router");

  const readSecret = (name: SecretName): string | undefined => {
    if (name === "typesafeApiKey") return optionalString(env.TYPESAFE_API_KEY) ?? optionalString(env.JEV_API_KEY);
    if (name === "deepseekApiKey") return optionalString(env.DEEPSEEK_API_KEY);
    return optionalString(env.OPENAI_API_KEY);
  };

  const config: JevConfig = {
    projectRoot,
    envFile,
    envFileFound: envInfo.found,
    envKeysApplied: envInfo.keysApplied,
    envKeysAlreadySet: envInfo.keysAlreadySet,
    ...(envInfo.error !== undefined ? { envFileError: envInfo.error } : {}),
    decisionProvider: parseEnum<DecisionProviderKind>(
      env.JEV_DECISION_PROVIDER,
      ["typesafe", "local", "static"],
      "typesafe"
    ),
    routeTimeoutMs: parseInteger(env.JEV_ROUTE_TIMEOUT_MS ?? env.JEV_TIMEOUT_MS, 800, { min: 50, max: 60_000 }),
    upstreamHeaderTimeoutMs: parseInteger(env.JEV_UPSTREAM_TIMEOUT_MS, 60_000, { min: 1_000, max: 110_000 }),
    fallback: {
      providerId: optionalString(env.JEV_FALLBACK_PROVIDER) ?? "deepseek",
      modelId: optionalString(env.JEV_FALLBACK_MODEL)
    },
    typesafe: {
      configured: typesafeApiKey !== undefined,
      endpoint: optionalString(env.JEV_TYPESAFE_ENDPOINT) ?? "https://api.typesafe.ai/v1/systemone",
      model: optionalString(env.JEV_TYPESAFE_MODEL) ?? "jev-latest"
    },
    deepseek: {
      configured: deepseekBaseUrl !== undefined,
      baseUrl: deepseekBaseUrl,
      wireApi: parseEnum<"responses" | "chat">(env.DEEPSEEK_WIRE_API, ["responses", "chat"], "responses")
    },
    codex: {
      upstreamUrl: optionalString(env.JEV_CODEX_UPSTREAM_URL) ?? "https://api.openai.com/v1/responses"
    },
    codexBin: optionalString(env.JEV_CODEX_BIN),
    probes: {
      openaiBaseUrl: optionalString(env.JEV_OPENAI_BASE_URL),
      ollamaUrl: optionalString(env.JEV_OLLAMA_URL),
      lmstudioUrl: optionalString(env.JEV_LMSTUDIO_URL)
    },
    privacyMode: parseEnum<PrivacyMode>(env.JEV_PRIVACY_MODE, ["cloud", "local-routing", "local-only"], "cloud"),
    localDecision: {
      url: optionalString(env.JEV_LOCAL_DECISION_URL),
      modelId: optionalString(env.JEV_LOCAL_DECISION_MODEL)
    },
    allowLongTier: parseBoolean(env.JEV_ALLOW_LONG, false),
    logExcerpt: parseBoolean(env.JEV_LOG_EXCERPT, false),
    proxyPort: parseInteger(env.JEV_PROXY_PORT, 10300, { min: 1024, max: 65535 }),
    sentinelModels: parseList(env.JEV_SENTINEL_MODELS, ["jev-router", "jev/auto"]),
    adjustReasoning: parseBoolean(env.JEV_ADJUST_REASONING, true),
    profilesDirectory,
    dataDirectory,
    readSecret
  };

  return config;
}

export interface SafeJevConfig {
  projectRoot: string;
  envFile: string;
  envFileFound: boolean;
  envKeysApplied: number;
  envKeysAlreadySet: number;
  envFileError?: string;
  decisionProvider: DecisionProviderKind;
  routeTimeoutMs: number;
  upstreamHeaderTimeoutMs: number;
  fallbackProvider: string;
  fallbackModel: string | null;
  typesafeKeyConfigured: boolean;
  typesafeEndpoint: string;
  typesafeModel: string;
  deepseekConfigured: boolean;
  deepseekBaseUrl: string | null;
  deepseekWireApi: "responses" | "chat";
  codexUpstreamUrl: string;
  codexBin: string | null;
  privacyMode: PrivacyMode;
  allowLongTier: boolean;
  logExcerpt: boolean;
  proxyPort: number;
  sentinelModels: string[];
  adjustReasoning: boolean;
  profilesDirectory: string;
  dataDirectory: string;
}

/** A redacted view of the configuration that is safe to print or log. */
export function describeConfig(config: JevConfig): SafeJevConfig {
  return {
    projectRoot: config.projectRoot,
    envFile: config.envFile,
    envFileFound: config.envFileFound,
    envKeysApplied: config.envKeysApplied.length,
    envKeysAlreadySet: config.envKeysAlreadySet.length,
    ...(config.envFileError !== undefined ? { envFileError: config.envFileError } : {}),
    decisionProvider: config.decisionProvider,
    routeTimeoutMs: config.routeTimeoutMs,
    upstreamHeaderTimeoutMs: config.upstreamHeaderTimeoutMs,
    fallbackProvider: config.fallback.providerId,
    fallbackModel: config.fallback.modelId ?? null,
    typesafeKeyConfigured: config.typesafe.configured,
    typesafeEndpoint: config.typesafe.endpoint,
    typesafeModel: config.typesafe.model,
    deepseekConfigured: config.deepseek.configured,
    deepseekBaseUrl: config.deepseek.baseUrl ? redactText(config.deepseek.baseUrl) : null,
    deepseekWireApi: config.deepseek.wireApi,
    codexUpstreamUrl: config.codex.upstreamUrl,
    codexBin: config.codexBin ?? null,
    privacyMode: config.privacyMode,
    allowLongTier: config.allowLongTier,
    logExcerpt: config.logExcerpt,
    proxyPort: config.proxyPort,
    sentinelModels: config.sentinelModels,
    adjustReasoning: config.adjustReasoning,
    profilesDirectory: config.profilesDirectory,
    dataDirectory: config.dataDirectory
  };
}
