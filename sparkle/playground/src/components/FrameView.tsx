import {
  ArrowUp,
  Breadcrumbs,
  Button,
  ButtonsSwitch,
  ButtonsSwitchList,
  Check,
  Clipboard,
  ClipboardCheck,
  Dialog,
  DialogContainer,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DotsHorizontal,
  Download01,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Edit04,
  Eye,
  Globe01,
  Input,
  LayoutAlt02,
  Link01,
  LinkExternal01,
  Lock01,
  Pin02,
  PopoverContent,
  PopoverRoot,
  PopoverTrigger,
  RefreshCw01,
  ReverseLeft,
  Separator,
  SliderToggle,
  Terminal,
  TextArea,
  Tooltip,
  Trash01,
  Users01,
  useCopyToClipboard,
  useSendNotification,
} from "@dust-tt/sparkle";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ConversationView } from "./ConversationView";
import { PanelLayout, PanelLayoutPanel } from "./PanelLayout";
import {
  mockAgents,
  mockUsers,
  type Agent,
  type Conversation,
  type ConversationItem,
} from "../data";

const locutor = mockUsers[0];
const frameAgent =
  mockAgents.find((agent) => agent.name === "ContentWriter") ?? mockAgents[0];

const SHARE_URL = "https://dust.tt/share/frame/board-q4-report";

// The regular arrow pointer, filled with the highlight color and given a white
// border plus a drop shadow so it reads on the page and on the metric cards.
// The hotspot sits on the arrow tip. oklch is the blue-500 token value; the
// SVG cannot read CSS variables.
const EDIT_CURSOR_SVG =
  "%3Csvg xmlns='http://www.w3.org/2000/svg' width='26' height='26' viewBox='0 0 26 26'%3E%3Cfilter id='s' x='-50%25' y='-50%25' width='200%25' height='200%25'%3E%3CfeDropShadow dx='0' dy='1' stdDeviation='1' flood-opacity='0.35'/%3E%3C/filter%3E%3Cpath d='M5 3l12.5 11.6h-6.2l3.3 6.7-2.6 1.3-3.4-6.8L5 19.6z' fill='oklch(65.39%25 0.1893 252.74)' stroke='white' stroke-width='1.4' stroke-linejoin='round' filter='url(%23s)'/%3E%3C/svg%3E";
const EDIT_CURSOR = `url("data:image/svg+xml,${EDIT_CURSOR_SVG}") 5 3, pointer`;

type FrameMode = "view" | "code";
type ShareScope = "invite" | "workspace" | "public";
type DraftConfirm = "delete" | "validate" | "deactivate";

interface BoardReport {
  title: string;
  period: string;
  summary: string;
  metrics: { label: string; value: string; note: string }[];
  landed: string[];
  risks: string[];
  ask: string;
}

const REPORT: BoardReport = {
  title: "Board Q4 report",
  period: "October 2026",
  summary:
    "Revenue held the plan, pipeline is ahead of the quarter, and the board is asked to approve the Q1 hiring plan.",
  metrics: [
    { label: "Revenue", value: "$4.8M", note: "+18% vs Q3" },
    { label: "Pipeline", value: "$12.1M", note: "Qualified" },
    { label: "Net retention", value: "118%", note: "Trailing twelve months" },
  ],
  landed: [
    "Closed the two enterprise renewals that were open at the Q3 review.",
    "Shipped frame sharing to every workspace on the new plan.",
    "Cut median time to first answer from 6.2s to 4.1s.",
  ],
  risks: [
    "One strategic account is in a procurement pause until January.",
    "Support load grew faster than the team.",
  ],
  ask: "Approve four hires for Q1: two on support, one on sales, one on product.",
};

function buildFrameConversation(agent: Agent): Conversation {
  const now = new Date();
  const start = new Date(now.getTime() - 20 * 60 * 1000);

  const messages: ConversationItem[] = [
    { kind: "section", id: "section-today", label: "Today" },
    {
      kind: "message",
      id: "msg-frame-ask",
      content:
        "Turn the Q4 numbers into a frame I can share with the board. Revenue, what landed, the risks, and the ask.",
      timestamp: new Date(start.getTime() + 2 * 60 * 1000),
      ownerId: locutor.id,
      ownerType: "user",
      type: "user",
      group: {
        id: "g-locutor",
        type: "locutor",
        timestamp: "16:42",
      },
    },
    {
      kind: "message",
      id: "msg-frame-draft",
      markdown: `**Board Q4 report**

The frame is open on the right. It covers revenue, what landed, the risks, and the hiring ask.`,
      timestamp: new Date(start.getTime() + 4 * 60 * 1000),
      ownerId: agent.id,
      ownerType: "agent",
      type: "agent",
      group: {
        id: "g-agent",
        type: "agent",
        name: agent.name,
        timestamp: "16:44",
        completionStatus: "Completed in 8 sec",
        avatar: {
          emoji: agent.emoji,
          backgroundColor: agent.backgroundColor,
        },
      },
      citations: [
        { id: "frame-board-q4", icon: "frame", title: "Board Q4 report" },
      ],
    },
  ];

  return {
    id: "conv-frame-draft",
    title: "Board Q4 report",
    createdAt: start,
    updatedAt: now,
    userParticipants: [locutor.id],
    agentParticipants: [agent.id],
    messages,
    description: "Share the Q4 board report as a frame.",
  };
}

function DirectEditForm({ onSubmit }: { onSubmit: (prompt: string) => void }) {
  const [prompt, setPrompt] = useState("");
  const canSend = prompt.trim().length > 0;

  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) {
          onSubmit(prompt);
        }
      }}
    >
      <Input
        autoFocus
        size="sm"
        variant="borderless"
        placeholder="Ask for a change"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        containerClassName="min-w-0 grow"
      />
      <Button
        type="submit"
        icon={ArrowUp}
        size="xs"
        variant="highlight"
        isRounded
        disabled={!canSend}
        aria-label="Send"
      />
    </form>
  );
}

interface EditableBlockProps {
  id: string;
  isDirectEdit: boolean;
  isOpen: boolean;
  onOpenChange: (id: string | null) => void;
  onSubmit: (id: string, prompt: string) => void;
  className?: string;
  children: ReactNode;
}

function EditableBlock({
  id,
  isDirectEdit,
  isOpen,
  onOpenChange,
  onSubmit,
  className,
  children,
}: EditableBlockProps) {
  if (!isDirectEdit) {
    return <div className={className}>{children}</div>;
  }

  return (
    <PopoverRoot
      open={isOpen}
      onOpenChange={(open) => onOpenChange(open ? id : null)}
    >
      <PopoverTrigger asChild>
        <div
          className={[
            className ?? "",
            // Outline rather than border or ring: it sits outside the box, so
            // the block never shifts when it highlights. The width is always
            // there (v4 width utilities also set the style) and only the color
            // changes, which keeps the highlight animatable.
            "rounded-lg outline-2 outline-offset-4 transition-[outline-color] duration-150 motion-reduce:transition-none",
            // Only one outline color class at a time: these are plain strings,
            // so two of them would leave the winner up to stylesheet order.
            isOpen
              ? "outline-highlight-400"
              : "outline-transparent hover:outline-highlight-200",
          ].join(" ")}
        >
          {children}
        </div>
      </PopoverTrigger>
      <PopoverContent align="start" side="bottom" className="w-[320px] p-1.5">
        <DirectEditForm onSubmit={(prompt) => onSubmit(id, prompt)} />
      </PopoverContent>
    </PopoverRoot>
  );
}

interface BoardReportViewProps {
  report: BoardReport;
  isDirectEdit: boolean;
  editBlockId: string | null;
  onEditBlockChange: (id: string | null) => void;
  onSubmitEdit: (id: string, prompt: string) => void;
}

function BoardReportView({
  report,
  isDirectEdit,
  editBlockId,
  onEditBlockChange,
  onSubmitEdit,
}: BoardReportViewProps) {
  const blockProps = (id: string) => ({
    id,
    isDirectEdit,
    isOpen: editBlockId === id,
    onOpenChange: onEditBlockChange,
    onSubmit: onSubmitEdit,
  });

  return (
    <div
      className="h-full overflow-auto bg-background px-8 py-7"
      style={isDirectEdit ? { cursor: EDIT_CURSOR } : undefined}
    >
      <EditableBlock {...blockProps("header")}>
        <p className="text-xs font-medium text-muted-foreground">
          Board report
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {report.title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{report.period}</p>
      </EditableBlock>
      <EditableBlock {...blockProps("summary")}>
        <p className="mt-4 max-w-xl text-sm leading-6">{report.summary}</p>
      </EditableBlock>
      <div className="mt-6 grid grid-cols-3 gap-3">
        {report.metrics.map((metric) => (
          <EditableBlock
            key={metric.label}
            {...blockProps(`metric-${metric.label}`)}
            className="rounded-xl border px-4 py-3"
          >
            <p className="text-xs text-muted-foreground">{metric.label}</p>
            <p className="mt-1 text-xl font-semibold">{metric.value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{metric.note}</p>
          </EditableBlock>
        ))}
      </div>
      <EditableBlock {...blockProps("landed")}>
        <h2 className="mt-8 text-sm font-semibold">What landed</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6">
          {report.landed.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </EditableBlock>
      <EditableBlock {...blockProps("risks")}>
        <h2 className="mt-6 text-sm font-semibold">Risks</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6">
          {report.risks.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </EditableBlock>
      <EditableBlock {...blockProps("ask")}>
        <h2 className="mt-6 text-sm font-semibold">Ask</h2>
        <p className="mt-2 max-w-xl text-sm leading-6">{report.ask}</p>
      </EditableBlock>
    </div>
  );
}

export function FrameView() {
  const conversation = useMemo(() => buildFrameConversation(frameAgent), []);
  const [isFrameOpen, setIsFrameOpen] = useState(true);
  const [mode, setMode] = useState<FrameMode>("view");
  // Whether a draft exists at all, managed from the Draft menu, and whether
  // the panel shows that draft instead of what everyone else sees.
  const [hasDraft, setHasDraft] = useState(false);
  const [isViewingDraft, setIsViewingDraft] = useState(false);
  const [isDirectEdit, setIsDirectEdit] = useState(false);
  const [editBlockId, setEditBlockId] = useState<string | null>(null);
  // The kind outlives the open state so the dialog keeps its copy while it
  // animates closed.
  const [confirmKind, setConfirmKind] = useState<DraftConfirm>("delete");
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [shareScope, setShareScope] = useState<ShareScope>("workspace");
  const [isPinned, setIsPinned] = useState(false);
  const [isPodTab, setIsPodTab] = useState(false);
  const [isCopied, copyToClipboard] = useCopyToClipboard();
  const sendNotification = useSendNotification();
  const frameCode = useMemo(
    () => `export default function BoardQ4Report() {
  return (
    <main className="frame-root">
      <h1>Board Q4 report</h1>
      <p>Revenue, what landed, the risks, and the hiring ask.</p>
    </main>
  );
}`,
    []
  );
  const frameCodeRows = useMemo(
    () => Math.max(frameCode.split("\n").length, 1),
    [frameCode]
  );

  const handleModeChange = (next: string) => {
    if (next !== "view" && next !== "code") {
      return;
    }
    setMode(next);
    if (next === "code") {
      setIsDirectEdit(false);
      setEditBlockId(null);
    }
  };

  const handleToggleDirectEdit = () => {
    setIsDirectEdit((editing) => !editing);
    setEditBlockId(null);
  };

  // Sending a change ends the editing pass: one prompt, one edit.
  const handleSubmitEdit = () => {
    setEditBlockId(null);
    setIsDirectEdit(false);
  };

  // Escape first closes the open popover (Radix handles that), so leaving edit
  // mode takes a second press once no block is selected.
  useEffect(() => {
    if (!isDirectEdit) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editBlockId) {
        setIsDirectEdit(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isDirectEdit, editBlockId]);

  const openConfirm = (kind: DraftConfirm) => {
    setConfirmKind(kind);
    setIsConfirmOpen(true);
  };

  const handleValidateDraft = () => {
    setHasDraft(false);
    setIsViewingDraft(false);
    sendNotification({ type: "success", title: "Draft validated" });
    setIsConfirmOpen(false);
  };

  const handleDeleteDraft = () => {
    setHasDraft(false);
    setIsViewingDraft(false);
    sendNotification({ type: "success", title: "Draft deleted" });
    setIsConfirmOpen(false);
  };

  // The See Draft toggle only switches which version the panel shows.
  const handleToggleSeeDraft = () => {
    setIsViewingDraft((viewing) => !viewing);
  };

  // The Draft menu owns whether a draft exists. Leaving draft mode has to
  // resolve the draft, so it asks to validate or delete it.
  const handleToggleDraft = () => {
    if (hasDraft) {
      openConfirm("deactivate");
      return;
    }
    setHasDraft(true);
    setIsViewingDraft(true);
  };

  const keepEditing = {
    label: "Keep editing",
    variant: "outline" as const,
    onClick: () => setIsConfirmOpen(false),
  };
  const deleteDraft = {
    label: "Delete draft",
    variant: "warning" as const,
    onClick: handleDeleteDraft,
  };
  const validateDraft = {
    label: "Validate draft",
    variant: "highlight" as const,
    onClick: handleValidateDraft,
  };
  const confirmCopy = {
    validate: {
      title: "Validate this draft?",
      description: "Validate will modify the frame for all users of the frame.",
      left: keepEditing,
      right: validateDraft,
    },
    delete: {
      title: "Delete this draft?",
      description: "Deleting will lose all the changes made in this draft.",
      left: keepEditing,
      right: deleteDraft,
    },
    deactivate: {
      title: "De-activate Draft mode?",
      description:
        "The draft has to be resolved first. Validate it to apply the changes to the frame, or delete it to lose them.",
      left: deleteDraft,
      right: validateDraft,
    },
  }[confirmKind];

  const handleCopyCode = async () => {
    await copyToClipboard(frameCode);
  };

  const handleCopyShareLink = async () => {
    await copyToClipboard(SHARE_URL);
    sendNotification({
      type: "success",
      title: "Link copied",
    });
  };

  const frameActions = (
    <>
      <div
        className={[
          "grid transition-[grid-template-columns,opacity] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none",
          hasDraft
            ? "grid-cols-[1fr] opacity-100"
            : "pointer-events-none grid-cols-[0fr] opacity-0",
        ].join(" ")}
      >
        <div className="overflow-hidden">
          <div className="mr-1 flex items-center rounded-xl border border-border-dark bg-muted-background py-1 pl-2 pr-2">
            <Tooltip
              label={
                isViewingDraft
                  ? "Show the frame everyone sees"
                  : "Show the draft"
              }
              tooltipTriggerAsChild
              trigger={
                // SliderToggle takes neither a ref nor extra props, so the
                // tooltip hangs off a wrapper instead of the toggle itself.
                <span className="flex">
                  <SliderToggle
                    selected={isViewingDraft}
                    onClick={handleToggleSeeDraft}
                  />
                </span>
              }
            />
            <span className="ml-2 whitespace-nowrap text-sm font-medium">
              See Draft
            </span>
            <div
              className={[
                "grid transition-[grid-template-columns,opacity] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none",
                isViewingDraft
                  ? "grid-cols-[1fr] opacity-100"
                  : "pointer-events-none grid-cols-[0fr] opacity-0",
              ].join(" ")}
            >
              <div className="overflow-hidden">
                <div className="flex items-center gap-2 pl-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        aria-label="Draft actions"
                        icon={DotsHorizontal}
                        size="xs"
                        variant="outline"
                      />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem
                        label="Delete draft"
                        icon={Trash01}
                        onClick={() => openConfirm("delete")}
                      />
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    icon={Check}
                    label="Validate"
                    size="xs"
                    variant="highlight"
                    onClick={() => openConfirm("validate")}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <ButtonsSwitchList
        size="sm"
        value={mode}
        onValueChange={handleModeChange}
      >
        <ButtonsSwitch value="view" icon={Eye} tooltip="View" />
        <ButtonsSwitch value="code" icon={Terminal} tooltip="Code" />
      </ButtonsSwitchList>
      <Button
        icon={Edit04}
        size="sm"
        variant={isDirectEdit ? "highlight" : "ghost"}
        tooltip={isDirectEdit ? "Stop editing" : "Edit"}
        aria-label="Edit"
        disabled={mode === "code"}
        onClick={handleToggleDirectEdit}
      />
      <Separator orientation="vertical" className="h-5 self-center" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            icon={Download01}
            size="sm"
            tooltip="Export"
            variant="ghost"
            aria-label="Export"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger label="PDF" />
            <DropdownMenuSubContent>
              <DropdownMenuItem
                label="Portrait"
                onClick={() =>
                  sendNotification({
                    type: "success",
                    title: "Exported as PDF, portrait",
                  })
                }
              />
              <DropdownMenuItem
                label="Landscape"
                onClick={() =>
                  sendNotification({
                    type: "success",
                    title: "Exported as PDF, landscape",
                  })
                }
              />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            label="PNG"
            onClick={() =>
              sendNotification({ type: "success", title: "Exported as PNG" })
            }
          />
          <DropdownMenuItem
            label="Source (.zip)"
            onClick={() =>
              sendNotification({
                type: "success",
                title: "Exported source",
              })
            }
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            icon={Users01}
            size="sm"
            tooltip="Share"
            variant="ghost"
            aria-label="Share"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            label="Copy link"
            icon={Link01}
            onClick={() => {
              void handleCopyShareLink();
            }}
          />
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={shareScope}
            onValueChange={(value) => {
              if (
                value === "invite" ||
                value === "workspace" ||
                value === "public"
              ) {
                setShareScope(value);
              }
            }}
          >
            <DropdownMenuLabel label="Who has access" />
            <DropdownMenuRadioItem
              value="invite"
              label="Invite only"
              icon={Lock01}
            />
            <DropdownMenuRadioItem
              value="workspace"
              label="All workspace members + invites"
              icon={Users01}
            />
            <DropdownMenuRadioItem
              value="public"
              label="Anyone with the link"
              icon={Globe01}
            />
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="More actions"
            icon={DotsHorizontal}
            size="sm"
            variant="ghost"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            label="Revert the last change"
            icon={ReverseLeft}
            onClick={() =>
              sendNotification({
                type: "success",
                title: "Reverted the last change",
              })
            }
          />
          <DropdownMenuSeparator />
          <DropdownMenuLabel label="Draft" />
          <DropdownMenuItem
            label={hasDraft ? "De-activate Draft mode" : "Activate Draft mode"}
            onClick={handleToggleDraft}
          />
          {hasDraft ? (
            <p className="w-[240px] px-2 pb-2 text-xs font-semibold text-foreground">
              One draft ongoing
            </p>
          ) : (
            <p className="w-[240px] px-2 pb-2 text-xs font-normal text-muted-foreground">
              Your changes stay hidden from other members until you validate the
              draft.
            </p>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            label={isPinned ? "Unpin from Pod banner" : "Pin as Pod banner"}
            icon={Pin02}
            onClick={() => {
              setIsPinned((pinned) => !pinned);
              sendNotification({
                type: "success",
                title: isPinned
                  ? "Unpinned from Pod banner"
                  : "Pinned as Pod banner",
              });
            }}
          />
          <DropdownMenuItem
            label={isPodTab ? "Remove from Pod tabs" : "Add as Pod tab"}
            icon={LayoutAlt02}
            onClick={() => {
              setIsPodTab((added) => !added);
              sendNotification({
                type: "success",
                title: isPodTab ? "Removed from Pod tabs" : "Added as Pod tab",
              });
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <Separator orientation="vertical" className="h-5 self-center" />
      <Button
        icon={LinkExternal01}
        size="sm"
        tooltip="Open in a new tab"
        variant="ghost"
        onClick={() =>
          sendNotification({
            type: "success",
            title: "Opened in a new tab",
          })
        }
      />
      <Button icon={RefreshCw01} size="sm" tooltip="Refresh" variant="ghost" />
    </>
  );

  return (
    <>
      <PanelLayout>
        <PanelLayoutPanel
          label="Board Q4 report"
          isOpen
          onClose={() => {}}
          topBarLeft={
            <Breadcrumbs
              items={[{ label: "Board Q4 report" }]}
              size="sm"
              hasLighterFont
            />
          }
        >
          <ConversationView
            conversation={conversation}
            locutor={locutor}
            users={mockUsers}
            agents={[frameAgent]}
            conversationsWithMessages={[]}
            conversationTitle="Board Q4 report"
            onCitationOpen={() => setIsFrameOpen(true)}
          />
        </PanelLayoutPanel>
        <PanelLayoutPanel
          label="Board Q4 report"
          sizingType="shared"
          fullscreenEnabled
          isOpen={isFrameOpen}
          onClose={() => setIsFrameOpen(false)}
          topBarLeft={
            <Breadcrumbs
              items={[{ label: "Board Q4 report" }]}
              size="sm"
              hasLighterFont
            />
          }
          topBarRight={frameActions}
        >
          <div className="relative h-full min-h-0 w-full">
            <div
              className={[
                "h-full w-full bg-info transition-[padding] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none",
                isViewingDraft ? "p-[6px]" : "p-0",
              ].join(" ")}
            >
              <div
                className={[
                  "h-full w-full overflow-hidden bg-background transition-[border-radius] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none",
                  isViewingDraft ? "rounded-lg" : "rounded-none",
                ].join(" ")}
              >
                {mode === "code" ? (
                  <div className="flex h-full flex-col gap-3 overflow-auto bg-background p-4">
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant="outline"
                        icon={isCopied ? ClipboardCheck : Clipboard}
                        label={isCopied ? "Copied" : "Copy to clipboard"}
                        onClick={() => {
                          void handleCopyCode();
                        }}
                      />
                    </div>
                    <TextArea value={frameCode} rows={frameCodeRows} readOnly />
                  </div>
                ) : (
                  <BoardReportView
                    report={REPORT}
                    isDirectEdit={isDirectEdit}
                    editBlockId={editBlockId}
                    onEditBlockChange={setEditBlockId}
                    onSubmitEdit={handleSubmitEdit}
                  />
                )}
              </div>
            </div>
            <div
              aria-hidden={!isViewingDraft}
              className={[
                "absolute right-0 top-0 z-10 rounded-bl-lg bg-info px-2 py-1 text-xs font-medium text-golden-950 transition-[opacity,translate] duration-[260ms] ease-[cubic-bezier(.4,0,.2,1)] motion-reduce:transition-none",
                isViewingDraft
                  ? "translate-y-0 opacity-100"
                  : "pointer-events-none -translate-y-2 opacity-0",
              ].join(" ")}
            >
              Draft
            </div>
          </div>
        </PanelLayoutPanel>
      </PanelLayout>
      <Dialog
        open={isConfirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsConfirmOpen(false);
          }
        }}
      >
        <DialogContent size="md">
          <DialogHeader>
            <DialogTitle>{confirmCopy.title}</DialogTitle>
          </DialogHeader>
          <DialogContainer>
            <DialogDescription className="text-foreground">
              {confirmCopy.description}
            </DialogDescription>
          </DialogContainer>
          <DialogFooter
            leftButtonProps={confirmCopy.left}
            rightButtonProps={confirmCopy.right}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
