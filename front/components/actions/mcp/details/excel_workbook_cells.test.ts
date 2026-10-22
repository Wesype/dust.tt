import { getExcelCellsFromParams } from "@app/components/actions/mcp/details/excel_workbook_cells";
import { describe, expect, it } from "vitest";

describe("getExcelCellsFromParams", () => {
  it("returns the sheets and ranges named in the expressions, without duplicates", () => {
    const params = {
      writes: [
        {
          expression:
            "workbook.worksheets.getItem('Report').getRange('A1:B2').set({ values: [[1, 2], [3, 4]] })",
        },
        {
          expression:
            "workbook.worksheets.getItem('Report').getRange('A1:B2').format.autofitColumns()",
        },
        { expression: "workbook.getActiveWorksheet().getRange('C3').clear()" },
        { expression: 'workbook.worksheets.getItem("Data").delete()' },
        { expression: "workbook.tables.getItem('Sales').delete()" },
      ],
    };

    expect(getExcelCellsFromParams(params)).toEqual([
      "Report!A1:B2",
      "C3",
      "Data",
    ]);
  });
});
