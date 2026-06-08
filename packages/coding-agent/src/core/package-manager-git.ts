// Git install / update / remove / version-checking for the package manager.
//
// Extracted from `package-manager.ts` so the I/O-heavy git path is no longer
// mixed with the rest of the orchestrator. The class depends on a small
// `PackageManagerGitDeps` interface so it can be unit-tested in isolation.

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { GitSource } from "../utils/git.ts";

export type SourceScope = "user" | "project" | "temporary";
export type InstalledSourceScope = Exclude<SourceScope, "temporary">;

const NETWORK_TIMEOUT_MS = 10000;

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export interface PackageManagerGitDeps {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: { getNpmCommand(): string[] | undefined };
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string>;
	runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void>;
	withProgress<T>(
		action: "install" | "update" | "remove" | "clone" | "pull",
		source: string,
		message: string,
		fn: () => Promise<T>,
	): Promise<T>;
	getTemporaryDir(prefix: string, suffix?: string): string;
	assertProjectTrustedForScope(scope: SourceScope): void;
	resolveManagedPath(root: string, ...parts: string[]): string;
	getLocalUpdateTarget(installedPath: string): Promise<{ ref: string; head: string; fetchArgs: string[] }>;
}

export class PackageManagerGit {
	private readonly deps: PackageManagerGitDeps;

	constructor(deps: PackageManagerGitDeps) {
		this.deps = deps;
	}

	async install(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getInstallPath(source, scope);
		if (existsSync(targetDir)) {
			if (source.ref) {
				await this.ensureRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
				return;
			}
			const target = await this.getLocalUpdateTarget(targetDir);
			await this.ensureRef(targetDir, target.fetchArgs, target.ref);
			return;
		}
		const gitRoot = this.getInstallRoot(scope);
		if (gitRoot) {
			this.ensureIgnore(gitRoot);
		}
		mkdirSync(dirname(targetDir), { recursive: true });

		await this.deps.runCommand("git", ["clone", source.repo, targetDir]);
		if (source.ref) {
			await this.deps.runCommand("git", ["checkout", source.ref], { cwd: targetDir });
		}
		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await this.deps.runNpmCommand(this.getDependencyInstallArgs(), { cwd: targetDir });
		}
	}

	async update(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getInstallPath(source, scope);
		if (!existsSync(targetDir)) {
			await this.install(source, scope);
			return;
		}

		if (source.ref) {
			await this.ensureRef(targetDir, ["fetch", "origin", source.ref], "FETCH_HEAD");
			return;
		}

		const target = await this.getLocalUpdateTarget(targetDir);
		await this.ensureRef(targetDir, target.fetchArgs, target.ref);
	}

	async remove(source: GitSource, scope: SourceScope): Promise<void> {
		const targetDir = this.getInstallPath(source, scope);
		if (!existsSync(targetDir)) return;
		rmSync(targetDir, { recursive: true, force: true });
		this.pruneEmptyParents(targetDir, this.getInstallRoot(scope));
	}

	async refreshTemporary(source: GitSource, sourceStr: string): Promise<void> {
		if (isOfflineModeEnabled()) {
			return;
		}
		try {
			await this.deps.withProgress("pull", sourceStr, `Refreshing ${sourceStr}...`, async () => {
				await this.update(source, "temporary");
			});
		} catch {
			// Keep cached temporary checkout if refresh fails.
		}
	}

	async hasAvailableUpdate(installedPath: string): Promise<boolean> {
		if (isOfflineModeEnabled()) {
			return false;
		}

		try {
			const localHead = await this.deps.runCommandCapture("git", ["rev-parse", "HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const remoteHead = await this.getRemoteHead(installedPath);
			return localHead.trim() !== remoteHead.trim();
		} catch {
			return false;
		}
	}

	getInstallPath(source: GitSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return this.deps.getTemporaryDir(`git-${source.host}`, source.path);
		}
		const installRoot = this.getInstallRoot(scope);
		if (!installRoot) {
			throw new Error("Missing git install root");
		}
		return this.deps.resolveManagedPath(installRoot, source.host, source.path);
	}

	getInstallRoot(scope: SourceScope): string | undefined {
		if (scope === "temporary") {
			return undefined;
		}
		if (scope === "project") {
			this.deps.assertProjectTrustedForScope(scope);
			return join(this.deps.cwd, CONFIG_DIR_NAME, "git");
		}
		return join(this.deps.agentDir, "git");
	}

	getDependencyInstallArgs(): string[] {
		const configuredCommand = this.deps.settingsManager.getNpmCommand();
		if (configuredCommand && configuredCommand.length > 0) {
			return ["install", "--ignore-scripts"];
		}
		return ["install", "--omit=dev", "--ignore-scripts"];
	}

	ensureIgnore(dir: string): void {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const ignorePath = join(dir, ".gitignore");
		if (!existsSync(ignorePath)) {
			writeFileSync(ignorePath, "*\n!.gitignore\n", "utf-8");
		}
	}

	async ensureRef(targetDir: string, fetchArgs: string[], ref: string): Promise<void> {
		// Fetch only the ref we will reset to, avoiding unrelated branch/tag noise.
		await this.deps.runCommand("git", fetchArgs, { cwd: targetDir });

		const localHead = await this.deps.runCommandCapture("git", ["rev-parse", "HEAD"], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		const commitRef = `${ref}^{commit}`;
		const targetHead = await this.deps.runCommandCapture("git", ["rev-parse", commitRef], {
			cwd: targetDir,
			timeoutMs: NETWORK_TIMEOUT_MS,
		});
		if (localHead.trim() === targetHead.trim()) {
			return;
		}

		await this.deps.runCommand("git", ["reset", "--hard", commitRef], { cwd: targetDir });

		// Clean untracked files (extensions should be pristine)
		await this.deps.runCommand("git", ["clean", "-fdx"], { cwd: targetDir });

		const packageJsonPath = join(targetDir, "package.json");
		if (existsSync(packageJsonPath)) {
			await this.deps.runNpmCommand(this.getDependencyInstallArgs(), { cwd: targetDir });
		}
	}

	getLocalUpdateTarget(installedPath: string): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
		return this.deps.getLocalUpdateTarget(installedPath);
	}

	// Internal implementation, used by deps that don't provide their own getLocalUpdateTarget.
	async _getLocalUpdateTargetInternal(
		installedPath: string,
	): Promise<{ ref: string; head: string; fetchArgs: string[] }> {
		try {
			const upstream = await this.deps.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmedUpstream = upstream.trim();
			if (!trimmedUpstream.startsWith("origin/")) {
				throw new Error(`Unsupported upstream remote: ${trimmedUpstream}`);
			}
			const branch = trimmedUpstream.slice("origin/".length);
			if (!branch) {
				throw new Error("Missing upstream branch name");
			}
			const head = await this.deps.runCommandCapture("git", ["rev-parse", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			return {
				ref: "@{upstream}",
				head,
				fetchArgs: [
					"fetch",
					"--prune",
					"--no-tags",
					"origin",
					`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
				],
			};
		} catch {
			await this.deps
				.runCommand("git", ["remote", "set-head", "origin", "-a"], { cwd: installedPath })
				.catch(() => {});
			const head = await this.deps.runCommandCapture("git", ["rev-parse", "origin/HEAD"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const originHeadRef = await this.deps
				.runCommandCapture("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
					cwd: installedPath,
					timeoutMs: NETWORK_TIMEOUT_MS,
				})
				.catch(() => "");
			const branch = originHeadRef.trim().replace(/^refs\/remotes\/origin\//, "");
			if (branch) {
				return {
					ref: "origin/HEAD",
					head,
					fetchArgs: [
						"fetch",
						"--prune",
						"--no-tags",
						"origin",
						`+refs/heads/${branch}:refs/remotes/origin/${branch}`,
					],
				};
			}
			return {
				ref: "origin/HEAD",
				head,
				fetchArgs: ["fetch", "--prune", "--no-tags", "origin", "+HEAD:refs/remotes/origin/HEAD"],
			};
		}
	}

	async getRemoteHead(installedPath: string): Promise<string> {
		const upstreamRef = await this.getUpstreamRef(installedPath);
		if (upstreamRef) {
			const remoteHead = await this.runRemoteCommand(installedPath, ["ls-remote", "origin", upstreamRef]);
			const match = remoteHead.match(/^([0-9a-f]{40})\s+/m);
			if (match?.[1]) {
				return match[1];
			}
		}

		const remoteHead = await this.runRemoteCommand(installedPath, ["ls-remote", "origin", "HEAD"]);
		const match = remoteHead.match(/^([0-9a-f]{40})\s+HEAD$/m);
		if (!match?.[1]) {
			throw new Error("Failed to determine remote HEAD");
		}
		return match[1];
	}

	async getUpstreamRef(installedPath: string): Promise<string | undefined> {
		try {
			const upstream = await this.deps.runCommandCapture("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
				cwd: installedPath,
				timeoutMs: NETWORK_TIMEOUT_MS,
			});
			const trimmed = upstream.trim();
			if (!trimmed.startsWith("origin/")) {
				return undefined;
			}
			const branch = trimmed.slice("origin/".length);
			return branch ? `refs/heads/${branch}` : undefined;
		} catch {
			return undefined;
		}
	}

	runRemoteCommand(installedPath: string, args: string[]): Promise<string> {
		return this.deps.runCommandCapture("git", args, {
			cwd: installedPath,
			timeoutMs: NETWORK_TIMEOUT_MS,
			env: {
				GIT_TERMINAL_PROMPT: "0",
			},
		});
	}

	pruneEmptyParents(targetDir: string, installRoot: string | undefined): void {
		if (!installRoot) return;
		const resolvedRoot = require("node:path").resolve(installRoot);
		let current = dirname(targetDir);
		while (current.startsWith(resolvedRoot) && current !== resolvedRoot) {
			if (!existsSync(current)) {
				current = dirname(current);
				continue;
			}
			const entries = readdirSync(current);
			if (entries.length > 0) {
				break;
			}
			try {
				rmSync(current, { recursive: true, force: true });
			} catch {
				break;
			}
			current = dirname(current);
		}
	}
}
