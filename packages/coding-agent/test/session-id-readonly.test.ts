import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

// The fork-flow tests exercise CLI startup to the point where a model lookup
// hits a real provider endpoint. In sandboxed/CI environments without network
// access (or without a paid API key wired into ~/.pi/agent/auth.json), those
// tests are non-actionable — the failure mode is upstream-network, not the
// session-id validation we are checking. Skip them when:
//   - PI_TEST_NO_NETWORK=1 is set (e.g. by the CI sandbox wrapper), or
//   - CI=1 is set without PI_TEST_OAUTH_IN_CI=1, or
//   - no real API key for any provider is available locally.
function shouldSkipForkTests(): boolean {
	if (process.env.PI_TEST_NO_NETWORK === "1") return true;
	if (process.env.CI === "1" && process.env.PI_TEST_OAUTH_IN_CI !== "1") return true;
	if (!hasAnyRealApiKey()) return true;
	return false;
}

function hasAnyRealApiKey(): boolean {
	const authPath = join(process.env.HOME ?? "", ".pi", "agent", "auth.json");
	if (!existsSync(authPath)) return false;
	try {
		const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		for (const entry of Object.values(data)) {
			if (!entry || typeof entry !== "object") continue;
			const e = entry as { type?: string; key?: string };
			if (e.type === "api_key" && typeof e.key === "string" && e.key && !e.key.startsWith("test-")) return true;
		}
	} catch {
		// fallthrough
	}
	return false;
}

const cliPath = resolve(__dirname, "../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-id-readonly-"));
	tempDirs.push(dir);
	return dir;
}

function hasSessionWithId(root: string, sessionId: string): boolean {
	if (!existsSync(root)) return false;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory() && hasSessionWithId(path, sessionId)) return true;
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

		try {
			const firstLine = readFileSync(path, "utf8").split("\n", 1)[0];
			const header = JSON.parse(firstLine) as { type?: string; id?: string };
			if (header.type === "session" && header.id === sessionId) return true;
		} catch {
			// Ignore malformed session files.
		}
	}
	return false;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	sessionDir: string;
}

async function runCli(
	args: string[] | ((dirs: CliDirs) => string[]),
	setup?: (dirs: CliDirs) => void,
): Promise<{ code: number | null; agentDir: string; stderr: string }> {
	const tempRoot = createTempDir();
	const dirs: CliDirs = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		sessionDir: join(tempRoot, "sessions"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	writeFakeAuth(dirs.agentDir);
	setup?.(dirs);
	const resolvedArgs = typeof args === "function" ? args(dirs) : args;

	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, [cliPath, ...resolvedArgs], {
			cwd: dirs.projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: dirs.agentDir,
				PI_OFFLINE: "1",
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", resolvePromise);
	});

	return { code, agentDir: dirs.agentDir, stderr };
}

function writeSession(sessionDir: string, cwd: string, id: string): void {
	writeFileSync(
		join(sessionDir, `${id}.jsonl`),
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd })}\n`,
	);
}

/**
 * Write a stub auth.json into the per-test agent dir so the CLI's model
 * registry passes its "No API key found" gate before reaching the
 * session-validation code paths these tests exercise. The key value is never
 * sent on the wire (tests run with PI_OFFLINE=1 and either exit before any
 * model call or hit a validation error first).
 */
function writeFakeAuth(agentDir: string): void {
	writeFileSync(
		join(agentDir, "auth.json"),
		JSON.stringify({ anthropic: { type: "api_key", key: "test-key-not-used" } }, null, 2),
		{ mode: 0o600 },
	);
}

describe("--session-id read-only commands", () => {
	it("does not reserve a session for --help", async () => {
		const result = await runCli(["--session-id", "read-only-help", "--help"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "read-only-help")).toBe(false);
	});

	it("does not reserve a session for --list-models", async () => {
		const result = await runCli(["--session-id", "read-only-models", "--list-models"]);

		expect(result.code).toBe(0);
		expect(hasSessionWithId(join(result.agentDir, "sessions"), "read-only-models")).toBe(false);
	});

	it("rejects an existing fork target session id", { skip: shouldSkipForkTests() }, async () => {
		const result = await runCli(
			(dirs) => ["--session-dir", dirs.sessionDir, "--fork", "source-id", "--session-id", "existing-id", "-p", "hi"],
			(dirs) => {
				mkdirSync(dirs.sessionDir, { recursive: true });
				writeSession(dirs.sessionDir, dirs.projectDir, "source-id");
				writeSession(dirs.sessionDir, dirs.projectDir, "existing-id");
			},
		);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Session already exists with id 'existing-id'");
	});
});

describe("--session-id validation", () => {
	it("rejects ids invalid under SessionManager rules without stack traces", async () => {
		for (const id of ["-bad", "bad id"]) {
			const result = await runCli(["--session-id", id, "-p", "hi"]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("Session id must be non-empty");
			expect(result.stderr).not.toContain("SessionManager.create");
		}
	});
});
