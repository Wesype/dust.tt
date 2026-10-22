import { isString } from "@app/types/shared/utils/general";

// Tools of the Excel add-in (client-side MCP server, `extension/platforms/excel/tools/`).
export const EXCEL_READ_WORKBOOK_TOOL_NAME = "read_workbook";
export const EXCEL_WRITE_WORKBOOK_TOOL_NAME = "write_workbook";

const SHEET_REGEX = /worksheets\.getItem\(\s*(['"])(.+?)\1\s*\)/;
const RANGE_REGEX = /getRange\(\s*(['"])(.+?)\1\s*\)/;

function getCellsFromExpression(expression: string): string | null {
  const sheet = expression.match(SHEET_REGEX)?.[2];
  const range = expression.match(RANGE_REGEX)?.[2];
  if (sheet && range) {
    return `${sheet}!${range}`;
  }
  return sheet ?? range ?? null;
}

/**
 * Returns the cells named in the Office.js expressions of an Excel tool call, without duplicates,
 * e.g. "Sheet1!A1:C10" for `workbook.worksheets.getItem('Sheet1').getRange('A1:C10').load(...)`.
 * An expression that names no sheet and no range (e.g. `workbook.tables.getCount()`) adds nothing.
 */
export function getExcelCellsFromParams(
  params: Record<string, unknown>
): string[] {
  const items = params.reads ?? params.writes;
  if (!Array.isArray(items)) {
    return [];
  }

  const cells = items.flatMap((item: unknown) => {
    const expression =
      typeof item === "object" &&
      item !== null &&
      "expression" in item &&
      isString(item.expression)
        ? item.expression
        : null;
    const itemCells = expression ? getCellsFromExpression(expression) : null;
    return itemCells ? [itemCells] : [];
  });

  return [...new Set(cells)];
}
