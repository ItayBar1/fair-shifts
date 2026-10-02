import { readFileSync } from "node:fs";
import * as map from "./acceptance-map";
import type { Entry, Evidence, External } from "./acceptance-map";

/** The numbered stories (section 4) and scenarios (section 9) of the PRD. */
export function parsePrd(prd: string) {
  const between = (from: string, to: string) => {
    const start = prd.indexOf(from);
    const end = prd.indexOf(to, start);
    if (start < 0 || end < 0) throw new Error(`Missing section ${from}`);
    return prd.slice(start, end).split("\n");
  };
  const stories = new Map<number, string>();
  for (const line of between("## 4. סיפורי משתמש", "## 5.")) {
    const match = /^(\d+)\. (.+)$/.exec(line);
    if (match) stories.set(Number(match[1]), match[2]);
  }
  const scenarios = new Map<number, string>();
  for (const line of between("## 9. בדיקות וקריטריוני קבלה", "## 10.")) {
    const match = /^(\d+)\. \*\*(.+?)\*\*/.exec(line);
    if (match) scenarios.set(Number(match[1]), match[2].replace(/\.$/, ""));
  }
  return { stories, scenarios };
}

const titlePattern =
  /(?:test\.describe|describe|it|test)(?:\.each\([^)]*\))?(?:\.serial)?\(\s*(?:`([^`]*)`|"((?:[^"\\]|\\.)*)"|'([^']*)')/g;
/** The titles of the tests and groups a spec or test file declares. */
export function testTitles(file: string, root = "."): string[] {
  const source = readFileSync(`${root}/${file}`, "utf8");
  return [...source.matchAll(titlePattern)].map(
    (match) => match[1] ?? match[2] ?? match[3]
  );
}

const statusLabel = {
  covered: "מכוסה",
  partial: "חלקי",
  open: "פתוח",
} as const;
const roleLabel: Record<map.RoleKey, string> = {
  soldier: "חייל",
  manager: "אחראי ראשון",
  otherManager: "אחראי שני",
  technical: "מנהל טכני",
};
const stateLabel: Record<map.RoleState, string> = {
  allowed: "מותר",
  forbidden: "אסור",
  empty: "מצב ריק",
  loading: "טעינה",
  error: "שגיאה",
  changed: "גרסה שהשתנתה",
};
const aspectLabel: Record<map.Aspect, string> = {
  privacy: "פרטיות",
  concurrency: "מקביליות",
  hebrew: "עברית מימין לשמאל",
  mobile: "נייד",
  keyboard: "מקלדת",
  monthEnd: "סוף חודש",
  clockChange: "שעון קיץ וחורף",
};
const recoveryLabel: Record<map.Recovery, string> = {
  workerDown: "השבתת עובד",
  retries: "ניסיונות חוזרים",
  importRestore: "שחזור ייבוא",
  backupRestore: "שחזור גיבוי",
  randomness: "אקראיות נשלטת",
  clock: "שעון נשלט",
};

const shorten = (text: string, length = 120) =>
  text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
/** One bullet for each file, with the test titles it supplies. */
function evidenceLines(evidence: Evidence[]) {
  const byFile = new Map<string, string[]>();
  for (const item of evidence)
    byFile.set(item.file, [...(byFile.get(item.file) ?? []), item.title]);
  return [...byFile].map(
    ([file, titles]) =>
      `- [${file.split("/").pop()}](../${file}): ${titles.map((title) => `\`${title}\``).join("; ")}`
  );
}
const externalLines = (items: External[] = []) =>
  items.map(
    (item) =>
      `- ${item.state === "verified" ? "נבדק" : "טרם נבדק"}: ${item.what}${item.ref ? ` (${item.ref})` : ""}`
  );
const issue = (number: number) =>
  `[#${number}](https://github.com/ItayBar1/fair-shifts/issues/${number})`;
const gapLines = (entry: Entry) =>
  entry.gap
    ? [`- חוסר: ${entry.gap}${entry.ticket ? ` (${issue(entry.ticket)})` : ""}`]
    : [];

function numbered(
  titles: Map<number, string>,
  entries: Record<number, Entry>,
  heading: string
) {
  return [
    heading,
    "",
    ...[...titles].flatMap(([number, title]) => {
      const entry = entries[number];
      return [
        `### ${number}. ${shorten(title)} — ${statusLabel[entry.status]}`,
        "",
        ...evidenceLines(entry.evidence),
        ...(entry.external?.length
          ? [
              "- ספקים, שרת ופיילוט:",
              ...externalLines(entry.external).map((line) => `  ${line}`),
            ]
          : []),
        ...gapLines(entry),
        "",
      ];
    }),
  ].join("\n");
}
function counts(entries: Record<number, Entry>) {
  const all = Object.values(entries);
  const of = (status: Entry["status"]) =>
    all.filter((entry) => entry.status === status).length;
  return `${all.length} במפה: ${of("covered")} מכוסים, ${of("partial")} חלקיים, ${of("open")} פתוחים`;
}
function grouped<K extends string>(
  keys: K[],
  labels: Record<K, string>,
  evidence: Record<K, Evidence[]>,
  heading: string
) {
  return [
    heading,
    "",
    ...keys.flatMap((key) => [
      `### ${labels[key]}`,
      "",
      ...evidenceLines(evidence[key]),
      "",
    ]),
  ].join("\n");
}
function roleSection() {
  const lines: string[] = [];
  for (const state of map.roleStates) {
    const cells = map.roleMatrix[state];
    const same = map.roleKeys.every(
      (role) =>
        JSON.stringify(cells[role]) === JSON.stringify(cells[map.roleKeys[0]])
    );
    if (same)
      lines.push(
        `### ${stateLabel[state]}: כל ארבעת התפקידים`,
        "",
        ...evidenceLines(cells.soldier),
        ""
      );
    else
      for (const role of map.roleKeys)
        lines.push(
          `### ${stateLabel[state]}: ${roleLabel[role]}`,
          "",
          ...evidenceLines(cells[role]),
          ""
        );
  }
  return lines.join("\n");
}
function openItems() {
  const items = [
    ...Object.entries(map.stories).map(([id, entry]) => ({
      label: `סיפור ${id}`,
      entry,
    })),
    ...Object.entries(map.scenarios).map(([id, entry]) => ({
      label: `תרחיש ${id}`,
      entry,
    })),
  ].filter(({ entry }) => entry.status !== "covered");
  return items.length
    ? items.map(
        ({ label, entry }) =>
          `- ${label} (${statusLabel[entry.status]}): ${entry.gap}${entry.ticket ? ` (${issue(entry.ticket)})` : ""}`
      )
    : ["- אין חוסר פתוח במפה."];
}

/** The Markdown of docs/acceptance-matrix.md, before formatting. */
export function renderMatrix(prd: string) {
  const { stories, scenarios } = parsePrd(prd);
  return [
    "# מפת קבלה מול בדיקות",
    "",
    "המסמך נוצר אוטומטית מ־`tests/acceptance/acceptance-map.ts` בפקודה `pnpm docs:matrix`, ואין לערוך אותו ביד. הבדיקה `tests/unit/acceptance-matrix.test.ts` מוודאת שכל קובץ ושם בדיקה שמופיעים בו קיימים, שהמספרים זהים לאלה שבאפיון (סעיפים 4 ו־9), ושהמסמך שבמאגר שווה למה שהמפה מייצרת. כרטיס [#38](https://github.com/ItayBar1/fair-shifts/issues/38).",
    "",
    "**איך קוראים.** ״מכוסה״: לכל סעיף בסיפור או בתרחיש יש בדיקה אוטומטית. ״חלקי״ ו״פתוח״: השורה ״חוסר״ אומרת מה אין לו בדיקה, ובפתוח גם איזה כרטיס יסגור זאת. בדיקה נקראת לפי הקובץ וחלק משמה, כך שבדיקה שנמחקה או ששמה שונה שוברת את הבדיקה של המפה. תוצאות מול ספק, שרת ופיילוט מופיעות בנפרד בשורה ״ספקים, שרת ופיילוט״: ״נבדק״ מתועד ב[מצב הפרויקט](../config/memory/project-state.md), ״טרם נבדק״ עדיין לא נעשה. מעבר בדיקה אוטומטית אינו הוכחה שקיימת הפעלה בשרת או בפיילוט.",
    "",
    `סיפורים: ${counts(map.stories)}. תרחישי קבלה: ${counts(map.scenarios)}.`,
    "",
    "## מה עדיין פתוח",
    "",
    ...openItems(),
    "",
    numbered(stories, map.stories, "## סיפורי משתמש"),
    "",
    numbered(scenarios, map.scenarios, "## תרחישי קבלה"),
    "",
    "## תפקידים ומצבים",
    "",
    "חייל, שני האחראים והמנהל הטכני, בכל אחד מהמצבים: מותר, אסור, מצב ריק, טעינה, שגיאה וגרסה שהשתנתה. הבדיקות ב־`tests/integration/role-matrix.test.ts` (שרת) וב־`tests/e2e/screens-sweep.spec.ts` (דפדפן) רצות לכל תפקיד בנפרד.",
    "",
    roleSection(),
    "",
    grouped(
      Object.keys(aspectLabel) as map.Aspect[],
      aspectLabel,
      map.aspects,
      "## תרחישים רוחביים 2, 33 ו־35"
    ),
    "",
    grouped(
      Object.keys(recoveryLabel) as map.Recovery[],
      recoveryLabel,
      map.recovery,
      "## השבתה, ניסיונות חוזרים, שחזור ושליטה באקראיות ובשעון"
    ),
    "",
    "## ספקים, שרת ופיילוט",
    "",
    ...externalLines(map.external),
    "",
  ].join("\n");
}
