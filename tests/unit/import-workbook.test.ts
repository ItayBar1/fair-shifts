import ExcelJS from "exceljs";
import { describe, it, expect } from "vitest";
import {
  createImportTemplate,
  parseImportWorkbook,
} from "../../src/server/import-workbook";
import { importColumns } from "../../src/domain/import-columns";

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
  it("reads the issued number, names, gender, a zero-led phone, Israeli dates, explicit false and integer scores", async () => {
    const book = await workbook();
    const sheet = book.getWorksheet("חיילים")!;
    expect(sheet.views[0].rightToLeft).toBe(true);
    sheet.addRow([
      7,
      "סינתטי",
      "בדיקה",
      "נקבה",
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
    // A new soldier has no number; a phone typed as a number keeps its zero by format.
    sheet.addRow([
      null,
      "פורמט",
      "אפסים",
      "זכר",
      "zero@example.invalid",
      500000001,
    ]);
    sheet.getCell("F3").numFmt = "0000000000";
    const rows = await parseImportWorkbook(await serialize(book));
    expect(rows[0].values).toMatchObject({
      idNumber: 7,
      firstName: "סינתטי",
      lastName: "בדיקה",
      gender: "female",
      phone: "0500000000",
      currentScore: 0,
      population: "academic",
      arrivalDate: "2026-09-01",
      graceEligible: false,
    });
    expect(rows[0].values).not.toHaveProperty("releaseDate");
    expect(rows[1].values).not.toHaveProperty("idNumber");
    expect(rows[1].values).toMatchObject({
      gender: "male",
      phone: "0500000001",
    });
  });
  it("lists the unit's soldiers by issued number and name, so an update fills only what changes", async () => {
    const template = await createImportTemplate(
      [],
      [{ idNumber: 12, firstName: "דנה", lastName: "ירוק" }]
    );
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(new Uint8Array(template).buffer);
    book.getWorksheet("חיילים")!.getCell("M2").value = "2027-01-31";
    const rows = await parseImportWorkbook(await serialize(book));
    expect(rows).toEqual([
      {
        rowNumber: 2,
        values: {
          idNumber: 12,
          firstName: "דנה",
          lastName: "ירוק",
          releaseDate: "2027-01-31",
        },
      },
    ]);
  });
  it("rejects the entire file and returns row, field and value for duplicates and malformed cells", async () => {
    const book = await workbook();
    const sheet = book.getWorksheet("חיילים")!;
    sheet.addRow([7, "תקין", "אחד", "זכר", "one@example.invalid"]);
    sheet.addRow([7, "כפול", "שניים", "זכר", "two@example.invalid"]);
    sheet.addRow(["ז12", "מספר", "אינו מספר", "גבר", "bad", null, null, -1]);
    sheet.addRow([
      9,
      { formula: '"name"', result: "נוסחה" },
      "נוסחה",
      "אחר",
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
              field: "מספר זיהוי",
              value: "7",
            }),
            expect.objectContaining({ row: 4, field: "מספר זיהוי" }),
            expect.objectContaining({ row: 4, field: "מגדר" }),
            expect.objectContaining({ row: 4, field: "מייל" }),
            expect.objectContaining({ row: 5, field: "שם פרטי" }),
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
    book.getWorksheet("חיילים")!.getCell("A502").value = 7;
    await expect(parseImportWorkbook(await serialize(book))).rejects.toThrow(
      "500"
    );
  });
});
describe("import format guide", () => {
  it("documents every template column, and its examples pass the parser", async () => {
    const book = await workbook();
    const sheet = book.getWorksheet("חיילים")!;
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      ...importColumns.map((column) => column.label),
    ]);
    for (const column of importColumns) {
      expect(column.need, column.key).not.toBe("");
      expect(column.values, column.key).not.toBe("");
    }
    // The guide's example row is a valid update of the soldier the site numbered 12.
    sheet.addRow(importColumns.map((column) => column.example || null));
    const rows = await parseImportWorkbook(await serialize(book));
    expect(rows[0].values).toMatchObject({
      idNumber: 12,
      gender: "female",
      phone: "0501234567",
      population: "mandatory",
      graceEligible: false,
      rankName: "סמל",
      rankEffectiveDate: "2026-05-01",
    });
  });
});
