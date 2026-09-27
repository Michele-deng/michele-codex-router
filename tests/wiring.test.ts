import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  discoverProviderWiring,
  fetchModelIds,
  parseNetstatPid,
  profilesFromModelIds
} from "@jev-router/adapter-codex";

describe("provider wiring discovery", () => {
  it("reads the user's own provider block including its bearer token", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-wiring-"));
    try {
      const configPath = path.join(dir, "config.toml");
      writeFileSync(
        configPath,
        [
          'model_provider = "foo"',
          "",
          "[model_providers.foo]",
          'base_url = "https://api.deepseek.com/v1"',
          'wire_api = "responses"',
          'experimental_bearer_token = "tok-123"',
          ""
        ].join("\n"),
        "utf8"
      );
      const wiring = await discoverProviderWiring({ configPath });
      assert.equal(wiring.kind, "provider-block");
      assert.equal(wiring.baseUrl, "https://api.deepseek.com/v1");
      assert.equal(wiring.modelsUrl, "https://api.deepseek.com/v1/models");
      assert.equal(wiring.bearerToken, "tok-123");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to root openai_base_url and to the vanilla default", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "jev-wiring-"));
    try {
      const configPath = path.join(dir, "config.toml");
      writeFileSync(configPath, 'openai_base_url = "http://127.0.0.1:10100/v1"\n', "utf8");
      const root = await discoverProviderWiring({ configPath });
      assert.equal(root.kind, "openai-base-url");
      assert.equal(root.modelsUrl, "http://127.0.0.1:10100/v1/models");

      const empty = await discoverProviderWiring({ configPath: path.join(dir, "none.toml") });
      assert.equal(empty.kind, "vanilla-openai");
      assert.equal(empty.requiresOpenaiAuth, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("auto profile generation", () => {
  it("uses conservative unknowns and reads context when the upstream provides it", async () => {
    const wiring = {
      kind: "vanilla-openai" as const,
      source: "test",
      baseUrl: "http://upstream/v1",
      modelsUrl: "http://upstream/v1/models",
      wireApi: "responses" as const
    };
    const fetchedImpl: typeof fetch = async () =>
      new Response(JSON.stringify({
        data: [
          { id: "deepseek-v4-flash", capabilities: { context_length: 1_000_000 } },
          { id: "mystery-model" }
        ]
      }), { status: 200 });
    const fetched = await fetchModelIds(wiring, fetchedImpl);
    const profiles = profilesFromModelIds(fetched);
    assert.equal(profiles[0]?.static.tier, "low");
    assert.equal(profiles[0]?.static.contextLimit, 1_000_000);
    assert.equal(profiles[1]?.static.tier, "medium");
    assert.equal(profiles[1]?.static.contextLimit, 128_000);
    assert.equal(profiles[0]?.providerId, "passthrough");
    assert.equal(profiles[0]?.static.supportsTools, true);
  });
});

describe("netstat parsing", () => {
  it("finds the listening PID for a port", () => {
    const output = [
      "  TCP    127.0.0.1:10300       0.0.0.0:0              LISTENING       4242",
      "  TCP    127.0.0.1:10100       0.0.0.0:0              LISTENING       9999"
    ].join("\r\n");
    assert.equal(parseNetstatPid(output, 10300), 4242);
    assert.equal(parseNetstatPid(output, 20000), undefined);
  });
});
