"use client";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  rows,
} from "@/client/types";
import { ActionDialog, Badge, Empty, Panel, Notice } from "../ui";
import { CatalogEntryAdd, PersonnelHistory } from "../personnel-history";
import {
  WindowsEditor,
  describeWindow,
  newWindow,
  windowsOf,
} from "../eligibility-conditions";

/** An hours exemption carries fixed daily windows (decision 226). */
export const isHours = (entry: Row) => rows(entry.windows).length > 0;
const catalogKindLabel = (entry: Row) =>
  entry.kind === "capability"
    ? "כשירות"
    : isHours(entry)
      ? "פטור שעות"
      : "פטור";
/**
 * Creates or edits an hours exemption: a name and the windows every duty of a
 * soldier who holds it must fall in. A changed window reaches every soldier
 * who holds it and flags assignments that no longer fit.
 */
function HoursExemptionDialog({
  action,
  entry,
}: {
  action: Action;
  entry?: Row;
}) {
  const [windows, setWindows] = useState(() =>
    entry ? windowsOf(entry.windows) : [newWindow()]
  );
  return (
    <ActionDialog
      title={entry ? `עריכת ${str(entry.name)}` : "פטור שעות חדש"}
      action={action}
      type="eligibility.catalog.save"
      payload={
        entry ? { id: entry.id, kind: "exemption" } : { kind: "exemption" }
      }
      version={entry ? num(entry.version) : undefined}
      onOpen={() =>
        setWindows(entry ? windowsOf(entry.windows) : [newWindow()])
      }
      transform={(values) => ({
        name: values.name,
        description: values.description,
        windows,
      })}
      description="פטור שעות חל על כל התורנויות של החייל שמחזיק בו, בתוקף שנקבע בשיוך. כל חלק מהתורנות חייב להיות בתוך אחד החלונות, לפי שעון ישראל. חלון שחוצה חצות שייך ליום שבו הוא מתחיל. חריגה אפשרית רק בשיבוץ ידני, עם אישור ונימוק."
      fields={[
        {
          name: "name",
          label: "שם הפטור",
          required: true,
          value: str(entry?.name),
        },
        {
          name: "description",
          label: "הסבר לשימוש",
          type: "textarea",
          full: true,
          value: str(entry?.description),
        },
        {
          name: "windows",
          label: "חלונות השעות המותרים",
          type: "custom",
          custom: <WindowsEditor windows={windows} onChange={setWindows} />,
        },
      ]}
    />
  );
}
export function EligibilityView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const catalogs = rows(state.eligibilityCatalog);
  const [catalogId, setCatalogId] = useState("");
  // Opened from a soldier's profile: the assignment form starts with that
  // soldier. The view renders only in the browser, after the state loads.
  const [preset] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URLSearchParams(window.location.search).get("soldier") ?? "")
  );
  const listed = state.soldiers.filter(
    (person) =>
      !person.deletedAt &&
      (catalogId
        ? [person.capabilities, person.exemptions].some((value) =>
            rows(value).some(
              (entry) => (entry.capabilityId ?? entry.exemptionId) === catalogId
            )
          )
        : [person.capabilities, person.exemptions, person.inactivePeriods].some(
            (value) => rows(value).length
          ))
  );
  return (
    <>
      <Notice>
        כשירויות ופטורים מוזנים לאחר בדיקת האחראי, עם תאריך התחלה ותאריך סיום.
        בלי תאריך סיום הם קבועים. כשירות נדרשת חייבת להיות בתוקף לכל משך
        התורנות; פטור חוסם את סוגי התורנות שסימנו אותו, אם הוא חל בחלק מהתורנות.
        פטור שעות חל על כל התורנויות: כל חלק מהתורנות חייב להיות בתוך החלון שלו.
        שינוי נתונים מסמן שיבוצים שנפגעו לטיפול ואינו מבטל אותם אוטומטית.
      </Notice>
      <div className="two-columns">
        <Panel
          title="סוגי פטורים וכשירויות"
          actions={
            <div className="inline">
              <HoursExemptionDialog action={action} />
              <ActionDialog
                title="הגדרה חדשה"
                fields={[
                  {
                    name: "kind",
                    label: "סוג ההגדרה",
                    type: "select",
                    required: true,
                    options: [
                      { value: "capability", label: "כשירות" },
                      { value: "exemption", label: "פטור" },
                    ],
                  },
                  { name: "name", label: "שם", required: true },
                  {
                    name: "description",
                    label: "הסבר לשימוש",
                    type: "textarea",
                    full: true,
                  },
                ]}
                action={action}
                type="eligibility.catalog.save"
              />
            </div>
          }
        >
          {catalogs.length ? (
            catalogs.map((c) => (
              <div className="task-item" key={c.id}>
                <span className="task-symbol teal">
                  <ShieldCheck size={20} />
                </span>
                <span>
                  <strong>{str(c.name)}</strong>
                  <small>{str(c.description)}</small>
                  {isHours(c) && (
                    <small>
                      {rows(c.windows).map(describeWindow).join(" · ")}
                    </small>
                  )}
                </span>
                <Badge>{catalogKindLabel(c)}</Badge>
                {isHours(c) ? (
                  <HoursExemptionDialog action={action} entry={c} />
                ) : (
                  <ActionDialog
                    title={`עריכת ${str(c.name)}`}
                    action={action}
                    type="eligibility.catalog.save"
                    payload={{ id: c.id, kind: c.kind }}
                    version={c.version}
                    fields={[
                      {
                        name: "name",
                        label: "שם ההגדרה",
                        required: true,
                        value: str(c.name),
                      },
                      {
                        name: "description",
                        label: "הסבר לשימוש",
                        type: "textarea",
                        full: true,
                        value: str(c.description),
                      },
                    ]}
                  />
                )}
              </div>
            ))
          ) : (
            <Empty
              title="הקטלוג עדיין ריק"
              text="מגדירים כשירות (למשל מטווחים או רישיון נהיגה) או פטור, ואז משייכים אותם לחיילים ולסוגי תורנות."
            />
          )}
        </Panel>
        <Panel
          title="שיוך לחייל"
          subtitle="תחילת התוקף היא היום כברירת מחדל; בלי תאריך סיום השיוך קבוע"
        >
          <CatalogEntryAdd
            key={preset}
            state={state}
            action={action}
            presetSoldierId={preset || undefined}
          />
        </Panel>
      </div>
      <Panel
        title="כשירויות ופטורים קיימים"
        actions={
          <select
            aria-label="סינון לפי סוג מהקטלוג"
            value={catalogId}
            onChange={(e) => setCatalogId(e.target.value)}
          >
            <option value="">כל השיוכים ותקופות אי־הפעילות</option>
            {catalogs.map((c) => (
              <option key={c.id} value={c.id}>
                {str(c.name)} · {catalogKindLabel(c)}
              </option>
            ))}
          </select>
        }
      >
        {!listed.length && (
          <Empty
            title={catalogId ? "אין חיילים עם השיוך הזה" : "אין שיוכים קיימים"}
            text="לאחר שיוך לחייל אפשר לשנות תוקף או להסיר, עם בדיקת ההשפעה על השיבוצים."
          />
        )}
        {listed.map((person) => (
          <div className="subsection" key={person.id}>
            <h3>{str(person.name)}</h3>
            <PersonnelHistory
              state={state}
              action={action}
              person={person}
              catalogId={catalogId}
            />
          </div>
        ))}
      </Panel>
    </>
  );
}
