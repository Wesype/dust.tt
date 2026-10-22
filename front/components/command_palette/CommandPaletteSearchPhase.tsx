import {
  ItemEmptyState,
  ItemRow,
  ItemTitle,
  KeyboardHints,
} from "@app/components/command_palette/CommandPaletteItems";
import { useItemRowSelected } from "@app/components/command_palette/CommandPaletteItems";
import { MIN_COMMAND_PALETTE_SEARCH_LENGTH } from "@app/components/command_palette/useCommandPaletteSearch";
import type { AdminSectionId } from "@app/lib/admin/adminSectionIds";
import {
  getAgentDisplayDescription,
  getSkillDisplayDescription,
} from "@app/lib/dust_provided_descriptions";
import { getSkillAvatarIcon } from "@app/lib/skill";
import { getSpaceIcon } from "@app/lib/spaces";
import type { AgentSearchListItemType } from "@app/types/agent_search/agent_search";
import type { LightAgentConfigurationType } from "@app/types/assistant/agent";
import type { ConversationListItemType } from "@app/types/assistant/conversation";
import { getConversationDisplayTitle } from "@app/types/assistant/conversation";
import type {
  SkillListItemType,
  SkillWithoutInstructionsAndToolsType,
} from "@app/types/assistant/skill_configuration";
import { assertNever } from "@app/types/shared/utils/assert_never";
import type { PodListItemType } from "@app/types/space";
import type { LightUserTypeWithWorkspace } from "@app/types/user";
import {
  Avatar,
  Chip,
  FilterChip,
  HoverScrollText,
  Icon,
  LoadingBlock,
  MessageCircle01,
  MessagePlusCircle,
  Plus,
  SearchInput,
  Settings01,
} from "@dust-tt/sparkle";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type React from "react";
import { useEffect, useMemo, useRef } from "react";

export type CommandPaletteCategory =
  | "Conversations"
  | "Pods"
  | "Agents"
  | "Members"
  | "Skills"
  | "Settings";
export type CommandPaletteFilter = "All" | CommandPaletteCategory;

const ACCESSIBLE_CATEGORY_ORDER: CommandPaletteCategory[] = [
  "Conversations",
  "Pods",
  "Agents",
  "Skills",
  "Members",
  "Settings",
];

const FILTER_LABELS: Record<CommandPaletteFilter, MessageDescriptor> = {
  All: msg`All`,
  Conversations: msg`Conversations`,
  Pods: msg`Pods`,
  Agents: msg`Agents`,
  Members: msg`Members`,
  Skills: msg`Skills`,
  Settings: msg`Settings`,
};

/** Stable empty list so category filters don't invalidate memos every render. */
const NO_ITEMS: never[] = [];

type CommandPaletteSkill =
  | SkillListItemType
  | SkillWithoutInstructionsAndToolsType;

type CommandPaletteAgent =
  | LightAgentConfigurationType
  | AgentSearchListItemType;

type CommandPalettePod = PodListItemType;

type CommandPaletteConversation = ConversationListItemType & {
  spaceName: string | null;
};

export type CommandPaletteMember = LightUserTypeWithWorkspace;

export type CommandPaletteSetting = {
  label: string;
  pageLabel: string;
  pageHref: string;
  sectionId: AdminSectionId;
  tab?: string;
};

export type CommandPaletteDefaultAction =
  | "new_conversation_in_pod"
  | "new_conversation"
  | "new_pod";

export type CommandPaletteItem =
  | { kind: "action"; action: CommandPaletteDefaultAction }
  | { kind: "agent"; agent: CommandPaletteAgent }
  | { kind: "conversation"; conversation: CommandPaletteConversation }
  | { kind: "member"; member: CommandPaletteMember }
  | { kind: "pod"; pod: CommandPalettePod }
  | { kind: "setting"; setting: CommandPaletteSetting }
  | { kind: "skill"; skill: CommandPaletteSkill };

export function getCommandPaletteItemKey(item: CommandPaletteItem): string {
  switch (item.kind) {
    case "action":
      return `action:${item.action}`;
    case "agent":
      return `agent:${item.agent.sId}`;
    case "conversation":
      return `conversation:${item.conversation.sId}`;
    case "member":
      return `member:${item.member.sId}`;
    case "pod":
      return `pod:${item.pod.sId}`;
    case "setting":
      return `setting:${item.setting.pageHref}#${item.setting.sectionId}:${item.setting.label}`;
    case "skill":
      return `skill:${item.skill.sId}`;
    default:
      assertNever(item);
  }
}

export interface CommandPaletteActionOptions {
  /** Agents get no actions phase: selecting one only starts a conversation. */
  hideAgentActions: boolean;
  /** Skills get no actions phase: selecting one only adds it to the message. */
  hideSkillActions: boolean;
  /** Members get no actions phase: selecting one only starts a conversation. */
  hideMemberActions: boolean;
}

/** True when Right arrow / the row chevron should open the actions phase. */
export function commandPaletteItemHasActions(
  item: CommandPaletteItem,
  {
    hideAgentActions,
    hideSkillActions,
    hideMemberActions,
  }: CommandPaletteActionOptions
): item is Extract<
  CommandPaletteItem,
  { kind: "agent" | "member" | "skill" | "pod" }
> {
  switch (item.kind) {
    case "agent":
      return !hideAgentActions;
    case "member":
      return !hideMemberActions;
    case "pod":
      return true;
    case "skill":
      return !hideSkillActions;
    case "action":
    case "conversation":
    case "setting":
      return false;
    default:
      assertNever(item);
  }
}

interface CommandPaletteSearchPhaseProps {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  agents: CommandPaletteAgent[];
  conversations: CommandPaletteConversation[];
  members: CommandPaletteMember[];
  pods: CommandPalettePod[];
  skills: CommandPaletteSkill[];
  settings: CommandPaletteSetting[];
  /** Top frecency-ranked items to show when the query is empty and All is selected. */
  frequentItems: CommandPaletteItem[];
  /** When set, include "Create new conversation in pod" in the empty-All defaults. */
  activePodId: string | null;
  hasMoreAgents: boolean;
  hasMoreConversations: boolean;
  hasMoreMembers: boolean;
  hasMorePods: boolean;
  hasMoreSkills: boolean;
  hasMoreSettings: boolean;
  canSearchSettings: boolean;
  actionOptions: CommandPaletteActionOptions;
  selectedCategory: CommandPaletteFilter;
  onSelectedCategoryChange: (category: CommandPaletteFilter) => void;
  isLoading: boolean;
  selectedIndex: number;
  onSelectedIndexChange: (index: number) => void;
  onItemSelect: (item: CommandPaletteItem) => void;
  onOpenActions: (item: CommandPaletteItem) => void;
}

interface ItemTextProps {
  primary: string;
  secondary?: string | null;
}

/**
 * The row's text: the name keeps its full width (it only truncates when it alone does not fit),
 * and the muted description takes the rest, truncated at rest and scrolled to its end while the
 * row is selected, like sidebar labels (`HoverScrollText`).
 */
function ItemText({ primary, secondary }: ItemTextProps) {
  const isSelected = useItemRowSelected();
  return (
    <div className="flex min-w-0 grow items-center gap-1.5">
      <span className="max-w-full shrink-0 truncate font-medium">
        {primary}
      </span>
      {secondary && (
        <HoverScrollText
          isActive={isSelected}
          className="grow text-muted-foreground"
          text={secondary}
        />
      )}
    </div>
  );
}

function CommandPaletteItemContent({ item }: { item: CommandPaletteItem }) {
  const { t } = useLingui();

  switch (item.kind) {
    case "action": {
      switch (item.action) {
        case "new_conversation_in_pod":
          return (
            <>
              <Icon visual={MessagePlusCircle} size="xs" />
              <span className="font-medium">
                {t`Create new conversation in pod`}
              </span>
            </>
          );
        case "new_conversation":
          return (
            <>
              <Icon visual={MessagePlusCircle} size="xs" />
              <span className="font-medium">{t`Create new conversation`}</span>
            </>
          );
        case "new_pod":
          return (
            <>
              <Icon visual={Plus} size="xs" />
              <span className="font-medium">{t`Create new Pod`}</span>
            </>
          );
        default:
          assertNever(item.action);
      }
    }
    case "conversation":
      return (
        <>
          <Icon visual={MessageCircle01} size="xs" />
          <ItemText
            primary={getConversationDisplayTitle(item.conversation)}
            secondary={item.conversation.spaceName}
          />
        </>
      );
    case "pod":
      return (
        <>
          <Icon visual={getSpaceIcon(item.pod)} size="xs" />
          <ItemText primary={item.pod.name} secondary={item.pod.description} />
          {/* The text grows, which pushes the chip to the row's right edge,
              just before the actions arrow. */}
          {!item.pod.isMember && (
            <Chip label={t`Not a member`} size="xs" color="primary" />
          )}
        </>
      );
    case "agent":
      return (
        <>
          <Avatar visual={item.agent.pictureUrl} size="3xs" />
          <ItemText
            primary={item.agent.name}
            secondary={getAgentDisplayDescription(t, item.agent)}
          />
        </>
      );
    case "member":
      return (
        <>
          <Avatar
            name={item.member.fullName}
            visual={item.member.image ?? undefined}
            size="3xs"
            isRounded
          />
          <ItemText
            primary={item.member.fullName}
            secondary={item.member.email}
          />
        </>
      );
    case "skill": {
      const SkillAvatar = getSkillAvatarIcon(item.skill);
      return (
        <>
          <SkillAvatar size="3xs" />
          <ItemText
            primary={item.skill.name}
            secondary={getSkillDisplayDescription(t, item.skill)}
          />
        </>
      );
    }
    case "setting":
      return (
        <>
          <Icon visual={Settings01} size="xs" />
          <ItemText
            primary={item.setting.label}
            secondary={item.setting.pageLabel}
          />
        </>
      );
    default:
      assertNever(item);
  }
}

/**
 * @cc [owner:ClementAupiais,label:product;react] flat-items-follow-category-order
 * The concatenation order here MUST be `ACCESSIBLE_CATEGORY_ORDER` (Conversations, Pods, Agents,
 * Skills, Members, Settings), and the result sections MUST render in that same order with
 * matching `*Offset` values: `selectedIndex` indexes this flat list and the rendered rows alike,
 * so any mismatch moves keyboard selection onto the wrong row.
 */
function getFlatItems(
  conversations: CommandPaletteConversation[],
  pods: CommandPalettePod[],
  agents: CommandPaletteAgent[],
  skills: CommandPaletteSkill[],
  members: CommandPaletteMember[],
  settings: CommandPaletteSetting[]
): CommandPaletteItem[] {
  return [
    ...conversations.map((conversation): CommandPaletteItem => ({
      kind: "conversation",
      conversation,
    })),
    ...pods.map((pod): CommandPaletteItem => ({ kind: "pod", pod })),
    ...agents.map((agent): CommandPaletteItem => ({ kind: "agent", agent })),
    ...skills.map((skill): CommandPaletteItem => ({ kind: "skill", skill })),
    ...members.map((member): CommandPaletteItem => ({
      kind: "member",
      member,
    })),
    ...settings.map((setting): CommandPaletteItem => ({
      kind: "setting",
      setting,
    })),
  ];
}

function getAvailableCategories({
  agents,
  skills,
  members,
  pods,
  conversations,
  settings,
}: {
  agents: CommandPaletteAgent[];
  skills: CommandPaletteSkill[];
  members: CommandPaletteMember[];
  pods: CommandPalettePod[];
  conversations: CommandPaletteConversation[];
  settings: CommandPaletteSetting[];
}): CommandPaletteCategory[] {
  const categories: CommandPaletteCategory[] = [];
  if (conversations.length > 0) {
    categories.push("Conversations");
  }
  if (pods.length > 0) {
    categories.push("Pods");
  }
  if (agents.length > 0) {
    categories.push("Agents");
  }
  if (skills.length > 0) {
    categories.push("Skills");
  }
  if (members.length > 0) {
    categories.push("Members");
  }
  if (settings.length > 0) {
    categories.push("Settings");
  }
  return categories;
}

export function CommandPaletteSearchPhase({
  searchQuery,
  onSearchQueryChange,
  agents,
  conversations,
  members,
  pods,
  skills,
  settings,
  frequentItems,
  activePodId,
  hasMoreAgents,
  hasMoreConversations,
  hasMoreMembers,
  hasMorePods,
  hasMoreSkills,
  hasMoreSettings,
  canSearchSettings,
  actionOptions,
  selectedCategory,
  onSelectedCategoryChange,
  isLoading,
  selectedIndex,
  onSelectedIndexChange,
  onItemSelect,
  onOpenActions,
}: CommandPaletteSearchPhaseProps) {
  const { t } = useLingui();
  const trimmedQuery = searchQuery.trim();
  const isEmptyQuery = trimmedQuery.length === 0;
  const isQueryTooShort =
    trimmedQuery.length > 0 &&
    trimmedQuery.length < MIN_COMMAND_PALETTE_SEARCH_LENGTH;
  const isSearchQueryReady =
    trimmedQuery.length >= MIN_COMMAND_PALETTE_SEARCH_LENGTH;

  const accessibleCategories = useMemo((): CommandPaletteCategory[] => {
    return ACCESSIBLE_CATEGORY_ORDER.filter(
      (category) => category !== "Settings" || canSearchSettings
    );
  }, [canSearchSettings]);

  const filters = useMemo(
    (): CommandPaletteFilter[] => ["All", ...accessibleCategories],
    [accessibleCategories]
  );

  // If Settings was preselected but the user isn't an admin, fall back to All.
  const effectiveSelectedCategory: CommandPaletteFilter = filters.includes(
    selectedCategory
  )
    ? selectedCategory
    : "All";

  const categoriesWithResults = useMemo(
    () =>
      getAvailableCategories({
        agents,
        skills,
        members,
        pods,
        conversations,
        settings,
      }),
    [agents, skills, members, pods, conversations, settings]
  );

  const hasSearchResults = categoriesWithResults.length > 0;

  // While typing, keep every accessible chip visible but disable those with no
  // hits (except the selected chip, which stays clickable).
  const disabledFilters = useMemo((): CommandPaletteFilter[] => {
    if (isEmptyQuery) {
      return [];
    }
    return filters.filter((filter) => {
      if (filter === effectiveSelectedCategory) {
        return false;
      }
      if (filter === "All") {
        return !hasSearchResults;
      }
      return !categoriesWithResults.includes(filter);
    });
  }, [
    isEmptyQuery,
    filters,
    effectiveSelectedCategory,
    hasSearchResults,
    categoriesWithResults,
  ]);

  const filteredConversations =
    effectiveSelectedCategory === "All" ||
    effectiveSelectedCategory === "Conversations"
      ? conversations
      : NO_ITEMS;
  const filteredPods =
    effectiveSelectedCategory === "All" || effectiveSelectedCategory === "Pods"
      ? pods
      : NO_ITEMS;
  const filteredAgents =
    effectiveSelectedCategory === "All" ||
    effectiveSelectedCategory === "Agents"
      ? agents
      : NO_ITEMS;
  const filteredMembers =
    effectiveSelectedCategory === "All" ||
    effectiveSelectedCategory === "Members"
      ? members
      : NO_ITEMS;
  const filteredSkills =
    effectiveSelectedCategory === "All" ||
    effectiveSelectedCategory === "Skills"
      ? skills
      : NO_ITEMS;
  const filteredSettings =
    effectiveSelectedCategory === "All" ||
    effectiveSelectedCategory === "Settings"
      ? settings
      : NO_ITEMS;

  const searchFlatItems = useMemo(
    () =>
      getFlatItems(
        filteredConversations,
        filteredPods,
        filteredAgents,
        filteredSkills,
        filteredMembers,
        filteredSettings
      ),
    [
      filteredConversations,
      filteredPods,
      filteredAgents,
      filteredSkills,
      filteredMembers,
      filteredSettings,
    ]
  );

  // Empty query + All: default create actions above frecency suggestions.
  const defaultActions = useMemo((): CommandPaletteItem[] => {
    if (!isEmptyQuery || effectiveSelectedCategory !== "All") {
      return [];
    }
    const actions: CommandPaletteItem[] = [];
    if (activePodId) {
      actions.push({ kind: "action", action: "new_conversation_in_pod" });
    }
    actions.push({ kind: "action", action: "new_conversation" });
    actions.push({ kind: "action", action: "new_pod" });
    return actions;
  }, [isEmptyQuery, effectiveSelectedCategory, activePodId]);

  const flatItems =
    isEmptyQuery && effectiveSelectedCategory === "All"
      ? [...defaultActions, ...frequentItems]
      : isSearchQueryReady
        ? searchFlatItems
        : [];
  const showCategoryCta = isEmptyQuery && effectiveSelectedCategory !== "All";
  const showFrequentItems =
    isEmptyQuery &&
    effectiveSelectedCategory === "All" &&
    frequentItems.length > 0;
  const showDefaultActions = defaultActions.length > 0;
  const showQueryTooShortHint = isQueryTooShort;

  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the search input on mount. Deferred with requestAnimationFrame
  // to run after Radix FocusScope has finished trapping focus.
  useEffect(() => {
    const frameId = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frameId);
  }, []);

  // Scroll selected item into view. Guard against selectedIndex being
  // transiently out-of-bounds on the render cycle before the reset effect fires.
  useEffect(() => {
    if (selectedIndex < flatItems.length) {
      itemRefs.current[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, flatItems.length]);

  // Keep keyboard selection valid when the result list shrinks (e.g. typing).
  useEffect(() => {
    itemRefs.current.length = flatItems.length;
    onSelectedIndexChange(0);
  }, [flatItems.length, onSelectedIndexChange]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    const totalItems = flatItems.length;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (totalItems > 0) {
          onSelectedIndexChange((selectedIndex + 1) % totalItems);
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (totalItems > 0) {
          onSelectedIndexChange((selectedIndex - 1 + totalItems) % totalItems);
        }
        break;
      case "Enter":
        e.preventDefault();
        if (flatItems[selectedIndex]) {
          onItemSelect(flatItems[selectedIndex]);
        }
        break;
      case "ArrowRight": {
        const item = flatItems[selectedIndex];
        if (item && commandPaletteItemHasActions(item, actionOptions)) {
          e.preventDefault();
          onOpenActions(item);
        }
        break;
      }
    }
  }

  // Same order as `getFlatItems` (see `flat-items-follow-category-order`).
  const conversationsOffset = 0;
  const podsOffset = conversationsOffset + filteredConversations.length;
  const agentsOffset = podsOffset + filteredPods.length;
  const skillsOffset = agentsOffset + filteredAgents.length;
  const membersOffset = skillsOffset + filteredSkills.length;
  const settingsOffset = membersOffset + filteredMembers.length;

  const queryTooShortHint = t`Type to search.`;

  const categoryCtaHint = (() => {
    switch (effectiveSelectedCategory) {
      case "Conversations":
        return t`Type to search conversations.`;
      case "Pods":
        return t`Type to search pods.`;
      case "Agents":
        return t`Type to search agents.`;
      case "Members":
        return t`Type to search members.`;
      case "Skills":
        return t`Type to search skills.`;
      case "Settings":
        return t`Type to search settings.`;
      case "All":
        return t`Type to search.`;
    }
  })();

  return (
    <div className="flex flex-col">
      {/* 6px side padding + the md field's 12px icon inset puts the search
          icon at the same 18px x as row icons (6px list padding + 12px row
          padding). */}
      <div className="px-1.5 py-3">
        <SearchInput
          ref={searchInputRef}
          name="command-palette-search"
          placeholder={t`Search…`}
          value={searchQuery}
          onChange={onSearchQueryChange}
          onKeyDown={handleKeyDown}
          size="md"
          variant="borderless"
          iconPosition="left"
        />
        {/* One chip per category and no "All" chip: clicking the selected
            chip again clears the filter back to "All". */}
        <div className="scrollbar-hide flex flex-row gap-2 overflow-x-auto px-1.5 pt-2">
          {accessibleCategories.map((category) => {
            const isSelected = category === effectiveSelectedCategory;
            return (
              <FilterChip
                key={category}
                label={t(FILTER_LABELS[category])}
                isSelected={isSelected}
                disabled={disabledFilters.includes(category)}
                variant="secondary"
                onClick={() => {
                  onSelectedCategoryChange(isSelected ? "All" : category);
                  onSelectedIndexChange(0);
                }}
              />
            );
          })}
        </div>
      </div>
      {/* Capped at 500px, and on short viewports at the dialog's 90vh minus
          the search field, chips and footer (~11rem), so the palette's natural
          height always fits the dialog and the list scrolls instead of the
          footer being clipped (see `height-follows-content`). */}
      <div className="flex max-h-[min(31.25rem,calc(90vh-11rem))] flex-col gap-2 overflow-y-auto p-1.5">
        {showDefaultActions && (
          <div>
            {defaultActions.map((item, i) => (
              <ItemRow
                key={getCommandPaletteItemKey(item)}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                isSelected={selectedIndex === i}
                onClick={() => onItemSelect(item)}
                onMouseMove={() => onSelectedIndexChange(i)}
              >
                <CommandPaletteItemContent item={item} />
              </ItemRow>
            ))}
          </div>
        )}

        {showCategoryCta && <ItemEmptyState>{categoryCtaHint}</ItemEmptyState>}

        {showQueryTooShortHint && (
          <ItemEmptyState>{queryTooShortHint}</ItemEmptyState>
        )}

        {showFrequentItems && (
          <div>
            <ItemTitle>
              <Trans>Suggestions</Trans>
            </ItemTitle>
            {frequentItems.map((item, i) => {
              const globalIndex = defaultActions.length + i;
              return (
                <ItemRow
                  key={getCommandPaletteItemKey(item)}
                  ref={(el) => {
                    itemRefs.current[globalIndex] = el;
                  }}
                  isSelected={selectedIndex === globalIndex}
                  onClick={() => onItemSelect(item)}
                  onMouseMove={() => onSelectedIndexChange(globalIndex)}
                  onOpenActions={
                    commandPaletteItemHasActions(item, actionOptions)
                      ? () => onOpenActions(item)
                      : undefined
                  }
                >
                  <CommandPaletteItemContent item={item} />
                </ItemRow>
              );
            })}
          </div>
        )}

        {isSearchQueryReady && isLoading && !hasSearchResults && (
          <div className="flex flex-col gap-1 p-1">
            {Array.from({ length: 9 }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5 px-3 py-2.5">
                <LoadingBlock className="h-6 w-6 shrink-0 rounded-full" />
                <LoadingBlock
                  className="h-4"
                  style={{ width: `${30 + (i % 3) * 20}%` }}
                />
              </div>
            ))}
          </div>
        )}
        {isSearchQueryReady && !isLoading && !hasSearchResults && (
          <ItemEmptyState>
            <Trans>No results found.</Trans>
          </ItemEmptyState>
        )}

        {isSearchQueryReady && filteredConversations.length > 0 && (
          <div>
            <ItemTitle>
              <Trans>Conversations</Trans>
            </ItemTitle>
            {filteredConversations.map((conversation, i) => {
              const globalIndex = conversationsOffset + i;
              return (
                <ItemRow
                  key={conversation.sId}
                  ref={(el) => {
                    itemRefs.current[globalIndex] = el;
                  }}
                  isSelected={selectedIndex === globalIndex}
                  onClick={() =>
                    onItemSelect({ kind: "conversation", conversation })
                  }
                  onMouseMove={() => onSelectedIndexChange(globalIndex)}
                >
                  <CommandPaletteItemContent
                    item={{ kind: "conversation", conversation }}
                  />
                </ItemRow>
              );
            })}
            {hasMoreConversations && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <Trans>More conversations available. Type to filter.</Trans>
              </div>
            )}
          </div>
        )}

        {isSearchQueryReady && filteredPods.length > 0 && (
          <div>
            <ItemTitle>
              <Trans>Pods</Trans>
            </ItemTitle>
            {filteredPods.map((pod, i) => {
              const globalIndex = podsOffset + i;
              const item = { kind: "pod" as const, pod };
              return (
                <ItemRow
                  key={pod.sId}
                  ref={(el) => {
                    itemRefs.current[globalIndex] = el;
                  }}
                  isSelected={selectedIndex === globalIndex}
                  onClick={() => onItemSelect(item)}
                  onMouseMove={() => onSelectedIndexChange(globalIndex)}
                  onOpenActions={() => onOpenActions(item)}
                >
                  <CommandPaletteItemContent item={item} />
                </ItemRow>
              );
            })}
            {hasMorePods && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <Trans>More pods available. Type to filter.</Trans>
              </div>
            )}
          </div>
        )}

        {isSearchQueryReady && filteredAgents.length > 0 && (
          <div>
            <ItemTitle>
              <Trans>Agents</Trans>
            </ItemTitle>
            {filteredAgents.map((agent, i) => {
              const globalIndex = agentsOffset + i;
              return (
                <ItemRow
                  key={agent.sId}
                  ref={(el) => {
                    itemRefs.current[globalIndex] = el;
                  }}
                  isSelected={selectedIndex === globalIndex}
                  onClick={() => onItemSelect({ kind: "agent", agent })}
                  onMouseMove={() => onSelectedIndexChange(globalIndex)}
                  onOpenActions={
                    actionOptions.hideAgentActions
                      ? undefined
                      : () => onOpenActions({ kind: "agent", agent })
                  }
                >
                  <CommandPaletteItemContent item={{ kind: "agent", agent }} />
                </ItemRow>
              );
            })}
            {hasMoreAgents && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <Trans>More agents available. Type to filter.</Trans>
              </div>
            )}
          </div>
        )}

        {isSearchQueryReady && filteredSkills.length > 0 && (
          <div>
            <ItemTitle>
              <Trans>Skills</Trans>
            </ItemTitle>
            {filteredSkills.map((skill, i) => {
              const globalIndex = skillsOffset + i;
              const item = {
                kind: "skill" as const,
                skill,
              };
              return (
                <ItemRow
                  key={skill.sId}
                  ref={(el) => {
                    itemRefs.current[globalIndex] = el;
                  }}
                  isSelected={selectedIndex === globalIndex}
                  onClick={() => onItemSelect(item)}
                  onMouseMove={() => onSelectedIndexChange(globalIndex)}
                  onOpenActions={
                    commandPaletteItemHasActions(item, actionOptions)
                      ? () => onOpenActions(item)
                      : undefined
                  }
                >
                  <CommandPaletteItemContent item={item} />
                </ItemRow>
              );
            })}
            {hasMoreSkills && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <Trans>More skills available. Type to filter.</Trans>
              </div>
            )}
          </div>
        )}

        {isSearchQueryReady && filteredMembers.length > 0 && (
          <div>
            <ItemTitle>
              <Trans>Members</Trans>
            </ItemTitle>
            {filteredMembers.map((member, i) => {
              const globalIndex = membersOffset + i;
              return (
                <ItemRow
                  key={member.sId}
                  ref={(el) => {
                    itemRefs.current[globalIndex] = el;
                  }}
                  isSelected={selectedIndex === globalIndex}
                  onClick={() => onItemSelect({ kind: "member", member })}
                  onMouseMove={() => onSelectedIndexChange(globalIndex)}
                  onOpenActions={
                    actionOptions.hideMemberActions
                      ? undefined
                      : () => onOpenActions({ kind: "member", member })
                  }
                >
                  <CommandPaletteItemContent
                    item={{ kind: "member", member }}
                  />
                </ItemRow>
              );
            })}
            {hasMoreMembers && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <Trans>More members available. Type to filter.</Trans>
              </div>
            )}
          </div>
        )}

        {isSearchQueryReady && filteredSettings.length > 0 && (
          <div>
            <ItemTitle>
              <Trans>Settings</Trans>
            </ItemTitle>
            {filteredSettings.map((setting, i) => {
              const globalIndex = settingsOffset + i;
              return (
                <ItemRow
                  key={`${setting.pageHref}#${setting.sectionId}:${setting.label}`}
                  ref={(el) => {
                    itemRefs.current[globalIndex] = el;
                  }}
                  isSelected={selectedIndex === globalIndex}
                  onClick={() => onItemSelect({ kind: "setting", setting })}
                  onMouseMove={() => onSelectedIndexChange(globalIndex)}
                >
                  <CommandPaletteItemContent
                    item={{ kind: "setting", setting }}
                  />
                </ItemRow>
              );
            })}
            {hasMoreSettings && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                <Trans>More settings available. Type to filter.</Trans>
              </div>
            )}
          </div>
        )}
      </div>
      <KeyboardHints
        hints={[
          { keys: ["↑", "↓"], label: t`Navigate` },
          { keys: ["↵"], label: t`Select` },
          { keys: ["→"], label: t`Actions` },
          { keys: ["Esc"], label: t`Close` },
        ]}
      />
    </div>
  );
}
