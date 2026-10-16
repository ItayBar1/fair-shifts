/**
 * The columns of the soldier import sheet. The workbook reads and writes them,
 * and the import screen shows the same list as the file format, so the guide
 * on screen cannot drift from what the parser accepts.
 */
export type ImportColumnKey =
  | "idNumber"
  | "firstName"
  | "lastName"
  | "gender"
  | "email"
  | "phone"
  | "address"
  | "currentScore"
  | "population"
  | "serviceType"
  | "arrivalDate"
  | "enlistmentDate"
  | "releaseDate"
  | "officerDate"
  | "permanentDate"
  | "graceEligible"
  | "rankName"
  | "rankTrack"
  | "rankEffectiveDate";
export type ImportColumn = {
  key: ImportColumnKey;
  label: string;
  kind?:
    | "idNumber"
    | "identifier"
    | "date"
    | "score"
    | "population"
    | "service"
    | "boolean"
    | "gender";
  width?: number;
  /** When the cell must be filled, in the words the screen shows. */
  need: string;
  /** The values the parser accepts. */
  values: string;
  example: string;
};
const newSoldier = "חובה בחייל חדש";
const rankTogether = "רשות; שלושת שדות הדרגה יחד";
export const importColumns: ImportColumn[] = [
  {
    key: "idNumber",
    label: "מספר זיהוי",
    kind: "idNumber",
    width: 14,
    need: "ריק בחייל חדש; חובה בעדכון",
    values: "המספר שהאתר הנפיק (מופיע בתבנית)",
    example: "12",
  },
  {
    key: "firstName",
    label: "שם פרטי",
    width: 18,
    need: newSoldier,
    values: "טקסט, עד 100 תווים",
    example: "נועה",
  },
  {
    key: "lastName",
    label: "שם משפחה",
    width: 18,
    need: newSoldier,
    values: "טקסט, עד 100 תווים",
    example: "לוי",
  },
  {
    key: "gender",
    label: "מגדר",
    kind: "gender",
    width: 10,
    need: newSoldier,
    values: "זכר / נקבה / אחר",
    example: "נקבה",
  },
  {
    key: "email",
    label: "מייל",
    width: 35,
    need: newSoldier,
    values: "כתובת מייל תקינה; שינוי לחייל קיים נעשה באתר",
    example: "noa@example.com",
  },
  {
    key: "phone",
    label: "טלפון",
    kind: "identifier",
    need: newSoldier,
    values: "נייד בן 10 ספרות שמתחיל ב־05, או מספר שמתחיל ב־+; תא טקסט",
    example: "0501234567",
  },
  {
    key: "address",
    label: "כתובת",
    width: 35,
    need: "רשות",
    values: "טקסט, עד 500 תווים",
    example: "הרצל 1, חיפה",
  },
  {
    key: "currentScore",
    label: "ניקוד נוכחי",
    kind: "score",
    need: "רשות (ברירת מחדל 0)",
    values: "מספר שלם שאינו שלילי, בלי ניקוד שמור",
    example: "40",
  },
  {
    key: "population",
    label: "אוכלוסיית שיבוץ",
    kind: "population",
    need: "רשות (ברירת מחדל חובה)",
    values: "חובה / קבע / קצינים / קמ״א",
    example: "חובה",
  },
  {
    key: "serviceType",
    label: "סוג שירות",
    kind: "service",
    need: "רשות (ברירת מחדל חובה)",
    values: "חובה / קבע",
    example: "חובה",
  },
  {
    key: "arrivalDate",
    label: "תאריך הגעה",
    kind: "date",
    need: "רשות",
    values: "YYYY-MM-DD",
    example: "2026-03-01",
  },
  {
    key: "enlistmentDate",
    label: "תאריך גיוס",
    kind: "date",
    need: "רשות",
    values: "YYYY-MM-DD",
    example: "2025-08-10",
  },
  {
    key: "releaseDate",
    label: "תאריך שחרור",
    kind: "date",
    need: "רשות",
    values: "YYYY-MM-DD",
    example: "2028-02-09",
  },
  {
    key: "officerDate",
    label: "תחילת קצונה",
    kind: "date",
    need: "רשות",
    values: "YYYY-MM-DD",
    example: "",
  },
  {
    key: "permanentDate",
    label: "תחילת קבע",
    kind: "date",
    need: "רשות",
    values: "YYYY-MM-DD",
    example: "",
  },
  {
    key: "graceEligible",
    label: "זכאות לחסד",
    kind: "boolean",
    need: "רשות (ברירת מחדל לא)",
    values: "כן / לא",
    example: "לא",
  },
  {
    key: "rankName",
    label: "דרגה",
    need: rankTogether,
    values: "שם דרגה מהקטלוג (גיליון ״קטלוג דרגות״ בתבנית)",
    example: "סמל",
  },
  {
    key: "rankTrack",
    label: "מסלול דרגה",
    need: rankTogether,
    values: "מסלול שהדרגה שייכת אליו בקטלוג",
    example: "חוגרים",
  },
  {
    key: "rankEffectiveDate",
    label: "תחולת דרגה",
    kind: "date",
    need: rankTogether,
    values: "YYYY-MM-DD",
    example: "2026-05-01",
  },
];
