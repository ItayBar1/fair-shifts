"use client";
import { useState } from "react";
import {
  type AppState,
  type Action,
  str,
  num,
  rows,
  displayDate,
  personName,
} from "@/client/types";
import {
  Panel,
  Empty,
  Form,
  QuickAction,
  Status,
  Notice,
  type Field,
} from "./ui";
type Props = { state: AppState; action: Action };
const building = (
  <Notice>
    המסלול הזה נמצא בבנייה. הוא ייפתח לאחר השלמת השמירה ובדיקות התהליך.
  </Notice>
);
export { ConstraintsView } from "./constraints";
export function RequestsView({ state }: Props) {
  return (
    <>
      {building}
      <Panel title="החלפות ובקשות">
        {state.requests.length ? (
          state.requests.map((row) => (
            <div className="task-item" key={row.id}>
              <strong>{str(row.kind)}</strong>
              <Status value={row.status} />
            </div>
          ))
        ) : (
          <Empty title="אין בקשות פתוחות" />
        )}
      </Panel>
    </>
  );
}
export function NotificationsView({ state, action }: Props) {
  const notifications = state.notifications.filter((row) => !row.hiddenAt);
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
  return (
    <Panel title="העדפות הודעות">
      <Notice>ההעדפות נשמרות; מנגנון התזכורות המלא יושלם בשלב 18.</Notice>
      <Form
        fields={[
          {
            name: "emailEnabled",
            label: "קבלת הודעות במייל",
            type: "checkbox",
            value: settings.emailEnabled !== false,
          },
          {
            name: "reminderHours",
            label: "שעות לפני תורנות, מופרדות בפסיק",
            value: Array.isArray(settings.reminderHours)
              ? settings.reminderHours.join(", ")
              : "24, 2",
          },
          {
            name: "roundOpening",
            label: "הודעה על פתיחת סבב",
            type: "checkbox",
            value: settings.roundOpening !== false,
          },
          {
            name: "roundClosing",
            label: "תזכורת לפני סגירת סבב",
            type: "checkbox",
            value: settings.roundClosing !== false,
          },
          {
            name: "publishedChanges",
            label: "עדכוני תורנות שפורסמה",
            type: "checkbox",
            value: settings.publishedChanges !== false,
          },
        ]}
        onSubmit={(values) =>
          action(
            "settings.save",
            {
              ...values,
              reminderHours: str(values.reminderHours)
                .split(",")
                .map((value) => Number(value.trim()))
                .filter((value) => value > 0),
            },
            typeof settings.version === "number" ? settings.version : undefined
          )
        }
      />
    </Panel>
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
                  <th>שינוי</th>
                  <th>יתרה</th>
                  <th>סיבה</th>
                </tr>
              </thead>
              <tbody>
                {state.ledger.map((row) => (
                  <tr key={row.id}>
                    <td>{personName(state, row.soldierId)}</td>
                    <td>{displayDate(row.effectiveAt, true)}</td>
                    <td>{num(row.amount)}</td>
                    <td>{num(row.after)}</td>
                    <td>{str(row.reason)}</td>
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
export function AuditView({ state }: { state: AppState }) {
  return (
    <Panel title="יומן פעולות">
      {state.audit.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>מבצע</th>
                <th>פעולה</th>
                <th>רשומה</th>
              </tr>
            </thead>
            <tbody>
              {state.audit.map((row) => (
                <tr key={row.id}>
                  <td>{str(row.actorName)}</td>
                  <td>{str(row.action)}</td>
                  <td dir="ltr">{str(row.targetId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="אין פעולות להצגה" />
      )}
    </Panel>
  );
}
export function TechnicalView({
  state,
  action,
  path,
}: Props & { path: string }) {
  if (path.endsWith("/backups"))
    return (
      <>
        {building}
        <Panel title="גיבוי ושחזור">
          <Empty
            title="אין גיבויים מאומתים"
            text="אין להשתמש בנתוני אמת לפני השלמת שחזור בדיקה."
          />
        </Panel>
      </>
    );
  if (path.endsWith("/recovery"))
    return (
      <Panel title="שחזור גישה">
        <p>
          קודי שחזור חד־פעמיים מופקים בעת הקמת המנהל הטכני ונשמרים בנפרד. לאחר
          שימוש בקוד יש להתחבר מחדש.
        </p>
      </Panel>
    );
  if (path.endsWith("/mail"))
    return (
      <Panel title="משלוחי מייל">
        {state.operations.length ? (
          state.operations.map((row) => (
            <div className="task-item" key={row.id}>
              <strong>{str(row.kind)}</strong>
              <Status value={row.status} />
              <span>{num(row.attempts)} ניסיונות</span>
            </div>
          ))
        ) : (
          <Empty title="אין משלוחים" />
        )}
      </Panel>
    );
  const accounts = state.accounts.filter(
    (row) => !path.endsWith("/locked") || row.lockedAt
  );
  return (
    <Panel title="חשבונות והרשאות">
      <Notice>החשבון הטכני נפרד מרשימת החיילים ומנהל את הרשאות האחראים.</Notice>
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
          {row.lockedAt && row.role === "manager" ? (
            <QuickAction
              action={action}
              type="account.unlock"
              payload={{ id: row.id }}
              version={row.version}
            >
              שחרור חשבון
            </QuickAction>
          ) : null}
        </div>
      ))}
    </Panel>
  );
}
