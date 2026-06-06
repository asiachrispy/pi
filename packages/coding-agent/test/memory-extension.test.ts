import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryExtension, {
	applyMemoryEvent,
	buildMemoryIndex,
	formatMemoryEntries,
	getMemoryVisibility,
	getProjectMemoryPath,
	isForgotten,
	type MemoryEntry,
	type MemoryEvent,
	mergeProjectStore,
	parseProjectSnapshot,
	rebuildFromSessionEntries,
	searchMemories,
	serializeProjectSnapshot,
	sortForIndex,
	validateMemorySetInput,
	writeProjectSnapshot,
} from "../examples/extensions/memory.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "../src/index.ts";

interface TextResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
}

type CapturedHandler = (event: Record<string, unknown>, ctx: ExtensionContext) => Promise<unknown> | unknown;
type CapturedToolExecutor = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: undefined,
	ctx: ExtensionContext,
) => Promise<TextResult>;

interface CapturedTool {
	name: string;
	execute: CapturedToolExecutor;
}

interface CapturedCommand {
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
}

interface CapturedApi {
	api: ExtensionAPI;
	tools: Map<string, CapturedTool>;
	commands: Map<string, CapturedCommand>;
	handlers: Map<string, CapturedHandler[]>;
	entries: Array<{ customType: string; data: unknown }>;
}

const NOW = Date.UTC(2026, 5, 6, 12, 0, 0);
const DAY_MS = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isCapturedTool(value: unknown): value is CapturedTool {
	return isRecord(value) && typeof value.name === "string" && typeof value.execute === "function";
}

function isCapturedCommand(value: unknown): value is CapturedCommand {
	return isRecord(value) && typeof value.handler === "function";
}

function createMemory(overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "key" | "value">): MemoryEntry {
	return {
		key: overrides.key,
		value: overrides.value,
		category: overrides.category ?? "fact",
		createdAt: overrides.createdAt ?? NOW,
		updatedAt: overrides.updatedAt ?? NOW,
		accessCount: overrides.accessCount ?? 0,
		lastAccessed: overrides.lastAccessed ?? NOW,
		importance: overrides.importance ?? 3,
	};
}

function memoryCustomEntry(id: string, data: MemoryEvent, parentId: string | null = null): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: new Date(NOW).toISOString(),
		customType: "memory",
		data,
	};
}

function createCapturedApi(): CapturedApi {
	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, CapturedCommand>();
	const handlers = new Map<string, CapturedHandler[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];

	const api = {
		on: (event: string, handler: CapturedHandler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerTool: (tool: unknown) => {
			if (isCapturedTool(tool)) tools.set(tool.name, tool);
		},
		registerCommand: (name: string, options: unknown) => {
			if (isCapturedCommand(options)) commands.set(name, options);
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ customType, data });
		},
		registerShortcut: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		setSessionName: vi.fn(),
		getSessionName: vi.fn(),
		setLabel: vi.fn(),
		exec: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
		getCommands: vi.fn(() => []),
		setModel: vi.fn(async () => false),
		getThinkingLevel: vi.fn(() => "off"),
		setThinkingLevel: vi.fn(),
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
		events: {},
	} as unknown as ExtensionAPI;

	return { api, tools, commands, handlers, entries };
}

function createContext(
	cwd: string,
	branch: SessionEntry[] = [],
	options: { hasUI?: boolean; confirm?: boolean; notifications?: string[] } = {},
): ExtensionContext {
	const notifications = options.notifications;
	const ui = {
		notify: (message: string) => {
			notifications?.push(message);
		},
		confirm: vi.fn(async () => options.confirm ?? true),
	} as unknown as ExtensionContext["ui"];

	return {
		mode: "tui",
		hasUI: options.hasUI ?? true,
		ui,
		cwd,
		sessionManager: {
			getBranch: () => branch,
		} as unknown as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		isIdle: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		compact: vi.fn(),
		getSystemPrompt: () => "",
	};
}

async function runHandlers(
	captured: CapturedApi,
	eventName: string,
	event: Record<string, unknown>,
	ctx: ExtensionContext,
) {
	for (const handler of captured.handlers.get(eventName) ?? []) {
		await handler(event, ctx);
	}
}

async function runContextHandler(captured: CapturedApi, messages: AgentMessage[], ctx: ExtensionContext) {
	const handler = captured.handlers.get("context")?.[0];
	expect(handler).toBeDefined();
	return handler?.({ type: "context", messages }, ctx);
}

function readProjectStore(cwd: string): Map<string, MemoryEntry> {
	return parseProjectSnapshot(readFileSync(getProjectMemoryPath(cwd), "utf8"));
}

describe("memory final extension helpers", () => {
	it("validates keys, values, categories, importance, and sensitive names", () => {
		expect(validateMemorySetInput({ key: "preferred_db", value: "PostgreSQL" })).toMatchObject({
			ok: true,
			category: "fact",
			importance: 3,
		});
		expect(validateMemorySetInput({ key: "UPPER", value: "x" })).toMatchObject({ ok: false });
		expect(validateMemorySetInput({ key: "bad__key", value: "x" })).toMatchObject({ ok: false });
		expect(validateMemorySetInput({ key: "api_key", value: "x" })).toMatchObject({ ok: false });
		expect(validateMemorySetInput({ key: "valid_key", value: "" })).toMatchObject({ ok: false });
		expect(validateMemorySetInput({ key: "valid_key", value: "x", importance: 6 })).toMatchObject({ ok: false });
	});

	it("rebuilds from events and keeps branch deletes ahead of project snapshots", () => {
		const setEvent: MemoryEvent = {
			op: "set",
			key: "preferred_db",
			value: "PostgreSQL",
			category: "preference",
			importance: 4,
			timestamp: NOW,
		};
		const overwriteEvent: MemoryEvent = {
			op: "set",
			key: "preferred_db",
			value: "SQLite",
			category: "decision",
			importance: 2,
			timestamp: NOW + 1,
		};
		const deleteEvent: MemoryEvent = { op: "delete", key: "old_url", timestamp: NOW + 2 };

		const result = rebuildFromSessionEntries([
			memoryCustomEntry("1", setEvent),
			memoryCustomEntry("2", overwriteEvent, "1"),
			memoryCustomEntry("3", deleteEvent, "2"),
		]);

		expect(result.store.get("preferred_db")).toMatchObject({
			value: "SQLite",
			category: "decision",
			importance: 2,
		});
		expect(result.touchedKeys.has("old_url")).toBe(true);

		const project = new Map<string, MemoryEntry>([
			["old_url", createMemory({ key: "old_url", value: "https://old.example" })],
			["ci_provider", createMemory({ key: "ci_provider", value: "GitHub Actions", accessCount: 8 })],
			["preferred_db", createMemory({ key: "preferred_db", value: "MySQL", accessCount: 20 })],
		]);
		const merged = mergeProjectStore(result.store, result.touchedKeys, project);

		expect(merged.has("old_url")).toBe(false);
		expect(merged.get("ci_provider")).toMatchObject({ value: "GitHub Actions" });
		expect(merged.get("preferred_db")).toMatchObject({ value: "SQLite", accessCount: 20 });
	});

	it("classifies forgetting, importance resistance, hot index, search, and formatting", () => {
		const active = createMemory({ key: "active_fact", value: "recent", lastAccessed: NOW - DAY_MS });
		const dormant = createMemory({ key: "dormant_fact", value: "older", lastAccessed: NOW - 10 * DAY_MS });
		const forgotten = createMemory({ key: "forgotten_fact", value: "stale", lastAccessed: NOW - 25 * DAY_MS });
		const reinforced = createMemory({
			key: "reinforced_fact",
			value: "visited",
			lastAccessed: NOW - 25 * DAY_MS,
			accessCount: 10,
		});
		const important = createMemory({
			key: "important_decision",
			value: "keep",
			category: "decision",
			lastAccessed: NOW - 90 * DAY_MS,
			importance: 5,
		});

		expect(getMemoryVisibility(active, NOW)).toBe("active");
		expect(getMemoryVisibility(dormant, NOW)).toBe("dormant");
		expect(getMemoryVisibility(forgotten, NOW)).toBe("forgotten");
		expect(getMemoryVisibility(reinforced, NOW)).toBe("dormant");
		expect(getMemoryVisibility(important, NOW)).toBe("dormant");
		expect(isForgotten(important, NOW)).toBe(false);

		const store = new Map<string, MemoryEntry>([
			[active.key, active],
			[dormant.key, dormant],
			[forgotten.key, forgotten],
			[reinforced.key, reinforced],
			[important.key, important],
		]);
		const index = buildMemoryIndex(store, NOW);
		expect(index).toContain("[memory:5, +3 dormant]");
		expect(index).toContain("F active_fact: recent");
		expect(index).not.toContain("dormant_fact");
		expect(searchMemories(store, "stale", NOW)).toHaveLength(0);
		expect(searchMemories(store, "older", NOW)[0]?.key).toBe("dormant_fact");
		expect(formatMemoryEntries([forgotten], NOW, true)).toContain("[stale]");

		const sorted = sortForIndex([active, { ...active, key: "high", accessCount: 20, importance: 5 }], NOW);
		expect(sorted[0]?.key).toBe("high");
	});

	it("serializes and parses project snapshots", () => {
		const store = new Map<string, MemoryEntry>([
			["b_key", createMemory({ key: "b_key", value: "b" })],
			["a_key", createMemory({ key: "a_key", value: "a" })],
		]);

		const text = serializeProjectSnapshot(store);
		expect(text.split("\n")[0]).toContain('"a_key"');
		expect(parseProjectSnapshot(`${text}\nnot-json\n`).size).toBe(2);
	});

	it("applies snapshot events during replay", () => {
		const store = new Map<string, MemoryEntry>();
		const touched = new Set<string>();
		applyMemoryEvent(store, touched, {
			op: "snapshot",
			memories: [createMemory({ key: "snapshot_key", value: "snapshot" })],
			touchedKeys: ["deleted_key", "snapshot_key"],
			timestamp: NOW,
		});

		expect(store.get("snapshot_key")?.value).toBe("snapshot");
		expect(touched.has("snapshot_key")).toBe(true);
		expect(touched.has("deleted_key")).toBe(true);
	});

	it("keeps snapshot tombstones when merging a project snapshot", () => {
		const sessionResult = rebuildFromSessionEntries([
			memoryCustomEntry("1", {
				op: "snapshot",
				memories: [createMemory({ key: "kept_key", value: "branch" })],
				touchedKeys: ["deleted_key", "kept_key"],
				timestamp: NOW,
			}),
		]);
		const project = new Map<string, MemoryEntry>([
			["deleted_key", createMemory({ key: "deleted_key", value: "project" })],
			["project_key", createMemory({ key: "project_key", value: "project" })],
		]);

		const merged = mergeProjectStore(sessionResult.store, sessionResult.touchedKeys, project);

		expect(merged.has("deleted_key")).toBe(false);
		expect(merged.get("kept_key")?.value).toBe("branch");
		expect(merged.get("project_key")?.value).toBe("project");
	});
});

describe("memory final extension runtime", () => {
	let tempDir: string;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		vi.useRealTimers();
	});

	it("registers tools, writes session events and project snapshots, reinforces access, and injects one index", async () => {
		vi.setSystemTime(NOW);
		tempDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
		const captured = createCapturedApi();
		memoryExtension(captured.api);
		const ctx = createContext(tempDir);
		await runHandlers(captured, "session_start", { type: "session_start" }, ctx);

		const setResult = await captured.tools
			.get("memory_set")
			?.execute(
				"tool-1",
				{ key: "preferred_db", value: "PostgreSQL", category: "preference", importance: 5 },
				undefined,
				undefined,
				ctx,
			);
		expect(setResult?.content[0]?.text).toContain("Saved");
		expect(captured.entries).toHaveLength(1);
		expect(captured.entries[0]?.customType).toBe("memory");
		expect(readProjectStore(tempDir).get("preferred_db")).toMatchObject({
			value: "PostgreSQL",
			category: "preference",
			importance: 5,
		});

		const getResult = await captured.tools
			.get("memory_get")
			?.execute("tool-2", { key: "preferred_db" }, undefined, undefined, ctx);
		expect(getResult?.content[0]?.text).toContain("PostgreSQL");
		await runHandlers(captured, "session_shutdown", { type: "session_shutdown" }, ctx);
		expect(readProjectStore(tempDir).get("preferred_db")?.accessCount).toBe(1);

		const oldIndex = {
			role: "custom",
			customType: "memory-index",
			content: "old",
			display: false,
			timestamp: NOW,
		} as unknown as AgentMessage;
		const userMessage = { role: "user", content: "hi", timestamp: NOW } satisfies AgentMessage;
		const contextResult = await runContextHandler(captured, [oldIndex, userMessage], ctx);
		expect(contextResult).toMatchObject({ messages: expect.any(Array) });
		const messages = isRecord(contextResult) && Array.isArray(contextResult.messages) ? contextResult.messages : [];
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ role: "custom", customType: "memory-index" });
		expect(isRecord(messages[0]) && typeof messages[0].content === "string" ? messages[0].content : "").toContain(
			"preferred_db",
		);
	});

	it("restores project snapshots and lets current branch events win", async () => {
		vi.setSystemTime(NOW);
		tempDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
		await writeProjectSnapshot(
			tempDir,
			new Map([
				["preferred_db", createMemory({ key: "preferred_db", value: "MySQL", accessCount: 3 })],
				["ci_provider", createMemory({ key: "ci_provider", value: "GitHub Actions" })],
			]),
		);
		const branch = [
			memoryCustomEntry("1", {
				op: "set",
				key: "preferred_db",
				value: "SQLite",
				category: "decision",
				importance: 2,
				timestamp: NOW,
			}),
		];
		const captured = createCapturedApi();
		memoryExtension(captured.api);
		const ctx = createContext(tempDir, branch);

		await runHandlers(captured, "session_start", { type: "session_start" }, ctx);
		const listResult = await captured.tools.get("memory_list")?.execute("tool-1", {}, undefined, undefined, ctx);

		expect(listResult?.content[0]?.text).toContain("preferred_db: SQLite");
		expect(listResult?.content[0]?.text).toContain("ci_provider: GitHub Actions");
	});

	it("cleans stale memories only after confirmation and writes delete events", async () => {
		vi.setSystemTime(NOW);
		tempDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
		await writeProjectSnapshot(
			tempDir,
			new Map([["old_fact", createMemory({ key: "old_fact", value: "stale", lastAccessed: NOW - 25 * DAY_MS })]]),
		);

		const captured = createCapturedApi();
		memoryExtension(captured.api);
		const cancelNotifications: string[] = [];
		const cancelCtx = createContext(tempDir, [], { confirm: false, notifications: cancelNotifications });
		await runHandlers(captured, "session_start", { type: "session_start" }, cancelCtx);
		await captured.commands.get("memory")?.handler("clean", cancelCtx as ExtensionCommandContext);

		expect(cancelNotifications.at(-1)).toBe("Memory clean cancelled.");
		expect(readProjectStore(tempDir).has("old_fact")).toBe(true);

		const confirmNotifications: string[] = [];
		const confirmCtx = createContext(tempDir, [], { confirm: true, notifications: confirmNotifications });
		await runHandlers(captured, "session_start", { type: "session_start" }, confirmCtx);
		await captured.commands.get("memory")?.handler("clean", confirmCtx as ExtensionCommandContext);

		expect(confirmNotifications.at(-1)).toBe("Deleted 1 stale memories.");
		expect(readProjectStore(tempDir).has("old_fact")).toBe(false);
		expect(captured.entries.some((entry) => isRecord(entry.data) && entry.data.op === "delete")).toBe(true);
	});

	it("refuses memory clean without interactive confirmation support", async () => {
		vi.setSystemTime(NOW);
		tempDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
		await writeProjectSnapshot(
			tempDir,
			new Map([["old_fact", createMemory({ key: "old_fact", value: "stale", lastAccessed: NOW - 25 * DAY_MS })]]),
		);

		const captured = createCapturedApi();
		memoryExtension(captured.api);
		const notifications: string[] = [];
		const ctx = createContext(tempDir, [], { hasUI: false, notifications });
		await runHandlers(captured, "session_start", { type: "session_start" }, ctx);
		await captured.commands.get("memory")?.handler("clean", ctx as ExtensionCommandContext);

		expect(notifications.at(-1)).toBe("/memory clean requires confirmation in an interactive UI.");
		expect(readProjectStore(tempDir).has("old_fact")).toBe(true);
	});

	it("appends a snapshot event before compaction when access updates are dirty", async () => {
		vi.setSystemTime(NOW);
		tempDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
		const captured = createCapturedApi();
		memoryExtension(captured.api);
		const ctx = createContext(tempDir);
		await runHandlers(captured, "session_start", { type: "session_start" }, ctx);
		await captured.tools
			.get("memory_set")
			?.execute("tool-1", { key: "preferred_db", value: "PostgreSQL" }, undefined, undefined, ctx);
		await captured.tools.get("memory_get")?.execute("tool-2", { key: "preferred_db" }, undefined, undefined, ctx);

		await runHandlers(captured, "session_before_compact", { type: "session_before_compact" }, ctx);

		expect(captured.entries.some((entry) => isRecord(entry.data) && entry.data.op === "snapshot")).toBe(true);
		expect(readProjectStore(tempDir).get("preferred_db")?.accessCount).toBe(1);
	});

	it("persists access reinforcement before session tree navigation", async () => {
		vi.setSystemTime(NOW);
		tempDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
		await writeProjectSnapshot(
			tempDir,
			new Map([["preferred_db", createMemory({ key: "preferred_db", value: "PostgreSQL", accessCount: 0 })]]),
		);
		const captured = createCapturedApi();
		memoryExtension(captured.api);
		const ctx = createContext(tempDir);
		await runHandlers(captured, "session_start", { type: "session_start" }, ctx);
		await captured.tools.get("memory_get")?.execute("tool-1", { key: "preferred_db" }, undefined, undefined, ctx);

		await runHandlers(captured, "session_before_tree", { type: "session_before_tree" }, ctx);
		await runHandlers(captured, "session_tree", { type: "session_tree" }, ctx);

		expect(readProjectStore(tempDir).get("preferred_db")?.accessCount).toBe(1);
	});

	it("appends a compaction snapshot after clean memory_set persistence", async () => {
		vi.setSystemTime(NOW);
		tempDir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
		const captured = createCapturedApi();
		memoryExtension(captured.api);
		const ctx = createContext(tempDir);
		await runHandlers(captured, "session_start", { type: "session_start" }, ctx);
		await captured.tools
			.get("memory_set")
			?.execute("tool-1", { key: "preferred_db", value: "PostgreSQL" }, undefined, undefined, ctx);

		await runHandlers(captured, "session_before_compact", { type: "session_before_compact" }, ctx);

		const snapshot = captured.entries.find((entry) => isRecord(entry.data) && entry.data.op === "snapshot");
		expect(snapshot?.data).toMatchObject({ op: "snapshot", touchedKeys: ["preferred_db"] });
	});
});
