/**
 * Pi Memory Final Extension
 *
 * Project-local, branch-aware memory with a compact index, explicit retrieval
 * tools, and human-memory-inspired forgetting rules.
 *
 * Usage:
 *   pi --extension packages/coding-agent/examples/extensions/memory.ts
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

export type MemoryCategory = "fact" | "decision" | "preference" | "context";
export type MemoryImportance = 1 | 2 | 3 | 4 | 5;
export type MemoryVisibility = "active" | "dormant" | "forgotten";

export interface MemoryEntry {
	key: string;
	value: string;
	category: MemoryCategory;
	createdAt: number;
	updatedAt: number;
	accessCount: number;
	lastAccessed: number;
	importance: MemoryImportance;
}

export interface MemorySetEvent {
	op: "set";
	key: string;
	value: string;
	category: MemoryCategory;
	importance: MemoryImportance;
	timestamp: number;
}

export interface MemoryDeleteEvent {
	op: "delete";
	key: string;
	timestamp: number;
}

export interface MemorySnapshotEvent {
	op: "snapshot";
	memories: MemoryEntry[];
	touchedKeys: string[];
	timestamp: number;
}

export type MemoryEvent = MemorySetEvent | MemoryDeleteEvent | MemorySnapshotEvent;

export interface RebuildResult {
	store: Map<string, MemoryEntry>;
	touchedKeys: Set<string>;
}

interface MemorySetInput {
	key: string;
	value: string;
	category?: MemoryCategory;
	importance?: number;
}

interface ValidationSuccess {
	ok: true;
	key: string;
	value: string;
	category: MemoryCategory;
	importance: MemoryImportance;
	warning?: string;
}

interface ValidationFailure {
	ok: false;
	error: string;
}

type ValidationResult = ValidationSuccess | ValidationFailure;

interface MemoryDetails {
	action: "set" | "get" | "search" | "list" | "delete" | "clean";
	key?: string;
	error?: string;
	warning?: string;
	memories: MemoryEntry[];
}

const MEMORY_CUSTOM_TYPE = "memory";
const MEMORY_INDEX_CUSTOM_TYPE = "memory-index";
const MEMORY_FILE = join(".pi", "memory.jsonl");
const DAY_MS = 86_400_000;
const MAX_HOT_KEYS = 8;
const MAX_SEARCH_RESULTS = 5;
const PREVIEW_LENGTH = 80;
const DEFAULT_IMPORTANCE: MemoryImportance = 3;
const CATEGORIES = ["fact", "decision", "preference", "context"] as const;
const SENSITIVE_KEY_PATTERN =
	/(?:api[_-]?key|auth[_-]?token|private[_-]?key|token|secret|password|passwd|credentials?|credential)/i;

const MemorySetParams = Type.Object({
	key: Type.String({ description: "Memory key: snake_case, <= 64 chars" }),
	value: Type.String({ description: "Memory value" }),
	category: Type.Optional(
		StringEnum(CATEGORIES, {
			description: "Memory category: fact | decision | preference | context",
			default: "fact",
		}),
	),
	importance: Type.Optional(Type.Number({ description: "Importance from 1 to 5. Defaults to 3." })),
});

const MemoryGetParams = Type.Object({
	key: Type.String({ description: "Exact memory key" }),
});

const MemorySearchParams = Type.Object({
	query: Type.String({ description: "Keyword query. Empty string or * returns the hottest memories." }),
});

const MemoryListParams = Type.Object({
	category: Type.Optional(StringEnum(CATEGORIES, { description: "Optional category filter" })),
});

const MemoryDeleteParams = Type.Object({
	key: Type.String({ description: "Exact memory key to delete" }),
});

export function getProjectMemoryPath(cwd: string): string {
	return join(cwd, MEMORY_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
	return CATEGORIES.includes(value as MemoryCategory);
}

function isMemoryImportance(value: unknown): value is MemoryImportance {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

export function isSensitiveKey(key: string): boolean {
	return SENSITIVE_KEY_PATTERN.test(key);
}

export function isMemoryEntry(value: unknown): value is MemoryEntry {
	if (!isRecord(value)) return false;
	return (
		typeof value.key === "string" &&
		typeof value.value === "string" &&
		isMemoryCategory(value.category) &&
		typeof value.createdAt === "number" &&
		typeof value.updatedAt === "number" &&
		typeof value.accessCount === "number" &&
		Number.isInteger(value.accessCount) &&
		typeof value.lastAccessed === "number" &&
		isMemoryImportance(value.importance)
	);
}

export function isMemoryEvent(value: unknown): value is MemoryEvent {
	if (!isRecord(value) || typeof value.op !== "string") return false;
	if (value.op === "set") {
		return (
			typeof value.key === "string" &&
			typeof value.value === "string" &&
			isMemoryCategory(value.category) &&
			isMemoryImportance(value.importance) &&
			typeof value.timestamp === "number"
		);
	}
	if (value.op === "delete") {
		return typeof value.key === "string" && typeof value.timestamp === "number";
	}
	if (value.op === "snapshot") {
		return (
			Array.isArray(value.memories) &&
			value.memories.every(isMemoryEntry) &&
			Array.isArray(value.touchedKeys) &&
			value.touchedKeys.every((key) => typeof key === "string") &&
			typeof value.timestamp === "number"
		);
	}
	return false;
}

export function validateMemorySetInput(input: MemorySetInput): ValidationResult {
	const key = input.key.trim();
	const value = input.value.trim();
	const category = input.category ?? "fact";
	const importance = input.importance ?? DEFAULT_IMPORTANCE;

	if (!key) return { ok: false, error: "Memory key is required." };
	if (key.length > 64) return { ok: false, error: "Memory key must be 64 characters or fewer." };
	if (!/^[a-z][a-z0-9_]*$/.test(key)) {
		return {
			ok: false,
			error: "Memory key must be snake_case and start with a lowercase letter.",
		};
	}
	if (key.includes("__")) return { ok: false, error: "Memory key must not contain consecutive underscores." };
	if (isSensitiveKey(key)) {
		return {
			ok: false,
			error: "Refusing to store sensitive credentials, tokens, passwords, or secrets in memory.",
		};
	}
	if (!value) return { ok: false, error: "Memory value is required." };
	if (!isMemoryCategory(category)) {
		return { ok: false, error: "Memory category must be fact, decision, preference, or context." };
	}
	if (!isMemoryImportance(importance)) {
		return { ok: false, error: "Memory importance must be an integer from 1 to 5." };
	}

	return {
		ok: true,
		key,
		value,
		category,
		importance,
		warning: value.length > 500 ? "[long value] Stored value is longer than 500 characters." : undefined,
	};
}

export function getMemoryVisibility(entry: MemoryEntry, now: number): MemoryVisibility {
	const ageDays = Math.max(0, (now - entry.lastAccessed) / DAY_MS);
	const active = ageDays < 3 || (entry.accessCount >= 5 && ageDays < 7);
	if (active) return "active";
	if (entry.importance >= 4) return "dormant";
	const forgottenThreshold = entry.accessCount >= 10 ? 30 : 21;
	return ageDays > forgottenThreshold ? "forgotten" : "dormant";
}

export function isForgotten(entry: MemoryEntry, now: number): boolean {
	return getMemoryVisibility(entry, now) === "forgotten";
}

export function sortForIndex(entries: MemoryEntry[], now: number): MemoryEntry[] {
	return [...entries].sort((a, b) => getMemoryScore(b, now) - getMemoryScore(a, now));
}

export function getMemoryScore(entry: MemoryEntry, now: number): number {
	const accessDecay = 0.5 ** ((now - entry.lastAccessed) / DAY_MS / 7);
	const updateDecay = 0.5 ** ((now - entry.updatedAt) / DAY_MS / 14);
	return entry.accessCount * 5 + accessDecay * 50 + updateDecay * 30 + entry.importance * 10;
}

export function applyMemoryEvent(store: Map<string, MemoryEntry>, touchedKeys: Set<string>, event: MemoryEvent): void {
	if (event.op === "snapshot") {
		store.clear();
		touchedKeys.clear();
		for (const key of event.touchedKeys) {
			touchedKeys.add(key);
		}
		for (const memory of event.memories) {
			store.set(memory.key, { ...memory });
		}
		return;
	}

	touchedKeys.add(event.key);
	if (event.op === "delete") {
		store.delete(event.key);
		return;
	}

	const existing = store.get(event.key);
	store.set(event.key, {
		key: event.key,
		value: event.value,
		category: event.category,
		importance: event.importance,
		createdAt: existing?.createdAt ?? event.timestamp,
		updatedAt: event.timestamp,
		accessCount: existing?.accessCount ?? 0,
		lastAccessed: event.timestamp,
	});
}

export function rebuildFromSessionEntries(entries: SessionEntry[]): RebuildResult {
	const store = new Map<string, MemoryEntry>();
	const touchedKeys = new Set<string>();

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MEMORY_CUSTOM_TYPE) continue;
		if (!isMemoryEvent(entry.data)) continue;
		applyMemoryEvent(store, touchedKeys, entry.data);
	}

	return { store, touchedKeys };
}

export function mergeProjectStore(
	sessionStore: Map<string, MemoryEntry>,
	touchedKeys: Set<string>,
	projectStore: Map<string, MemoryEntry>,
): Map<string, MemoryEntry> {
	const merged = new Map<string, MemoryEntry>();
	for (const [key, entry] of sessionStore) {
		merged.set(key, { ...entry });
	}

	for (const [key, projectEntry] of projectStore) {
		const sessionEntry = merged.get(key);
		if (!sessionEntry && !touchedKeys.has(key)) {
			merged.set(key, { ...projectEntry });
			continue;
		}
		if (!sessionEntry) continue;
		merged.set(key, {
			...sessionEntry,
			accessCount: Math.max(sessionEntry.accessCount, projectEntry.accessCount),
			lastAccessed: Math.max(sessionEntry.lastAccessed, projectEntry.lastAccessed),
		});
	}

	return merged;
}

export function serializeProjectSnapshot(store: Map<string, MemoryEntry>): string {
	return `${Array.from(store.values())
		.sort((a, b) => a.key.localeCompare(b.key))
		.map((entry) => JSON.stringify(entry))
		.join("\n")}\n`;
}

export function parseProjectSnapshot(text: string): Map<string, MemoryEntry> {
	const store = new Map<string, MemoryEntry>();
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isMemoryEntry(parsed)) {
				store.set(parsed.key, { ...parsed });
			}
		} catch {}
	}
	return store;
}

export async function readProjectSnapshot(cwd: string): Promise<Map<string, MemoryEntry>> {
	try {
		return parseProjectSnapshot(await readFile(getProjectMemoryPath(cwd), "utf8"));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return new Map();
		throw error;
	}
}

export async function writeProjectSnapshot(cwd: string, store: Map<string, MemoryEntry>): Promise<void> {
	const memoryPath = getProjectMemoryPath(cwd);
	await mkdir(dirname(memoryPath), { recursive: true });
	await writeFile(memoryPath, serializeProjectSnapshot(store), "utf8");
}

function cloneStore(store: Map<string, MemoryEntry>): MemoryEntry[] {
	return Array.from(store.values()).map((entry) => ({ ...entry }));
}

function categoryPrefix(category: MemoryCategory): string {
	switch (category) {
		case "fact":
			return "F";
		case "decision":
			return "D";
		case "preference":
			return "P";
		case "context":
			return "C";
	}
}

function truncatePreview(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function previewValue(entry: MemoryEntry): string {
	if (isSensitiveKey(entry.key)) return "[redacted]";
	return truncatePreview(entry.value, PREVIEW_LENGTH);
}

export function buildMemoryIndex(store: Map<string, MemoryEntry>, now: number): string {
	if (store.size === 0) return "";
	const entries = Array.from(store.values());
	const dormantCount = entries.filter((entry) => getMemoryVisibility(entry, now) === "dormant").length;
	const hotEntries = sortForIndex(
		entries.filter((entry) => getMemoryVisibility(entry, now) === "active"),
		now,
	).slice(0, MAX_HOT_KEYS);
	const dormantText = dormantCount > 0 ? `, +${dormantCount} dormant` : "";
	const lines = [`[memory:${store.size}${dormantText}]`];
	for (const entry of hotEntries) {
		lines.push(`${categoryPrefix(entry.category)} ${entry.key}: ${previewValue(entry)}`);
	}
	return lines.join("\n");
}

export function searchMemories(store: Map<string, MemoryEntry>, query: string, now: number): MemoryEntry[] {
	const normalizedQuery = query.trim().toLowerCase();
	const candidates = Array.from(store.values()).filter((entry) => !isForgotten(entry, now));
	if (!normalizedQuery || normalizedQuery === "*") {
		return sortForIndex(candidates, now).slice(0, MAX_SEARCH_RESULTS);
	}
	return sortForIndex(
		candidates.filter(
			(entry) =>
				entry.key.toLowerCase().includes(normalizedQuery) || entry.value.toLowerCase().includes(normalizedQuery),
		),
		now,
	).slice(0, MAX_SEARCH_RESULTS);
}

export function formatMemoryEntries(entries: MemoryEntry[], now: number, includeVisibility: boolean): string {
	if (entries.length === 0) return "No memories stored.";
	return entries
		.map((entry) => {
			const visibility = getMemoryVisibility(entry, now);
			const stale = visibility === "forgotten" ? " [stale]" : "";
			const visibilityText = includeVisibility ? ` ${visibility}${stale}` : "";
			return `${categoryPrefix(entry.category)} ${entry.key}${visibilityText}: ${previewValue(entry)}`;
		})
		.join("\n");
}

function formatFullMemory(entry: MemoryEntry): string {
	return `[${entry.category}] ${entry.key}:\n${entry.value}`;
}

function availableKeys(store: Map<string, MemoryEntry>): string {
	const keys = Array.from(store.keys()).sort();
	return keys.length ? keys.join(", ") : "(none)";
}

function isMemoryIndexMessage(message: AgentMessage): boolean {
	return isRecord(message) && message.role === "custom" && message.customType === MEMORY_INDEX_CUSTOM_TYPE;
}

function makeMemoryIndexMessage(content: string, timestamp: number): AgentMessage {
	return {
		role: "custom",
		customType: MEMORY_INDEX_CUSTOM_TYPE,
		content,
		display: false,
		timestamp,
	} as unknown as AgentMessage;
}

function textResult(text: string, details: MemoryDetails) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

async function safeWriteProjectSnapshot(
	ctx: ExtensionContext,
	store: Map<string, MemoryEntry>,
	setClean: () => void,
): Promise<void> {
	try {
		await writeProjectSnapshot(ctx.cwd, store);
		setClean();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Memory snapshot write failed: ${message}`, "warning");
	}
}

export default function memoryExtension(pi: ExtensionAPI): void {
	let store = new Map<string, MemoryEntry>();
	let branchTouchedKeys = new Set<string>();
	let dirty = false;

	function markDirty(): void {
		dirty = true;
	}

	function markClean(): void {
		dirty = false;
	}

	async function persistSnapshot(ctx: ExtensionContext): Promise<void> {
		await safeWriteProjectSnapshot(ctx, store, markClean);
	}

	async function rebuild(ctx: ExtensionContext): Promise<void> {
		const sessionResult = rebuildFromSessionEntries(ctx.sessionManager.getBranch());
		const projectStore = await readProjectSnapshot(ctx.cwd);
		store = mergeProjectStore(sessionResult.store, sessionResult.touchedKeys, projectStore);
		branchTouchedKeys = new Set(sessionResult.touchedKeys);
		markClean();
	}

	async function setMemory(input: MemorySetInput, ctx: ExtensionContext) {
		const validation = validateMemorySetInput(input);
		if (!validation.ok) {
			return textResult(`Error: ${validation.error}`, {
				action: "set",
				error: validation.error,
				memories: cloneStore(store),
			});
		}

		const now = Date.now();
		const existing = store.get(validation.key);
		const entry: MemoryEntry = {
			key: validation.key,
			value: validation.value,
			category: validation.category,
			importance: validation.importance,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			accessCount: existing?.accessCount ?? 0,
			lastAccessed: now,
		};
		store.set(entry.key, entry);
		branchTouchedKeys.add(entry.key);
		markDirty();

		pi.appendEntry<MemoryEvent>(MEMORY_CUSTOM_TYPE, {
			op: "set",
			key: entry.key,
			value: entry.value,
			category: entry.category,
			importance: entry.importance,
			timestamp: now,
		});
		await persistSnapshot(ctx);

		const action = existing ? "Updated" : "Saved";
		const warning = validation.warning ? `\n${validation.warning}` : "";
		return textResult(`${action}: [${entry.category}] ${entry.key}${warning}`, {
			action: "set",
			key: entry.key,
			warning: validation.warning,
			memories: cloneStore(store),
		});
	}

	function getMemory(keyInput: string) {
		const key = keyInput.trim();
		const entry = store.get(key);
		if (!entry) {
			return textResult(`No memory found: ${key}\nAvailable: ${availableKeys(store)}`, {
				action: "get",
				key,
				memories: cloneStore(store),
			});
		}

		entry.accessCount += 1;
		entry.lastAccessed = Date.now();
		markDirty();
		return textResult(formatFullMemory(entry), {
			action: "get",
			key,
			memories: cloneStore(store),
		});
	}

	function searchMemory(query: string) {
		const now = Date.now();
		const results = searchMemories(store, query, now);
		for (const entry of results) {
			entry.accessCount += 1;
			entry.lastAccessed = now;
		}
		if (results.length > 0) markDirty();
		const text = results.length
			? results.map((entry) => formatFullMemory(entry)).join("\n\n")
			: `No memories match: ${query}`;
		return textResult(text, {
			action: "search",
			memories: cloneStore(store),
		});
	}

	function listMemory(category: MemoryCategory | undefined, includeAll: boolean) {
		const now = Date.now();
		const entries = sortForIndex(
			Array.from(store.values()).filter((entry) => {
				if (category && entry.category !== category) return false;
				return includeAll || !isForgotten(entry, now);
			}),
			now,
		);
		return textResult(formatMemoryEntries(entries, now, includeAll), {
			action: "list",
			memories: cloneStore(store),
		});
	}

	async function deleteMemory(keyInput: string, ctx: ExtensionContext) {
		const key = keyInput.trim();
		if (!store.has(key)) {
			return textResult(`No memory found: ${key}`, {
				action: "delete",
				key,
				memories: cloneStore(store),
			});
		}

		store.delete(key);
		branchTouchedKeys.add(key);
		markDirty();
		pi.appendEntry<MemoryEvent>(MEMORY_CUSTOM_TYPE, { op: "delete", key, timestamp: Date.now() });
		await persistSnapshot(ctx);
		return textResult(`Deleted: ${key}`, {
			action: "delete",
			key,
			memories: cloneStore(store),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		await rebuild(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		await rebuild(ctx);
	});

	pi.on("session_before_tree", async (_event, ctx) => {
		if (dirty) await persistSnapshot(ctx);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		if (dirty) await persistSnapshot(ctx);
		if (store.size === 0 && branchTouchedKeys.size === 0) return;
		pi.appendEntry<MemoryEvent>(MEMORY_CUSTOM_TYPE, {
			op: "snapshot",
			memories: cloneStore(store),
			touchedKeys: Array.from(branchTouchedKeys).sort(),
			timestamp: Date.now(),
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (dirty) await persistSnapshot(ctx);
	});

	pi.on("context", async (event) => {
		const filtered = event.messages.filter((message) => !isMemoryIndexMessage(message));
		const index = buildMemoryIndex(store, Date.now());
		if (!index) {
			return filtered.length === event.messages.length ? undefined : { messages: filtered };
		}
		return {
			messages: [makeMemoryIndexMessage(index, Date.now()), ...filtered],
		};
	});

	pi.registerTool({
		name: "memory_set",
		label: "Memory Set",
		description: "Save or update a project memory by key. Do not store credentials, tokens, passwords, or secrets.",
		promptSnippet: "memory_set: save a project memory by snake_case key",
		promptGuidelines: [
			"Use memory_set only for durable project facts, decisions, preferences, and context worth remembering.",
			"Never store secrets, credentials, tokens, passwords, or API keys in memory.",
		],
		parameters: MemorySetParams,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => setMemory(params, ctx),
	});

	pi.registerTool({
		name: "memory_get",
		label: "Memory Get",
		description: "Retrieve a memory by exact key. This can retrieve forgotten memories when the key is known.",
		promptSnippet: "memory_get: retrieve a full memory by exact key",
		parameters: MemoryGetParams,
		execute: async (_toolCallId, params) => getMemory(params.key),
	});

	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search project memories by keyword. Forgotten memories are excluded; use memory_get with an exact key for those.",
		promptSnippet: "memory_search: search non-forgotten project memories",
		parameters: MemorySearchParams,
		execute: async (_toolCallId, params) => searchMemory(params.query),
	});

	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description: "List non-forgotten project memories, optionally filtered by category.",
		promptSnippet: "memory_list: list non-forgotten project memories",
		parameters: MemoryListParams,
		execute: async (_toolCallId, params) => listMemory(params.category, false),
	});

	pi.registerTool({
		name: "memory_delete",
		label: "Memory Delete",
		description: "Delete a project memory by exact key.",
		promptSnippet: "memory_delete: delete a project memory by exact key",
		parameters: MemoryDeleteParams,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => deleteMemory(params.key, ctx),
	});

	pi.registerCommand("memory", {
		description: "List, delete, or clean project memories",
		getArgumentCompletions: (prefix) => {
			const values = [
				"list",
				"list --all",
				"list fact",
				"list decision",
				"list preference",
				"list context",
				"delete",
				"clean",
			];
			const matches = values.filter((value) => value.startsWith(prefix));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const command = parts[0] ?? "list";

			if (command === "list") {
				const includeAll = parts.includes("--all");
				const category = parts.find((part) => isMemoryCategory(part));
				ctx.ui.notify(listMemory(category, includeAll).content[0].text, "info");
				return;
			}

			if (command === "delete") {
				const key = parts[1];
				if (!key) {
					ctx.ui.notify("Usage: /memory delete <key>", "error");
					return;
				}
				const result = await deleteMemory(key, ctx);
				ctx.ui.notify(result.content[0].text, "info");
				return;
			}

			if (command === "clean") {
				const now = Date.now();
				const staleKeys = Array.from(store.values())
					.filter((entry) => isForgotten(entry, now))
					.map((entry) => entry.key)
					.sort();
				if (staleKeys.length === 0) {
					ctx.ui.notify("No stale memories to clean.", "info");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("/memory clean requires confirmation in an interactive UI.", "error");
					return;
				}
				const confirmed = await ctx.ui.confirm(
					"Clean stale memories",
					`Delete ${staleKeys.length} stale memories?\n${staleKeys.join(", ")}`,
				);
				if (!confirmed) {
					ctx.ui.notify("Memory clean cancelled.", "info");
					return;
				}
				for (const key of staleKeys) {
					store.delete(key);
					branchTouchedKeys.add(key);
					pi.appendEntry<MemoryEvent>(MEMORY_CUSTOM_TYPE, { op: "delete", key, timestamp: Date.now() });
				}
				markDirty();
				await persistSnapshot(ctx);
				ctx.ui.notify(`Deleted ${staleKeys.length} stale memories.`, "info");
				return;
			}

			ctx.ui.notify("Usage: /memory list [category|--all], /memory delete <key>, /memory clean", "error");
		},
	});
}
