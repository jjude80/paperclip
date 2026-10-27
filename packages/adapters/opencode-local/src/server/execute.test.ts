import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import fs_sync from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@paperclipai/adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { ensureRemoteOpenCodeModelConfiguredAndAvailable, execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@paperclipai/adapter-utils/execution-target";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

async function createSkillDir(root: string, name: string): Promise<string> {
  const skillDir = path.join(root, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, "SKILL.md"), `# ${name}\n`, "utf8");
  return skillDir;
}

function probeResult(overrides: Record<string, unknown>) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
    ...overrides,
  } as never;
}

describe("OpenCode local skill injection", () => {
  let configHome: string;

  beforeEach(async () => {
    configHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-test-config-"));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(configHome, { recursive: true, force: true });
  });

  it.each([false, true])("keeps chat policy with a legacy OpenCode prompt (custom=%s)", async (custom) => {
    const commandPath = path.join(configHome, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValue(probeResult({ stdout: JSON.stringify({
      type: "text", sessionID: "chat-session", part: { text: "Reply" },
    }) }));
    const directive = "Chat directive: clarify goals and hand plans off to project tasks.";
    let prompt = "";
    const result = await execute({
      runId: "chat-run",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: {
        command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" },
        ...(custom ? { promptTemplate: "Custom agent instruction." } : {}),
      },
      context: {
        conversationMode: true,
        paperclipTaskMarkdown: directive,
        paperclipWake: {
          reason: "issue_commented", issue: { id: "chat-1", status: "in_progress", workMode: "planning" },
          interactionKind: "request_confirmation", interactionStatus: "accepted",
        },
      },
      onLog: async () => {},
      onMeta: async (meta) => { prompt = String(meta.prompt ?? ""); },
    });
    expect(result.exitCode).toBe(0);
    expect(prompt).toContain(directive);
    expect(prompt).toContain(custom ? "Custom agent instruction." : "You are agent agent-1");
    expect(prompt).not.toContain("Execution contract:");
    expect(prompt).not.toContain("Create child issues");
  });

  it("delivers assignment context on an ordinary task turn and rebuilds it after resume fallback", async () => {
    const commandPath = path.join(configHome, "fake-opencode-context");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const prompts: string[] = [];
    runProcessMock
      .mockReset()
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "error", error: "unknown session" }) }))
      .mockResolvedValueOnce(probeResult({ stdout: JSON.stringify({ type: "text", sessionID: "fresh", part: { text: "done" } }) }));
    await execute({
      runId: "run-context-fallback",
      agent: { id: "agent-1", companyId: "company-1", name: "OpenCode", adapterType: "opencode_local", adapterConfig: {} },
      runtime: { sessionId: "previous", sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: commandPath, cwd: configHome, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
      context: createPromptContextFixture(),
      onLog: async () => {},
      onMeta: async (meta) => { prompts.push(String(meta.prompt ?? "")); },
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("## Compact assignment");
    expect(prompts[1]).toContain("## Owned assignment");
    for (const prompt of prompts) expect(prompt).not.toContain("Execution contract:");
    expect(prompts[1]).toContain("You are agent agent-1 (OpenCode).");
    expect(prompts[1]).toContain("Connection tools:");
  });

  it("injects runtime skills into the configured child HOME", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-configured-home-"));
    const processHome = path.join(root, "process-home");
    const configuredHome = path.join(root, "configured-home");
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const skillSource = await createSkillDir(path.join(root, "runtime-skills"), "paperclip");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);

    const previousHome = process.env.HOME;
    process.env.HOME = processHome;
    runProcessMock.mockReset();
    runProcessMock.mockResolvedValueOnce(probeResult({
      stdout: JSON.stringify({
        type: "text",
        sessionID: "session-configured-home",
        part: { text: "done" },
      }),
    }));

    try {
      const result = await execute({
        runId: "run-configured-home",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "openai/gpt-5",
          env: {
            HOME: configuredHome,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          paperclipRuntimeSkills: [{
            key: "paperclipai/paperclip/paperclip",
            runtimeName: "paperclip",
            source: skillSource,
          }],
          promptTemplate: "Follow the paperclip heartbeat.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(0);
      const installedSkill = path.join(configuredHome, ".claude", "skills", "paperclip");
      expect((await fs.lstat(installedSkill)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(installedSkill)).toBe(await fs.realpath(skillSource));
      await expect(fs.lstat(path.join(processHome, ".claude", "skills", "paperclip"))).rejects.toThrow();
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])("preserves API billing in streamed usage and final results without leaking keys (timedOut=%s)", async (timedOut) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-openrouter-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "opencode");
    const apiKey = "openrouter-test-secret";
    const model = "openrouter/anthropic/claude-sonnet-4.5";
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    runProcessMock.mockReset();
    const usageLine = JSON.stringify({ type: "step_finish", sessionID: "session-openrouter",
      part: { cost: 0.0025, tokens: { input: 10, output: 2, cache: { read: 100, write: 0 } } } });
    runProcessMock.mockImplementationOnce(async (...args) => {
      await args[4].onLog("stdout", `${usageLine}\n`);
      return probeResult({ stdout: usageLine, timedOut, exitCode: timedOut ? 143 : 0, signal: timedOut ? "SIGTERM" : null });
    });
    const logs: string[] = [];
    const metadata: unknown[] = [];
    const onUsage = vi.fn();

    try {
      const result = await execute({
        runId: "run-openrouter",
        agent: {
          id: "agent-openrouter",
          companyId: "company-1",
          name: "OpenRouter Coder",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model,
          env: {
            OPENROUTER_API_KEY: apiKey,
            OPENCODE_ALLOW_ALL_MODELS: "1",
          },
          promptTemplate: "Run the task.",
        },
        context: {},
        authToken: "run-jwt-token",
        onUsage,
        onLog: async (_stream, chunk) => {
          logs.push(chunk);
        },
        onMeta: async (value) => {
          metadata.push(value);
        },
      });

      expect(result.exitCode).toBe(timedOut ? 143 : 0);
      expect(result.usageComplete).toBe(!timedOut);
      expect(result.model).toBe(model);
      expect(result.billingType).toBe("metered_api");
      expect(result.biller).toBe("openrouter");
      expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ billingType: "metered_api", biller: "openrouter", model, complete: false }));
      expect(onUsage).toHaveBeenLastCalledWith(expect.objectContaining({ billingType: "metered_api", biller: "openrouter", model, complete: !timedOut }));
      const executionCall = runProcessMock.mock.calls.at(-1)!;
      expect(executionCall[3]).toContain("--model");
      expect(executionCall[3]).toContain(model);
      expect((executionCall[4] as { env: Record<string, string> }).env.OPENROUTER_API_KEY).toBe(apiKey);
      expect(JSON.stringify({ logs, metadata, result })).not.toContain(apiKey);
      expect(JSON.stringify(metadata)).toContain('"OPENROUTER_API_KEY":"***REDACTED***"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable", () => {
  afterEach(() => {
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
  });

  // The remote/sandbox execution path must honour OPENCODE_ALLOW_ALL_MODELS just
  // like the local path: gateway-routed models (e.g. anthropic/<gateway>/<model>
  // via Bifrost) never appear in `opencode models`, so the availability probe
  // must be skipped. The early return happens before the executionTarget is ever
  // touched, so a bogus target proves the probe was not run.
  const bogusTarget = {} as never;

  it("skips the remote availability probe when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-1",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-2",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        cwd: "/tmp",
        env: {},
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).resolves.toBeUndefined();
  });

  it("still enforces provider/model format even when the bypass flag is set", async () => {
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({
        runId: "run-3",
        executionTarget: bogusTarget,
        command: "opencode",
        model: "",
        cwd: "/tmp",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
        timeoutSec: 30,
        graceSec: 5,
      }),
    ).rejects.toThrow();
  });
});

describe("ensureRemoteOpenCodeModelConfiguredAndAvailable — probe is non-fatal when it cannot run", () => {
  const target = { kind: "remote", transport: "ssh" } as never;
  const base = {
    runId: "run-probe",
    executionTarget: target,
    command: "opencode",
    cwd: "/tmp",
    env: {} as Record<string, string>,
    timeoutSec: 30,
    graceSec: 5,
  };

  beforeEach(() => {
    runProcessMock.mockReset();
  });

  it("proceeds when the remote probe exits non-zero (e.g. a transient `Unexpected error`)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 1, stderr: "Unexpected error" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe times out", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ timedOut: true, exitCode: null }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("proceeds when the remote probe returns no models", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).resolves.toBeUndefined();
  });

  it("still rejects when the probe succeeds but the configured model is absent (guard retained)", async () => {
    runProcessMock.mockResolvedValueOnce(probeResult({ exitCode: 0, stdout: "openai/gpt-4.1\n" }));
    await expect(
      ensureRemoteOpenCodeModelConfiguredAndAvailable({ ...base, model: "openai/gpt-5" }),
    ).rejects.toThrow("Configured OpenCode model is unavailable on the remote execution target");
  });
});

describe("NEXA-643 secret-file environment", () => {
  let secretBase: string;

  beforeEach(async () => {
    secretBase = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-secret-env-"));
    vi.stubEnv("PAPERCLIP_SECRET_FILE_DIR", secretBase);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(secretBase, { recursive: true, force: true });
  });

  interface SpawnSnapshot {
    env: Record<string, string>;
    files: Record<string, string>;
    modes: Record<string, string>;
  }

  async function runWithSecrets(): Promise<SpawnSnapshot> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-643-"));
    const commandPath = path.join(root, "fake-opencode");
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    runProcessMock.mockReset();
    const snapshot: SpawnSnapshot = { env: {}, files: {}, modes: {} };
    // The adapter deletes the directory when the run ends, so the spawn env and
    // the carrier contents have to be captured at spawn time, not afterwards.
    runProcessMock.mockImplementation(async (...args) => {
      snapshot.env = { ...(args[4] as { env: Record<string, string> }).env };
      for (const [key, file] of Object.entries(snapshot.env)) {
        if (!key.endsWith("_FILE")) continue;
        snapshot.files[key] = fs_sync.readFileSync(file, "utf8");
        snapshot.modes[key] = ((fs_sync.statSync(file).mode & 0o777).toString(8));
      }
      return probeResult({ exitCode: 0, stdout: "" });
    });
    const identity = {
      keyId: "key-1",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\npublic\n-----END PUBLIC KEY-----",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
    };
    try {
      await execute({
        runId: "run-secret-files",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "OpenCode",
          adapterType: "opencode_local",
          adapterConfig: {},
        },
        agentIdentity: identity,
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config: { command: commandPath, cwd: root, model: "openai/gpt-5", env: { OPENCODE_ALLOW_ALL_MODELS: "1" } },
        context: {},
        authToken: "run-jwt-token",
        runtimeTools: {
          version: 1,
          guidance: "guide",
          mcpEndpoint: "http://127.0.0.1:3100/runtime-tools/mcp",
          rest: {
            connectionsSearch: "http://127.0.0.1:3100/runtime-tools/connections/search",
            connectionRequest: "http://127.0.0.1:3100/runtime-tools/connections/request",
          },
          bearerToken: "runtime-tools-jwt",
          expiresAt: "2026-10-27T00:00:00.000Z",
          tools: ["connections_search", "connection_request"],
        },
        onLog: async () => {},
      });
      return snapshot;
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("spawns with file paths and no bearer values in the child environment", async () => {
    const { env, files, modes } = await runWithSecrets();

    expect(env.PAPERCLIP_API_KEY).toBeUndefined();
    expect(env.PAPERCLIP_RUNTIME_TOOLS_TOKEN).toBeUndefined();
    expect(env.PAPERCLIP_AGENT_PRIVATE_KEY).toBeUndefined();
    expect(env.PAPERCLIP_AGENT_PUBLIC_KEY).toBeTruthy();

    expect(env.PAPERCLIP_API_TOKEN_FILE).toBeTruthy();
    expect(files.PAPERCLIP_API_TOKEN_FILE.trim()).toBe("run-jwt-token");
    expect(files.PAPERCLIP_RUNTIME_TOOLS_TOKEN_FILE.trim()).toBe("runtime-tools-jwt");
    expect(files.PAPERCLIP_AGENT_PRIVATE_KEY_FILE.trim()).toBe(
      "-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
    );
    expect(modes).toEqual({
      PAPERCLIP_API_TOKEN_FILE: "600",
      PAPERCLIP_RUNTIME_TOOLS_TOKEN_FILE: "600",
      PAPERCLIP_AGENT_PRIVATE_KEY_FILE: "600",
    });

    // No value survives anywhere in the environment handed to the child.
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("run-jwt-token");
    expect(serialized).not.toContain("runtime-tools-jwt");
    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
  }, 20_000);

  it("removes the private directory when the run ends", async () => {
    const { env } = await runWithSecrets();
    await expect(fs.stat(path.dirname(env.PAPERCLIP_API_TOKEN_FILE))).rejects.toThrow();
  }, 20_000);

  it("keeps the old env injection when the rollback flag is set", async () => {
    vi.stubEnv("PAPERCLIP_SECRET_FILE_ENV", "0");
    const { env } = await runWithSecrets();
    expect(env.PAPERCLIP_API_KEY).toBe("run-jwt-token");
    expect(env.PAPERCLIP_API_TOKEN_FILE).toBeUndefined();
  }, 20_000);
});
