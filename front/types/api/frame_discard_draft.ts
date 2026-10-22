import { z } from "zod";

export const DiscardFrameDraftRequestBodySchema = z.object({
  /**
   * Guards against discarding a draft the caller has not seen; it never selects what is discarded
   * (discard always goes back to the live publication). Send the pending draft the caller is
   * showing, or the live publication's id when it shows no draft: discard is refused if the
   * Frame's pending draft is not that one. Omitted by callers that only know the Frame (sandbox).
   */
  draftPublicationId: z.string().min(1).optional(),
});

export type DiscardFrameDraftResponseBody = { publicationId: string };
