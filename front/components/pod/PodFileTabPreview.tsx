import { ThinComposer } from "@app/components/assistant/conversation/input_bar/ThinComposer";
import { FilePreviewBody } from "@app/components/file_explorer/FilePreviewBody";
import { useFilePreviewContent } from "@app/components/file_explorer/FilePreviewContent";
import { MarkdownFilePreviewViewModeSwitch } from "@app/components/file_explorer/MarkdownFilePreview";
import type { FileEntry } from "@app/components/file_explorer/types";
import type { MarkdownFileEditor } from "@app/components/file_explorer/useMarkdownFileEditor";
import { useMarkdownFileEditor } from "@app/components/file_explorer/useMarkdownFileEditor";
import { MissingPodFileTabCallout } from "@app/components/pod/MissingPodFileTabCallout";
import {
  getFilePathDownloadUrl,
  getFilePathViewUrl,
  useFileMetadataFromPath,
} from "@app/lib/swr/files";
import { contentTypeFromFileName } from "@app/types/files";
import { resolveCanonicalScopedPath } from "@app/types/mount_path";
import type { LightWorkspaceType } from "@app/types/user";
import { Button, cn, Spinner } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";

interface PodFileTabPreviewProps {
  owner: LightWorkspaceType;
  podId: string;
  filePath: string;
}

function usePodFileTabEntry({
  owner,
  filePath,
}: {
  owner: LightWorkspaceType;
  filePath: string;
}) {
  const { metadata, isFileMetadataLoading, isFileMetadataNotFound } =
    useFileMetadataFromPath({
      owner,
      filePath,
    });

  const fileName = filePath.split("/").pop() ?? filePath;
  const contentType =
    metadata?.contentType ??
    contentTypeFromFileName(fileName) ??
    "application/octet-stream";

  const entry: FileEntry | null = useMemo(() => {
    if (isFileMetadataNotFound) {
      return null;
    }
    return {
      kind: "file",
      isDirectory: false,
      fileName,
      path: filePath,
      contentType,
      fileId: metadata?.fileId ?? null,
      thumbnailUrl: null,
      sizeBytes: metadata?.sizeBytes ?? 0,
      lastModifiedMs: 0,
    };
  }, [
    contentType,
    fileName,
    filePath,
    isFileMetadataNotFound,
    metadata?.fileId,
    metadata?.sizeBytes,
  ]);

  return { entry, isFileMetadataLoading, isFileMetadataNotFound };
}

/**
 * Full-height preview for a non-frame Pod tab. Reuses the file preview stack so
 * markdown and other previewable files behave the same as in the side panel,
 * including the live editor when the path is writable.
 */
export function PodFileTabPreview({
  owner,
  podId,
  filePath,
}: PodFileTabPreviewProps) {
  const [documentControls, setDocumentControls] =
    useState<HTMLDivElement | null>(null);
  const [documentStatus, setDocumentStatus] = useState<HTMLSpanElement | null>(
    null
  );

  const { entry, isFileMetadataLoading, isFileMetadataNotFound } =
    usePodFileTabEntry({ owner, filePath });

  const fileUrl = getFilePathViewUrl(owner, filePath);

  const preview = useFilePreviewContent({
    entry,
    fileUrl,
    enabled: !!entry,
  });

  const markdown = useMarkdownFileEditor({
    category: preview.category,
    entryPath: filePath,
    fileUrl,
    isActive: !!entry,
    isContentLoading: preview.isContentLoading,
    isTooLarge: preview.isTooLarge,
    isTruncated: preview.isTruncated,
    canWrite: preview.canWrite,
    owner,
    rawContent: preview.truncatedContent,
    processedContent: preview.processedContent,
  });

  if (isFileMetadataLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (isFileMetadataNotFound || !entry) {
    return <MissingPodFileTabCallout path={filePath} />;
  }

  const hasHeader = markdown.canEdit || !!markdown.richEditor;
  const documentPath = resolveCanonicalScopedPath(filePath, {
    conversationId: null,
    spaceId: podId,
  });

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden p-2">
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-xl ring-1 ring-border/60">
        {hasHeader && (
          <PodFileTabPreviewHeader
            entryPath={entry.path}
            markdown={markdown}
            onDocumentStatusRef={setDocumentStatus}
            onDocumentControlsRef={setDocumentControls}
          />
        )}
        <div
          className={cn(
            "min-h-0 flex-1 p-4",
            preview.category === "markdown"
              ? "flex flex-col overflow-hidden"
              : "overflow-y-auto"
          )}
        >
          <FilePreviewBody
            download={{ href: getFilePathDownloadUrl(owner, filePath) }}
            entry={entry}
            fileUrl={fileUrl}
            isFullWidth
            markdown={markdown}
            markdownHeaderControlsContainer={documentControls}
            markdownStatusContainer={documentStatus}
            onMarkdownViewModeChange={markdown.setViewMode}
            owner={owner}
            preview={preview}
          />
        </div>
        {markdown.richEditor && documentPath && (
          <ThinComposer
            owner={owner}
            podId={podId}
            documentPath={documentPath}
          />
        )}
      </div>
    </div>
  );
}

interface PodFileTabPreviewHeaderProps {
  entryPath: string;
  markdown: MarkdownFileEditor;
  onDocumentStatusRef: (element: HTMLSpanElement | null) => void;
  onDocumentControlsRef: (element: HTMLDivElement | null) => void;
}

function PodFileTabPreviewHeader({
  entryPath,
  markdown,
  onDocumentStatusRef,
  onDocumentControlsRef,
}: PodFileTabPreviewHeaderProps) {
  const { t } = useLingui();

  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
      <div className="flex items-center gap-2">
        {markdown.canEdit &&
          !markdown.richEditor &&
          markdown.collabViewMode !== "source" && (
            <MarkdownFilePreviewViewModeSwitch
              key={entryPath}
              viewMode={markdown.viewMode}
              onViewModeChange={markdown.setViewMode}
            />
          )}
        <span ref={onDocumentStatusRef} className="flex empty:hidden" />
      </div>
      <div className="flex items-center gap-2">
        {markdown.canEdit && !markdown.richEditor && (
          <>
            <Button
              label={t`Save`}
              variant="highlight"
              size="sm"
              isLoading={markdown.isSaving}
              disabled={!markdown.isDirty || markdown.isSaving}
              onClick={() => void markdown.save()}
            />
            <Button
              label={t`Revert`}
              variant="outline"
              size="sm"
              disabled={!markdown.isDirty || markdown.isSaving}
              onClick={markdown.revert}
            />
          </>
        )}
        <div ref={onDocumentControlsRef} className="flex empty:hidden" />
      </div>
    </div>
  );
}
