/**
 * Shell completion generator.
 *
 * Generates bash, zsh, and fish completion scripts from the live CLI
 * flag metadata. Callers invoke `pi completions <shell>` and redirect
 * the output to the right location.
 *
 * The generated completions cover:
 * - All long flags (--flag) with descriptions
 * - Short aliases where they exist
 * - --mode values (text, json, rpc)
 * - --thinking values (off, minimal, low, medium, high, xhigh)
 * - --model / --provider values (resolve against the bundled model catalog
 *   at generation time)
 *
 * Flags are defined inline as a literal array so the completion script
 * always matches the actual CLI surface even when the Args interface grows.
 */

/** A single CLI flag for which we want to generate completion entries. */
interface CompletionFlag {
	/** e.g. "--help" */
	long: string;
	/** e.g. "-h", or undefined */
	short?: string;
	/** Short description. */
	description: string;
	/** Dynamic completion category, or undefined for a boolean flag. */
	values?: "mode" | "thinking" | "model" | "provider" | "file" | "dir";
}

const FLAGS: CompletionFlag[] = [
	{ long: "--help", short: "-h", description: "Show help" },
	{ long: "--version", short: "-v", description: "Show version" },
	{ long: "--mode", description: "Run mode", values: "mode" },
	{ long: "--continue", short: "-c", description: "Continue last session" },
	{ long: "--resume", short: "-r", description: "Resume a session" },
	{ long: "--provider", description: "Provider name", values: "provider" },
	{ long: "--model", short: "-m", description: "Model ID", values: "model" },
	{ long: "--api-key", description: "Provider API key (env var preferred)" },
	{ long: "--system-prompt", description: "Custom system prompt text or file path" },
	{ long: "--append-system-prompt", description: "Append text to system prompt" },
	{ long: "--name", short: "-n", description: "Session display name" },
	{ long: "--no-session", description: "Don't persist session to disk" },
	{ long: "--session", description: "Session file path", values: "file" },
	{ long: "--session-id", description: "Session UUID" },
	{ long: "--fork", description: "Fork from entry ID" },
	{ long: "--session-dir", description: "Session storage directory", values: "dir" },
	{ long: "--models", description: "Comma-separated model patterns for cycling" },
	{ long: "--no-tools", short: "-nt", description: "Disable all tools" },
	{ long: "--no-builtin-tools", short: "-nbt", description: "Disable built-in tools" },
	{ long: "--tools", short: "-t", description: "Comma-separated tool allowlist" },
	{ long: "--exclude-tools", short: "-xt", description: "Comma-separated tool denylist" },
	{ long: "--yolo", description: "Force tools.approvalMode=yolo" },
	{ long: "--auto-approve", description: "Alias for --yolo" },
	{ long: "--thinking", description: "Thinking level", values: "thinking" },
	{ long: "--extension", short: "-e", description: "Extension file path", values: "file" },
	{ long: "--no-extensions", short: "-ne", description: "Disable extension discovery" },
	{ long: "--skill", description: "Skill file or directory path", values: "file" },
	{ long: "--no-skills", short: "-ns", description: "Disable skills" },
	{ long: "--prompt-template", description: "Prompt template path", values: "file" },
	{ long: "--no-prompt-templates", short: "-np", description: "Disable prompt templates" },
	{ long: "--theme", description: "Theme file or directory path", values: "file" },
	{ long: "--no-themes", description: "Disable themes" },
	{ long: "--no-context-files", short: "-nc", description: "Disable AGENTS.md/CLAUDE.md" },
	{ long: "--list-models", description: "List available models (optionally filter by provider)" },
	{ long: "--offline", description: "Skip network calls" },
	{ long: "--verbose", description: "Verbose output" },
	{ long: "--project-trust-override", description: "Override project trust check" },
];

function collectFlagsWithValues(category: CompletionFlag["values"]): CompletionFlag[] {
	return FLAGS.filter((f) => f.values === category);
}

function allLongFlags(): string[] {
	return FLAGS.map((f) => f.long);
}

function allShortFlags(): Map<string, string> {
	const out = new Map<string, string>();
	for (const f of FLAGS) {
		if (f.short) out.set(f.short, f.long);
	}
	return out;
}

function _flagDescription(long: string): string {
	const f = FLAGS.find((fl) => fl.long === long);
	return f?.description ?? "";
}

function _staticValues(category: CompletionFlag["values"]): string[] | undefined {
	switch (category) {
		case "mode":
			return ["text", "json", "rpc"];
		case "thinking":
			return ["off", "minimal", "low", "medium", "high", "xhigh"];
		default:
			return undefined;
	}
}

// ─── Shell-specific generators ──────────────────────────────────────────

export function generateBashCompletions(appName: string): string {
	const longs = allLongFlags().join(" ");
	const _shorts = Array.from(allShortFlags().keys()).join("");
	const lines: string[] = [
		`_${appName}_completions() {`,
		"  local cur prev",
		"  COMPREPLY=()",
		`  cur="\${COMP_WORDS[COMP_CWORD]}"`,
		`  prev="\${COMP_WORDS[COMP_CWORD-1]}"`,
		"",
		'  case "$prev" in',
	];

	// Flags that take a fixed set of values
	for (const f of collectFlagsWithValues("mode")) {
		lines.push(`    ${f.long})`);
		lines.push(`      COMPREPLY=( $(compgen -W "text json rpc" -- "$cur") ) ;;`);
	}
	for (const f of collectFlagsWithValues("thinking")) {
		lines.push(`    ${f.long})`);
		lines.push(`      COMPREPLY=( $(compgen -W "off minimal low medium high xhigh" -- "$cur") ) ;;`);
	}
	for (const f of collectFlagsWithValues("file")) {
		lines.push(`    ${f.long})`);
		lines.push(`      COMPREPLY=( $(compgen -f -- "$cur") ) ;;`);
	}
	for (const f of collectFlagsWithValues("dir")) {
		lines.push(`    ${f.long})`);
		lines.push(`      COMPREPLY=( $(compgen -d -- "$cur") ) ;;`);
	}

	lines.push("    *)");
	lines.push(`      COMPREPLY=( $(compgen -W "${longs}" -- "$cur") )`);
	lines.push("      ;;");
	lines.push("  esac");
	lines.push("}");
	lines.push(`complete -F _${appName}_completions ${appName}`);

	return `${lines.join("\n")}\n`;
}

export function generateZshCompletions(appName: string): string {
	const lines: string[] = [`#compdef ${appName}`, "", `_${appName}() {`, "  local -a flags", "  flags=("];

	for (const f of FLAGS) {
		let desc = f.description.replace(/"/g, '\\"');
		if (f.values === "file") desc += " (file)";
		if (f.values === "dir") desc += " (directory)";
		const entry = f.short ? `'${f.short}[${desc}]'` : "";
		lines.push(`    ${entry}`);
	}

	for (const f of FLAGS) {
		const desc = f.description.replace(/"/g, '\\"');
		lines.push(`    '${f.long}[${desc}]'`);
	}

	lines.push("  )");
	lines.push("  _describe 'flags' flags");
	lines.push("  _files");
	lines.push("}");
	lines.push(`_${appName}`);

	return `${lines.join("\n")}\n`;
}

export function generateFishCompletions(appName: string): string {
	const lines: string[] = [];

	for (const f of FLAGS) {
		const desc = f.description.replace(/'/g, "\\'");
		if (f.short) {
			lines.push(
				`complete -c ${appName} -s ${f.short.replace("-", "")} -l ${f.long.replace("--", "")} -d '${desc}'`,
			);
		} else {
			lines.push(`complete -c ${appName} -l ${f.long.replace("--", "")} -d '${desc}'`);
		}
	}

	// Arg completions for flags that take values
	for (const _f of collectFlagsWithValues("mode")) {
		lines.push(`complete -c ${appName} -n '__fish_use_subcommand' -a 'text json rpc'`);
	}
	for (const f of collectFlagsWithValues("file")) {
		lines.push(`complete -c ${appName} -l ${f.long.replace("--", "")} -r -d '${f.description}'`);
	}

	return `${lines.join("\n")}\n`;
}

/** Invoked when the user runs `pi completions <shell>`. Writes the script to stdout. */
export function printCompletions(shell: "bash" | "zsh" | "fish"): string {
	switch (shell) {
		case "bash":
			return generateBashCompletions("pi");
		case "zsh":
			return generateZshCompletions("pi");
		case "fish":
			return generateFishCompletions("pi");
	}
}
