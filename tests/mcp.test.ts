import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { profile } from "./fixtures.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(projectRoot, "apps", "jev-cli", "dist", "index.js");
const CANARY = "JEV-CANARY-20260928-LOCAL-ONLY";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class McpClient {
  readonly responses: Array<Record<string, any>> = [];
  private buffer = "";

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let newline = this.buffer.indexOf("\n");
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          try {
            this.responses.push(JSON.parse(line) as Record<string, any>);
          } catch {
            // Non-JSON noise must not break the stream reader.
          }
        }
        newline = this.buffer.indexOf("\n");
      }
    });
  }

  send(value: unknown): void {
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  async waitFor(count: number): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (this.responses.length < count) {
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for MCP response #" + count);
      }
      await sleep(25);
    }
  }
}

describe("MCP stdio service (MCP-001..005)", () => {
  it("answers the protocol round trip without leaking secrets", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "jev-mcp-"));
    const codexHome = path.join(root, "codexhome");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "config.toml"), "", "utf8");
    const profilesDir = path.join(root, "profiles");
    mkdirSync(profilesDir, { recursive: true });
    writeFileSync(
      path.join(profilesDir, "low-model.json"),
      JSON.stringify(profile("low-model", "low"), null, 2),
      "utf8"
    );
    const child = spawn(process.execPath, [CLI, "mcp"], {
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        JEV_DATA_DIR: path.join(root, "data"),
        JEV_PROFILES_DIR: profilesDir,
        JEV_ENV_FILE: path.join(root, ".env"),
        JEV_PROXY_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
        JEV_DECISION_PROVIDER: "rules",
        TYPESAFE_API_KEY: CANARY,
        APPDATA: path.join(root, "appdata")
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const client = new McpClient(child);

    try {
      client.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await client.waitFor(1);
      assert.equal(client.responses[0]?.result.serverInfo.name, "jev-router");

      client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await client.waitFor(2);
      const names = (client.responses[1]?.result.tools ?? []).map((tool: { name: string }) => tool.name);
      assert.deepEqual(names.sort(), ["jev_explain", "jev_health", "jev_route"]);

      client.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "jev_route", arguments: { request: "hi" } }
      });
      await client.waitFor(3);
      const routed = JSON.parse(client.responses[2]?.result.content[0].text ?? "{}");
      assert.equal(routed.decisionSource, "rules");
      assert.equal(routed.modelId, "low-model");
      const log = readFileSync(path.join(root, "data", "decisions.jsonl"), "utf8");
      assert.equal(log.includes("low-model"), true, "jev_route writes the decision log");
      assert.equal(log.includes(CANARY), false, "no canary in the decision log");

      client.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "jev_health", arguments: {} } });
      await client.waitFor(4);
      const healthText = client.responses[3]?.result.content[0].text ?? "";
      assert.equal(JSON.parse(healthText).typesafeKeyConfigured, true);
      assert.equal(healthText.includes(CANARY), false, "no canary from jev_health");

      client.send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "jev_explain", arguments: {} } });
      await client.waitFor(5);
      assert.match(client.responses[4]?.result.content[0].text ?? "", /low-model/);

      client.child.stdin.write("{not json\n");
      await client.waitFor(6);
      assert.equal(client.responses[5]?.error.code, -32700, "invalid JSON reports a parse error");

      client.send({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "no_such_tool", arguments: {} }
      });
      await client.waitFor(7);
      assert.equal(client.responses[6]?.result.isError, true, "unknown tool is an error result");

      client.send({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "jev_route", arguments: {} } });
      await client.waitFor(8);
      assert.ok(client.responses[7]?.error, "missing arguments return an error");

      client.send({ jsonrpc: "2.0", id: 9, method: "initialize", params: {} });
      await client.waitFor(9);
      assert.equal(client.responses[8]?.result.serverInfo.name, "jev-router", "service survives errors");
    } finally {
      child.stdin.end();
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        sleep(5_000).then(() => child.kill())
      ]);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
