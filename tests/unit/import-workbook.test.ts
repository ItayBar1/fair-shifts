import ExcelJS from "exceljs";
import { describe, it, expect } from "vitest";
import {
  createImportTemplate,
  parseImportWorkbook,
} from "../../src/server/import-workbook";

async function workbook() {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    new Uint8Array(
      await createImportTemplate([
        { name: "דרגה לבדיקה", track: "מסלול לבדיקה" },
      ])
    ).buffer
  );
  return book;
}
async function serialize(book: ExcelJS.Workbook) {
  return Buffer.from(new Uint8Array(await book.xlsx.writeBuffer()));
}
describe("XLSX import contract", () => {
  it("preserves identifiers and zeros, Israeli calendar dates, explicit false and integer scores", async () => {
    const book = await workbook();
    const sheet = book.getWorksheet("חיילים")!;
    expect(sheet.views[0].rightToLeft).toBe(true);
    sheet.addRow([
      "000007",
      "סינתטי",
      "synthetic@example.invalid",
      "0500000000",
      null,
      0,
      "קמ״א",
      "חובה",
      new Date("2026-09-01T00:00:00Z"),
      null,
      null,
      null,
      null,
      "לא",
    ]);
    sheet.addRow([8, "פורמט אפסים", "zero@example.invalid"]);
    sheet.getCell("A3").numFmt = "000000";
    const rows = await parseImportWorkbook(await serialize(book));
    expect(rows[0].values).toMatchObject({
      personalNumber: "000007",
      phone: "0500000000",
      currentScore: 0,
      population: "academic",
      arrivalDate: "2026-09-01",
      graceEligible: false,
    });
    expect(rows[0].values).not.toHaveProperty("releaseDate");
    expect(rows[1].values.personalNumber).toBe("000008");
  });
  it("rejects the entire file and returns row, field and value for duplicates and malformed cells", async () => {
    const book = await workbook();
    const sheet = book.getWorksheet("חיילים")!;
    sheet.addRow(["000007", "תקין", "one@example.invalid"]);
    sheet.addRow(["000007", "כפול", "two@example.invalid"]);
    sheet.addRow([12, "מספר אינו טקסט", "bad", null, null, -1]);
    sheet.addRow([
      "000009",
      { formula: '"name"', result: "נוסחה" },
      "formula@example.invalid",
    ]);
    try {
      await parseImportWorkbook(await serialize(book));
      throw new Error("Expected workbook rejection");
    } catch (error) {
      expect(error).toMatchObject({
        code: "import_errors",
        details: {
          problems: expect.arrayContaining([
            expect.objectContaining({
              row: 3,
              field: "מספר אישי",
              value: "000007",
            }),
            expect.objectContaining({ row: 4, field: "מספר אישי" }),
            expect.objectContaining({ row: 4, field: "מייל" }),
            expect.objectContaining({ row: 5, field: "שם מלא" }),
          ]),
        },
      });
    }
  });
  it("rejects invalid archives, empty templates and excess rows", async () => {
    await expect(parseImportWorkbook(Buffer.from("invalid"))).rejects.toThrow(
      "XLSX"
    );
    await expect(
      parseImportWorkbook(await createImportTemplate())
    ).rejects.toThrow("אין שורות");
    const book = await workbook();
    book.getWorksheet("חיילים")!.getCell("A502").value = "000007";
    await expect(parseImportWorkbook(await serialize(book))).rejects.toThrow(
      "500"
    );
  });
});
