import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  DESKTOP_MANAGED_MARKER,
  SENTINEL_MODEL_ID,
  catalogHasSentinel,
  configHasManagedMarker,
  injectDesktopConfig,
  mergeModelCatalog,
  readRootConfigValue,
  restoreDesktopConfig,
  type DesktopIntegrationRecord
} from "@jev-router/adapter-codex";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(projectRoot, "apps", "jev-cli", "dist", "index.js");

function runCliSync(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000
  });
}

function isolatedEnv(sandbox: string): Record<string, string> {
  return {
    CODEX_HOME: path.join(sandbox, "codexhome"),
    JEV_DATA_DIR: path.join(sandbox, "data"),
    JEV_PROFILES_DIR: path.join(sandbox, "profiles"),
    JEV_ENV_FILE: path.join(sandbox, ".env"),
    JEV_PROXY_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
    JEV_DECISION_PROVIDER: "rules",
    TYPESAFE_API_KEY: "JEV-CANARY-20260928-LOCAL-ONLY",
    APPDATA: path.join(sandbox, "appdata")
  };
}

function makeTempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "jev-desktop-"));
}

const ORIGINAL_CONFIG = [
  'model_reasoning_effort = "high"',
  'model_catalog_json = "C:\\Users\\test\\.codex\\opencodex-catalog.json"',
  'model = "deepseek/deepseek-flash"',
  "# Auto-injected by opencodex (undo: ocx restore)",
  'openai_base_url = "http://127.0.0.1:10100/v1"',
  "",
  "[mcp_servers.syslab]",
  'type = "stdio"'
].join("\r\n") + "\r\n";

describe("desktop config injection", () => {
  it("adds the Jev provider without touching opencodex keys and restores byte-for-byte", async () => {
    const dir = makeTempDir();
    try {
      const configPath = path.join(dir, "config.toml");
      writeFileSync(configPath, ORIGINAL_CONFIG, "utf8");

      const injected = await injectDesktopConfig({
        configPath,
        dataDirectory: dir,
        port: 10300,
        catalogPath: path.join(dir, "model-catalog.json")
      });

      const after = readFileSync(configPath, "utf8");
      assert.equal(after.includes(DESKTOP_MANAGED_MARKER), true);
      assert.equal(await configHasManagedMarker(configPath), true);
      assert.equal(await readRootConfigValue(configPath, "model_provider"), "jev_router");
      assert.equal(
        await readRootConfigValue(configPath, "model_catalog_json"),
        path.join(dir, "model-catalog.json")
      );
      // backslashes must be escaped for TOML or codex fails to parse config
      const escapedCatalog = path.join(dir, "model-catalog.json").replace(/\\/g, "\\\\");
      assert.equal(
        after.includes('model_catalog_json = "' + escapedCatalog + '"'),
        true,
        "written path is valid TOML"
      );
      // opencodex keeps ownership of its own key
      assert.equal(
        await readRootConfigValue(configPath, "openai_base_url"),
        "http://127.0.0.1:10100/v1",
        "opencodex openai_base_url untouched"
      );
      assert.equal(after.includes("# Auto-injected by opencodex (undo: ocx restore)"), true);
      // managed provider section exists with websocket support disabled
      assert.equal(after.includes("[model_providers.jev_router]"), true);
      assert.equal(after.includes("supports_websockets = false"), true);
      assert.equal(after.includes('base_url = "http://127.0.0.1:10300/v1"'), true);
      assert.equal(after.includes('model = "deepseek/deepseek-flash"'), true);
      assert.equal(injected.record.originalLines.model_provider, null);
      assert.equal(injected.record.originalSection ?? null, null);

      const restored = await restoreDesktopConfig(configPath, injected.record);
      assert.equal(restored.includes("model_provider"), true);
      assert.equal(restored.includes("model_catalog_json"), true);
      assert.equal(restored.includes("model_providers.jev_router"), true);
      assert.equal(readFileSync(configPath, "utf8"), ORIGINAL_CONFIG, "byte-identical restore");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inserts missing keys and removes them on restore", async () => {
    const dir = makeTempDir();
    try {
      const configPath = path.join(dir, "config.toml");
      const original = 'model = "deepseek/deepseek-flash"\n\n[mcp_servers.x]\ntype = "stdio"\n';
      writeFileSync(configPath, original, "utf8");

      const injected = await injectDesktopConfig({
        configPath,
        dataDirectory: dir,
        port: 10300,
        catalogPath: path.join(dir, "model-catalog.json")
      });
      assert.equal(await readRootConfigValue(configPath, "model_provider"), "jev_router");
      assert.equal(
        await readRootConfigValue(configPath, "model_catalog_json"),
        path.join(dir, "model-catalog.json")
      );
      assert.equal(readFileSync(configPath, "utf8").includes("[model_providers.jev_router]"), true);

      await restoreDesktopConfig(configPath, injected.record);
      assert.equal(readFileSync(configPath, "utf8"), original, "inserted lines fully removed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-enable keeps the first captured originals", async () => {
    const dir = makeTempDir();
    try {
      const configPath = path.join(dir, "config.toml");
      writeFileSync(configPath, ORIGINAL_CONFIG, "utf8");
      const first = await injectDesktopConfig({
        configPath, dataDirectory: dir, port: 10300,
        catalogPath: path.join(dir, "model-catalog.json")
      });
      const second = await injectDesktopConfig({
        configPath, dataDirectory: dir, port: 10400,
        catalogPath: path.join(dir, "model-catalog.json"),
        previousRecord: first.record
      });
      const after = readFileSync(configPath, "utf8");
      assert.equal(after.includes('base_url = "http://127.0.0.1:10400/v1"'), true);
      assert.equal(after.includes('base_url = "http://127.0.0.1:10300/v1"'), false, "no stale section lines");
      assert.equal(
        second.record.originalLines.model_catalog_json,
        'model_catalog_json = "C:\\Users\\test\\.codex\\opencodex-catalog.json"',
        "originals are not overwritten by our own managed lines"
      );
      await restoreDesktopConfig(configPath, second.record);
      assert.equal(readFileSync(configPath, "utf8"), ORIGINAL_CONFIG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates the legacy openai_base_url hijack back to opencodex", async () => {
    const dir = makeTempDir();
    try {
      const configPath = path.join(dir, "config.toml");
      const legacyLine = 'openai_base_url = "http://127.0.0.1:10300/v1" ' + DESKTOP_MANAGED_MARKER;
      writeFileSync(configPath, legacyLine + '\nmodel = "deepseek/deepseek-flash"\n', "utf8");
      const legacyRecord = {
        enabledAt: "2026-09-26T00:00:00.000Z",
        port: 10300,
        catalogPath: path.join(dir, "model-catalog.json"),
        configPath,
        originalLines: {
          openai_base_url: 'openai_base_url = "http://127.0.0.1:10100/v1"',
          model_catalog_json: null
        },
        originalValues: { openai_base_url: "http://127.0.0.1:10100/v1", model_catalog_json: null }
      } as DesktopIntegrationRecord;

      await injectDesktopConfig({
        configPath,
        dataDirectory: dir,
        port: 10300,
        catalogPath: path.join(dir, "model-catalog.json"),
        previousRecord: legacyRecord
      });
      const after = readFileSync(configPath, "utf8");
      assert.equal(
        after.includes('openai_base_url = "http://127.0.0.1:10100/v1"'),
        true,
        "legacy hijack restored to opencodex"
      );
      assert.equal(after.includes(DESKTOP_MANAGED_MARKER + "\nmodel ="), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("model catalog merge", () => {
  function sourceCatalog(): string {
    return JSON.stringify({
      generated: "opencodex",
      models: [
        {
          slug: "deepseek/deepseek-flash",
          display_name: "deepseek/deepseek-flash",
          context_window: 1_000_000,
          supported_reasoning_levels: [
            { effort: "low", description: "low" },
            { effort: "high", description: "high" },
            { effort: "max", description: "max" }
          ],
          opencodex_capability_provenance: { provider: "deepseek" }
        },
        { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", context_window: 272_000 }
      ]
    });
  }

  it("adds the sentinel, keeps every source entry and is idempotent", async () => {
    const dir = makeTempDir();
    try {
      const source = path.join(dir, "source.json");
      const output = path.join(dir, "merged.json");
      writeFileSync(source, sourceCatalog(), "utf8");

      const first = await mergeModelCatalog(source, output);
      assert.equal(first.entryCount, 3);
      assert.equal(first.sentinelFrom, "deepseek/deepseek-flash");
      assert.equal(await catalogHasSentinel(output), true);

      const merged = JSON.parse(readFileSync(output, "utf8")) as { models: Array<Record<string, any>> };
      assert.equal(merged.models.length, 3);
      const sentinel = merged.models.find((entry) => entry.slug === SENTINEL_MODEL_ID);
      assert.ok(sentinel);
      assert.equal(sentinel.context_window, 1_000_000, "inherits the template entry's context window");
      assert.equal(sentinel.supported_in_api, true);
      assert.deepEqual(
        (sentinel.supported_reasoning_levels as Array<{ effort: string }>).map((level) => level.effort),
        ["low", "high"],
        "only levels shared by GPT and DeepSeek catalogs are advertised"
      );
      assert.equal(sentinel.opencodex_capability_provenance, undefined);
      assert.equal("templateSlug" in sentinel, false, "no helper fields leak into the catalog");
      assert.equal(merged.models.some((entry) => entry.slug === "gpt-5.6-luna"), true);
      assert.equal((JSON.parse(readFileSync(output, "utf8")) as { generated: string }).generated, "opencodex");

      const second = await mergeModelCatalog(source, output);
      assert.equal(second.entryCount, 3, "re-running does not duplicate the sentinel");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("picks up source catalog updates on the next merge", async () => {
    const dir = makeTempDir();
    try {
      const source = path.join(dir, "source.json");
      const output = path.join(dir, "merged.json");
      writeFileSync(source, sourceCatalog(), "utf8");
      await mergeModelCatalog(source, output);

      const parsed = JSON.parse(readFileSync(source, "utf8")) as { models: unknown[] };
      parsed.models.push({ slug: "mimo/mimo-v2.6-flash", context_window: 1_000_000 });
      writeFileSync(source, JSON.stringify(parsed), "utf8");

      const rebuilt = await mergeModelCatalog(source, output);
      assert.equal(rebuilt.entryCount, 4);
      const merged = JSON.parse(readFileSync(output, "utf8")) as { models: Array<{ slug: string }> };
      assert.equal(merged.models.some((entry) => entry.slug === "mimo/mimo-v2.6-flash"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("desktop lifecycle (isolated child process)", () => {
  it("refuses to enable when preflight fails and changes nothing (DESK-002)", () => {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "jev-desk-"));
    try {
      const codexHome = path.join(sandbox, "codexhome");
      mkdirSync(codexHome, { recursive: true });
      const configPath = path.join(codexHome, "config.toml");
      const original = 'openai_base_url = "http://127.0.0.1:9/v1"\nmodel = "deepseek/deepseek-flash"\n';
      writeFileSync(configPath, original, "utf8");

      const result = runCliSync(["desktop", "enable"], isolatedEnv(sandbox));
      assert.equal(result.status, 1, "preflight failure must refuse (exit 1)");
      const output = JSON.parse(result.stdout) as { refused?: boolean; issues?: string[] };
      assert.equal(output.refused, true);
      assert.ok((output.issues?.length ?? 0) > 0, "explains what is missing");

      assert.equal(readFileSync(configPath, "utf8"), original, "config untouched");
      assert.equal(existsSync(path.join(sandbox, ".env")), false, ".env untouched");
      const startup = path.join(
        sandbox,
        "appdata",
        "Microsoft",
        "Windows",
        "Start Menu",
        "Programs",
        "Startup"
      );
      assert.equal(existsSync(path.join(startup, "jev-router-proxy.vbs")), false, "no autostart");
      assert.equal(existsSync(path.join(sandbox, "data")), false, "no data dir");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("disable without an integration record reports the backup path (REC-005)", () => {
    const sandbox = mkdtempSync(path.join(os.tmpdir(), "jev-desk-"));
    try {
      const codexHome = path.join(sandbox, "codexhome");
      mkdirSync(codexHome, { recursive: true });
      const configPath = path.join(codexHome, "config.toml");
      const managed = [
        'model_provider = "jev_router" # Jev-Router managed (restore: jev desktop disable)',
        'model_catalog_json = "C:\\tmp\\catalog.json" # Jev-Router managed (restore: jev desktop disable)',
        "",
        "# Jev-Router managed (restore: jev desktop disable)",
        "[model_providers.jev_router]",
        'name = "Jev Router"',
        'base_url = "http://127.0.0.1:10300/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "supports_websockets = false",
        ""
      ].join("\n");
      writeFileSync(configPath, managed, "utf8");

      const result = runCliSync(["desktop", "disable"], isolatedEnv(sandbox));
      assert.equal(result.status, 1, "incomplete state is an issue, not a silent success");
      const output = JSON.parse(result.stdout) as { issues?: string[]; backup?: string };
      assert.match((output.issues ?? []).join(" "), /integration record is missing/);
      assert.match((output.issues ?? []).join(" "), /backup/);
      assert.equal(readFileSync(configPath, "utf8"), managed, "no blind restore");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("round-trips config files under spaces and non-ASCII paths (DESK-014)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev 桌面 "));
    try {
      const inner = path.join(dir, "配置 目录");
      mkdirSync(inner, { recursive: true });
      const configPath = path.join(inner, "config.toml");
      writeFileSync(configPath, ORIGINAL_CONFIG, "utf8");

      const injected = await injectDesktopConfig({
        configPath,
        dataDirectory: dir,
        port: 10300,
        catalogPath: path.join(inner, "模型 目录.json")
      });
      assert.equal(await readRootConfigValue(configPath, "model_provider"), "jev_router");
      await restoreDesktopConfig(configPath, injected.record);
      assert.equal(readFileSync(configPath, "utf8"), ORIGINAL_CONFIG, "byte-identical");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
