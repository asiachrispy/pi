// Enforce workspace dependency direction:
//   ai -> none
//   agent -> ai
//   tui -> none
//   coding-agent -> ai, agent, tui
//
// Default: warn (exit 0). Pass --enforce to fail the build.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const packageNameByPath = {
	"packages/ai": "ai",
	"packages/agent": "agent",
	"packages/tui": "tui",
	"packages/coding-agent": "coding-agent",
};

const allowedEdges = {
	ai: new Set(),
	agent: new Set(["ai"]),
	tui: new Set(),
	"coding-agent": new Set(["ai", "agent", "tui"]),
};

const enforce = process.argv.includes("--enforce");
const ignoredDirectories = new Set([".git", "dist", "node_modules", "coverage"]);
const sourceFiles = [];

function collectSourceFiles(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.isDirectory()) {
			if (!ignoredDirectories.has(entry.name)) {
				collectSourceFiles(join(directory, entry.name));
			}
			continue;
		}
		if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
			sourceFiles.push(join(directory, entry.name));
		}
	}
}

collectSourceFiles("packages");

// Anchored alternation so we match the full package name, not a prefix of another.
const importPattern = /from\s+["'](@earendil-works\/pi-(ai|agent|tui|coding-agent))["']/g;
const violations = [];

for (const file of sourceFiles) {
	const text = readFileSync(file, "utf8");
	const relPath = relative(".", file);
	const ownerPkg = Object.keys(packageNameByPath).find((root) => relPath.startsWith(root + "/"));
	if (!ownerPkg) continue;
	const ownerName = packageNameByPath[ownerPkg];
	const allowed = allowedEdges[ownerName];
	let match;
	while ((match = importPattern.exec(text)) !== null) {
		const target = match[2];
		if (target === ownerName) continue; // self-import is always allowed
		if (!allowed.has(target)) {
			const upto = text.slice(0, match.index);
			const lines = upto.split("\n");
			violations.push(
				`${relPath}:${lines.length}:${lines[lines.length - 1].length + 1}: ${ownerName} must not import from ${target} (allowed: [${[...allowed].join(", ") || "none"}])`,
			);
		}
	}
}

if (violations.length === 0) {
	console.log("package boundaries: ok");
	process.exit(0);
}

console.error(`package boundary violations (${enforce ? "enforce" : "warning"}):`);
for (const v of violations) console.error(`  ${v}`);
process.exit(enforce ? 1 : 0);
