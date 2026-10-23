import {
  podTaskAssignee,
  trackPodTaskAdd,
} from "@app/components/pod/podTracking";
import { AddTaskComposer } from "@app/components/pod/tasks/AddTaskComposer";
import { usePodTasksPanel } from "@app/components/pod/tasks/PodTasksPanelContext";
import { Spinner } from "@dust-tt/sparkle";
import { Trans } from "@lingui/react/macro";

export function PodTaskCreateBar() {
  const {
    viewerUserId,
    podMembers,
    isReadOnly,
    isPodInfoLoading,
    defaultNewAssigneeId,
    handleAddTask,
    podId,
  } = usePodTasksPanel();

  const handleAdd = (text: string, assigneeId: string | null) => {
    trackPodTaskAdd({
      podId,
      assignee: podTaskAssignee(assigneeId, viewerUserId),
    });
    return handleAddTask(text, assigneeId);
  };

  if (isReadOnly) {
    return null;
  }

  if (isPodInfoLoading) {
    return (
      <div className="flex h-7 items-center">
        <Spinner size="sm" />
      </div>
    );
  }

  if (podMembers.length === 0 || !defaultNewAssigneeId) {
    return (
      <p className="text-sm text-muted-foreground">
        <Trans>No Pod members available to assign.</Trans>
      </p>
    );
  }

  return (
    <AddTaskComposer
      podMembers={podMembers}
      viewerUserId={viewerUserId}
      defaultAssigneeId={defaultNewAssigneeId}
      onAdd={handleAdd}
    />
  );
}
