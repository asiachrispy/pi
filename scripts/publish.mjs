#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packages = [
	{ directory: "packages/ai", name: "@earendil-works/pi-ai" },
	{ directory: "packages/agent", name: "@earendil-works/pi-agent-core" },
	{ directory: "packages/tui", name: "@earendil-works/pi-tui" },
	{ directory: "packages/coding-agent", name: "@earendil-works/pi-coding-agent" },
];

const dryRun = process.argv.includes("--dry-run");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--dry-run");
const publishScope = process.env.PI_NPM_SCOPE?.trim();
const sourceScope = "@earendil-works";
const publishProvenance = process.env.PI_NPM_PROVENANCE !== "0";
const stagingRoots = [];

if (unknownArgs.length > 0) {
	console.error(`Usage: node scripts/publish.mjs [--dry-run]`);
	process.exit(1);
}

function commandForPlatform(command) {
	return process.platform === "win32" ? `${command}.cmd` : command;
}

function run(command, args, options = {}) {
	console.log(`$ ${[command, ...args].join(" ")}`);
	const result = spawnSync(commandForPlatform(command), args, {
		cwd: options.cwd,
		encoding: "utf8",
		stdio: options.capture ? ["inherit", "pipe", "pipe"] : "inherit",
	});

	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
		throw new Error(output ? `Command failed: ${command} ${args.join(" ")}\n${output}` : `Command failed: ${command} ${args.join(" ")}`);
	}

	return result;
}

function readPackageJson(directory) {
	return JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function assertBuildOutputExists(directory) {
	if (!existsSync(join(directory, "dist"))) {
		throw new Error(`${directory}/dist does not exist. Run npm run build before publishing.`);
	}
}

function targetName(sourceName) {
	if (!publishScope || publishScope === sourceScope) {
		return sourceName;
	}
	return `${publishScope}/${sourceName.split("/")[1]}`;
}

function internalAliasSpecifier(sourceName, version) {
	return `npm:${targetName(sourceName)}@${version}`;
}

function isInternalPackageName(name) {
	return name.startsWith(`${sourceScope}/pi-`);
}

function rewriteDependencyMap(dependencies, version) {
	if (!dependencies) return;
	for (const name of Object.keys(dependencies)) {
		if (isInternalPackageName(name)) {
			dependencies[name] = internalAliasSpecifier(name, version);
		}
	}
}

function registryTarballUrl(packageName, version) {
	const tarballName = packageName.split("/")[1] ?? packageName;
	return `https://registry.npmjs.org/${packageName}/-/${tarballName}-${version}.tgz`;
}

function rewritePackageJsonForTarget(directory, sourceName, version) {
	const packageJsonPath = join(directory, "package.json");
	const packageJson = readPackageJson(directory);
	packageJson.name = targetName(sourceName);
	rewriteDependencyMap(packageJson.dependencies, version);
	rewriteDependencyMap(packageJson.optionalDependencies, version);
	rewriteDependencyMap(packageJson.peerDependencies, version);
	writeJson(packageJsonPath, packageJson);
}

function rewriteShrinkwrapForTarget(directory, sourceName, version) {
	const shrinkwrapPath = join(directory, "npm-shrinkwrap.json");
	if (!existsSync(shrinkwrapPath)) {
		return;
	}

	const shrinkwrap = JSON.parse(readFileSync(shrinkwrapPath, "utf8"));
	shrinkwrap.name = targetName(sourceName);
	for (const entry of Object.values(shrinkwrap.packages ?? {})) {
		rewriteDependencyMap(entry.dependencies, version);
		rewriteDependencyMap(entry.optionalDependencies, version);
		rewriteDependencyMap(entry.peerDependencies, version);
	}

	const rootEntry = shrinkwrap.packages?.[""];
	if (rootEntry) {
		rootEntry.name = targetName(sourceName);
	}

	for (const sourcePackage of packages) {
		const lockPath = `node_modules/${sourcePackage.name}`;
		const entry = shrinkwrap.packages?.[lockPath];
		if (!entry) {
			continue;
		}
		entry.name = targetName(sourcePackage.name);
		entry.resolved = registryTarballUrl(entry.name, version);
	}

	writeJson(shrinkwrapPath, shrinkwrap);
}

function createScopedPublishDirectory(pkg) {
	const packageJson = readPackageJson(pkg.directory);
	if (!publishScope || publishScope === sourceScope) {
		return pkg.directory;
	}

	const stagingRoot = mkdtempSync(join(tmpdir(), "pi-npm-publish-"));
	stagingRoots.push(stagingRoot);
	const tarballDirectory = join(stagingRoot, "tarballs");
	mkdirSync(tarballDirectory, { recursive: true });
	const packResult = run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", tarballDirectory], {
		capture: true,
		cwd: pkg.directory,
	});
	const tarballName = JSON.parse(packResult.stdout)[0]?.filename;
	if (!tarballName) {
		throw new Error(`npm pack did not return a filename for ${pkg.directory}`);
	}
	run("tar", ["-xzf", join(tarballDirectory, tarballName), "-C", stagingRoot]);
	const publishDirectory = join(stagingRoot, "package");
	rewritePackageJsonForTarget(publishDirectory, pkg.name, packageJson.version);
	rewriteShrinkwrapForTarget(publishDirectory, pkg.name, packageJson.version);
	return publishDirectory;
}

function validatePack(directory) {
	const result = run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { capture: true, cwd: directory });
	const packed = JSON.parse(result.stdout)[0];
	console.log(`  ${packed.filename}: ${packed.files.length} files, ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked`);
}

function isPublished(name, version) {
	const result = spawnSync(commandForPlatform("npm"), ["view", `${name}@${version}`, "version", "--json"], {
		encoding: "utf8",
		stdio: ["inherit", "pipe", "pipe"],
	});

	if (result.status === 0 && result.stdout.trim()) {
		return true;
	}

	const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
	if (result.status !== 0 && (output.includes("E404") || output.includes("404 Not Found"))) {
		return false;
	}

	throw new Error(output ? `Failed to query ${name}@${version}\n${output}` : `Failed to query ${name}@${version}`);
}

const packageVersions = new Map();
for (const pkg of packages) {
	const packageJson = readPackageJson(pkg.directory);
	if (packageJson.name !== pkg.name) {
		throw new Error(`${pkg.directory}/package.json has name ${packageJson.name}, expected ${pkg.name}`);
	}
	packageVersions.set(pkg.name, packageJson.version);
}

const versions = [...new Set(packageVersions.values())];
if (versions.length !== 1) {
	throw new Error(`Publish packages are not lockstep versioned: ${versions.join(", ")}`);
}

console.log(
	`Publishing pi packages at ${versions[0]}${publishScope && publishScope !== sourceScope ? ` to ${publishScope}` : ""}${dryRun ? " (dry run)" : ""}\n`,
);

try {
	for (const pkg of packages) {
		const version = packageVersions.get(pkg.name);
		assertBuildOutputExists(pkg.directory);
		const publishName = targetName(pkg.name);
		const publishDirectory = createScopedPublishDirectory(pkg);
		const published = isPublished(publishName, version);

		if (dryRun) {
			if (published) {
				console.log(`${publishName}@${version} is already published; validating package contents only.`);
			} else {
				console.log(`${publishName}@${version} is not published; validating package contents before publish.`);
			}
			validatePack(publishDirectory);
			console.log();
			continue;
		}

		if (published) {
			console.log(`Skipping ${publishName}@${version}: already published\n`);
			continue;
		}

		const publishArgs = ["publish", "--access", "public", "--ignore-scripts"];
		if (publishProvenance) {
			publishArgs.splice(3, 0, "--provenance");
		}
		run("npm", publishArgs, { cwd: publishDirectory });
		console.log();
	}
} finally {
	for (const stagingRoot of stagingRoots) {
		rmSync(stagingRoot, { force: true, recursive: true });
	}
}
