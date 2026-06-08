import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PackageManagerGit } from "../src/core/package-manager-git.ts";

interface FakeDeps {
	cwd: string;
	agentDir: string;
	settingsManager: { getNpmCommand(): string[] | undefined };
	runCommand: ReturnType<typeof vi.fn>;
	runCommandCapture: ReturnType<typeof vi.fn>;
	runNpmCommand: ReturnType<typeof vi.fn>;
	withProgress: ReturnType<typeof vi.fn>;
	getTemporaryDir: ReturnType<typeof vi.fn>;
	assertProjectTrustedForScope: ReturnType<typeof vi.fn>;
	resolveManagedPath: ReturnType<typeof vi.fn>;
	getLocalUpdateTarget: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: Partial<FakeDeps> = {}): FakeDeps {
	return {
		cwd: "/cwd",
		agentDir: "/agent",
		settingsManager: { getNpmCommand: () => undefined },
		runCommand: vi.fn().mockResolvedValue(undefined),
		runCommandCapture: vi.fn().mockResolvedValue(""),
		runNpmCommand: vi.fn().mockResolvedValue(undefined),
		withProgress: vi.fn(async (_kind, _label, _msg, fn) => fn()),
		getTemporaryDir: vi.fn((prefix: string, suffix?: string) => `/tmp/${prefix}-${suffix ?? "x"}`),
		assertProjectTrustedForScope: vi.fn(),
		resolveManagedPath: vi.fn((root: string, ...parts: string[]) => join(root, ...parts)),
		getLocalUpdateTarget: vi.fn().mockResolvedValue({ ref: "@{upstream}", head: "h", fetchArgs: [] }),
		...overrides,
	};
}

describe("PackageManagerGit", () => {
	describe("getInstallPath", () => {
		it("joins installRoot/host/path for user scope", () => {
			const git = new PackageManagerGit(makeDeps());
			const path = git.getInstallPath(
				{ type: "git", repo: "https://github.com/u/r.git", host: "github.com", path: "u/r", pinned: false },
				"user",
			);
			expect(path).toBe(join("/agent", "git", "github.com", "u", "r"));
		});

		it("uses cwd/.pi/git for project scope after asserting trust", () => {
			const deps = makeDeps();
			const git = new PackageManagerGit(deps);
			const path = git.getInstallPath(
				{ type: "git", repo: "https://github.com/u/r.git", host: "github.com", path: "u/r", pinned: false },
				"project",
			);
			expect(path).toBe(join("/cwd", ".pi", "git", "github.com", "u", "r"));
			expect(deps.assertProjectTrustedForScope).toHaveBeenCalledWith("project");
		});

		it("uses a temporary dir for temporary scope", () => {
			const git = new PackageManagerGit(makeDeps());
			const path = git.getInstallPath(
				{ type: "git", repo: "https://github.com/u/r.git", host: "github.com", path: "u/r", pinned: false },
				"temporary",
			);
			expect(path).toBe("/tmp/git-github.com-u/r");
		});
	});

	describe("getInstallRoot", () => {
		it("returns undefined for temporary scope", () => {
			const git = new PackageManagerGit(makeDeps());
			expect(git.getInstallRoot("temporary")).toBeUndefined();
		});

		it("returns the agent git dir for user scope", () => {
			const git = new PackageManagerGit(makeDeps());
			expect(git.getInstallRoot("user")).toBe(join("/agent", "git"));
		});

		it("returns cwd/.pi/git for project scope", () => {
			const git = new PackageManagerGit(makeDeps());
			expect(git.getInstallRoot("project")).toBe(join("/cwd", ".pi", "git"));
		});
	});

	describe("getDependencyInstallArgs", () => {
		it("returns --ignore-scripts when a custom npmCommand is set", () => {
			const git = new PackageManagerGit(makeDeps({ settingsManager: { getNpmCommand: () => ["bun"] } }));
			expect(git.getDependencyInstallArgs()).toEqual(["install", "--ignore-scripts"]);
		});

		it("returns --omit=dev and --ignore-scripts when no npmCommand is set", () => {
			const git = new PackageManagerGit(makeDeps());
			expect(git.getDependencyInstallArgs()).toEqual(["install", "--omit=dev", "--ignore-scripts"]);
		});
	});

	describe("ensureIgnore", () => {
		let workDir: string;

		beforeEach(() => {
			workDir = join(tmpdir(), `pi-git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		});

		afterEach(() => {
			if (existsSync(workDir)) {
				const { rmSync } = require("node:fs") as typeof import("node:fs");
				rmSync(workDir, { recursive: true, force: true });
			}
		});

		it("creates the dir and writes .gitignore if missing", () => {
			const git = new PackageManagerGit(makeDeps());
			git.ensureIgnore(workDir);
			expect(existsSync(workDir)).toBe(true);
			expect(existsSync(join(workDir, ".gitignore"))).toBe(true);
		});

		it("does not overwrite an existing .gitignore", () => {
			mkdirSync(workDir, { recursive: true });
			writeFileSync(join(workDir, ".gitignore"), "custom\n");
			const git = new PackageManagerGit(makeDeps());
			git.ensureIgnore(workDir);
			const content = require("node:fs").readFileSync(join(workDir, ".gitignore"), "utf-8") as string;
			expect(content).toBe("custom\n");
		});
	});

	describe("hasAvailableUpdate", () => {
		it("returns false when offline mode is enabled", async () => {
			const original = process.env.PI_OFFLINE;
			process.env.PI_OFFLINE = "1";
			try {
				const git = new PackageManagerGit(makeDeps());
				const result = await git.hasAvailableUpdate("/some/path");
				expect(result).toBe(false);
			} finally {
				if (original === undefined) delete process.env.PI_OFFLINE;
				else process.env.PI_OFFLINE = original;
			}
		});

		it("returns false when runCommandCapture throws", async () => {
			const git = new PackageManagerGit(
				makeDeps({
					runCommandCapture: vi.fn().mockRejectedValue(new Error("boom")),
				}),
			);
			expect(await git.hasAvailableUpdate("/some/path")).toBe(false);
		});

		it("returns true when local and remote heads differ", async () => {
			const oldHash = "0".repeat(40);
			const newHash = "1".repeat(40);
			const git = new PackageManagerGit(
				makeDeps({
					runCommandCapture: vi.fn().mockImplementation(async (_cmd, args) => {
						if (args[0] === "rev-parse" && args[1] === "HEAD") return `${oldHash}\n`;
						if (args[0] === "ls-remote") return `${newHash}\tHEAD\n`;
						return "";
					}),
				}),
			);
			expect(await git.hasAvailableUpdate("/some/path")).toBe(true);
		});

		it("returns false when local and remote heads match", async () => {
			const git = new PackageManagerGit(
				makeDeps({
					runCommandCapture: vi.fn().mockImplementation(async (_cmd, args) => {
						if (args[0] === "rev-parse" && args[1] === "HEAD") return "same\n";
						if (args[0] === "ls-remote") return "same HEAD\n";
						return "";
					}),
				}),
			);
			expect(await git.hasAvailableUpdate("/some/path")).toBe(false);
		});
	});

	describe("remove", () => {
		let workDir: string;

		beforeEach(() => {
			workDir = join(tmpdir(), `pi-git-rm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		});

		afterEach(() => {
			if (existsSync(workDir)) {
				const { rmSync } = require("node:fs") as typeof import("node:fs");
				rmSync(workDir, { recursive: true, force: true });
			}
		});

		it("does nothing when the target dir does not exist", async () => {
			const git = new PackageManagerGit(makeDeps());
			await git.remove({ type: "git", repo: "r", host: "h", path: "u/r", pinned: false }, "user");
			// No throw
		});

		it("removes the target dir when it exists", async () => {
			const target = join(workDir, "github.com", "u", "r");
			mkdirSync(target, { recursive: true });
			writeFileSync(join(target, "marker"), "x");

			const git = new PackageManagerGit(
				makeDeps({
					resolveManagedPath: vi.fn((_root: string, ...parts: string[]) => join(workDir, ...parts)),
				}),
			);
			await git.remove({ type: "git", repo: "r", host: "github.com", path: "u/r", pinned: false }, "user");
			expect(existsSync(target)).toBe(false);
		});
	});
});
