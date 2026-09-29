"use client";
import {
  type AppState,
  type Action,
  str,
  num,
  rows,
  obj,
  displayDate,
} from "@/client/types";
import { failureLabels, type BackupFailureCode } from "@/domain/backup";
import { backupFreshness, formatBytes } from "@/client/backups";
import { Badge, Panel, Empty, Notice, QuickAction } from "./ui";

const runStatus: Record<string, [string, string]> = {
  pending: ["ממתין", "warning"],
  running: ["רץ", "warning"],
  verified: ["אומת", "success"],
  failed: ["נכשל", "danger"],
  deleted: ["נמחק", "neutral"],
};
const storageLabels: Record<string, string> = {
  drive: "Google Drive",
  directory: "תיקייה מקומית (בדיקות)",
  none: "כבוי בסביבה הזאת",
};
const deleteReasons: Record<string, string> = {
  retention: "מעבר ל־30 עותקים",
  space: "פינוי מקום לגיבוי חדש",
};

const freshnessLabels: Record<string, [string, string]> = {
  ok: ["עדכני", "success"],
  stale: ["ישן מיממה וחצי", "danger"],
  missing: ["אין גיבוי מאומת", "danger"],
  disabled: ["כבוי", "warning"],
};
export function BackupFreshnessBadge({
  backups,
  now,
}: {
  backups: Record<string, unknown>;
  now: number;
}) {
  const [label, tone] = freshnessLabels[backupFreshness(backups, now)];
  return <Badge tone={tone}>{label}</Badge>;
}

function failureText(code: unknown) {
  return failureLabels[code as BackupFailureCode] ?? str(code, "—");
}

export function BackupsView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const backups = obj(state.backups);
  const runs = rows(backups.runs);
  const now = new Date(str(state.serverNow)).getTime();
  const active = runs.some((row) =>
    ["pending", "running"].includes(str(row.status))
  );
  const kind = str(backups.kind, "none");
  return (
    <>
      <Panel
        title="גיבוי יומי מוצפן"
        actions={<BackupFreshnessBadge backups={backups} now={now} />}
      >
        <div className="task-item">
          <strong className="grow">יעד</strong>
          <span>{storageLabels[kind] ?? kind}</span>
          {kind !== "none" && (
            <Badge tone={backups.storageConfigured ? "success" : "danger"}>
              {backups.storageConfigured ? "מוגדר" : "חסרות הגדרות"}
            </Badge>
          )}
        </div>
        <div className="task-item">
          <strong className="grow">מפתח הצפנה ציבורי (age)</strong>
          <Badge tone={backups.keyConfigured ? "success" : "danger"}>
            {backups.keyConfigured ? "מוגדר" : "חסר"}
          </Badge>
        </div>
        <div className="task-item">
          <strong className="grow">מועד</strong>
          <span>כל יום ב־{str(backups.time)} שעון ישראל</span>
        </div>
        <div className="task-item">
          <strong className="grow">גיבוי מאומת אחרון</strong>
          <span>{displayDate(backups.lastVerifiedAt, true)}</span>
        </div>
        <div className="task-item">
          <strong className="grow">עותקים שמורים</strong>
          <span>
            {num(backups.retained)} מתוך עד {num(backups.max)}, בכפוף למקום
            הפנוי
          </span>
        </div>
        {kind === "none" ? (
          <Notice tone="warning">
            הגיבוי כבוי בסביבה הזאת. אין להכניס נתוני אמת לפני הפעלת גיבוי
            ושחזור בדיקה.
          </Notice>
        ) : (
          <div className="inline">
            {active ? (
              <span className="muted">גיבוי ממתין או רץ כעת.</span>
            ) : (
              <QuickAction
                action={action}
                type="backup.request"
                payload={{}}
                className="primary"
              >
                גיבוי עכשיו
              </QuickAction>
            )}
          </div>
        )}
        <p className="muted">
          ״אומת״ פירושו שהקובץ המוצפן נקרא בחזרה מהיעד ושגודלו וחתימת SHA-256
          שלו זהים למה שהוצפן בשרת. מפתח הפענוח אינו נשמר בשרת. שחזור בדיקה
          רבעוני למסד מבודד נדרש בנפרד.
        </p>
      </Panel>
      <Panel title="ריצות אחרונות">
        {runs.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>נוצרה</th>
                  <th>סוג</th>
                  <th>מצב</th>
                  <th>ניסיונות</th>
                  <th>גודל</th>
                  <th>פירוט</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((row) => {
                  const [label, tone] = runStatus[str(row.status)] ?? [
                    str(row.status),
                    "neutral",
                  ];
                  return (
                    <tr key={row.id}>
                      <td>{displayDate(row.createdAt, true)}</td>
                      <td>{row.trigger === "manual" ? "ידני" : "יומי"}</td>
                      <td>
                        <Badge tone={tone}>{label}</Badge>
                      </td>
                      <td>{num(row.attempts)}</td>
                      <td>{formatBytes(row.sizeBytes)}</td>
                      <td>
                        {row.status === "deleted"
                          ? (deleteReasons[str(row.deleteReason)] ?? "נמחק")
                          : row.errorCode
                            ? `${failureText(row.errorCode)}${
                                row.status === "pending"
                                  ? ` · ניסיון נוסף ${displayDate(row.nextAttemptAt, true)}`
                                  : ""
                              }`
                            : row.status === "verified"
                              ? `הסתיים ${displayDate(row.finishedAt, true)}`
                              : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="עדיין לא בוצע גיבוי"
            text="אין להשתמש בנתוני אמת לפני גיבוי מאומת ושחזור בדיקה."
          />
        )}
      </Panel>
    </>
  );
}
