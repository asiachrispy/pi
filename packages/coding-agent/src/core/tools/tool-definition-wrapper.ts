/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 *
 * `wrapToolDefinitionWithApproval` additionally enforces the session's tool
 * approval policy before `execute()` runs. It is the integration path for
 * `tools.approvalMode` and `tools.approval.<name>` settings.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { type ApprovalDecision, type ApprovalSettings, resolveApproval } from "./approval.ts";

/** Wrap a ToolDefinition into an AgentTool for the core runtime. */
export function wrapToolDefinition<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext),
	};
}

/** Wrap multiple ToolDefinitions into AgentTools for the core runtime. */
export function wrapToolDefinitions(
	definitions: ToolDefinition<any, any>[],
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinition(definition, ctxFactory));
}

/**
 * Result of a blocked tool call. Surfaced as an `isError` result so the
 * harness still records the call in the session log.
 */
function blockedToolResult<TDetails>(reason: string) {
	return {
		content: [{ type: "text", text: reason }] as Array<{ type: "text"; text: string }>,
		details: undefined as TDetails,
		isError: true as const,
	};
}

/** Build a short header line for the approval prompt body. */
function formatApprovalHeader(toolName: string, decision: ApprovalDecision): string[] {
	const lines = [`Allow tool: ${toolName}`];
	if (decision.reason) lines.push(`Reason: ${decision.reason}`);
	return lines;
}

/**
 * Wrap a ToolDefinition with the session's approval policy. When the policy
 * resolves to `prompt`, the user is asked via `ctx.ui.confirm`. When it
 * resolves to `deny`, the call short-circuits with an `isError` result.
 */
export function wrapToolDefinitionWithApproval<TDetails = unknown>(
	definition: ToolDefinition<any, TDetails>,
	getSettings: () => ApprovalSettings | undefined,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: definition.parameters,
		prepareArguments: definition.prepareArguments,
		executionMode: definition.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => {
			const decision = resolveApproval(definition.name, definition, params, getSettings());
			if (decision.decision === "allow") {
				return definition.execute(toolCallId, params, signal, onUpdate, ctxFactory?.() as ExtensionContext);
			}

			if (decision.decision === "deny") {
				return blockedToolResult(decision.reason ?? `Tool "${definition.name}" was denied by policy.`);
			}

			// decision.decision === "prompt"
			const ctx = ctxFactory?.() as ExtensionContext | undefined;
			if (!ctx?.hasUI || !ctx.ui) {
				// No UI available — fail closed. This is the same fail-closed
				// behavior the harness uses for `tool_call` events that throw.
				return blockedToolResult(
					decision.reason ?? `Tool "${definition.name}" requires approval but no UI is available.`,
				);
			}

			const bodyLines = [...formatApprovalHeader(definition.name, decision), ...(decision.formatDetails?.() ?? [])];
			const ok = await ctx.ui.confirm(`Allow tool: ${definition.name}`, bodyLines.join("\n"));
			if (!ok) {
				return blockedToolResult(`Tool "${definition.name}" was not approved.`);
			}
			return definition.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	};
}

/** Wrap multiple ToolDefinitions with the session's approval policy. */
export function wrapToolDefinitionsWithApproval(
	definitions: ToolDefinition<any, any>[],
	getSettings: () => ApprovalSettings | undefined,
	ctxFactory?: () => ExtensionContext,
): AgentTool<any>[] {
	return definitions.map((definition) => wrapToolDefinitionWithApproval(definition, getSettings, ctxFactory));
}

/**
 * Synthesize a minimal ToolDefinition from an AgentTool.
 *
 * This keeps AgentSession's internal registry definition-first even when a caller
 * provides plain AgentTool overrides that do not include prompt metadata or renderers.
 */
export function createToolDefinitionFromAgentTool(tool: AgentTool<any>): ToolDefinition<any, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters as any,
		prepareArguments: tool.prepareArguments,
		executionMode: tool.executionMode,
		execute: async (toolCallId, params, signal, onUpdate) => tool.execute(toolCallId, params, signal, onUpdate),
	};
}
