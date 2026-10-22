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
import {
  ArrowUp,
  Button,
  cn,
  LoadingBlock,
  OptionCard,
} from "@dust-tt/sparkle";
import { Trans, useLingui } from "@lingui/react/macro";
import { useReducedMotion } from "framer-motion";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

interface UserAnswerRequiredProps {
  blockedAction: AgentLoopBlockedToolExecution & {
    status: "blocked_user_answer_required";
  };
  triggeringUser: UserType | null;
  owner: LightWorkspaceType;
  retryHandler: () => Promise<void>;
}

type SubmissionState = {
  kind: "answer" | "skip";
  phase: "pending" | "exiting";
} | null;

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

// A line placeholder as wide as the text it stands for: the text sets the width but stays invisible.
function TextLineSkeleton({
  text,
  className,
}: {
  text: string;
  className: string;
}) {
  return (
    <LoadingBlock
      className={cn("w-fit max-w-full select-none text-transparent", className)}
    >
      {text}
    </LoadingBlock>
  );
}

// While the answer is submitted, the card stays in the layout but transparent, under a skeleton
// laid out like the card (border, padding and gap of a small `Card`).
function CardSkeletonOverlay({
  isLoading,
  skeleton,
  children,
}: {
  isLoading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <div
        aria-hidden={isLoading}
        className={cn(
          "transition-opacity ease-enter motion-reduce:transition-none",
          isLoading ? "opacity-0 duration-exit" : "opacity-100 duration-enter"
        )}
      >
        {children}
      </div>
      {isLoading && (
        <div
          aria-hidden="true"
          className="absolute inset-0 flex items-center gap-2 border border-transparent p-3 animate-in fade-in-0 duration-exit ease-enter motion-reduce:animate-none"
        >
          {skeleton}
        </div>
      )}
    </div>
  );
}

function OptionCardSkeleton({
  label,
  description,
}: {
  label: string;
  description: string | null;
}) {
  return (
    <>
      <LoadingBlock className="size-5 shrink-0 rounded-full" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-5 items-center">
          <TextLineSkeleton text={label} className="h-3 text-sm font-medium" />
        </div>
        {description && (
          <div className="flex h-4 items-center">
            <TextLineSkeleton text={description} className="h-2.5 text-xs" />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * @cc [owner:aubin-tchoi,label:product] explicit-submit
 * A multi-select question MUST be submitted only with the send button or Cmd/Ctrl+Enter, so that
 * the user can pick several options first. In a single-select question, picking an option MUST
 * submit it right away.
 */
export function UserAnswerRequired({
  blockedAction,
  triggeringUser,
  owner,
  retryHandler,
}: UserAnswerRequiredProps) {
  const { t } = useLingui();
  const { user } = useAuth();
  const { removeCompletedAction } = useBlockedActionsContext();
  const { answerQuestion, errorMessage } = useAnswerUserQuestion({ owner });

  const answerDraft = useUserAnswerDraft({
    multiSelect: blockedAction.question.multiSelect,
  });
  const [submission, setSubmission] = useState<SubmissionState>(null);
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

  const isSubmitting = submission !== null;

  // Reset the keyboard cursor and focus when a new blocked action replaces the current one.
  useEffect(() => {
    setActiveOptionIndex(0);
    setIsCustomResponseFocused(false);
    setIsKeyboardNavigating(false);
    containerRef.current?.focus({ preventScroll: true });
  }, [blockedAction.actionId]);

  async function submitAnswer(
    answer: UserQuestionAnswer,
    { isSkip = false }: { isSkip?: boolean } = {}
  ) {
    // Move focus out of the controls before disabling and hiding them.
    containerRef.current?.focus({ preventScroll: true });
    const submissionKind = isSkip ? "skip" : "answer";
    setSubmission({ kind: submissionKind, phase: "pending" });

    // Submit against the action's own conversation/message: for a sub-agent
    // question these are the child's ids (the action lives in the child
    // conversation). For a direct question they equal the current conversation.
    const result = await answerQuestion({
      conversationId: blockedAction.conversationId,
      messageId: blockedAction.messageId,
      actionId: blockedAction.actionId,
      answer,
    });

    if (result.success) {
      // Resume the agent run. For a sub-agent question this also relaunches the
      // blocked parent run (the child retry is a no-op once the answer is in).
      await retryHandler();

      if (shouldReduceMotion) {
        removeCompletedAction(blockedAction.actionId);
      } else {
        // Keep the submission state visible until the exit animation removes the card.
        setSubmission({ kind: submissionKind, phase: "exiting" });
      }
    } else {
      setSubmission(null);
    }
  }

  function activateOption(index: number) {
    setIsCustomResponseFocused(false);
    setActiveOptionIndex(index);
  }

  function handleOptionClick(index: number) {
    if (isSubmitting) {
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
    if (isSubmitting || answerDraft.answerToSubmit === null) {
      return;
    }

    void submitAnswer(answerDraft.answerToSubmit);
  }

  function handleSkip() {
    if (isSubmitting) {
      return;
    }

    void submitAnswer({ selectedOptions: [] }, { isSkip: true });
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
      aria-busy={isSubmitting}
      onKeyDownCapture={handleContainerKeyDownCapture}
      onKeyDown={handleContainerKeyDown}
      onMouseMove={() => setIsKeyboardNavigating(false)}
      onAnimationEnd={(event) => {
        if (
          submission?.phase === "exiting" &&
          event.currentTarget === event.target
        ) {
          removeCompletedAction(blockedAction.actionId);
        }
      }}
      className={cn(
        "flex flex-col gap-4 rounded-2xl border border-dark bg-background p-5 outline-hidden",
        "ease-enter motion-reduce:animate-none",
        submission?.phase === "exiting" &&
          "animate-out fill-mode-forwards fade-out-0 duration-exit",
        isKeyboardNavigating && "cursor-none"
      )}
    >
      <div className="text-base font-medium leading-tight text-foreground">
        {question.question}
      </div>
      <div className="flex flex-col gap-2">
        {layout === "list" &&
          question.options.map((option, index) => (
            <CardSkeletonOverlay
              key={index}
              isLoading={isSubmitting}
              skeleton={
                <OptionCardSkeleton
                  label={option.label}
                  description={option.description}
                />
              }
            >
              <OptionCard
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
                disabled={isSubmitting}
              />
            </CardSkeletonOverlay>
          ))}
        <CardSkeletonOverlay
          isLoading={isSubmitting}
          skeleton={
            <div className="flex h-5 min-w-0 flex-1 items-center">
              <TextLineSkeleton
                text={
                  answerDraft.customResponse || getCustomResponsePlaceholder()
                }
                className="h-3 text-sm"
              />
            </div>
          }
        >
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
            disabled={isSubmitting}
            onFocus={() => {
              setIsCustomResponseFocused(true);
              answerDraft.selectCustomResponse();
            }}
            onBlur={() => setIsCustomResponseFocused(false)}
            onChange={(value) => answerDraft.updateCustomResponse(value)}
            onKeyDown={handleCustomResponseKeyDown}
          />
        </CardSkeletonOverlay>
        <span role="status" className="sr-only">
          {isSubmitting &&
            (submission?.kind === "skip"
              ? t`Skipping question`
              : t`Submitting answer`)}
        </span>
      </div>
      {errorMessage && (
        <div className="text-sm font-medium text-warning-800">
          {errorMessage}
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <Button
          label={t`Skip`}
          variant="outline"
          size="sm"
          onClick={handleSkip}
          isLoading={submission?.kind === "skip"}
          disabled={isSubmitting}
        />
        <Button
          icon={ArrowUp}
          variant="highlight"
          size="sm"
          isLoading={submission?.kind === "answer"}
          disabled={isSubmitting || answerDraft.answerToSubmit === null}
          onClick={handleSubmit}
          aria-label={t`Send answer`}
          className="rounded-full"
        />
      </div>
    </div>
  );
}
