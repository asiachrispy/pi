import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

function parseResponses(outputLines: string[], id: string, command: string): Array<Record<string, unknown>> {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.filter((record) => record.id === id && record.type === "response" && record.command === command);
}

async function startRpcHarness(): Promise<{
	lineHandler: (line: string) => void;
	session: AgentSession;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const tempDir = join(tmpdir(), `pi-rpc-tree-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { systemPrompt: "Test", tools: [] },
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		lineHandler: rpcIo.lineHandler!,
		session,
		cleanup: async () => {
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

describe("RPC tree/tools commands", () => {
	it("handles get_tools and set_tools", async () => {
		const { lineHandler, cleanup } = await startRpcHarness();
		try {
			lineHandler(JSON.stringify({ id: "t1", type: "get_tools" }));
			await vi.waitFor(() => {
				const responses = parseResponses(rpcIo.outputLines, "t1", "get_tools");
				expect(responses).toHaveLength(1);
				expect(responses[0]?.success).toBe(true);
				expect(responses[0]?.data).toEqual({ tools: expect.any(Array) });
			});

			rpcIo.outputLines = [];
			lineHandler(JSON.stringify({ id: "t2", type: "set_tools", toolNames: ["read"] }));
			await vi.waitFor(() => {
				const responses = parseResponses(rpcIo.outputLines, "t2", "set_tools");
				expect(responses).toHaveLength(1);
				expect(responses[0]?.success).toBe(true);
			});
		} finally {
			await cleanup();
		}
	});

	it("returns error for missing navigate_tree target", async () => {
		const { lineHandler, cleanup } = await startRpcHarness();
		try {
			lineHandler(JSON.stringify({ id: "t3", type: "navigate_tree", targetId: "missing-entry" }));
			await vi.waitFor(() => {
				const responses = parseResponses(rpcIo.outputLines, "t3", "navigate_tree");
				expect(responses).toHaveLength(1);
				expect(responses[0]?.success).toBe(false);
			});
		} finally {
			await cleanup();
		}
	});
});
