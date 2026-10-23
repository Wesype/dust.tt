import {
  podTabKind,
  podTaskAssignee,
  trackPodCreateDialogClose,
  trackPodCreateDialogSubmit,
  trackPodOnboardingStart,
  trackPodsBrowseOpen,
  trackPodSuggestionAccept,
  trackPodSuggestionsBulk,
  trackPodTabSelect,
  trackPodTaskAdd,
  trackPodTaskStart,
} from "@app/components/pod/podTracking";
import { trackEvent } from "@app/lib/tracking";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the real TRACKING_AREAS/TRACKING_ACTIONS so the module builds genuine
// values; only intercept the emit so we can assert the event contract.
vi.mock("@app/lib/tracking", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@app/lib/tracking")>();
  return { ...actual, trackEvent: vi.fn() };
});

const trackEventMock = vi.mocked(trackEvent);

beforeEach(() => {
  trackEventMock.mockClear();
});

describe("podTracking", () => {
  it("emits pods:create_dialog:submit with the access level", () => {
    trackPodCreateDialogSubmit({ access: "restricted" });

    expect(trackEventMock).toHaveBeenCalledTimes(1);
    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "create_dialog",
      action: "submit",
      extra: { access: "restricted" },
    });
  });

  it("emits pods:create_dialog:close with whether a name was typed", () => {
    trackPodCreateDialogClose({ hasName: true });

    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "create_dialog",
      action: "close",
      extra: { has_name: true },
    });
  });

  it("emits pods:onboarding_start:click with the pod id", () => {
    trackPodOnboardingStart({ podId: "pod_1", isEditor: false });

    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "onboarding_start",
      action: "click",
      extra: { pod_id: "pod_1", is_editor: false },
    });
  });

  it("emits pods:suggestions:select on accept all", () => {
    trackPodSuggestionsBulk({
      podId: "pod_1",
      decision: "accept",
      taskIds: ["t1", "t2"],
      onboardingTaskCount: 2,
    });

    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "suggestions",
      action: "select",
      extra: {
        pod_id: "pod_1",
        task_ids: "t1,t2",
        task_count: 2,
        onboarding_task_count: 2,
      },
    });
  });

  it("emits pods:suggestions:dismiss on dismiss all", () => {
    trackPodSuggestionsBulk({
      podId: "pod_1",
      decision: "dismiss",
      taskIds: ["t1"],
      onboardingTaskCount: 0,
    });

    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "suggestions",
      action: "dismiss",
      extra: {
        pod_id: "pod_1",
        task_ids: "t1",
        task_count: 1,
        onboarding_task_count: 0,
      },
    });
  });

  it("emits pods:suggestion:select on a single accept", () => {
    trackPodSuggestionAccept({
      podId: "pod_1",
      taskId: "t1",
      isOnboardingTask: true,
    });

    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "suggestion",
      action: "select",
      extra: { pod_id: "pod_1", task_id: "t1", is_onboarding_task: true },
    });
  });

  it("emits pods:task:submit without the task text", () => {
    trackPodTaskAdd({ podId: "pod_1", assignee: "self" });

    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "task",
      action: "submit",
      extra: { pod_id: "pod_1", assignee: "self" },
    });
  });

  it("maps the assignee to self, other or none", () => {
    expect(podTaskAssignee(null, "u1")).toBe("none");
    expect(podTaskAssignee("u1", "u1")).toBe("self");
    expect(podTaskAssignee("u2", "u1")).toBe("other");
  });

  it("emits pods:task_start:click with the task id", () => {
    trackPodTaskStart({
      podId: "pod_1",
      taskId: "t1",
      isOnboardingTask: true,
      isFirstOnboardingTask: true,
      goToConversation: true,
    });

    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "task_start",
      action: "click",
      extra: {
        pod_id: "pod_1",
        task_id: "t1",
        is_onboarding_task: true,
        is_first_onboarding_task: true,
        go_to_conversation: true,
      },
    });
  });

  it("emits pods:tab:select with the tab kind, never a file path", () => {
    trackPodTabSelect({ podId: "pod_1", tab: "frame:reports/q3-plan.html" });

    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "tab",
      action: "select",
      extra: { pod_id: "pod_1", tab: "file_tab" },
    });
    expect(podTabKind("tasks")).toBe("tasks");
  });

  it("emits pods:browse:open", () => {
    trackPodsBrowseOpen();

    expect(trackEventMock).toHaveBeenCalledWith({
      area: "pods",
      object: "browse",
      action: "open",
      extra: undefined,
    });
  });
});
