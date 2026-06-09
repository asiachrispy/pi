/**
 * Rule loader.
 *
 * Walks the project cwd and global agent dir for `AGENTS.md` / `CLAUDE.md`
 * files and parses each into a `Rule`. The walk mirrors the existing
 * `loadProjectContextFiles` discovery in `core/resource-loader.ts` so
 * the rulebook sees the same files the system prompt already includes.
 *
 * Priority (highest first):
 *   1. project <cwd>/AGENTS.md
 *   2. project <ancestor>/AGENTS.md (closest to cwd first)
 *   3. project <cwd>/CLAUDE.md
 *   4. project <ancestor>/CLAUDE.md
 *   5. global <agentDir>/AGENTS.md
 *   6. global <agentDir>/CLAUDE.md
 *
 * Two files with the same `name` dedupe: the higher-priority file wins.
 * Files that fail to parse are reported as diagnostics, not thrown.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { parseRuleFromFile } from "./parse.ts";
import type { Rule, RuleLoadResult, RuleSource } from "./types.ts";

const PROJECT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"] as const;

interface ProjectFileHit {
	path: string;
	level: "project" | "global";
	label: string;
}

function listCandidateDirs(cwd: string, agentDir: string): Array<{ dir: string; level: "project" | "global" }> {
	const out: Array<{ dir: string; level: "project" | "global" }> = [];
	const seen = new Set<string>();

	const global = resolvePath(agentDir);
	if (!seen.has(global)) {
		seen.add(global);
		out.push({ dir: global, level: "global" });
	}

	const resolvedCwd = resolvePath(cwd);
	const root = resolve("/");
	let current = resolvedCwd;
	while (true) {
		if (!seen.has(current)) {
			seen.add(current);
			out.push({ dir: current, level: "project" });
		}
		if (current === root) break;
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return out;
}

function discoverContextFilePaths(cwd: string, agentDir: string): ProjectFileHit[] {
	const dirs = listCandidateDirs(cwd, agentDir);
	const hits: ProjectFileHit[] = [];
	const seenPaths = new Set<string>();

	// Project-level files take priority over global, and AGENTS.md wins over
	// CLAUDE.md when both are present in the same directory.
	for (const { dir, level } of dirs) {
		for (const filename of PROJECT_FILE_NAMES) {
			const filePath = join(dir, filename);
			if (!existsSync(filePath)) continue;
			if (seenPaths.has(filePath)) continue;
			seenPaths.add(filePath);
			hits.push({
				path: filePath,
				level,
				label: level === "project" ? `<project-${filename}>` : `<global-${filename}>`,
			});
		}
	}

	return hits;
}

export interface LoadRulesOptions {
	cwd: string;
	agentDir: string;
	projectTrusted?: boolean;
}

export function loadRules(options: LoadRulesOptions): RuleLoadResult {
	const diagnostics: RuleLoadResult["diagnostics"] = [];

	if (options.projectTrusted === false) {
		// Project context is untrusted, so skip project-level rules entirely.
		// The global rulebook is still loaded because it is owned by the user.
	}

	const hits = discoverContextFilePaths(options.cwd, options.agentDir);
	const byName = new Map<string, Rule>();

	for (const hit of hits) {
		// Skip project files if the project is not trusted.
		if (hit.level === "project" && options.projectTrusted === false) continue;

		let content: string;
		try {
			content = readFileSync(hit.path, "utf-8");
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: `Failed to read rule file: ${error instanceof Error ? error.message : String(error)}`,
				path: hit.path,
			});
			continue;
		}

		const source: RuleSource = {
			label: hit.label,
			path: canonicalizePath(hit.path),
			level: hit.level,
		};

		const result = parseRuleFromFile(hit.path, content, source);
		diagnostics.push(...result.diagnostics);

		for (const rule of result.rules) {
			const existing = byName.get(rule.name);
			if (existing) {
				// Higher-priority source wins. We process in priority order, so
				// the first insertion is the highest-priority one. The second
				// (lower-priority) file becomes a diagnostic warning.
				diagnostics.push({
					type: "warning",
					message: `Duplicate rule name "${rule.name}" shadows earlier definition from ${existing._source.label}`,
					path: hit.path,
				});
				continue;
			}
			byName.set(rule.name, rule);
		}
	}

	return { rules: Array.from(byName.values()), diagnostics };
}
