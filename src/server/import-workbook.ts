import ExcelJS from "exceljs";
import { z } from "zod";
import { AppError, invariant } from "./errors";
import { date, population } from "./validation";
import { validateWorkbookArchive } from "./workbook-archive";
import { parseWorkbookInProcess } from "./workbook-process";

export const importValues = z
  .object({
    personalNumber: z
      .string()
      .regex(/^\d{1,20}$/, "נדרש מספר אישי בן 1–20 ספרות כטקסט"),
    name: z.string().trim().min(1).max(500).optional(),
    email: z
      .email("נדרשת כתובת מייל תקינה")
      .transform((value) => value.toLowerCase())
      .optional(),
    phone: z.string().max(30).optional(),
    address: z.string().max(500).optional(),
    currentScore: z.number().int().nonnegative().max(2147483647).optional(),
    population: population.optional(),
    serviceType: z.enum(["mandatory", "career"]).optional(),
    arrivalDate: date.optional(),
    enlistmentDate: date.optional(),
    releaseDate: date.optional(),
    officerDate: date.optional(),
    permanentDate: date.optional(),
    graceEligible: z.boolean().optional(),
    rankName: z.string().trim().min(1).max(100).optional(),
    rankTrack: z.string().trim().min(1).max(100).optional(),
    rankEffectiveDate: date.optional(),
  })
  .strict();
export const importRows = z
  .array(
    z.object({
      rowNumber: z.number().int().min(2).max(501),
      values: importValues,
    })
  )
  .min(1)
  .max(500);
export type ImportValues = z.infer<typeof importValues>;
export type ImportRow = z.infer<typeof importRows>[number];
export type ImportProblem = {
  row: number;
  field: string;
  value: string;
  reason: string;
  fix: string;
};
type Column = {
  key: keyof ImportValues;
  label: string;
  kind?: "identifier" | "date" | "score" | "population" | "service" | "boolean";
  width?: number;
};
export const importColumns: Column[] = [
  { key: "personalNumber", label: "מספר אישי", kind: "identifier" },
  { key: "name", label: "שם מלא", width: 25 },
  { key: "email", label: "מייל", width: 35 },
  { key: "phone", label: "טלפון", kind: "identifier" },
  { key: "address", label: "כתובת", width: 35 },
  { key: "currentScore", label: "ניקוד נוכחי", kind: "score" },
  { key: "population", label: "אוכלוסיית שיבוץ", kind: "population" },
  { key: "serviceType", label: "סוג שירות", kind: "service" },
  { key: "arrivalDate", label: "תאריך הגעה", kind: "date" },
  { key: "enlistmentDate", label: "תאריך גיוס", kind: "date" },
  { key: "releaseDate", label: "תאריך שחרור", kind: "date" },
  { key: "officerDate", label: "תחילת קצונה", kind: "date" },
  { key: "permanentDate", label: "תחילת קבע", kind: "date" },
  { key: "graceEligible", label: "זכאות לחסד", kind: "boolean" },
  { key: "rankName", label: "דרגה" },
  { key: "rankTrack", label: "מסלול דרגה" },
  { key: "rankEffectiveDate", label: "תחולת דרגה", kind: "date" },
];

export async function createImportTemplate(
  ranks: { name: string; track: string }[] = []
) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Fair Shifts";
  const sheet = workbook.addWorksheet("חיילים", {
    views: [{ state: "frozen", ySplit: 1, rightToLeft: true }],
  });
  sheet.columns = importColumns.map((column) => ({
    header: column.label,
    key: column.key,
    width: column.width ?? 20,
    style: {
      numFmt:
        column.kind === "score"
          ? "0"
          : column.kind === "date"
            ? "yyyy-mm-dd"
            : "@",
    },
  }));
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF174A44" },
  };
  sheet.getRow(1).height = 28;
  sheet.autoFilter = { from: "A1", to: "Q1" };
  const instructions = workbook.addWorksheet("הוראות", {
    views: [{ rightToLeft: true }],
  });
  instructions.getColumn(1).width = 110;
  for (const line of [
    "תבנית קליטה ועדכון חיילים — גרסה 1",
    "ממלאים בגיליון חיילים. מספר אישי וטלפון הם טקסט; שומרים אפסים מובילים.",
    "לקליטה חדשה נדרשים מספר אישי, שם ומייל. תא ריק בעדכון אינו מוחק ערך קיים.",
    "תאריכים: YYYY-MM-DD. ניקוד: מספר שלם שאינו שלילי; אינו כולל ניקוד שמור.",
    "אוכלוסייה: חובה / קבע / קצינים / קמ״א. סוג שירות: חובה / קבע. זכאות לחסד: כן / לא.",
    "אם לא הוזנו בקליטה חדשה: אוכלוסייה וסוג שירות חובה, ללא זכאות לחסד, יתרת פתיחה 0. התצוגה המקדימה תפרט זאת.",
    "לייבוא דרגה ממלאים יחד שם דרגה, מסלול ותאריך תחולה לפי הקטלוג שבמערכת.",
    "שינוי מייל של חייל קיים נעשה באתר באמצעות אימות הכתובת החדשה.",
    "נוסחאות אינן נתמכות. שגיאה אחת או כפילות דוחות את הקובץ כולו; עד 500 שורות ו־5MB.",
    "ייבוא אינו שומר היסטוריית תורנויות מהקובץ. תמיד בודקים תצוגה מקדימה לפני אישור.",
  ])
    instructions.addRow([line]);
  if (ranks.length) {
    const catalog = workbook.addWorksheet("קטלוג דרגות", {
      views: [{ rightToLeft: true }],
    });
    catalog.columns = [
      { header: "דרגה", key: "name", width: 30 },
      { header: "מסלול דרגה", key: "track", width: 30 },
    ];
    for (const rank of ranks) catalog.addRow(rank);
  }
  return Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer()));
}

const populationNames: Record<string, string> = {
  חובה: "mandatory",
  קבע: "career",
  קצינים: "career",
  "קבע / קצינים": "career",
  "קמ״א": "academic",
  'קמ"א': "academic",
};
function readValue(cell: ExcelJS.Cell, column: Column): unknown {
  const value = cell.value;
  if (value === null || value === undefined || value === "") return undefined;
  if (value instanceof Date) {
    if (column.kind !== "date" || !Number.isFinite(value.getTime()))
      throw new Error("תאריך בשדה שאינו תאריך");
    return value.toISOString().slice(0, 10);
  }
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  )
    throw new Error(
      "נוסחה, תא שגיאה או תוכן מורכב אינם נתמכים; יש להדביק ערך כטקסט"
    );
  if (column.kind === "identifier" && typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || !/^0+$/.test(cell.numFmt))
      throw new Error(
        "מספר אישי וטלפון חייבים להיות טקסט כדי לשמור אפסים מובילים"
      );
    return String(value).padStart(cell.numFmt.length, "0");
  }
  const text = String(value).trim();
  if (!text) return undefined;
  if (column.kind === "score") {
    if (!/^\d+$/.test(text))
      throw new Error("הניקוד חייב להיות מספר שלם שאינו שלילי");
    return Number(text);
  }
  if (column.kind === "boolean") {
    if (["כן", "true"].includes(text)) return true;
    if (["לא", "false"].includes(text)) return false;
    throw new Error("יש להזין כן או לא");
  }
  if (column.kind === "population") return populationNames[text] ?? text;
  if (column.kind === "service")
    return text === "חובה" ? "mandatory" : text === "קבע" ? "career" : text;
  return text;
}

export async function decodeImportWorkbook(
  buffer: Buffer
): Promise<ImportRow[]> {
  await validateWorkbookArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(new Uint8Array(buffer).buffer);
  } catch {
    throw new AppError(
      "invalid_workbook",
      "לא ניתן לקרוא את הקובץ. יש לשמור XLSX לפי התבנית"
    );
  }
  const sheet = workbook.getWorksheet("חיילים");
  invariant(sheet, "invalid_workbook", "חסר גיליון חיילים לפי התבנית");
  invariant(
    sheet.rowCount <= 501 && sheet.columnCount <= importColumns.length,
    "invalid_workbook",
    "נדרשות עד 500 שורות ועמודות לפי התבנית"
  );
  const columns: { column: Column; index: number }[] = [];
  const problems: ImportProblem[] = [];
  const seenHeaders = new Set<string>();
  sheet.getRow(1).eachCell((cell, index) => {
    const column = importColumns.find(
      (item) => item.label === cell.text.trim()
    );
    if (!column || seenHeaders.has(column.key))
      problems.push({
        row: 1,
        field: cell.text,
        value: cell.text,
        reason: "כותרת לא מוכרת או כפולה",
        fix: "יש להשתמש בכותרות התבנית ללא שינוי",
      });
    else {
      columns.push({ column, index });
      seenHeaders.add(column.key);
    }
  });
  if (!seenHeaders.has("personalNumber"))
    problems.push({
      row: 1,
      field: "מספר אישי",
      value: "",
      reason: "חסרה עמודת זיהוי",
      fix: "יש להשתמש בתבנית",
    });
  const parsed: ImportRow[] = [];
  const seenNumbers = new Set<string>();
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber++) {
    const row = sheet.getRow(rowNumber);
    if (!row.hasValues) continue;
    row.eachCell((cell, index) => {
      if (!columns.some((item) => item.index === index))
        problems.push({
          row: rowNumber,
          field: `עמודה ${index}`,
          value: cell.text.slice(0, 200),
          reason: "תוכן בעמודה ללא כותרת מוכרת",
          fix: "יש להשתמש בעמודות התבנית",
        });
    });
    const values: Record<string, unknown> = {};
    for (const { column, index } of columns) {
      const cell = row.getCell(index);
      try {
        const value = readValue(cell, column);
        if (value !== undefined) values[column.key] = value;
      } catch (error) {
        problems.push({
          row: rowNumber,
          field: column.label,
          value: cell.text.slice(0, 200),
          reason: error instanceof Error ? error.message : "ערך לא תקין",
          fix: "יש לתקן את התא ולשמור שוב את הקובץ",
        });
      }
    }
    if (Object.keys(values).length === 0) continue;
    const result = importValues.safeParse(values);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const key = String(issue.path[0]);
        problems.push({
          row: rowNumber,
          field: importColumns.find((item) => item.key === key)?.label ?? key,
          value: String(values[key] ?? ""),
          reason: issue.message,
          fix: "יש לתקן לפי הוראות התבנית",
        });
      }
    } else {
      if (seenNumbers.has(result.data.personalNumber))
        problems.push({
          row: rowNumber,
          field: "מספר אישי",
          value: result.data.personalNumber,
          reason: "מספר אישי כפול בקובץ",
          fix: "יש להשאיר שורה אחת לכל חייל",
        });
      seenNumbers.add(result.data.personalNumber);
      parsed.push({ rowNumber, values: result.data });
    }
  }
  invariant(
    problems.length === 0,
    "import_errors",
    "הקובץ נדחה בשל שגיאות. לא נשמרו שינויים",
    422,
    { problems }
  );
  invariant(parsed.length > 0, "empty_workbook", "אין שורות נתונים לייבוא");
  return parsed;
}

export async function parseImportWorkbook(
  buffer: Buffer
): Promise<ImportRow[]> {
  return parseWorkbookInProcess(buffer);
}
