import type { UserMessageType } from "@app/types/assistant/conversation";
import { documentCommentOf } from "@app/types/assistant/document_comment";
import type { CollabAgent } from "@app/types/collab";

/**
 * @cc [owner:adrien,label:product] collab-agent-of-run
 * The agent MUST carry the thread of `userMessage`'s `document_comment` directive as `commentId`,
 * and none for any other message, so editors show its activity in that thread only.
 */
export function toCollabAgent({
  agentConfiguration,
  userMessage,
}: {
  agentConfiguration: { sId: string; name: string };
  userMessage: UserMessageType;
}): CollabAgent {
  return {
    agentId: agentConfiguration.sId,
    name: agentConfiguration.name,
    userId: userMessage.user?.sId ?? null,
    userName: userMessage.context.fullName || userMessage.context.username,
    commentId: documentCommentOf(userMessage)?.commentId ?? null,
  };
}
