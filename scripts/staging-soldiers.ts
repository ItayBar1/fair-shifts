/**
 * Synthetic soldiers for a staging environment (card #25). Writes an XLSX in
 * the import template's own format, to be uploaded at /manage/imports; nothing
 * is written to a database. The addresses are @example.invalid and receive no
 * mail. A tester's real address is passed with --extra and never stored in the
 * repository. Output is English: it may run on the server (decision 187).
 *
 *   pnpm staging:soldiers --out .local/staging-soldiers.xlsx \
 *     --extra "tester@gmail.com|חייל בדיקה Google"
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import ExcelJS from "exceljs";
import {
  createImportTemplate,
  importColumns,
} from "../src/server/import-workbook";

const { values: args } = parseArgs({
  options: {
    out: { type: "string", default: ".local/staging-soldiers.xlsx" },
    extra: { type: "string", multiple: true, default: [] },
  },
});

const firstNames = [
  "נועה",
  "איתי",
  "מאיה",
  "יונתן",
  "תמר",
  "עומר",
  "שירה",
  "דניאל",
  "יעל",
  "אורי",
  "רוני",
  "אלון",
  "הדר",
  "נדב",
  "ליה",
  "גיא",
  "מיכל",
  "אביב",
  "עדי",
  "ניר",
];
const lastNames = [
  "לוי",
  "כהן",
  "מזרחי",
  "פרץ",
  "ביטון",
  "אברהם",
  "פרידמן",
  "שפירא",
  "דהן",
  "אזולאי",
];
type Row = Record<string, string | number>;
const rows: Row[] = firstNames.map((first, index) => {
  const number = index + 1;
  const base: Row = {
    personalNumber: String(9_000_000 + number),
    name: `${first} ${lastNames[index % lastNames.length]}`,
    email: `soldier${String(number).padStart(2, "0")}@example.invalid`,
    currentScore: (index * 7) % 41,
    arrivalDate: `2025-${String((index % 9) + 1).padStart(2, "0")}-01`,
  };
  // Twelve mandatory, five career or officers, three academic (קמ״א).
  if (index < 12)
    return {
      ...base,
      population: "חובה",
      serviceType: "חובה",
      enlistmentDate: `2024-${String((index % 12) + 1).padStart(2, "0")}-15`,
      releaseDate: `2027-${String((index % 12) + 1).padStart(2, "0")}-14`,
      graceEligible: index % 4 === 0 ? "כן" : "לא",
    };
  if (index < 17)
    return {
      ...base,
      population: index % 2 ? "קצינים" : "קבע",
      serviceType: "קבע",
      enlistmentDate: "2019-03-01",
      permanentDate: "2022-03-01",
      ...(index % 2 && { officerDate: "2021-08-01" }),
    };
  return {
    ...base,
    population: "קמ״א",
    serviceType: "חובה",
    enlistmentDate: "2023-10-01",
    releaseDate: "2029-09-30",
  };
});
args.extra.forEach((entry, index) => {
  const [email, name] = entry.split("|").map((part) => part.trim());
  if (!email || !name) throw new Error(`--extra needs "email|name": ${entry}`);
  rows.push({
    personalNumber: String(9_000_101 + index),
    name,
    email,
    currentScore: 10,
    population: "חובה",
    serviceType: "חובה",
    arrivalDate: "2025-01-01",
    enlistmentDate: "2024-06-15",
    releaseDate: "2027-06-14",
    graceEligible: "לא",
  });
});

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.load(
  (await createImportTemplate()) as unknown as ExcelJS.Buffer
);
const sheet = workbook.getWorksheet("חיילים")!;
// A loaded sheet has no column keys, so rows follow the template's order.
// Dates stay text in yyyy-mm-dd, as the template's instructions ask.
for (const row of rows)
  sheet.addRow(importColumns.map((column) => row[column.key] ?? null));
await writeFile(
  args.out,
  Buffer.from(new Uint8Array(await workbook.xlsx.writeBuffer()))
);
console.log(
  `Wrote ${rows.length} synthetic soldiers to ${args.out} (${args.extra.length} tester addresses). Import it at /manage/imports and review the preview before applying.`
);
