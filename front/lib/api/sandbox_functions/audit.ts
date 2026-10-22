import type { SandboxFunctionInvocationResource } from "@app/lib/resources/sandbox_function_invocation_resource";
import logger from "@app/logger/logger";
import type { SandboxFunctionInvocationContext } from "@app/types/api/sandbox_functions";
import { normalizeError } from "@app/types/shared/utils/error_utils";

/**
 * The invocation context for audit metadata only: a failed read is logged and yields no context,
 * so audit enrichment never blocks the tool call.
 */
export async function readInvocationContextForAudit(
  invocation: SandboxFunctionInvocationResource
): Promise<SandboxFunctionInvocationContext | undefined> {
  try {
    return await invocation.getContext();
  } catch (err) {
    logger.warn(
      { invocationId: invocation.sId, err: normalizeError(err) },
      "Failed to read the invocation context for audit metadata"
    );
    return undefined;
  }
}

/**
 * Function identifiers for the shared `tool.*` audit events. Function-initiated tool calls reuse
 * the agent-loop actions so admins read one stream; these keys stand in for the conversation and
 * agent-message identifiers the agent flavor carries. `context` adds the schedule that fired a
 * `scheduled` invocation.
 */
export function buildSandboxFunctionAuditMetadata(
  invocation: SandboxFunctionInvocationResource,
  context: SandboxFunctionInvocationContext | undefined
): Record<string, string> {
  const { sandboxFunction } = invocation;
  const { frame } = sandboxFunction;

  return {
    frame_id: frame.sId,
    frame_function_id: sandboxFunction.sId,
    frame_function_name: sandboxFunction.slug,
    frame_publication_id: sandboxFunction.publicationId,
    invocation_id: invocation.sId,
    // Null for invocations recorded before origins were tracked.
    ...(invocation.origin ? { invocation_origin: invocation.origin } : {}),
    ...(context?.scheduleId ? { schedule_id: context.scheduleId } : {}),
    ...(context?.scheduledFireTime
      ? { scheduled_fire_time: context.scheduledFireTime }
      : {}),
  };
}
