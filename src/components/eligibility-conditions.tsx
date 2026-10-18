"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import {
  type AppState,
  type Action,
  type Row,
  rows,
  str,
} from "@/client/types";
import { Fields, Form, Notice } from "./ui";
import { ImpactList } from "./personnel-history";

/** Shown beside every gender condition: all three is the same as none (decision 198). */
export const genderHint = "כל המגדרים = ללא תנאי מגדר";
export const genders = [
  { value: "male", label: "זכר" },
  { value: "female", label: "נקבה" },
  { value: "other", label: "אחר" },
];
export const genderLabel = (value: unknown) =>
  genders.find((item) => item.value === value)?.label ?? "לא הוזן";
/** ISO weekdays in the order of the Israeli week. */
const weekdays = [
  { value: 7, label: "ראשון" },
  { value: 1, label: "שני" },
  { value: 2, label: "שלישי" },
  { value: 3, label: "רביעי" },
  { value: 4, label: "חמישי" },
  { value: 5, label: "שישי" },
  { value: 6, label: "שבת" },
];
const everyDay = weekdays.map((day) => day.value);

/** Pill checkboxes for a small set of values, such as genders or capabilities. */
export function ConditionToggles({
  legend,
  options,
  value,
  onChange,
  hint,
}: {
  legend: string;
  options: { value: string; label: string }[];
  value: string[];
  onChange: (value: string[]) => void;
  hint?: string;
}) {
  return (
    <fieldset className="toggle-group">
      <legend>{legend}</legend>
      {options.length ? (
        options.map((option) => (
          <label key={option.value} className="toggle">
            <input
              type="checkbox"
              checked={value.includes(option.value)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, option.value]
                    : value.filter((item) => item !== option.value)
                )
              }
            />
            {option.label}
          </label>
        ))
      ) : (
        <span className="muted">אין ערכים בקטלוג</span>
      )}
      {hint && <small className="muted">{hint}</small>}
    </fieldset>
  );
}

export const capabilityOptions = (state: AppState) =>
  rows(state.eligibilityCatalog)
    .filter((item) => item.kind === "capability")
    .map((item) => ({ value: item.id, label: str(item.name) }));

export type Window = { startTime: string; endTime: string; weekdays: number[] };

export const newWindow = (): Window => ({
  startTime: "08:00",
  endTime: "17:00",
  weekdays: everyDay,
});
/** The windows stored on a catalog entry, ready for the editor. */
export function windowsOf(value: unknown): Window[] {
  return rows(value).map((window) => ({
    startTime: str(window.startTime),
    endTime: str(window.endTime),
    weekdays: Array.isArray(window.weekdays)
      ? window.weekdays.map(Number)
      : everyDay,
  }));
}
/** ISO weekdays as names in the order of the Israeli week; none or all is every day. */
export function describeWeekdays(days: number[]) {
  return !days.length || days.length === 7
    ? "כל הימים"
    : weekdays
        .filter((day) => days.includes(day.value))
        .map((day) => day.label)
        .join(", ");
}
export function describeWindow(window: Row) {
  const days = Array.isArray(window.weekdays)
    ? window.weekdays.map(Number)
    : [];
  return `${str(window.startTime)}–${str(window.endTime)} · ${describeWeekdays(days)}`;
}

/**
 * The manager changes a soldier's gender after reviewing which reserved
 * assignments it affects. Capabilities and exemptions, hours exemptions among
 * them (decision 226), are dated entries on the eligibility screen.
 */
export function SoldierConditions({
  action,
  person,
}: {
  action: Action;
  person: Row;
}) {
  const [gender, setGender] = useState(str(person.gender));
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState<{
    payload: Record<string, unknown>;
    version?: number;
    preview: Record<string, unknown>;
  } | null>(null);

  if (draft) {
    const impact = rows(draft.preview.impact);
    const affected = impact.filter((item) => item.affected === true);
    return (
      <div className="stack" role="region" aria-label="השפעת שינוי תנאי ההתאמה">
        <h3>שיבוצים שהשינוי משפיע עליהם</h3>
        <ImpactList
          impact={affected}
          empty="השינוי אינו משנה את ההתאמה של שיבוצים קיימים."
        />
        {impact.length > affected.length && (
          <p className="muted">
            שיבוצים נוספים שנבדקו ואינם מושפעים:{" "}
            {impact.length - affected.length}
          </p>
        )}
        <Notice>
          השיבוצים נשארים בתוקף. שיבוץ שנפגע יסומן ״דורש טיפול״ באותה שמירה;
          אילוצים, יתרה והיסטוריה אינם משתנים.
        </Notice>
        <Form
          fields={[
            {
              name: "confirmed",
              label: "בדקתי את ההשפעה ומאשר את שינוי תנאי ההתאמה",
              type: "checkbox",
              required: true,
            },
          ]}
          submitLabel="אישור שינוי התנאים"
          onSubmit={async (confirmation) => {
            await action(
              "soldier.conditions",
              {
                ...draft.payload,
                ...confirmation,
                previewToken: draft.preview.previewToken,
              },
              draft.version
            );
            setDraft(null);
          }}
        />
        <button className="btn secondary" onClick={() => setDraft(null)}>
          חזרה לעריכה
        </button>
      </div>
    );
  }
  return (
    <Form
      fields={[]}
      submitLabel="בדיקת השפעת השינוי"
      onSubmit={async () => {
        const payload = {
          soldierId: person.id,
          gender,
          reason,
        };
        const preview = await action(
          "soldier.conditions.preview",
          payload,
          person.version
        );
        setDraft({ payload, version: person.version, preview });
      }}
    >
      <div className="stack">
        <label className="field">
          <span>מגדר</span>
          <select
            aria-label="מגדר"
            value={gender}
            onChange={(e) => setGender(e.target.value)}
          >
            {!person.gender && <option value="">לא הוזן</option>}
            {genders.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <Fields
          fields={[
            {
              name: "reason",
              label: "הערת אחראי לשינוי",
              type: "textarea",
              full: true,
              onChange: setReason,
            },
          ]}
        />
      </div>
    </Form>
  );
}

/**
 * The daily windows of an hours exemption (decision 226): every part of a duty
 * must fall in one of them, by Israel time. A window that crosses midnight
 * belongs to the day it starts.
 */
export function WindowsEditor({
  windows,
  onChange,
}: {
  windows: Window[];
  onChange: (windows: Window[]) => void;
}) {
  const update = (index: number, change: Partial<Window>) =>
    onChange(
      windows.map((window, i) =>
        i === index ? { ...window, ...change } : window
      )
    );
  return (
    <div className="stack" role="group" aria-label="חלונות השעות המותרים">
      <strong>חלונות השעות המותרים</strong>
      {windows.map((window, index) => (
        <div className="subsection" key={index}>
          <label className="field">
            <span>משעה</span>
            <input
              type="time"
              required
              aria-label={`תחילת חלון ${index + 1}`}
              value={window.startTime}
              onChange={(e) => update(index, { startTime: e.target.value })}
            />
          </label>
          <label className="field">
            <span>עד שעה</span>
            <input
              type="time"
              required
              aria-label={`סיום חלון ${index + 1}`}
              value={window.endTime}
              onChange={(e) => update(index, { endTime: e.target.value })}
            />
          </label>
          <ConditionToggles
            legend="ימים"
            options={weekdays.map((day) => ({
              value: String(day.value),
              label: day.label,
            }))}
            value={window.weekdays.map(String)}
            onChange={(days) => update(index, { weekdays: days.map(Number) })}
          />
          {windows.length > 1 && (
            <button
              type="button"
              className="text-button"
              onClick={() => onChange(windows.filter((_, i) => i !== index))}
            >
              הסרת החלון
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="text-button"
        onClick={() => onChange([...windows, newWindow()])}
      >
        <Plus size={15} />
        הוספת חלון
      </button>
    </div>
  );
}
