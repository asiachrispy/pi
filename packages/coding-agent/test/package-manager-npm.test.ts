import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { PackageManagerNpm, type PackageManagerNpmDeps } from "../src/core/package-manager-npm.ts";

interface FakeDeps extends PackageManagerNpmDeps {
	cwd: string;
	agentDir: string;
	settingsManager: { getNpmCommand(): string[] | undefined };
	runCommand: PackageManagerNpmDeps["runCommand"] & Mock;
	runCommandSync: PackageManagerNpmDeps["runCommandSync"] & Mock;
	runCommandCapture: PackageManagerNpmDeps["runCommandCapture"] & Mock;
	withProgress: PackageManagerNpmDeps["withProgress"] & Mock;
	getTemporaryDir: PackageManagerNpmDeps["getTemporaryDir"] & Mock;
	assertProjectTrustedForScope: PackageManagerNpmDeps["assertProjectTrustedForScope"] & Mock;
	markPathIgnoredByCloudSync: PackageManagerNpmDeps["markPathIgnoredByCloudSync"] & Mock;
}

function makeDeps(overrides: Partial<FakeDeps> = {}): FakeDeps {
	return {
		cwd: "/cwd",
		agentDir: "/agent",
		settingsManager: { getNpmCommand: () => undefined },
		runCommand: vi.fn().mockResolvedValue(undefined) as FakeDeps["runCommand"],
		runCommandSync: vi.fn().mockReturnValue("") as FakeDeps["runCommandSync"],
		runCommandCapture: vi.fn().mockResolvedValue('""') as FakeDeps["runCommandCapture"],
		withProgress: vi.fn(async (_kind, _label, _msg, fn) => fn()) as FakeDeps["withProgress"],
		getTemporaryDir: vi.fn(
			(prefix: string, suffix?: string) => `/tmp/${prefix}-${suffix ?? "x"}`,
		) as FakeDeps["getTemporaryDir"],
		assertProjectTrustedForScope: vi.fn() as FakeDeps["assertProjectTrustedForScope"],
		markPathIgnoredByCloudSync: vi.fn() as FakeDeps["markPathIgnoredByCloudSync"],
		...overrides,
	};
}

describe("PackageManagerNpm", () => {
	describe("getNpmCommand", () => {
		it("returns npm with no args when no command is configured", () => {
			const deps = makeDeps();
			const npm = new PackageManagerNpm(deps);
			expect(npm.getNpmCommand()).toEqual({ command: "npm", args: [] });
		});

		it("returns the configured command with its args", () => {
			const deps = makeDeps({ settingsManager: { getNpmCommand: () => ["mise", "exec", "node@20", "--", "npm"] } });
			const npm = new PackageManagerNpm(deps);
			expect(npm.getNpmCommand()).toEqual({ command: "mise", args: ["exec", "node@20", "--", "npm"] });
		});

		it("returns npm default when configured command is empty", () => {
			const deps = makeDeps({ settingsManager: { getNpmCommand: () => [] } });
			const npm = new PackageManagerNpm(deps);
			expect(npm.getNpmCommand()).toEqual({ command: "npm", args: [] });
		});
	});

	describe("getPackageManagerName", () => {
		it("returns the trailing command name from a configured command", () => {
			const deps = makeDeps({ settingsManager: { getNpmCommand: () => ["mise", "exec", "node@20", "--", "pnpm"] } });
			const npm = new PackageManagerNpm(deps);
			expect(npm.getPackageManagerName()).toBe("pnpm");
		});

		it("strips .cmd / .exe suffixes", () => {
			const deps = makeDeps({ settingsManager: { getNpmCommand: () => ["npm.cmd"] } });
			const npm = new PackageManagerNpm(deps);
			expect(npm.getPackageManagerName()).toBe("npm");
		});

		it("returns npm when no command is configured", () => {
			const deps = makeDeps();
			const npm = new PackageManagerNpm(deps);
			expect(npm.getPackageManagerName()).toBe("npm");
		});
	});

	describe("getNpmInstallArgs", () => {
		it("uses bun flags for bun", () => {
			const deps = makeDeps({ settingsManager: { getNpmCommand: () => ["bun"] } });
			const npm = new PackageManagerNpm(deps);
			expect(npm.getNpmInstallArgs(["x@1"], "/root")).toEqual([
				"install",
				"x@1",
				"--cwd",
				"/root",
				"--omit=peer",
				"--ignore-scripts",
			]);
		});

		it("uses pnpm flags for pnpm", () => {
			const deps = makeDeps({ settingsManager: { getNpmCommand: () => ["pnpm"] } });
			const npm = new PackageManagerNpm(deps);
			expect(npm.getNpmInstallArgs(["x@1"], "/root")).toEqual([
				"install",
				"x@1",
				"--prefix",
				"/root",
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
				"--ignore-scripts",
			]);
		});

		it("uses npm legacy-peer-deps flags for npm", () => {
			const deps = makeDeps();
			const npm = new PackageManagerNpm(deps);
			expect(npm.getNpmInstallArgs(["x@1"], "/root")).toEqual([
				"install",
				"x@1",
				"--prefix",
				"/root",
				"--legacy-peer-deps",
				"--ignore-scripts",
			]);
		});
	});

	describe("getInstallRoot", () => {
		it("uses the agent dir for user scope", () => {
			const deps = makeDeps();
			const npm = new PackageManagerNpm(deps);
			expect(npm.getInstallRoot("user", false)).toBe(join("/agent", "npm"));
		});

		it("uses cwd/.pi/npm for project scope after asserting trust", () => {
			const deps = makeDeps();
			const npm = new PackageManagerNpm(deps);
			expect(npm.getInstallRoot("project", false)).toBe(join("/cwd", ".pi", "npm"));
			expect(deps.assertProjectTrustedForScope).toHaveBeenCalledWith("project");
		});

		it("uses a temporary dir for temporary scope", () => {
			const deps = makeDeps();
			const npm = new PackageManagerNpm(deps);
			expect(npm.getInstallRoot("user", true)).toBe("/tmp/npm-x");
		});
	});

	describe("getManagedInstallPath", () => {
		it("joins node_modules/<name> onto the install root for user scope", () => {
			const deps = makeDeps();
			const npm = new PackageManagerNpm(deps);
			expect(npm.getManagedInstallPath({ type: "npm", spec: "x@1", name: "x", pinned: true }, "user")).toBe(
				join("/agent", "npm", "node_modules", "x"),
			);
		});

		it("uses cwd/.pi/npm/node_modules/<name> for project scope", () => {
			const deps = makeDeps();
			const npm = new PackageManagerNpm(deps);
			expect(npm.getManagedInstallPath({ type: "npm", spec: "x@1", name: "x", pinned: true }, "project")).toBe(
				join("/cwd", ".pi", "npm", "node_modules", "x"),
			);
			expect(deps.assertProjectTrustedForScope).toHaveBeenCalledWith("project");
		});

		it("uses the temporary dir for temporary scope", () => {
			const deps = makeDeps();
			const npm = new PackageManagerNpm(deps);
			expect(npm.getManagedInstallPath({ type: "npm", spec: "x@1", name: "x", pinned: false }, "temporary")).toBe(
				join("/tmp", "npm-x", "node_modules", "x"),
			);
		});
	});

	describe("getInstalledVersion", () => {
		let workDir: string;

		beforeEach(() => {
			workDir = join(tmpdir(), `pi-npm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(workDir, { recursive: true });
		});

		afterEach(() => {
			if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
		});

		it("returns undefined when package.json does not exist", () => {
			const npm = new PackageManagerNpm(makeDeps());
			expect(npm.getInstalledVersion(join(workDir, "missing"))).toBeUndefined();
		});

		it("returns undefined for malformed package.json", () => {
			const pkgDir = join(workDir, "pkg");
			mkdirSync(pkgDir);
			writeFileSync(join(pkgDir, "package.json"), "{not valid json");
			const npm = new PackageManagerNpm(makeDeps());
			expect(npm.getInstalledVersion(pkgDir)).toBeUndefined();
		});

		it("returns the version when package.json is well-formed", () => {
			const pkgDir = join(workDir, "pkg");
			mkdirSync(pkgDir);
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "x", version: "1.2.3" }));
			const npm = new PackageManagerNpm(makeDeps());
			expect(npm.getInstalledVersion(pkgDir)).toBe("1.2.3");
		});
	});

	describe("matchesInstalledPinnedVersion", () => {
		it("returns false when no installed version is present", async () => {
			const npm = new PackageManagerNpm(makeDeps());
			const result = await npm.matchesInstalledPinnedVersion(
				{ type: "npm", spec: "x@1.0.0", name: "x", pinned: true },
				"/nonexistent",
			);
			expect(result).toBe(false);
		});

		it("returns true when pinned version matches installed", async () => {
			const workDir = join(tmpdir(), `pi-npm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(join(workDir, "x"), { recursive: true });
			writeFileSync(join(workDir, "x", "package.json"), JSON.stringify({ version: "1.0.0" }));
			try {
				const npm = new PackageManagerNpm(makeDeps());
				const result = await npm.matchesInstalledPinnedVersion(
					{ type: "npm", spec: "x@1.0.0", name: "x", pinned: true },
					join(workDir, "x"),
				);
				expect(result).toBe(true);
			} finally {
				rmSync(workDir, { recursive: true, force: true });
			}
		});

		it("returns false when pinned version differs", async () => {
			const workDir = join(tmpdir(), `pi-npm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			mkdirSync(join(workDir, "x"), { recursive: true });
			writeFileSync(join(workDir, "x", "package.json"), JSON.stringify({ version: "1.0.0" }));
			try {
				const npm = new PackageManagerNpm(makeDeps());
				const result = await npm.matchesInstalledPinnedVersion(
					{ type: "npm", spec: "x@2.0.0", name: "x", pinned: true },
					join(workDir, "x"),
				);
				expect(result).toBe(false);
			} finally {
				rmSync(workDir, { recursive: true, force: true });
			}
		});
	});

	describe("getLatestVersion", () => {
		it("uses runCommandCapture with the configured npm command and --json", async () => {
			const deps = makeDeps({
				settingsManager: { getNpmCommand: () => ["mise", "exec", "node@20", "--", "npm"] },
				runCommandCapture: vi.fn().mockResolvedValue('"1.2.3"'),
			});
			const npm = new PackageManagerNpm(deps);
			const result = await npm.getLatestVersion("@scope/pkg");
			expect(result).toBe("1.2.3");
			expect(deps.runCommandCapture).toHaveBeenCalledWith(
				"mise",
				["exec", "node@20", "--", "npm", "view", "@scope/pkg", "version", "--json"],
				expect.objectContaining({ cwd: "/cwd", timeoutMs: expect.any(Number) }),
			);
		});
	});
});
