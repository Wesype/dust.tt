import { getPaginationParams } from "@app/lib/api/pagination";
import { searchReadablePods } from "@app/lib/api/projects/list";
import type { SearchProjectsResponseBody } from "@app/types/api/projects/list";
import {
  isProjectSearchOrderColumn,
  PROJECT_SEARCH_ORDER_COLUMNS,
} from "@app/types/api/projects/list";
import { workspaceApp } from "@front-api/middlewares/ctx";
import type { HandlerResult } from "@front-api/middlewares/utils";
import { apiError } from "@front-api/middlewares/utils";
import assert from "assert";

// Mounted under /api/w/:wId/spaces/search_projects.
const app = workspaceApp();

/** @ignoreswagger */
app.get("/", async (ctx): HandlerResult<SearchProjectsResponseBody> => {
  const auth = ctx.get("auth");

  const paginationRes = getPaginationParams(ctx.req.query(), {
    defaultLimit: 20,
    defaultOrderColumn: "name",
    defaultOrderDirection: "asc",
    supportedOrderColumn: [...PROJECT_SEARCH_ORDER_COLUMNS],
    maxLimit: 100,
  });

  if (paginationRes.isErr()) {
    return apiError(ctx, {
      status_code: 400,
      api_error: {
        type: "invalid_pagination_parameters",
        message: paginationRes.error.reason,
      },
    });
  }

  const queryString = ctx.req.query("query");
  const pagination = paginationRes.value;
  // `getPaginationParams` already restricts the column to `supportedOrderColumn`.
  assert(isProjectSearchOrderColumn(pagination.orderColumn));

  if (pagination.orderColumn === "ownership" && pagination.lastValue) {
    return apiError(ctx, {
      status_code: 400,
      api_error: {
        type: "invalid_pagination_parameters",
        message: "The ownership order only serves a first page.",
      },
    });
  }

  const result = await searchReadablePods(auth, {
    query: queryString,
    pagination: {
      limit: pagination.limit,
      lastValue: pagination.lastValue,
      orderColumn: pagination.orderColumn,
      orderDirection: pagination.orderDirection,
    },
  });

  return ctx.json(result);
});

export default app;
