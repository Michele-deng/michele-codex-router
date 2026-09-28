import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { profile } from "./fixtures.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(projectRoot, "apps", "jev-cli", "dist", "index.js");
const CANARY = "JEV-CANARY-20260928-LOCAL-ONLY";

interface Sandbox {
  root: string;
  envFile: string;
  baseEnv: Record<string, string>;
}

function makeSandbox(): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), "jev-cli-"));
  const codexHome = path.join(root, "codexhome");
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(
    path.join(codexHome, "config.toml"),
    'openai_base_url = "http://127.0.0.1:9/v1"\n',
    "utf8"
  );
  const profilesDir = path.join(root, "profiles");
  mkdirSync(profilesDir, { recursive: true });
  writeFileSync(
    path.join(profilesDir, "low-model.json"),
    JSON.stringify(profile("low-model", "low"), null, 2),
    "utf8"
  );
  return {
    root,
    envFile: path.join(root, ".env"),
    baseEnv: {
      ...process.env,
      CODEX_HOME: codexHome,
      JEV_DATA_DIR: path.join(root, "data"),
      JEV_PROFILES_DIR: profilesDir,
      JEV_ENV_FILE: path.join(root, ".env"),
      JEV_PROXY_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
      JEV_DECISION_PROVIDER: "rules",
      TYPESAFE_API_KEY: CANARY,
      // CI images have no Codex binary; point the health probe at the Node
      // executable so the codex-presence check stays deterministic.
      JEV_CODEX_BIN: process.execPath,
      APPDATA: path.join(root, "appdata")
    }
  };
}

function runCli(sandbox: Sandbox, args: string[], overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...sandbox.baseEnv, ...overrides },
    timeout: 60_000
  });
}

describe("CLI commands (isolated child process)", () => {
  it("health reports ok without leaking the canary (CLI-004, SEC-001)", () => {
    const sandbox = makeSandbox();
    try {
      const result = runCli(sandbox, ["health"]);
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout) as {
        ok: boolean;
        issues: Array<{ level: string }>;
        typesafeKeyConfigured: boolean;
        profileCount: number;
      };
      assert.equal(report.ok, true);
      assert.equal(report.typesafeKeyConfigured, true);
      assert.equal(report.profileCount, 1);
      assert.ok(Array.isArray(report.issues));
      assert.equal(result.stdout.includes(CANARY), false, "no canary in stdout");
      assert.equal(result.stderr.includes(CANARY), false, "no canary in stderr");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("health explains a missing key without failing (CLI-010)", () => {
    const sandbox = makeSandbox();
    try {
      const result = runCli(sandbox, ["health"], { TYPESAFE_API_KEY: "" });
      assert.equal(result.status, 0);
      const report = JSON.parse(result.stdout) as {
        ok: boolean;
        issues: Array<{ level: string; message: string }>;
      };
      assert.equal(report.ok, true, "rule routing still works without a key");
      assert.match(report.issues.map((issue) => issue.message).join(" "), /TYPESAFE_API_KEY not set/);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("route prints a rules decision and a manual override (CLI-001/002)", () => {
    const sandbox = makeSandbox();
    try {
      const auto = runCli(sandbox, ["route", "hi"]);
      assert.equal(auto.status, 0, auto.stderr);
      const decision = JSON.parse(auto.stdout) as { decisionSource?: string; modelId: string };
      assert.equal(decision.decisionSource, "rules");
      assert.equal(decision.modelId, "low-model");
      assert.equal(auto.stdout.includes(CANARY), false);

      const manual = runCli(sandbox, ["route", "--model", "low-model", "hi"]);
      assert.equal(manual.status, 0, manual.stderr);
      const picked = JSON.parse(manual.stdout) as { decisionSource?: string; modelId: string };
      assert.equal(picked.decisionSource, "manual");
      assert.equal(picked.modelId, "low-model");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("profiles, explain, health-reset and doctor answer with structured JSON (CLI-003/005/006/007)", () => {
    const sandbox = makeSandbox();
    try {
      const profiles = runCli(sandbox, ["profiles"]);
      assert.equal(profiles.status, 0, profiles.stderr);
      const list = JSON.parse(profiles.stdout) as Array<{ modelId: string }>;
      assert.equal(list.some((entry) => entry.modelId === "low-model"), true);

      const explain = runCli(sandbox, ["explain"]);
      assert.equal(explain.status, 0, explain.stderr);
      assert.match(explain.stdout, /No decision recorded/);
      assert.equal(explain.stdout.includes(CANARY), false, "no canary from explain");

      const reset = runCli(sandbox, ["health-reset"]);
      assert.equal(reset.status, 0, reset.stderr);
      const resetReport = JSON.parse(reset.stdout) as { ok: boolean; removed: number; note?: string };
      assert.equal(resetReport.ok, true);
      assert.equal(typeof resetReport.removed, "number");
      assert.match(resetReport.note ?? "", /hot reload/);

      const doctor = runCli(sandbox, ["doctor"]);
      assert.equal(doctor.status, 0, doctor.stderr);
      const doctorReport = JSON.parse(doctor.stdout) as {
        ok: boolean;
        warnings: string[];
        wiring: { source: string };
        models: { count: number };
      };
      assert.equal(doctorReport.ok, true, "existing profile keeps ok true");
      assert.ok(doctorReport.warnings.length >= 1, "unreachable model list surfaces a warning");
      assert.match(doctorReport.wiring.source, /openai_base_url/);
      assert.equal(doctorReport.models.count, 0);
      assert.equal(doctor.stdout.includes(CANARY), false);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("setup-key creates once and never overwrites a filled value (CLI-008)", () => {
    const sandbox = makeSandbox();
    try {
      const first = runCli(sandbox, ["setup-key"]);
      assert.equal(first.status, 0, first.stderr);
      assert.equal(readFileSync(sandbox.envFile, "utf8").includes("TYPESAFE_API_KEY="), true);

      const filled = "TYPESAFE_API_KEY=PRE-EXISTING-VALUE\n";
      writeFileSync(sandbox.envFile, filled, "utf8");
      const second = runCli(sandbox, ["setup-key"]);
      assert.equal(second.status, 0, second.stderr);
      assert.equal(readFileSync(sandbox.envFile, "utf8"), filled, "filled value untouched");
      assert.equal(second.stdout.includes("PRE-EXISTING-VALUE"), false, "never prints key material");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("rejects unknown commands with a usage hint (CLI-009)", () => {
    const sandbox = makeSandbox();
    try {
      const result = runCli(sandbox, ["definitely-not-a-command"]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unknown command/);
      assert.match(result.stdout, /Usage/);
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });

  it("status returns structured issues without secrets when the proxy is down", () => {
    const sandbox = makeSandbox();
    try {
      const result = runCli(sandbox, ["desktop", "status"]);
      // Sandbox has no running proxy, so issues are expected (exit 1).
      assert.notEqual(result.status, 0);
      const report = JSON.parse(result.stdout) as { issues: string[]; proxyRunning: boolean };
      assert.equal(report.proxyRunning, false);
      assert.ok(report.issues.length > 0);
      assert.equal(result.stdout.includes(CANARY), false, "no canary from status");
    } finally {
      rmSync(sandbox.root, { recursive: true, force: true });
    }
  });
});
