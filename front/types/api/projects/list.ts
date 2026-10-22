import type { PodListItemType, PodType } from "@app/types/space";

export type SpacesLookupResponseBody = {
  spaces: PodType[];
};

export const PROJECT_SEARCH_ORDER_COLUMNS = ["name", "ownership"] as const;
export type ProjectSearchOrderColumn =
  (typeof PROJECT_SEARCH_ORDER_COLUMNS)[number];

export function isProjectSearchOrderColumn(
  value: string
): value is ProjectSearchOrderColumn {
  return PROJECT_SEARCH_ORDER_COLUMNS.some((column) => column === value);
}

export type SearchProjectsResponseBody = {
  spaces: PodListItemType[];
  hasMore: boolean;
  lastValue: string | null;
};
