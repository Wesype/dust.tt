import { AgentPicker } from "@app/components/assistant/AgentPicker";
import {
  INPUT_BAR_COMPACT_ENTER_ANIMATION_CLASSES,
  INPUT_BAR_COMPACT_SURFACE_CLASSES,
} from "@app/components/assistant/conversation/input_bar/inputBarCompactStyles";
import { findDefaultAgent } from "@app/components/editor/input_bar/useHandleMentions";
import { useCreateConversationWithMessage } from "@app/hooks/useCreateConversationWithMessage";
import { useSendApiErrorNotification } from "@app/hooks/useNotification";
import { useAuth } from "@app/lib/auth/AuthContext";
import { getFilePreviewMarkdownDirective } from "@app/lib/markdown/file_preview";
import { useAppRouter } from "@app/lib/platform";
import { serializeSkillTag } from "@app/lib/skills/format";
import { useUnifiedAgentConfigurations } from "@app/lib/swr/assistants";
import { usePodConversationDefaults } from "@app/lib/swr/pods";
import { getConversationRoute } from "@app/lib/utils/router";
import { compareAgentsForSort } from "@app/types/assistant/assistant";
import type { RichAgentMentionCandidate } from "@app/types/assistant/mentions";
import { toRichAgentMentionType } from "@app/types/assistant/mentions";
import {
  FILE_PREVIEW_SIDE_PANEL_TYPE,
  SIDE_PANEL_HASH_PARAM,
  SIDE_PANEL_TYPE_HASH_PARAM,
} from "@app/types/conversation_side_panel";
import type { LightWorkspaceType } from "@app/types/user";
import { ArrowUp, Avatar, Button, cn, Icon, Robot } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";

interface ThinComposerProps {
  owner: LightWorkspaceType;
  podId: string;
  documentPath: string;
}

export function ThinComposer({
  owner,
  podId,
  documentPath,
}: ThinComposerProps) {
  const { t } = useLingui();
  const { user } = useAuth();
  const router = useAppRouter();
  const sendApiErrorNotification = useSendApiErrorNotification();
  const createConversationWithMessage = useCreateConversationWithMessage({
    owner,
    user,
  });

  const [text, setText] = useState("");
  const [pickedAgent, setPickedAgent] =
    useState<RichAgentMentionCandidate | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { agentConfigurations, isLoading: agentsLoading } =
    useUnifiedAgentConfigurations({ workspaceId: owner.sId });
  const activeAgents = useMemo(
    () =>
      agentConfigurations
        .filter((a) => a.status === "active")
        .sort(compareAgentsForSort),
    [agentConfigurations]
  );

  const { defaultAgentId, defaultSkills, isPodConversationDefaultsLoading } =
    usePodConversationDefaults({ owner, podId });
  const isAgentLoading = agentsLoading || isPodConversationDefaultsLoading;
  const defaultAgent = useMemo(
    () => findDefaultAgent(activeAgents, defaultAgentId) ?? null,
    [activeAgents, defaultAgentId]
  );
  const agent = pickedAgent ?? defaultAgent;
  const agentName = agent?.name ?? "";

  const createAndOpenConversation = async (
    message: string,
    mentionedAgent: RichAgentMentionCandidate
  ) => {
    const conversationRes = await createConversationWithMessage({
      messageData: {
        input: [
          ...defaultSkills.map((skill) =>
            serializeSkillTag({
              id: skill.sId,
              name: skill.name,
              icon: skill.icon,
            })
          ),
          `${message}\n\n${getFilePreviewMarkdownDirective({ path: documentPath })}`,
        ].join(" "),
        mentions: [{ configurationId: mentionedAgent.sId }],
        contentFragments: { uploaded: [], contentNodes: [] },
        richMentions: [toRichAgentMentionType(mentionedAgent)],
      },
      spaceId: podId,
      deferMessage: true,
    });

    if (conversationRes.isErr()) {
      sendApiErrorNotification({
        title: conversationRes.error.title,
        error: conversationRes.error.error,
      });
      return;
    }

    const hash = new URLSearchParams({
      [SIDE_PANEL_TYPE_HASH_PARAM]: FILE_PREVIEW_SIDE_PANEL_TYPE,
      [SIDE_PANEL_HASH_PARAM]: documentPath,
    });
    await router.push(
      `${getConversationRoute(owner.sId, conversationRes.value.sId)}#?${hash}`
    );
  };

  const submit = async () => {
    const message = text.trim();
    if (!message || !agent || isAgentLoading || isSubmitting) {
      return;
    }
    setIsSubmitting(true);
    try {
      await createAndOpenConversation(message, agent);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form
      className={cn(
        "absolute bottom-4 left-4 z-30 flex w-80 max-w-[calc(100%-2rem)] items-center gap-2 p-2",
        "rounded-squircle-40",
        INPUT_BAR_COMPACT_SURFACE_CLASSES,
        INPUT_BAR_COMPACT_ENTER_ANIMATION_CLASSES
      )}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <AgentPicker
        owner={owner}
        agents={activeAgents}
        selectedAgentId={agent?.sId}
        isLoading={isAgentLoading}
        disabled={isAgentLoading}
        mountPortal
        showDropdownArrow={false}
        showFooterButtons={false}
        side="top"
        size="xs"
        onItemClick={setPickedAgent}
        pickerButton={
          <button
            type="button"
            aria-label={t`Selected agent: ${agentName}`}
            className="shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {agent ? (
              <Avatar size="xs" visual={agent.pictureUrl} />
            ) : (
              <Icon visual={Robot} size="sm" />
            )}
          </button>
        }
      />
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t`Start a conversation…`}
        aria-label={t`Start a conversation about this document`}
        className="min-w-0 flex-1 border-0 bg-transparent p-0 copy-sm text-foreground shadow-none outline-none ring-0 placeholder:text-faint focus:border-0 focus:ring-0 dark:text-foreground-night dark:placeholder:text-faint-night"
      />
      <Button
        type="submit"
        size="xs"
        variant="highlight"
        icon={ArrowUp}
        className="rounded-full"
        aria-label={t`Send message`}
        isLoading={isSubmitting}
        disabled={!text.trim() || !agent || isAgentLoading}
      />
    </form>
  );
}
