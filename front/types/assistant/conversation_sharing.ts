import type { LightUserType } from "@app/types/user";

// View (`r`) or participate (`rw`), see `front/design-docs/SHARING.md`.
export const CONVERSATION_SHARING_PERMISSIONS = ["read", "write"] as const;
export type ConversationSharingPermission =
  (typeof CONVERSATION_SHARING_PERMISSIONS)[number];

export interface ConversationSharingMember {
  user: LightUserType;
  permission: ConversationSharingPermission;
}

export interface ConversationSharingType {
  // Whether the authenticated user can change the sharing.
  canManage: boolean;
  // The conversation's creator, whose access can't be removed.
  owner: LightUserType | null;
  // The users the conversation is shared with, the owner excluded.
  members: ConversationSharingMember[];
}
