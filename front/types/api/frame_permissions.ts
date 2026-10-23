export type GetFramePermissionsResponseBody = {
  canWriteFrameSource: boolean;
  /**
   * Temporary alias of `canWriteFrameSource` for clients that still decode the old field
   * (mobile `FramePermissions`, open web tabs). Remove once those clients ship the rename.
   */
  isFrameAuthor: boolean;
  /** Scoped path of the Frame package root (`conversation-…/MyFrame`), when known. */
  packageRoot: string | null;
  /** Display name of the Frame (folder name), when known. */
  frameName: string | null;
  /**
   * Whether the publication this request is served declares at least one function: the latest
   * one for a writer asking with `publication=latest` (the conversation panel), live otherwise.
   */
  hasFunctions: boolean;
  /** Publication the share link, and anyone who cannot edit, is served. */
  livePublicationId: string | null;
  /** When the live publication was published, in ms since epoch. */
  livePublishedAt: number | null;
  /**
   * Latest publication when it differs from the live one (a draft is pending), reported only to
   * callers who can edit the Frame.
   */
  draftPublicationId: string | null;
  /**
   * Whether the Frame is in draft mode (every publish is a draft until one is made live), reported
   * only to callers who can edit the Frame.
   */
  draftMode: boolean;
};
