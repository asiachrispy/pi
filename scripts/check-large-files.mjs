// Warn (default) or enforce (--enforce) a soft/hard cap on individual source file size.
// Soft cap = 2500, hard cap = 6000. Override via env: PI_LARGE_FILE_SOFT_CAP, PI_LARGE_FILE_HARD_CAP.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const enforce = process.argv.includes("--enforce");
const softCap = Number.parseInt(process.env.PI_LARGE_FILE_SOFT_CAP ?? "2500", 10);
const hardCap = Number.parseInt(process.env.PI_LARGE_FILE_HARD_CAP ?? "6000", 10);

const watchedRoots = [
	"packages/coding-agent/src",
	"packages/ai/src",
	"packages/agent/src",
	"packages/tui/src",
];

const ignoredDirectories = new Set([".git", "dist", "node_modules", "coverage"]);
const failures = [];

function countLines(filePath) {
	const text = readFileSync(filePath, "utf8");
	let count = 1;
	let inBlock = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\n") {
			count++;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			inBlock = true;
			i++;
			continue;
		}
		if (inBlock && ch === "*" && text[i + 1] === "/") {
			inBlock = false;
			i++;
		}
	}
	return count;
}

function walk(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) walk(join(directory, entry.name));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
		if (entry.name.endsWith(".generated.ts")) continue;
		const filePath = join(directory, entry.name);
		const lines = countLines(filePath);
		const rel = relative(".", filePath);
		if (lines > hardCap) {
			failures.push(`${rel}: ${lines} lines (hard cap ${hardCap})`);
		} else if (lines > softCap) {
			failures.push(`${rel}: ${lines} lines (soft cap ${softCap})`);
		}
	}
}

for (const root of watchedRoots) {
	try {
		statSync(root);
	} catch {
		continue;
	}
	walk(root);
}

if (failures.length === 0) {
	console.log(`large files: ok (soft cap ${softCap}, hard cap ${hardCap})`);
	process.exit(0);
}

console.error(`large files (${enforce ? "enforce" : "warning"}): soft=${softCap}, hard=${hardCap}`);
for (const f of failures) console.error(`  ${f}`);
process.exit(enforce ? 1 : 0);
