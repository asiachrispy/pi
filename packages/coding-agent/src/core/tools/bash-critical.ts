/**
 * Critical bash pattern detection.
 *
 * Used by the bash tool's `approval` declaration to flag dangerous commands
 * (e.g. `rm -rf /`, fork bombs, fetch-then-exec) so they force an approval
 * prompt via `override: true` even in `yolo` mode (when paired with a user
 * `prompt` policy).
 *
 * The patterns mirror the small set documented in omp's
 * `docs/approval-mode.md` and are intentionally conservative: any false
 * positive is annoying; any false negative is a data-loss risk.
 */

export interface BashCriticalHit {
	/** Stable identifier for the pattern. */
	id: string;
	/** Human-readable reason shown in the approval prompt. */
	reason: string;
}

/** Match a command line for known critical patterns. Returns the first hit, if any. */
export function findCriticalBashPattern(command: string): BashCriticalHit | undefined {
	const hits: { regex: RegExp; id: string; reason: string }[] = [
		{
			// Recursive delete targeting the filesystem root or home directory.
			regex: /\brm\s+(-[A-Za-z]*[rR][A-Za-z]*\s+|-[A-Za-z]*[fF][A-Za-z]*\s+|--force\s+|--recursive\s+)*\/(?:\s|$|\*)/,
			id: "rm-rf-root",
			reason: "Recursive delete targeting the filesystem root",
		},
		{
			// Same idea, but via --no-preserve-root or $HOME paths.
			regex: /\brm\s+(-[A-Za-z]*[rR][A-Za-z]*\s+|-[A-Za-z]*[fF][A-Za-z]*\s+|--force\s+|--recursive\s+)*--no-preserve-root\b/,
			id: "rm-no-preserve-root",
			reason: "Recursive delete with --no-preserve-root",
		},
		{
			// Classic fork bomb.
			regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
			id: "fork-bomb",
			reason: "Fork bomb",
		},
		{
			// fetch | bash
			regex: /\b(curl|wget|fetch)\b[^\n|;]*\|\s*(sudo\s+)?(ba)?sh\b/,
			id: "fetch-then-exec",
			reason: "Fetch piped to shell execution",
		},
		{
			// Direct write to /etc/passwd, /etc/shadow, or similar host files.
			regex: /(>>|>)\s*\/(etc\/(passwd|shadow|hosts|sudoers|sudoers\.d\/)|boot\/)/,
			id: "write-host-config",
			reason: "Write to host system file",
		},
		{
			// System shutdown / reboot.
			regex: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/,
			id: "system-shutdown",
			reason: "System shutdown or reboot",
		},
		{
			// Filesystem format on a device.
			regex: /\bmkfs(\.[a-z0-9]+)?\s+\/dev\//,
			id: "mkfs-device",
			reason: "Format a block device",
		},
		{
			// dd writing to a block device.
			regex: /\bdd\b[^\n|;]*\bof=\/dev\//,
			id: "dd-to-device",
			reason: "dd writing to a block device",
		},
	];

	for (const hit of hits) {
		if (hit.regex.test(command)) {
			return { id: hit.id, reason: hit.reason };
		}
	}
	return undefined;
}
