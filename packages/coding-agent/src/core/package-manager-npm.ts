// npm install / uninstall / update / version-checking for the package manager.
//
// Extracted from `package-manager.ts` so the I/O-heavy npm path is no longer
// mixed with the rest of the orchestrator. The class depends on a small
// `PackageManagerNpmDeps` interface so it can be unit-tested in isolation.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";

export type SourceScope = "user" | "project" | "temporary";
export type InstalledSourceScope = Exclude<SourceScope, "temporary">;

const NETWORK_TIMEOUT_MS = 10000;

export interface NpmSource {
	type: "npm";
	spec: string;
	name: string;
	pinned: boolean;
}

export interface PackageManagerNpmDeps {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: { getNpmCommand(): string[] | undefined };
	runCommand(command: string, args: string[], options?: { cwd?: string }): Promise<void>;
	runCommandSync(command: string, args: string[], options?: { cwd?: string }): string;
	runCommandCapture(
		command: string,
		args: string[],
		options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> },
	): Promise<string>;
	withProgress<T>(
		kind: "install" | "update" | "remove",
		label: string,
		message: string,
		fn: () => Promise<T>,
	): Promise<T>;
	getTemporaryDir(prefix: string, suffix?: string): string;
	assertProjectTrustedForScope(scope: SourceScope): void;
	markPathIgnoredByCloudSync(path: string): void;
}

export class PackageManagerNpm {
	private readonly deps: PackageManagerNpmDeps;

	constructor(deps: PackageManagerNpmDeps) {
		this.deps = deps;
	}

	async install(source: NpmSource, scope: SourceScope, temporary: boolean): Promise<void> {
		const installRoot = this.getInstallRoot(scope, temporary);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs([source.spec], installRoot));
	}

	async uninstall(source: NpmSource, scope: SourceScope): Promise<void> {
		const installRoot = this.getInstallRoot(scope, false);
		if (!existsSync(installRoot)) return;
		if (this.getPackageManagerName() === "bun") {
			await this.runNpmCommand(["uninstall", source.name, "--cwd", installRoot]);
			return;
		}
		await this.runNpmCommand(["uninstall", source.name, "--prefix", installRoot]);
	}

	async installBatch(specs: string[], scope: InstalledSourceScope): Promise<void> {
		const installRoot = this.getInstallRoot(scope, false);
		this.ensureNpmProject(installRoot);
		await this.runNpmCommand(this.getNpmInstallArgs(specs, installRoot));
	}

	async shouldUpdate(source: NpmSource, scope: InstalledSourceScope): Promise<boolean> {
		const installedPath = this.getManagedInstallPath(source, scope);
		const installedVersion = existsSync(installedPath) ? this.getInstalledVersion(installedPath) : undefined;
		if (!installedVersion) return true;
		try {
			const latestVersion = await this.getLatestVersion(source.name);
			return latestVersion !== installedVersion;
		} catch {
			return true;
		}
	}

	async updateBatch(
		sources: Array<{ source: string; parsed: NpmSource }>,
		scope: InstalledSourceScope,
	): Promise<void> {
		if (sources.length === 0) return;
		const sourceLabel = sources.length === 1 ? sources[0].source : `${scope} npm packages`;
		const message = sources.length === 1 ? `Updating ${sources[0].source}...` : `Updating ${scope} npm packages...`;
		const specs = sources.map((entry) => `${entry.parsed.name}@latest`);
		await this.deps.withProgress("update", sourceLabel, message, async () => {
			await this.installBatch(specs, scope);
		});
	}

	async matchesInstalledPinnedVersion(source: NpmSource, installedPath: string): Promise<boolean> {
		const installedVersion = this.getInstalledVersion(installedPath);
		if (!installedVersion) return false;
		const { version: pinnedVersion } = this.parseSpec(source.spec);
		if (!pinnedVersion) return true;
		return installedVersion === pinnedVersion;
	}

	async hasAvailableUpdate(source: NpmSource, installedPath: string): Promise<boolean> {
		const installedVersion = this.getInstalledVersion(installedPath);
		if (!installedVersion) return true;
		try {
			const latestVersion = await this.getLatestVersion(source.name);
			return latestVersion !== installedVersion;
		} catch {
			return true;
		}
	}

	getInstallRoot(scope: SourceScope, temporary: boolean): string {
		if (temporary) return this.deps.getTemporaryDir("npm");
		if (scope === "project") {
			this.deps.assertProjectTrustedForScope(scope);
			return join(this.deps.cwd, CONFIG_DIR_NAME, "npm");
		}
		return join(this.deps.agentDir, "npm");
	}

	getManagedInstallPath(source: NpmSource, scope: SourceScope): string {
		if (scope === "temporary") {
			return join(this.deps.getTemporaryDir("npm"), "node_modules", source.name);
		}
		if (scope === "project") {
			this.deps.assertProjectTrustedForScope(scope);
			return join(this.deps.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
		}
		return join(this.deps.agentDir, "npm", "node_modules", source.name);
	}

	getNpmCommand(): { command: string; args: string[] } {
		const configuredCommand = this.deps.settingsManager.getNpmCommand();
		if (!configuredCommand || configuredCommand.length === 0) {
			return { command: "npm", args: [] };
		}
		const [command, ...args] = configuredCommand;
		if (!command) {
			throw new Error("Invalid npmCommand: first array entry must be a non-empty command");
		}
		return { command, args };
	}

	getPackageManagerName(): string {
		const npmCommand = this.getNpmCommand();
		const commandParts = [npmCommand.command, ...npmCommand.args];
		const separatorIndex = commandParts.lastIndexOf("--");
		const packageManagerCommand = separatorIndex >= 0 ? commandParts[separatorIndex + 1] : npmCommand.command;
		return packageManagerCommand ? basename(packageManagerCommand).replace(/\.(cmd|exe)$/i, "") : "";
	}

	getNpmInstallArgs(specs: string[], installRoot: string): string[] {
		const packageManagerName = this.getPackageManagerName();
		if (packageManagerName === "bun") {
			return ["install", ...specs, "--cwd", installRoot, "--omit=peer", "--ignore-scripts"];
		}
		if (packageManagerName === "pnpm") {
			return [
				"install",
				...specs,
				"--prefix",
				installRoot,
				"--config.auto-install-peers=false",
				"--config.strict-peer-dependencies=false",
				"--config.strict-dep-builds=false",
				"--ignore-scripts",
			];
		}
		return ["install", ...specs, "--prefix", installRoot, "--legacy-peer-deps", "--ignore-scripts"];
	}

	async runNpmCommand(args: string[], options?: { cwd?: string }): Promise<void> {
		const cmd = this.getNpmCommand();
		await this.deps.runCommand(cmd.command, [...cmd.args, ...args], options);
	}

	runNpmCommandSync(args: string[]): string {
		const cmd = this.getNpmCommand();
		return this.deps.runCommandSync(cmd.command, [...cmd.args, ...args]);
	}

	getInstalledVersion(installedPath: string): string | undefined {
		const pkgJsonPath = join(installedPath, "package.json");
		if (!existsSync(pkgJsonPath)) return undefined;
		try {
			const raw = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as { version?: string };
			return raw.version;
		} catch {
			return undefined;
		}
	}

	async getLatestVersion(packageName: string): Promise<string> {
		const cmd = this.getNpmCommand();
		const raw = await this.deps.runCommandCapture(
			cmd.command,
			[...cmd.args, "view", packageName, "version", "--json"],
			{ cwd: this.deps.cwd, timeoutMs: NETWORK_TIMEOUT_MS },
		);
		const parsed = JSON.parse(raw);
		return typeof parsed === "string" ? parsed : String(parsed).replace(/^"|"$/g, "");
	}

	ensureNpmProject(installRoot: string): void {
		if (!existsSync(installRoot)) {
			mkdirSync(installRoot, { recursive: true });
		}
		this.deps.markPathIgnoredByCloudSync(installRoot);
		if (!existsSync(join(installRoot, ".gitignore"))) {
			writeFileSync(join(installRoot, ".gitignore"), "*\n!.gitignore\n", "utf-8");
		}
		const packageJsonPath = join(installRoot, "package.json");
		if (!existsSync(packageJsonPath)) {
			const pkgJson = { name: "pi-extensions", private: true };
			writeFileSync(packageJsonPath, JSON.stringify(pkgJson, null, 2), "utf-8");
		}
	}

	private parseSpec(spec: string): { name: string; version?: string } {
		const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
		if (!match) return { name: spec };
		const name = match[1] ?? spec;
		const version = match[2];
		return { name, version };
	}
}
