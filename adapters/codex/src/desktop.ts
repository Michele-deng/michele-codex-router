import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DESKTOP_AUTOSTART_FILE = "jev-router-proxy.vbs";
export const DESKTOP_MANAGED_MARKER = "Jev-Router managed";
const MANAGED_COMMENT = "# Jev-Router managed (restore: jev desktop disable)";
const SCALAR_KEYS = ["model_provider", "model_catalog_json"] as const;
const RESTORE_KEYS = ["model_provider", "model_catalog_json", "openai_base_url"] as const;
const PROVIDER_SECTION = "[model_providers.jev_router]";

export interface DesktopIntegrationRecord {
  enabledAt: string;
  port: number;
  catalogPath: string;
  configPath: string;
  originalLines: Record<string, string | null>;
  originalValues: Record<string, string | null>;
  originalSection?: string[] | null;
}

export function desktopPaths(dataDirectory: string): {
  recordPath: string;
  catalogPath: string;
  backupPath: string;
  launcherCmd: string;
  serviceLog: string;
} {
  return {
    recordPath: path.join(dataDirectory, "desktop-integration.json"),
    catalogPath: path.join(dataDirectory, "model-catalog.json"),
    backupPath: path.join(dataDirectory, "config.toml.backup"),
    launcherCmd: path.join(dataDirectory, "jev-service.cmd"),
    serviceLog: path.join(dataDirectory, "desktop-service.log")
  };
}

export async function readIntegrationRecord(dataDirectory: string): Promise<DesktopIntegrationRecord | undefined> {
  try {
    return JSON.parse(
      await readFile(desktopPaths(dataDirectory).recordPath, "utf8")
    ) as DesktopIntegrationRecord;
  } catch {
    return undefined;
  }
}

export async function writeIntegrationRecord(
  dataDirectory: string,
  record: DesktopIntegrationRecord
): Promise<void> {
  const { recordPath } = desktopPaths(dataDirectory);
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(recordPath, JSON.stringify(record, null, 2), "utf8");
}

export async function removeIntegrationRecord(dataDirectory: string): Promise<void> {
  await rm(desktopPaths(dataDirectory).recordPath, { force: true });
}

export interface InjectResult {
  record: DesktopIntegrationRecord;
  changedKeys: string[];
}

/**
 * Line-level edit of config.toml: only the two managed keys are touched, all
 * other bytes (including opencodex markers and user edits) stay untouched.
 */
export async function injectDesktopConfig(options: {
  configPath: string;
  dataDirectory: string;
  port: number;
  catalogPath: string;
  previousRecord?: DesktopIntegrationRecord;
}): Promise<InjectResult> {
  const raw = await readFile(options.configPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  const targets: Record<string, string> = {
    model_provider: "jev_router",
    model_catalog_json: options.catalogPath
  };
  const originalLines: Record<string, string | null> = {};
  const originalValues: Record<string, string | null> = {};
  const changedKeys: string[] = [];

  // Migration: older builds hijacked openai_base_url. Restore it so the
  // opencodex-owned key stays opencodex's property again.
  const legacyIndex = findRootKeyIndex(lines, "openai_base_url");
  if (legacyIndex >= 0 && (lines[legacyIndex] as string).includes(DESKTOP_MANAGED_MARKER)) {
    const legacyOriginal = options.previousRecord?.originalLines.openai_base_url ?? null;
    if (legacyOriginal !== null) lines[legacyIndex] = legacyOriginal;
    else lines.splice(legacyIndex, 1);
    changedKeys.push("openai_base_url (legacy cleanup)");
  }

  for (const key of SCALAR_KEYS) {
    const index = findRootKeyIndex(lines, key);
    const currentLine = index >= 0 ? lines[index] as string : undefined;
    const managed = currentLine !== undefined && currentLine.includes(DESKTOP_MANAGED_MARKER);

    let originalLine: string | null;
    if (options.previousRecord && key in options.previousRecord.originalLines) {
      originalLine = options.previousRecord.originalLines[key] ?? null;
    } else if (managed) {
      originalLine = key === "model_catalog_json"
        ? 'model_catalog_json = "' + path.join(path.dirname(options.configPath), "opencodex-catalog.json") + '"'
        : null;
    } else {
      originalLine = currentLine ?? null;
    }
    originalLines[key] = originalLine;
    originalValues[key] = originalLine !== null ? valueOfStringLine(originalLine) : null;

    const originalComment = currentLine !== undefined ? commentOfLine(currentLine) : "";
    const keepComment = originalComment && !managed ? " " + originalComment : "";
    const managedLine = key + " = " + tomlString(targets[key] as string) + " " + MANAGED_COMMENT + keepComment;

    if (index >= 0) {
      if (lines[index] !== managedLine) {
        lines[index] = managedLine;
        changedKeys.push(key);
      }
    } else {
      lines.unshift(managedLine);
      changedKeys.push(key);
    }
  }

  const sectionLines = buildManagedSection(options.port);
  const headerIndex = lines.findIndex((line) => line.trim() === PROVIDER_SECTION);
  let originalSection: string[] | null;
  if (headerIndex >= 0) {
    const span = extractProviderSection(lines, headerIndex);
    const managedSpan = span.lines.some((line) => line.includes(DESKTOP_MANAGED_MARKER));
    if (options.previousRecord && "originalSection" in options.previousRecord) {
      originalSection = options.previousRecord.originalSection ?? null;
    } else {
      originalSection = managedSpan
        ? null
        : span.lines.filter((line) => !line.includes(DESKTOP_MANAGED_MARKER));
    }
    lines.splice(span.start, span.lines.length, ...sectionLines);
    changedKeys.push("model_providers.jev_router");
  } else {
    originalSection = options.previousRecord?.originalSection ?? null;
    lines.push(...sectionLines);
    changedKeys.push("model_providers.jev_router");
  }

  const output = lines.join(eol) + (hadTrailingNewline ? eol : "");
  await writeFile(options.configPath, output, "utf8");
  const record: DesktopIntegrationRecord = {
    enabledAt: new Date().toISOString(),
    port: options.port,
    catalogPath: options.catalogPath,
    configPath: options.configPath,
    originalLines,
    originalValues,
    originalSection
  };
  return { record, changedKeys };
}

export async function restoreDesktopConfig(
  configPath: string,
  record: DesktopIntegrationRecord
): Promise<string[]> {
  const raw = await readFile(configPath, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  const restored: string[] = [];
  for (const key of RESTORE_KEYS) {
    const index = findRootKeyIndex(lines, key);
    const originalLine = record.originalLines[key] ?? null;
    if (index >= 0 && (lines[index] as string).includes(DESKTOP_MANAGED_MARKER)) {
      if (originalLine !== null) lines[index] = originalLine;
      else lines.splice(index, 1);
      restored.push(key);
    } else if (index < 0 && originalLine !== null) {
      lines.unshift(originalLine);
      restored.push(key);
    }
  }

  const headerIndex = lines.findIndex((line) => line.trim() === PROVIDER_SECTION);
  if (headerIndex >= 0) {
    const span = extractProviderSection(lines, headerIndex);
    const original = record.originalSection ?? null;
    if (original && original.length > 0) lines.splice(span.start, span.lines.length, ...original);
    else lines.splice(span.start, span.lines.length);
    restored.push("model_providers.jev_router");
  } else if (record.originalSection && record.originalSection.length > 0) {
    lines.push(...record.originalSection);
    restored.push("model_providers.jev_router");
  }

  const output = lines.join(eol) + (hadTrailingNewline ? eol : "");
  await writeFile(configPath, output, "utf8");
  return restored;
}

export async function backupConfig(configPath: string, dataDirectory: string): Promise<string> {
  const { backupPath } = desktopPaths(dataDirectory);
  await mkdir(dataDirectory, { recursive: true });
  await copyFile(configPath, backupPath);
  return backupPath;
}

export async function readRootConfigValue(configPath: string, key: string): Promise<string | null> {
  try {
    const lines = (await readFile(configPath, "utf8")).split(/\r?\n/);
    const index = findRootKeyIndex(lines, key);
    return index >= 0 ? valueOfStringLine(lines[index] as string) : null;
  } catch {
    return null;
  }
}

export async function readRootConfigLine(configPath: string, key: string): Promise<string | null> {
  try {
    const lines = (await readFile(configPath, "utf8")).split(/\r?\n/);
    const index = findRootKeyIndex(lines, key);
    return index >= 0 ? lines[index] as string : null;
  } catch {
    return null;
  }
}

export async function configHasManagedMarker(configPath: string): Promise<boolean> {
  try {
    return (await readFile(configPath, "utf8")).includes(DESKTOP_MANAGED_MARKER);
  } catch {
    return false;
  }
}

function findRootKeyIndex(lines: string[], key: string): number {
  const rootEnd = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = rootEnd >= 0 ? rootEnd : lines.length;
  const pattern = new RegExp("^\\s*" + key + "\\s*=");
  for (let index = 0; index < limit; index += 1) {
    if (pattern.test(lines[index] as string)) return index;
  }
  return -1;
}

function valueOfStringLine(line: string): string | null {
  const match = line.match(/^\s*[^=]+=\s*"(.*)"\s*(#.*)?$/);
  if (!match) return null;
  return (match[1] as string).replace(/\\\\/g, "\\").replace(/\\"/g, '"');
}

function tomlString(value: string): string {
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function commentOfLine(line: string): string {
  const index = line.indexOf(" #");
  return index >= 0 ? line.slice(index).trim() : "";
}

function buildManagedSection(port: number): string[] {
  return [
    MANAGED_COMMENT,
    PROVIDER_SECTION,
    'name = "Jev Router"',
    "base_url = " + tomlString("http://127.0.0.1:" + port + "/v1"),
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "supports_websockets = false"
  ];
}

function extractProviderSection(
  lines: string[],
  headerIndex: number
): { start: number; lines: string[] } {
  let end = headerIndex + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] as string)) end += 1;
  const hasMarkerAbove = headerIndex > 0 && (lines[headerIndex - 1] as string).includes(DESKTOP_MANAGED_MARKER);
  const start = hasMarkerAbove ? headerIndex - 1 : headerIndex;
  return { start, lines: lines.slice(start, end) };
}

/** Probes the local health endpoint and identifies our own service. */
export async function probeProxyHealth(
  port: number,
  timeoutMs = 1_500
): Promise<{ reachable: boolean; ours: boolean }> {
  try {
    const response = await fetch("http://127.0.0.1:" + port + "/health", {
      signal: AbortSignal.timeout(timeoutMs)
    });
    const body = await response.json() as { service?: string };
    return { reachable: true, ours: body.service === "jev-router" };
  } catch {
    return { reachable: false, ours: false };
  }
}

export async function isPortAccepting(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function waitForProxyHealth(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const probe = await probeProxyHealth(port);
    if (probe.ours) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function startupDirectory(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/**
 * Autostart via a Startup-folder VBS (hidden window, no elevation needed).
 * schtasks /SC ONLOGON is denied for non-admin users on this machine, while
 * the Startup folder already hosts equivalent VBS launchers.
 */
export async function installDesktopAutostart(options: {
  cliPath: string;
  dataDirectory: string;
  nodePath: string;
}): Promise<string> {
  const { launcherCmd } = desktopPaths(options.dataDirectory);
  await mkdir(options.dataDirectory, { recursive: true });
  await writeFile(
    launcherCmd,
    "@echo off\r\n\"" + options.nodePath + "\" \"" + options.cliPath + "\" desktop run\r\n",
    "utf8"
  );
  const autostartPath = path.join(startupDirectory(), DESKTOP_AUTOSTART_FILE);
  await mkdir(startupDirectory(), { recursive: true });
  await writeFile(
    autostartPath,
    [
      "' Jev-Router autostart - runs the proxy with a hidden window at logon.",
      "Set shell = CreateObject(\"WScript.Shell\")",
      "shell.Run \"\"\"" + launcherCmd + "\"\"\", 0, False",
      ""
    ].join("\r\n"),
    "utf8"
  );
  return autostartPath;
}

export async function removeDesktopAutostart(): Promise<{ existed: boolean }> {
  const target = path.join(startupDirectory(), DESKTOP_AUTOSTART_FILE);
  const existed = existsSync(target);
  await rm(target, { force: true });
  return { existed };
}

export async function desktopAutostartExists(): Promise<boolean> {
  return existsSync(path.join(startupDirectory(), DESKTOP_AUTOSTART_FILE));
}

/**
 * Stops the listener on our fixed port, but only after confirming its command
 * line is our own "desktop run" service. Foreign processes are left alone.
 */
export async function stopOwnService(port: number): Promise<{ stoppedPids: number[]; foreign: boolean }> {
  const script = [
    "$out = @()",
    "$foreign = $false",
    "$conns = Get-NetTCPConnection -LocalPort " + port + " -State Listen -ErrorAction SilentlyContinue",
    "foreach ($c in $conns) {",
    "  $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($c.OwningProcess)\" -ErrorAction SilentlyContinue",
    "  if ($p -and $p.CommandLine -like '*jev-cli*desktop run*') {",
    "    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue",
    "    $out += $c.OwningProcess",
    "  } elseif ($p) { $foreign = $true }",
    "}",
    "Write-Output ('PIDS=' + ($out -join ','))",
    "Write-Output ('FOREIGN=' + $foreign)"
  ].join("\n");
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
    const pidLine = stdout.split(/\r?\n/).find((line) => line.startsWith("PIDS=")) ?? "PIDS=";
    const foreignLine = stdout.split(/\r?\n/).find((line) => line.startsWith("FOREIGN=")) ?? "FOREIGN=False";
    const pids = pidLine.slice(5).split(",").filter(Boolean).map(Number).filter(Number.isFinite);
    return { stoppedPids: pids, foreign: foreignLine.endsWith("True") };
  } catch {
    return { stoppedPids: [], foreign: false };
  }
}

export function startServiceDetached(cliPath: string, nodePath: string): void {
  const child = spawn(nodePath, [cliPath, "desktop", "run"], {
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  child.unref();
}
