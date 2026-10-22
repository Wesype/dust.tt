import { createHash, timingSafeEqual } from "node:crypto";
import config from "@app/lib/api/config";
import { apiError } from "@front-api/middlewares/utils";
import { createMiddleware } from "hono/factory";

const BEARER_PREFIX = "Bearer ";

// Hashed first so the comparison takes the same time whatever the length of what was sent.
const digest = (value: string) => createHash("sha256").update(value).digest();

function isAuthorized(authorization: string | undefined): boolean {
  const secret = config.getCollabServerInternalSecret();
  if (!secret || !authorization?.startsWith(BEARER_PREFIX)) {
    return false;
  }
  return timingSafeEqual(
    digest(authorization.slice(BEARER_PREFIX.length)),
    digest(secret)
  );
}

/** Lets through only front's calls to the collab server, which carry the internal secret. */
export const collabInternalAuth = createMiddleware(async (ctx, next) => {
  if (!isAuthorized(ctx.req.header("authorization"))) {
    return apiError(ctx, {
      status_code: 401,
      api_error: {
        type: "not_authenticated",
        message: "The internal secret is missing or invalid.",
      },
    });
  }
  await next();
});
