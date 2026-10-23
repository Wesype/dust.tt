import { useBlockedActionsContext } from "@app/components/assistant/conversation/BlockedActionsProvider";
import { useAnswerUserQuestion } from "@app/hooks/useAnswerUserQuestion";
import { useUserAnswerDraft } from "@app/hooks/useUserAnswerDraft";
import type { AgentLoopBlockedToolExecution } from "@app/lib/actions/mcp";
import type { UserQuestion, UserQuestionAnswer } from "@app/lib/actions/types";
import { canCurrentUserRespondToParentUserMessage } from "@app/lib/api/assistant/conversation/can_current_user_respond";
import { useAuth } from "@app/lib/auth/AuthContext";
import { isEditableTarget } from "@app/lib/utils/dom";
import {
  assertNever,
  assertNeverAndIgnore,
} from "@app/types/shared/utils/assert_never";
import type { LightWorkspaceType, UserType } from "@app/types/user";
import { ArrowUp, Button, cn, OptionCard } from "@dust-tt/sparkle";
import { Trans, useLingui } from "@lingui/react/macro";
import { useReducedMotion } from "framer-motion";
import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

interface UserAnswerRequiredProps {
  blockedAction: AgentLoopBlockedToolExecution & {
    status: "blocked_user_answer_required";
  };
  // The message the action is queued under: the outermost agent message for a sub-agent question.
  outerMessageId: string;
  triggeringUser: UserType | null;
  owner: LightWorkspaceType;
  retryHandler: () => Promise<void>;
}

type QuestionLayout = "list";

/**
 * @cc [owner:aubin-tchoi,label:product] question-layout
 * A question MUST render with its `format`'s layout only when all of that format's constraints
 * hold, and as the default list otherwise, including when it has no `format` at all (stored before
 * the field existed) or one this client does not know.
 */
function getQuestionLayout(question: UserQuestion): QuestionLayout {
  switch (question.format) {
    case "list":
      return "list";
    default:
      assertNeverAndIgnore(question.format);
      return "list";
  }
}

function isPrintableKey(e: KeyboardEvent<HTMLDivElement>) {
  return (
    e.key.length === 1 && e.key !== " " && !e.altKey && !e.ctrlKey && !e.metaKey
  );
}

function getArrowKeyDirection(key: string): 1 | -1 | null {
  if (key === "ArrowDown") {
    return 1;
  }
  if (key === "ArrowUp") {
    return -1;
  }
  return null;
}

/**
 * @cc [owner:aubin-tchoi,label:product] explicit-submit
 * A multi-select question MUST be submitted only with the send button or Cmd/Ctrl+Enter, so that
 * the user can pick several options first. In a single-select question, picking an option MUST
 * submit it right away.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] close-on-submit
 * Submitting an answer or skipping MUST close the card without waiting for the answer to be saved,
 * and MUST show the card again if saving it fails.
 */
export function UserAnswerRequired({
  blockedAction,
  outerMessageId,
  triggeringUser,
  owner,
  retryHandler,
}: UserAnswerRequiredProps) {
  const { t } = useLingui();
  const { user } = useAuth();
  const { enqueueBlockedAction, removeCompletedAction } =
    useBlockedActionsContext();
  const { answerQuestion } = useAnswerUserQuestion({ owner });

  const answerDraft = useUserAnswerDraft({
    multiSelect: blockedAction.question.multiSelect,
  });
  const [isClosing, setIsClosing] = useState(false);
  const [activeOptionIndex, setActiveOptionIndex] = useState(0);
  const [isCustomResponseFocused, setIsCustomResponseFocused] = useState(false);
  const [isKeyboardNavigating, setIsKeyboardNavigating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const customResponseInputRef = useRef<HTMLInputElement>(null);
  const shouldReduceMotion = useReducedMotion();

  const { question } = blockedAction;
  const layout = getQuestionLayout(question);
  const requiresExplicitSubmit = question.multiSelect;
  const canCurrentUserRespond = canCurrentUserRespondToParentUserMessage({
    parentUserId: blockedAction.userId,
    currentUserId: user?.sId,
  });

  const isCustomResponseActive =
    isCustomResponseFocused ||
    answerDraft.answerToSubmit?.customResponse !== undefined;

  // Reset the keyboard cursor and focus when a new blocked action replaces the current one.
  useEffect(() => {
    setActiveOptionIndex(0);
    setIsCustomResponseFocused(false);
    setIsKeyboardNavigating(false);
    containerRef.current?.focus({ preventScroll: true });
  }, [blockedAction.actionId]);

  async function submitAnswer(answer: UserQuestionAnswer) {
    const { actionId } = blockedAction;

    // Move focus out of the controls before disabling and hiding them.
    containerRef.current?.focus({ preventScroll: true });
    // The card is removed without waiting for the answer to be saved. Without reduced motion, the
    // end of the exit animation removes it.
    if (shouldReduceMotion) {
      removeCompletedAction(actionId, { revalidate: false });
    } else {
      setIsClosing(true);
    }

    // Submit against the action's own conversation/message: for a sub-agent
    // question these are the child's ids (the action lives in the child
    // conversation). For a direct question they equal the current conversation.
    const result = await answerQuestion({
      conversationId: blockedAction.conversationId,
      messageId: blockedAction.messageId,
      actionId,
      answer,
    });

    if (!result.success) {
      // Puts the card back if it was already removed.
      enqueueBlockedAction({ messageId: outerMessageId, blockedAction });
      setIsClosing(false);
      return;
    }

    // Blocked actions are refetched only now that the answer is saved: an earlier refetch would
    // still return the action as blocked and show the card again.
    removeCompletedAction(actionId);
    // Saving the answer already resumes the agent run, including the blocked parent run of a
    // sub-agent question: the retry is not awaited.
    void retryHandler();
  }

  function activateOption(index: number) {
    setIsCustomResponseFocused(false);
    setActiveOptionIndex(index);
  }

  function handleOptionClick(index: number) {
    if (isClosing) {
      return;
    }

    activateOption(index);

    const answer = answerDraft.selectOption(index);

    if (answer !== null && !requiresExplicitSubmit) {
      void submitAnswer(answer);
    }
  }

  function moveActiveOption(direction: 1 | -1) {
    if (question.options.length === 0) {
      return;
    }

    setActiveOptionIndex(
      (prev) =>
        (prev + direction + question.options.length) % question.options.length
    );
  }

  function handleSubmit() {
    if (isClosing || answerDraft.answerToSubmit === null) {
      return;
    }

    void submitAnswer(answerDraft.answerToSubmit);
  }

  function handleSkip() {
    if (isClosing) {
      return;
    }

    void submitAnswer({ selectedOptions: [] });
  }

  function handleActiveOptionSelection() {
    if (question.options.length === 0) {
      return;
    }

    handleOptionClick(activeOptionIndex);
  }

  function handleStartCustomResponse(character: string) {
    setIsCustomResponseFocused(true);
    answerDraft.appendCustomResponse(character);
    customResponseInputRef.current?.focus();
  }

  function handleCustomResponseKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (
      e.key === "Backspace" &&
      answerDraft.customResponse.length === 0 &&
      question.options.length > 0
    ) {
      e.preventDefault();
      setIsKeyboardNavigating(true);
      setIsCustomResponseFocused(false);
      setActiveOptionIndex(question.options.length - 1);
      containerRef.current?.focus();
      return;
    }

    if (
      e.key === "Enter" &&
      (!question.multiSelect || e.metaKey || e.ctrlKey)
    ) {
      e.preventDefault();
      setIsKeyboardNavigating(true);
      handleSubmit();
    }
  }

  function handleContainerKeyDownCapture(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setIsKeyboardNavigating(true);
      handleSkip();
      return;
    }

    if (isEditableTarget(e.target)) {
      return;
    }

    if (
      (e.metaKey || e.ctrlKey) &&
      e.key === "Enter" &&
      requiresExplicitSubmit
    ) {
      e.preventDefault();
      e.stopPropagation();
      setIsKeyboardNavigating(true);
      handleSubmit();
    }
  }

  function handleContainerKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (isEditableTarget(e.target)) {
      return;
    }

    if (isPrintableKey(e)) {
      e.preventDefault();
      setIsKeyboardNavigating(true);
      handleStartCustomResponse(e.key);
      return;
    }

    const arrowKeyDirection = getArrowKeyDirection(e.key);
    if (arrowKeyDirection !== null) {
      e.preventDefault();
      setIsKeyboardNavigating(true);
      setIsCustomResponseFocused(false);
      moveActiveOption(arrowKeyDirection);
      containerRef.current?.focus();
      return;
    }

    switch (e.key) {
      case "Enter":
      case " ":
        if (e.currentTarget === e.target) {
          e.preventDefault();
          setIsKeyboardNavigating(true);
          handleActiveOptionSelection();
        }
        break;
    }
  }

  if (!canCurrentUserRespond) {
    const triggeringUserName = triggeringUser?.fullName;
    return (
      <div className="text-sm text-muted-foreground">
        {triggeringUserName ? (
          <Trans>
            Waiting for&nbsp;
            <span className="font-semibold">{triggeringUserName}</span>
            &nbsp; to answer.
          </Trans>
        ) : (
          <Trans>
            Waiting for&nbsp;
            <span className="font-semibold">another user</span>
            &nbsp; to answer.
          </Trans>
        )}
      </div>
    );
  }

  // Declared after the early return so that its strings keep their place in the extracted catalogs.
  function getCustomResponsePlaceholder() {
    switch (layout) {
      case "list":
        return t`Tell the agent what to do differently`;
      default:
        return assertNever(layout);
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDownCapture={handleContainerKeyDownCapture}
      onKeyDown={handleContainerKeyDown}
      onMouseMove={() => setIsKeyboardNavigating(false)}
      onAnimationEnd={(event) => {
        if (isClosing && event.currentTarget === event.target) {
          removeCompletedAction(blockedAction.actionId, { revalidate: false });
        }
      }}
      className={cn(
        "flex flex-col gap-4 rounded-2xl border border-dark bg-background p-5 outline-hidden",
        "ease-enter motion-reduce:animate-none",
        isClosing && "animate-out fill-mode-forwards fade-out-0 duration-exit",
        isKeyboardNavigating && "cursor-none"
      )}
    >
      <div className="text-base font-medium leading-tight text-foreground">
        {question.question}
      </div>
      <div className="flex flex-col gap-2">
        {layout === "list" &&
          question.options.map((option, index) => (
            <OptionCard
              key={index}
              label={option.label}
              description={option.description}
              counterValue={index + 1}
              selected={answerDraft.selectedOptions.includes(index)}
              disableHover={isKeyboardNavigating}
              selectionIndicator={question.multiSelect ? "checkbox" : "radio"}
              onFocusCapture={() => activateOption(index)}
              onMouseEnter={() => activateOption(index)}
              className={cn(
                activeOptionIndex === index &&
                  !isCustomResponseActive &&
                  !answerDraft.selectedOptions.includes(index) &&
                  "bg-primary-100",
                isKeyboardNavigating && "cursor-none"
              )}
              onClick={() => handleOptionClick(index)}
              disabled={isClosing}
            />
          ))}
        <OptionCard
          type="input"
          selected={isCustomResponseActive}
          disableHover={isKeyboardNavigating}
          className={cn(isKeyboardNavigating && "cursor-none")}
          inputRef={customResponseInputRef}
          id={`custom-response-${blockedAction.actionId}`}
          name="custom-response"
          placeholder={getCustomResponsePlaceholder()}
          value={answerDraft.customResponse}
          disabled={isClosing}
          onFocus={() => {
            setIsCustomResponseFocused(true);
            answerDraft.selectCustomResponse();
          }}
          onBlur={() => setIsCustomResponseFocused(false)}
          onChange={(value) => answerDraft.updateCustomResponse(value)}
          onKeyDown={handleCustomResponseKeyDown}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <Button
          label={t`Skip`}
          variant="outline"
          size="sm"
          onClick={handleSkip}
          disabled={isClosing}
        />
        <Button
          icon={ArrowUp}
          variant="highlight"
          size="sm"
          disabled={isClosing || answerDraft.answerToSubmit === null}
          onClick={handleSubmit}
          aria-label={t`Send answer`}
          className="rounded-full"
        />
      </div>
    </div>
  );
}
