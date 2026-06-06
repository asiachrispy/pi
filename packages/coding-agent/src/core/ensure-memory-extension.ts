import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveMemorySource(): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(here, "../../examples/extensions/memory.ts"),
		join(here, "../examples/extensions/memory.ts"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

/** Install upstream memory.ts into the agent dir when missing (shared by pi CLI and pi-web). */
export function ensureMemoryExtension(agentDir: string): string | null {
	const dest = join(agentDir, "extensions", "memory.ts");
	if (existsSync(dest)) return dest;

	const source = resolveMemorySource();
	if (!source) return null;

	mkdirSync(dirname(dest), { recursive: true });
	copyFileSync(source, dest);
	return dest;
}
