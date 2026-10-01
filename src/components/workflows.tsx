"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  type AppState,
  type Action,
  str,
  num,
  rows,
  obj,
  displayDate,
  personName,
} from "@/client/types";
import {
  emailTypeLabels,
  preferencesPayload,
  reminderHoursText,
  hiddenPreferenceTypes,
} from "@/client/notifications";
import { preferenceTypes } from "@/domain/notification-preferences";
import {
  Badge,
  Panel,
  Empty,
  Form,
  QuickAction,
  Notice,
  type Field,
} from "./ui";
import { TransferRequests } from "./transfers";
import { SwapRequests } from "./swaps";
import { AuditLink, ledgerSource } from "./audit";
import { effectiveDiffers } from "@/domain/time";
import { CancellationRequests } from "./cancellation-requests";
import { MailHealthRow, MailPanel } from "./mail-operations";
import { BackupsView, BackupFreshnessBadge } from "./backups";
type Props = { state: AppState; action: Action };
export { ConstraintsView } from "./constraints";
export function RequestsView({ state, action }: Props) {
  return (
    <>
      <Notice>
        העברת תורנות, החלפה הדדית בהסכמה ובקשות ביטול או דחייה לפני התחלה
        זמינות. החלפה במהלך ביצוע נמצאת עדיין בבנייה.
      </Notice>
      <CancellationRequests state={state} action={action} />
      <TransferRequests state={state} action={action} />
      <SwapRequests state={state} action={action} />
    </>
  );
}
export function NotificationsView({ state, action }: Props) {
  const notifications = state.notifications;
  return (
    <Panel title="מרכז הודעות">
      {notifications.length ? (
        notifications.map((row) => (
          <article className="task-item" key={row.id}>
            <div className="grow">
              <h3>{str(row.title)}</h3>
              <p>{str(row.body)}</p>
              {row.href && str(row.href).startsWith("/") ? (
                <a className="text-link" href={str(row.href)}>
                  פתיחת הפרטים
                </a>
              ) : null}
            </div>
            {!row.readAt && (
              <QuickAction
                action={action}
                type="notification.read"
                payload={{ id: row.id }}
                version={row.version}
              >
                סימון כנקראה
              </QuickAction>
            )}
            <QuickAction
              action={action}
              type="notification.hide"
              payload={{ id: row.id }}
              version={row.version}
            >
              הסתרה
            </QuickAction>
          </article>
        ))
      ) : (
        <Empty title="אין הודעות להצגה" />
      )}
    </Panel>
  );
}
export function SettingsView({ state, action }: Props) {
  const settings = state.settings;
  const defaults = obj(state.notificationDefaults);
  return (
    <>
      {state.actor.role === "manager" && (
        <Panel title="תחום האחריות שלי">
          <p className="muted">
            קובע אילו אוכלוסיות יוצגו כברירת מחדל ברשימת החיילים. זהו סינון
            תצוגה בלבד: תמיד אפשר להציג את כולם, ושני האחראים מנהלים את כל
            החיילים. גם המנהל הטכני יכול לשנות את התחום.
          </p>
          <ResponsibilitySelect
            id={state.actor.id}
            label="תחום האחריות שלי"
            value={state.actor.responsibility}
            version={state.actor.responsibilityVersion}
            action={action}
          />
        </Panel>
      )}
      <Panel title="העדפות הודעות">
        <p className="muted">
          הודעות האתר נשמרות תמיד. המתגים קובעים אילו הודעות יישלחו גם במייל.
          שעות התזכורת חלות על תזכורות האתר והמייל. קוד כניסה, הזמנה ואימות מייל
          נשלחים תמיד.
        </p>
        <Notice tone={settings.source === "personal" ? "info" : "success"}>
          {settings.source === "personal"
            ? "שמרת העדפות אישיות. שינוי בברירות המחדל של היחידה לא יחול עליך."
            : "חלות עליך ברירות המחדל של היחידה. אם האחראי ישנה אותן, השינוי יחול גם עליך."}
        </Notice>
        <PreferencesForm
          key={`${str(settings.source)}-${num(settings.version)}-${num(defaults.version)}`}
          values={settings}
          role={state.actor.role}
          submitLabel="שמירת העדפות אישיות"
          onSubmit={(payload) =>
            action(
              "settings.save",
              payload,
              typeof settings.version === "number"
                ? settings.version
                : undefined
            )
          }
        />
        {settings.source === "personal" && (
          <QuickAction
            action={action}
            type="settings.reset"
            payload={{}}
            version={num(settings.version)}
          >
            חזרה לברירות המחדל של היחידה
          </QuickAction>
        )}
      </Panel>
      {state.actor.role === "manager" && (
        <Panel title="ברירות מחדל להודעות ביחידה">
          <p className="muted">
            חלות על כל מי שלא שמר העדפות אישיות. מי ששמר העדפות אישיות ממשיך
            לקבל את מה שבחר.
          </p>
          <PreferencesForm
            key={`defaults-${num(defaults.version)}`}
            values={defaults}
            role="manager"
            submitLabel="שמירת ברירות המחדל"
            onSubmit={(payload) =>
              action(
                "notification.defaults.save",
                payload,
                typeof defaults.version === "number"
                  ? defaults.version
                  : undefined
              )
            }
          />
        </Panel>
      )}
    </>
  );
}
function PreferencesForm({
  values,
  role,
  submitLabel,
  onSubmit,
}: {
  values: Record<string, unknown>;
  role: unknown;
  submitLabel: string;
  onSubmit: (payload: Record<string, unknown>) => Promise<unknown>;
}) {
  const email = obj(values.email);
  const hidden = hiddenPreferenceTypes(role);
  return (
    <Form
      submitLabel={submitLabel}
      fields={[
        {
          name: "reminderHours",
          label: "שעות לפני תורנות, מופרדות בפסיק",
          hint: "עד שלוש תזכורות, בשעות שלמות בין 1 ל־168. שדה ריק: ללא תזכורות.",
          value: reminderHoursText(values.reminderHours),
        },
        ...preferenceTypes
          .filter((type) => !hidden.includes(type))
          .map((type): Field => ({
            name: `email.${type}`,
            label: `מייל: ${emailTypeLabels[type]}`,
            type: "checkbox",
            value: email[type] !== false,
          })),
      ]}
      onSubmit={(form) => onSubmit(preferencesPayload(form, hidden, email))}
    />
  );
}
export function ScoresView({ state, action }: Props) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [input, setInput] = useState<Record<string, unknown> | null>(null);
  const fields: Field[] = [
    {
      name: "soldierIds",
      label: "חיילים לשינוי היתרה",
      type: "multiselect",
      required: true,
      options: state.soldiers
        .filter((row) => !row.deletedAt)
        .map((row) => ({ value: row.id, label: str(row.name) })),
    },
    {
      name: "operation",
      label: "פעולה",
      type: "select",
      required: true,
      options: [
        { value: "add", label: "הוספת נקודות" },
        { value: "subtract", label: "הפחתת נקודות" },
        { value: "set", label: "קביעת יתרה" },
        { value: "percent", label: "הפחתת אחוזים" },
      ],
    },
    { name: "value", label: "ערך", type: "number", min: 0, required: true },
    {
      name: "reason",
      label: "סיבה",
      type: "textarea",
      required: true,
      full: true,
    },
  ];
  return (
    <>
      <Panel title="תיקון יתרה ונרמול קבוצתי">
        <Form
          fields={fields}
          submitLabel="תצוגה מקדימה"
          onSubmit={async (values) => {
            const command = values;
            setPreview(null);
            const result = await action("score.preview", command);
            setInput(command);
            setPreview(result);
          }}
        />
        {preview && (
          <div className="result-box">
            {rows(preview.rows).map((row) => (
              <p key={str(row.soldierId)}>
                {personName(state, row.soldierId)}: {num(row.before)} ←{" "}
                {num(row.after)}
              </p>
            ))}
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  await action("score.apply", {
                    ...input,
                    token: preview.token,
                  });
                  setPreview(null);
                } catch {
                  /* Workspace renders errors. */
                }
              }}
            >
              אישור שינוי היתרה
            </button>
          </div>
        )}
      </Panel>
      <Panel title="יומן ניקוד">
        {state.ledger.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>חייל</th>
                  <th>מועד תחולה</th>
                  <th>נרשם</th>
                  <th>שינוי</th>
                  <th>יתרה</th>
                  <th>סיבה</th>
                  <th>תיעוד</th>
                </tr>
              </thead>
              <tbody>
                {state.ledger.map((row) => (
                  <tr key={row.id}>
                    <td>{personName(state, row.soldierId)}</td>
                    <td>{displayDate(row.effectiveAt, true)}</td>
                    <td>
                      {effectiveDiffers(
                        str(row.effectiveAt),
                        str(row.recordedAt)
                      )
                        ? displayDate(row.recordedAt, true)
                        : "באותו מועד"}
                    </td>
                    <td>{num(row.amount)}</td>
                    <td>{num(row.after)}</td>
                    <td>{str(row.reason)}</td>
                    <td>
                      {ledgerSource(row) ? (
                        <AuditLink id={ledgerSource(row)} />
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="אין פעולות ניקוד" />
        )}
      </Panel>
    </>
  );
}
export { ImportsView } from "./imports";
export { AuditView } from "./audit";
export function TechnicalView({
  state,
  action,
  path,
}: Props & { path: string }) {
  if (path.endsWith("/backups"))
    return (
      <>
        <BackupsView state={state} action={action} />
        <Notice>
          שחזור מגיבוי למסד מבודד ובדיקת הנתונים לפני פתיחה נמצאים עדיין בבנייה.
        </Notice>
      </>
    );
  if (path.endsWith("/recovery"))
    return (
      <Panel title="שחזור גישה">
        <p>
          קודי שחזור חד־פעמיים מופקים בעת הקמת המנהל הטכני ונשמרים בנפרד. כל קוד
          תקף פעם אחת, משחרר נעילה ומחייב התחברות מחדש.
        </p>
        <p>
          אם אין קוד זמין, מפעיל השרת מריץ שחזור מתועד עם סיבה (
          <code dir="ltr">pnpm recover</code>). השחזור מנתק את כל החיבורים, מבטל
          את הקודים הקודמים ומפיק קודים חדשים.
        </p>
      </Panel>
    );
  if (path.endsWith("/mail")) return <MailPanel mail={obj(state.mail)} />;
  const accounts = state.accounts.filter(
    (row) => !path.endsWith("/locked") || row.lockedAt
  );
  return (
    <>
      {path === "/technical" && (
        <HealthPanel
          health={obj(state.health)}
          backups={obj(state.backups)}
          mail={obj(state.mail)}
          deletionLog={obj(state.deletionLog)}
          restoreDrill={obj(state.restoreDrill)}
          now={new Date(str(state.serverNow)).getTime()}
        />
      )}
      <AccountsPanel accounts={accounts} action={action} />
    </>
  );
}

const healthLabels: Record<string, [string, string]> = {
  ok: ["תקין", "success"],
  degraded: ["דורש בדיקה", "warning"],
  unavailable: ["לא זמין", "danger"],
  paused: ["מושהה לשחזור", "warning"],
  stale: ["מתעכב", "danger"],
  missing: ["לא דיווח", "danger"],
};
function HealthBadge({ value }: { value: unknown }) {
  const [label, tone] = healthLabels[str(value)] ?? [
    str(value, "—"),
    "neutral",
  ];
  return <Badge tone={tone}>{label}</Badge>;
}
// Values sit in one wrapper so task-item's second-child rule does not stretch badges.
function HealthRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="task-item">
      <strong className="grow">{label}</strong>
      <div className="inline">{children}</div>
    </div>
  );
}
/**
 * The independent deletion log (decision 196): whether deletions reach it, and
 * whether the copy in storage and the last check agree.
 */
function DeletionLogRow({ log }: { log: Record<string, unknown> }) {
  const pending = num(log.pending);
  const unverified = obj(log.verified).status === "unverified";
  const [label, tone] = !log.enabled
    ? ["כבוי", "danger"]
    : log.lastError
      ? ["תקלה בכתיבה", "danger"]
      : unverified
        ? ["לא אומת", "danger"]
        : pending > 0
          ? [`${pending} ממתינות לכתיבה`, "warning"]
          : log.storageCopy === "none"
            ? ["ללא עותק ב־Drive", "warning"]
            : log.storageCopy === "behind"
              ? ["העותק ב־Drive מתעכב", "warning"]
              : ["תקין", "success"];
  return (
    <HealthRow label="יומן מחיקות עצמאי">
      <Badge tone={tone}>{label}</Badge>
      <span>
        {num(log.entries)} רישומים
        {log.verifiedAt ? ` · נבדק ${displayDate(log.verifiedAt, true)}` : ""}
      </span>
    </HealthRow>
  );
}
/**
 * The quarterly restore drill (decision 200): when a backup was last restored
 * and checked end to end, and whether the next one is overdue.
 */
function RestoreDrillRow({ drill }: { drill: Record<string, unknown> }) {
  const state = str(drill.state);
  const failed = drill.lastOutcome === "failed";
  const [label, tone] =
    state === "disabled"
      ? ["אין גיבוי", "neutral"]
      : state === "overdue"
        ? [`באיחור: ${num(drill.daysSince)} ימים`, "danger"]
        : state === "ok"
          ? ["תקין", "success"]
          : ["טרם בוצע", "warning"];
  return (
    <HealthRow label="תרגיל שחזור אחרון">
      <Badge tone={tone}>{label}</Badge>
      <span>
        {drill.lastPassedAt
          ? `הצליח ${displayDate(drill.lastPassedAt, true)}`
          : state === "disabled"
            ? ""
            : "אין תרגיל מוצלח"}
        {drill.restorePoint
          ? ` · גיבוי מ־${displayDate(drill.restorePoint, true)}`
          : ""}
      </span>
      {failed && <Badge tone="warning">הניסיון האחרון נכשל</Badge>}
      {drill.lastOutcome === "needs_deletion_log" && (
        <Badge tone="warning">יומן המחיקות לא אומת בניסיון האחרון</Badge>
      )}
    </HealthRow>
  );
}
function HealthPanel({
  health,
  backups,
  mail,
  deletionLog,
  restoreDrill,
  now,
}: {
  health: Record<string, unknown>;
  backups: Record<string, unknown>;
  mail: Record<string, unknown>;
  deletionLog: Record<string, unknown>;
  restoreDrill: Record<string, unknown>;
  now: number;
}) {
  const worker = obj(health.worker);
  return (
    <Panel
      title="מצב המערכת"
      subtitle={`נבדק ${displayDate(health.checkedAt, true)}`}
      actions={<HealthBadge value={health.status} />}
    >
      <HealthRow label="גרסת האתר">
        <span dir="ltr">{str(health.version, "—")}</span>
      </HealthRow>
      <HealthRow label="מסד הנתונים">
        <HealthBadge value={health.database} />
      </HealthRow>
      <HealthRow label="עובד הרקע">
        <HealthBadge value={worker.status} />
        <span>פעימה אחרונה: {displayDate(worker.lastBeatAt, true)}</span>
      </HealthRow>
      <HealthRow label="גרסת העובד">
        <span dir="ltr">{str(worker.version, "—")}</span>
        <Badge tone={worker.sameVersion ? "success" : "danger"}>
          {worker.sameVersion ? "זהה לאתר" : "שונה מהאתר"}
        </Badge>
      </HealthRow>
      <HealthRow label="גיבוי אחרון">
        <BackupFreshnessBadge backups={backups} now={now} />
        <Link className="text-link" href="/technical/backups">
          {displayDate(backups.lastVerifiedAt, true)}
        </Link>
      </HealthRow>
      <DeletionLogRow log={deletionLog} />
      <RestoreDrillRow drill={restoreDrill} />
      {worker.status !== "ok" && (
        <Notice tone="warning">
          משימות רקע כמו זקיפה, תזכורות ומשלוח מייל אינן רצות כסדרן. יש לבדוק את
          קונטיינר העובד ואת יומן ההפעלה.
        </Notice>
      )}
      <MailHealthRow mail={mail} />
    </Panel>
  );
}

function AccountsPanel({
  accounts,
  action,
}: {
  accounts: AppState["accounts"];
  action: Action;
}) {
  return (
    <Panel title="חשבונות והרשאות">
      <Notice>
        החשבון הטכני נפרד מרשימת החיילים ומנהל את הרשאות האחראים. אחראי אינו
        משובץ לתורנויות: מינוי חייל מסמן את שיבוציו הקיימים לטיפול האחראים,
        והסרת ההרשאה מחזירה אותו לשיבוץ.
      </Notice>
      {accounts.map((row) => (
        <div className="task-item" key={row.id}>
          <strong className="grow">{str(row.name)}</strong>
          <span>
            {row.role === "technical"
              ? "מנהל טכני"
              : row.role === "manager"
                ? "אחראי תורנויות"
                : "חייל"}
          </span>
          {row.role !== "technical" && (
            <QuickAction
              action={action}
              type="account.role"
              payload={{
                id: row.id,
                role: row.role === "manager" ? "soldier" : "manager",
              }}
              version={row.version}
            >
              {row.role === "manager"
                ? "הסרת הרשאת אחראי"
                : "הענקת הרשאת אחראי"}
            </QuickAction>
          )}
          {row.role === "manager" && (
            <ResponsibilitySelect
              id={row.id}
              label={`תחום אחריות · ${str(row.name)}`}
              value={row.responsibility}
              version={row.responsibilityVersion}
              action={action}
            />
          )}
          {row.lockedAt ? <Badge tone="danger">נעול</Badge> : null}
          {row.lockedAt && row.role === "manager" ? (
            <QuickAction
              action={action}
              type="account.unlock"
              payload={{ id: row.id }}
              version={row.version}
            >
              שחרור חשבון
            </QuickAction>
          ) : row.lockedAt && row.role === "soldier" ? (
            <small>שחרור בידי אחראי התורנויות</small>
          ) : row.lockedAt ? (
            <small>שחרור בקוד שחזור או דרך השרת</small>
          ) : null}
        </div>
      ))}
    </Panel>
  );
}

function ResponsibilitySelect({
  id,
  label,
  value,
  version,
  action,
}: {
  id: string;
  label: string;
  value: unknown;
  version: unknown;
  action: Action;
}) {
  const [pending, setPending] = useState(false);
  return (
    <select
      aria-label={label}
      value={value === "mandatory" || value === "career" ? value : ""}
      disabled={pending}
      onChange={async (e) => {
        setPending(true);
        try {
          await action(
            "account.responsibility",
            { id, responsibility: e.target.value || null },
            num(version)
          );
        } catch {
          /* workspace displays API error */
        } finally {
          setPending(false);
        }
      }}
    >
      <option value="">לא נקבע (כל האוכלוסיות)</option>
      <option value="mandatory">חובה וקמ״א</option>
      <option value="career">קבע / קצינים וקמ״א</option>
    </select>
  );
}
