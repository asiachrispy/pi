/**
 * `conflict://` URL protocol.
 *
 * When a git merge conflict is present in a file, the model can write
 * `@theirs`, `@ours`, or `@base` to `conflict://<N>` to resolve that
 * conflict marker. The edit tool intercepts the URL, reads the file,
 * finds the conflict region, and applies the resolution.
 *
 * Bulk form: `conflict://*` resolves all conflicts in the working tree
 * to the same side (`@ours`, `@theirs`, or `@base`).
 *
 * This is a thin wrapper around the existing edit tool — when the write
 * target starts with `conflict://`, the file path is computed, the
 * conflict region is located, and the write is transformed into an
 * in-place file edit that removes the conflict markers.
 */

import { readFileSync } from "node:fs";

export const CONFLICT_URL_SCHEME = "conflict:";

export function isConflictUrl(url: string): boolean {
	return url.toLowerCase().startsWith(CONFLICT_URL_SCHEME);
}

/** Parse a `conflict://` URL. Returns the path and optional conflict number. */
export function parseConflictUrl(url: string): { path: string; index?: number } | undefined {
	const stripped = url.slice(CONFLICT_URL_SCHEME.length).replace(/^\/+/, "");
	if (!stripped) return undefined;
	// `conflict://src/file.ts` -> target a specific file
	// `conflict://3` -> target conflict region N in the currently edited file
	// `conflict://*` -> bulk resolve
	if (stripped === "*") return { path: "*" };

	const num = Number(stripped);
	if (!Number.isNaN(num)) return { path: stripped, index: num };

	return { path: stripped };
}

/**
 * Common conflict marker patterns. Git uses `<<<<<<<` / `=======` / `>>>>>>>`;
 * we also handle variant markers some tools produce.
 */
const _CONFLICT_START = /^<{7}\s*[^\r\n]*[\r\n]+/;
const _CONFLICT_MID = /^={7}[\r\n]+/;
const _CONFLICT_END = /^>{7}\s*[^\r\n]*[\r\n]+/;

interface ConflictRegion {
	/** Line index (0-based) of the `<<<<<<<` marker. */
	startLine: number;
	/** Line index of the `=======` separator. */
	midLine: number;
	/** Line index of the `>>>>>>>` marker. */
	endLine: number;
	/** Content of the "ours" side (between <<< and ===). */
	oursLines: string[];
	/** Content of the "theirs" side (between === and >>>). */
	theirsLines: string[];
	/** Content before the conflict marker (common ancestor), if available (diff3). */
	baseLines?: string[];
}

/**
 * Find all conflict regions in a file's text. Returns them in
 * line order so the model can refer to them by index (1-based).
 */
export function findConflictRegions(text: string): ConflictRegion[] {
	const lines = text.split("\n");
	const regions: ConflictRegion[] = [];
	let i = 0;

	while (i < lines.length) {
		const full = lines[i] ?? "";
		if (full.startsWith("<<<<<<<")) {
			const startLine = i;
			const oursLines: string[] = [];
			let midLine = -1;
			let endLine = -1;
			const theirsLines: string[] = [];

			i++;
			while (i < lines.length) {
				const l = lines[i] ?? "";
				if (l.startsWith("|||||||")) {
					// diff3 base marker — skip for now; just move past it.
					i++;
					continue;
				}
				if (l.startsWith("=======")) {
					midLine = i;
					i++;
					while (i < lines.length && !lines[i]?.startsWith(">>>>>>>")) {
						theirsLines.push(lines[i] ?? "");
						i++;
					}
					break;
				}
				oursLines.push(l);
				i++;
			}

			if (midLine >= 0 && i < lines.length && lines[i]?.startsWith(">>>>>>>")) {
				endLine = i;
				regions.push({
					startLine,
					midLine,
					endLine,
					oursLines,
					theirsLines,
				});
			}
			i++;
		} else {
			i++;
		}
	}

	return regions;
}

export type ConflictResolution = "@ours" | "@theirs" | "@base";

/**
 * Apply a resolution to one or more conflict regions.
 * `path` can be a real file path or `*` (bulk resolve all tracked files).
 * `index` selects a specific region (1-based); null means all.
 * Returns the resolved content for that file and the number of regions resolved.
 */
export function resolveConflictInFile(
	filePath: string,
	resolution: ConflictResolution,
	index: number | null,
): { content: string; resolved: number } | undefined {
	let text: string;
	try {
		text = readFileSync(filePath, "utf-8");
	} catch {
		return undefined;
	}

	const regions = findConflictRegions(text);
	if (regions.length === 0) return undefined;

	const selected = index !== null ? [regions[(index ?? 1) - 1]].filter(Boolean) : regions;
	if (index !== null && selected.length === 0) return undefined;

	// Resolve regions in reverse order so line indices stay valid.
	const resolved = [...selected].sort((a, b) => b.startLine - a.startLine);
	const lines = text.split("\n");

	for (const region of resolved) {
		let replacement: string[];
		switch (resolution) {
			case "@ours":
				replacement = region.oursLines;
				break;
			case "@theirs":
				replacement = region.theirsLines;
				break;
			case "@base":
				replacement = region.baseLines ?? [];
				break;
		}
		lines.splice(region.startLine, region.endLine - region.startLine + 1, ...replacement);
	}

	return { content: lines.join("\n"), resolved: resolved.length };
}
