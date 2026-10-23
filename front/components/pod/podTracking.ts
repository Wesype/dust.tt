import type { SystemPodTab } from "@app/hooks/useSpaceProjectTabs";
import { isSystemPodTab } from "@app/hooks/useSpaceProjectTabs";
import type { TrackingAction, TrackingExtra } from "@app/lib/tracking";
import {
  TRACKING_ACTIONS,
  TRACKING_AREAS,
  trackEvent,
} from "@app/lib/tracking";

// PostHog instrumentation for the Pod onboarding funnel: create a Pod → "Let's go" → accept or
// dismiss the starter suggestions → start a first task. Events are named
// `pods:<object>:<action>` (see `trackEvent`).
//
// The creation step (`pods:pod:create`) and the empty-callout view are intentionally not tracked
// here: Pod creation is counted from the database.

/**
 * @cc [owner:radjakahoul,label:product] pod-events-carry-pod-id
 * Every event emitted through this function MUST carry the Pod's `sId` as `pod_id`, so funnel
 * steps can be joined per Pod, except `create_dialog` events (no Pod exists yet) and
 * `browse:open` (not tied to one Pod). Events about tasks MUST also carry the task `sId`s
 * (`task_id` or `task_ids`).
 */
function trackPodEvent(
  object: string,
  action: TrackingAction,
  extra?: TrackingExtra
): void {
  trackEvent({ area: TRACKING_AREAS.PODS, object, action, extra });
}

// Create Pod dialog. No Pod exists yet, so these events carry no `pod_id`.

export type PodAccess = "open" | "restricted";

export function trackPodCreateDialogSubmit({
  access,
}: {
  access: PodAccess;
}): void {
  trackPodEvent("create_dialog", TRACKING_ACTIONS.SUBMIT, { access });
}

// Fired only when the dialog is closed without creating a Pod (Cancel, Escape, outside click).
export function trackPodCreateDialogClose({
  hasName,
}: {
  hasName: boolean;
}): void {
  trackPodEvent("create_dialog", TRACKING_ACTIONS.CLOSE, { has_name: hasName });
}

export function trackPodOnboardingStart({
  podId,
  isEditor,
}: {
  podId: string;
  isEditor: boolean;
}): void {
  trackPodEvent("onboarding_start", TRACKING_ACTIONS.CLICK, {
    pod_id: podId,
    is_editor: isEditor,
  });
}

export type PodSuggestionsDecision = "accept" | "dismiss";

// "Accept all" / "Dismiss all" on the Suggestions card of a Pod's Tasks tab.
export function trackPodSuggestionsBulk({
  podId,
  decision,
  taskIds,
  onboardingTaskCount,
}: {
  podId: string;
  decision: PodSuggestionsDecision;
  taskIds: string[];
  onboardingTaskCount: number;
}): void {
  trackPodEvent(
    "suggestions",
    decision === "accept" ? TRACKING_ACTIONS.SELECT : TRACKING_ACTIONS.DISMISS,
    {
      pod_id: podId,
      task_ids: taskIds.join(","),
      task_count: taskIds.length,
      onboarding_task_count: onboardingTaskCount,
    }
  );
}

// "Accept" on a single suggestion.
export function trackPodSuggestionAccept({
  podId,
  taskId,
  isOnboardingTask,
}: {
  podId: string;
  taskId: string;
  isOnboardingTask: boolean;
}): void {
  trackPodEvent("suggestion", TRACKING_ACTIONS.SELECT, {
    pod_id: podId,
    task_id: taskId,
    is_onboarding_task: isOnboardingTask,
  });
}

export type PodTaskAssignee = "self" | "other" | "none";

export function podTaskAssignee(
  assigneeId: string | null,
  viewerUserId: string | null
): PodTaskAssignee {
  if (assigneeId === null) {
    return "none";
  }
  return assigneeId === viewerUserId ? "self" : "other";
}

// A task added by hand from the Tasks tab composer. The task text is never sent.
export function trackPodTaskAdd({
  podId,
  assignee,
}: {
  podId: string;
  assignee: PodTaskAssignee;
}): void {
  trackPodEvent("task", TRACKING_ACTIONS.SUBMIT, {
    pod_id: podId,
    assignee,
  });
}

// "Start working on task" (Play) from the Tasks tab.
export function trackPodTaskStart({
  podId,
  taskId,
  isOnboardingTask,
  isFirstOnboardingTask,
  goToConversation,
}: {
  podId: string;
  taskId: string;
  isOnboardingTask: boolean;
  isFirstOnboardingTask: boolean;
  goToConversation: boolean;
}): void {
  trackPodEvent("task_start", TRACKING_ACTIONS.CLICK, {
    pod_id: podId,
    task_id: taskId,
    is_onboarding_task: isOnboardingTask,
    is_first_onboarding_task: isFirstOnboardingTask,
    go_to_conversation: goToConversation,
  });
}

export type PodTabKind = SystemPodTab | "file_tab";

// File tabs are keyed by file path, which is user content: only their kind is sent.
export function podTabKind(tab: string): PodTabKind {
  return isSystemPodTab(tab) ? tab : "file_tab";
}

// A tab picked by the user in the Pod header (programmatic tab changes are not tracked).
export function trackPodTabSelect({
  podId,
  tab,
}: {
  podId: string;
  tab: string;
}): void {
  trackPodEvent("tab", TRACKING_ACTIONS.SELECT, {
    pod_id: podId,
    tab: podTabKind(tab),
  });
}

// The "…" browse-Pods popover in the sidebar is opened. Not tied to a single Pod.
export function trackPodsBrowseOpen(): void {
  trackPodEvent("browse", TRACKING_ACTIONS.OPEN);
}
