/**
 * Tool approval policy resolution.
 *
 * Mirrors omp's `tools.approvalMode` model: each tool declares a tier
 * (`read` / `write` / `exec`) and the session picks a global mode plus
 * per-tool overrides. The result is a single decision (`allow` / `deny` /
 * `prompt`) consumed by `wrapToolDefinition` before `execute()` runs.
 *
 * Default tier for tools without an explicit `approval` is `exec`, which is
 * the safe default for MCP servers and unknown custom tools. Default mode is
 * `yolo`, so existing behavior is preserved unless a user opts in.
 */

import type { ToolApproval, ToolApprovalDecision, ToolDefinition, ToolTier } from "../extensions/types.ts";

/** Global approval policy for the active session. */
export type ApprovalMode = "yolo" | "write" | "always-ask";

/** Per-tool override applied on top of the global mode. */
export type PerToolApproval = "allow" | "deny" | "prompt";

/** Settings shape consumed by `resolveApproval`. */
export interface ApprovalSettings {
	mode?: ApprovalMode;
	perTool?: Record<string, PerToolApproval | undefined>;
}

/** Final resolved decision for a single tool call. */
export interface ApprovalDecision {
	decision: "allow" | "deny" | "prompt";
	tier: ToolTier;
	/** Reason surfaced to the user when prompting or denying. */
	reason?: string;
	/** Optional detail lines for the prompt body (command, path, etc.). */
	formatDetails?: () => string[] | undefined;
}

/** Per-tool prompt detail lines returned by `ToolDefinition.formatApprovalDetails`. */
export type ApprovalDetailsFormatter = (args: unknown) => string | string[] | undefined;

/** Normalize the per-tool override map; invalid values are ignored. */
function normalizePerTool(
	perTool: Record<string, PerToolApproval | undefined> | undefined,
): Record<string, PerToolApproval> {
	if (!perTool) return {};
	const out: Record<string, PerToolApproval> = {};
	for (const [name, value] of Object.entries(perTool)) {
		if (value === "allow" || value === "deny" || value === "prompt") {
			out[name] = value;
		}
	}
	return out;
}

/** Evaluate a tool-level approval declaration. */
function evaluateToolApproval(
	approval: ToolApproval | undefined,
	args: unknown,
): { decision: ToolApprovalDecision | { tier: ToolTier; reason?: string; override?: boolean }; tier: ToolTier } {
	const raw = typeof approval === "function" ? approval(args) : approval;
	if (raw === undefined) {
		return { decision: "exec", tier: "exec" };
	}
	if (typeof raw === "string") {
		return { decision: raw, tier: raw };
	}
	return { decision: raw, tier: raw.tier };
}

/**
 * Resolve the approval decision for a single tool call.
 *
 * Order of operations (matches omp `docs/approval-mode.md`):
 *
 * 1. Compute tier + reason from `ToolDefinition.approval(args)`.
 * 2. Apply the normalized `perTool` override if present.
 * 3. In `yolo` mode the user policy wins when set; safety `override` does
 *    not force a prompt. Otherwise allow.
 * 4. In non-yolo modes, a `override: true` tool decision forces a prompt
 *    unless the user explicitly set `deny`, in which case the call is
 *    blocked.
 * 5. Otherwise the user policy wins.
 * 6. Otherwise fall back to the mode's tier-based default.
 */
export function resolveApproval(
	toolName: string,
	toolDef: Pick<ToolDefinition, "approval" | "formatApprovalDetails">,
	args: unknown,
	settings: ApprovalSettings | undefined,
): ApprovalDecision {
	const mode: ApprovalMode = settings?.mode ?? "yolo";
	const perTool = normalizePerTool(settings?.perTool);
	const userPolicy = perTool[toolName];

	const { decision, tier } = evaluateToolApproval(toolDef.approval, args);
	const reason = typeof decision === "object" ? decision.reason : undefined;
	const override = typeof decision === "object" && decision.override === true;
	const formatDetails = (): string[] | undefined => {
		const out = toolDef.formatApprovalDetails?.(args);
		if (Array.isArray(out)) return out;
		if (typeof out === "string") return [out];
		return undefined;
	};

	if (mode === "yolo") {
		// In yolo mode, explicit user policy wins; otherwise allow. Safety
		// overrides do not force a prompt here.
		if (userPolicy === "deny") {
			return { decision: "deny", tier, reason, formatDetails };
		}
		if (userPolicy === "prompt") {
			return { decision: "prompt", tier, reason, formatDetails };
		}
		if (userPolicy === "allow") {
			return { decision: "allow", tier, reason, formatDetails };
		}
		return { decision: "allow", tier, reason, formatDetails };
	}

	// Non-yolo modes: `override: true` forces a prompt, `deny` is a hard block.
	if (override) {
		if (userPolicy === "deny") {
			return { decision: "deny", tier, reason, formatDetails };
		}
		return { decision: "prompt", tier, reason, formatDetails };
	}

	if (userPolicy === "deny") {
		return { decision: "deny", tier, reason, formatDetails };
	}
	if (userPolicy === "prompt") {
		return { decision: "prompt", tier, reason, formatDetails };
	}
	if (userPolicy === "allow") {
		return { decision: "allow", tier, reason, formatDetails };
	}

	// Mode-driven default. Mirrors `docs/approval-mode.md`:
	//   yolo     -> allow all tiers
	//   write    -> allow read/write, prompt exec
	//   always-ask -> allow read, prompt write/exec
	if (mode === "write" && tier !== "exec") {
		return { decision: "allow", tier, reason, formatDetails };
	}
	if (mode === "always-ask" && tier === "read") {
		return { decision: "allow", tier, reason, formatDetails };
	}
	return { decision: "prompt", tier, reason, formatDetails };
}
