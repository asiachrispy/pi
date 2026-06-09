/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 *
 * When `getApprovalSettings` is provided, the wrapped tools also enforce the
 * session's `tools.approvalMode` and per-tool overrides before each call.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ApprovalSettings } from "../tools/approval.ts";
import {
	wrapToolDefinition,
	wrapToolDefinitions,
	wrapToolDefinitionsWithApproval,
	wrapToolDefinitionWithApproval,
} from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(
	registeredTool: RegisteredTool,
	runner: ExtensionRunner,
	getApprovalSettings?: () => ApprovalSettings | undefined,
): AgentTool {
	if (getApprovalSettings) {
		return wrapToolDefinitionWithApproval(registeredTool.definition, getApprovalSettings, () =>
			runner.createContext(),
		);
	}
	return wrapToolDefinition(registeredTool.definition, () => runner.createContext());
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(
	registeredTools: RegisteredTool[],
	runner: ExtensionRunner,
	getApprovalSettings?: () => ApprovalSettings | undefined,
): AgentTool[] {
	if (getApprovalSettings) {
		return wrapToolDefinitionsWithApproval(
			registeredTools.map((registeredTool) => registeredTool.definition),
			getApprovalSettings,
			() => runner.createContext(),
		);
	}
	return wrapToolDefinitions(
		registeredTools.map((registeredTool) => registeredTool.definition),
		() => runner.createContext(),
	);
}
