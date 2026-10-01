"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import {
  type AppState,
  type Action,
  type Row,
  rows,
  str,
  displayDate,
} from "@/client/types";
import { Badge, Form, Notice } from "./ui";
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

type Window = { startTime: string; endTime: string; weekdays: number[] };
type Limit = {
  key: string;
  id?: string;
  start: string;
  end: string;
  windows: Window[];
};

const newWindow = (): Window => ({
  startTime: "08:00",
  endTime: "17:00",
  weekdays: everyDay,
});
function limitsOf(person: Row): Limit[] {
  return rows(person.allowedHours).map((limit) => ({
    key: limit.id,
    id: limit.id,
    start: str(limit.start),
    end: str(limit.end),
    windows: rows(limit.windows).map((window) => ({
      startTime: str(window.startTime),
      endTime: str(window.endTime),
      weekdays: Array.isArray(window.weekdays)
        ? window.weekdays.map(Number)
        : everyDay,
    })),
  }));
}
export function describeWindow(window: Row) {
  const days = Array.isArray(window.weekdays)
    ? window.weekdays.map(Number)
    : [];
  const names =
    !days.length || days.length === 7
      ? "כל הימים"
      : weekdays
          .filter((day) => days.includes(day.value))
          .map((day) => day.label)
          .join(", ");
  return `${str(window.startTime)}–${str(window.endTime)} · ${names}`;
}

/**
 * The manager replaces a soldier's gender, capabilities and personal hours
 * limits as one set, after reviewing which reserved assignments it affects.
 */
export function SoldierConditions({
  state,
  action,
  person,
}: {
  state: AppState;
  action: Action;
  person: Row;
}) {
  const [gender, setGender] = useState(str(person.gender));
  const [capabilities, setCapabilities] = useState<string[]>(
    Array.isArray(person.capabilities) ? person.capabilities.map(String) : []
  );
  const [limits, setLimits] = useState<Limit[]>(() => limitsOf(person));
  const [draft, setDraft] = useState<{
    payload: Record<string, unknown>;
    version?: number;
    preview: Record<string, unknown>;
  } | null>(null);
  const options = capabilityOptions(state);
  const updateLimit = (key: string, change: Partial<Limit>) =>
    setLimits(
      limits.map((limit) =>
        limit.key === key ? { ...limit, ...change } : limit
      )
    );
  const updateWindow = (
    key: string,
    index: number,
    change: Partial<Window>
  ) => {
    const limit = limits.find((item) => item.key === key)!;
    updateLimit(key, {
      windows: limit.windows.map((window, i) =>
        i === index ? { ...window, ...change } : window
      ),
    });
  };

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
      fields={[
        {
          name: "reason",
          label: "הערת אחראי לשינוי",
          type: "textarea",
          full: true,
        },
      ]}
      submitLabel="בדיקת השפעת השינוי"
      onSubmit={async (values) => {
        const payload = {
          soldierId: person.id,
          gender,
          capabilityIds: capabilities,
          allowedHours: limits.map((limit) => ({
            id: limit.id,
            start: limit.start,
            end: limit.end,
            windows: limit.windows,
          })),
          reason: values.reason,
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
            <option value="">לא הוזן</option>
            {genders.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <ConditionToggles
          legend="יכולות"
          options={options}
          value={capabilities}
          onChange={setCapabilities}
        />
        <h3>הגבלות שעות</h3>
        <p className="muted">
          בתקופת ההגבלה כל תורנות חייבת להיות בתוך החלונות, לכל משכה ולפי שעון
          ישראל. חלון שחוצה חצות שייך ליום שבו התחיל. חריגה אפשרית רק בשיבוץ
          ידני עם אישור ונימוק.
        </p>
        {!limits.length && <p className="muted">אין הגבלות שעות.</p>}
        {limits.map((limit, limitIndex) => (
          <div
            className="role-editor"
            key={limit.key}
            role="group"
            aria-label={`הגבלת שעות ${limitIndex + 1}`}
          >
            <label className="field">
              <span>בתוקף מתאריך</span>
              <input
                type="date"
                required
                value={limit.start}
                onChange={(e) =>
                  updateLimit(limit.key, { start: e.target.value })
                }
              />
            </label>
            <label className="field">
              <span>עד תאריך (כולל)</span>
              <input
                type="date"
                required
                value={limit.end}
                onChange={(e) =>
                  updateLimit(limit.key, { end: e.target.value })
                }
              />
            </label>
            {limit.windows.map((window, index) => (
              <div className="subsection" key={index}>
                <label className="field">
                  <span>משעה</span>
                  <input
                    type="time"
                    required
                    aria-label={`תחילת חלון ${index + 1}`}
                    value={window.startTime}
                    onChange={(e) =>
                      updateWindow(limit.key, index, {
                        startTime: e.target.value,
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>עד שעה</span>
                  <input
                    type="time"
                    required
                    aria-label={`סיום חלון ${index + 1}`}
                    value={window.endTime}
                    onChange={(e) =>
                      updateWindow(limit.key, index, {
                        endTime: e.target.value,
                      })
                    }
                  />
                </label>
                <ConditionToggles
                  legend="ימים"
                  options={weekdays.map((day) => ({
                    value: String(day.value),
                    label: day.label,
                  }))}
                  value={window.weekdays.map(String)}
                  onChange={(days) =>
                    updateWindow(limit.key, index, {
                      weekdays: days.map(Number),
                    })
                  }
                />
                {limit.windows.length > 1 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      updateLimit(limit.key, {
                        windows: limit.windows.filter((_, i) => i !== index),
                      })
                    }
                  >
                    הסרת החלון
                  </button>
                )}
              </div>
            ))}
            <div className="subsection">
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  updateLimit(limit.key, {
                    windows: [...limit.windows, newWindow()],
                  })
                }
              >
                <Plus size={15} />
                הוספת חלון
              </button>
              <button
                type="button"
                className="btn secondary small"
                onClick={() =>
                  setLimits(limits.filter((item) => item.key !== limit.key))
                }
              >
                הסרת ההגבלה
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setLimits([
              ...limits,
              {
                key: crypto.randomUUID(),
                start: "",
                end: "",
                windows: [newWindow()],
              },
            ])
          }
        >
          <Plus size={15} />
          הוספת הגבלת שעות
        </button>
      </div>
    </Form>
  );
}

/** Read-only summary of a soldier's conditions for the profile. */
export function ConditionsSummary({
  state,
  person,
}: {
  state: AppState;
  person: Row;
}) {
  const names = capabilityOptions(state);
  const held = Array.isArray(person.capabilities)
    ? person.capabilities.map(String)
    : [];
  return (
    <div className="stack">
      <div className="history-row">
        <strong>מגדר</strong>
        <span>{genderLabel(person.gender)}</span>
      </div>
      <div className="history-row">
        <strong>יכולות</strong>
        <span>
          {held.length
            ? held.map((id) => (
                <Badge key={id}>
                  {names.find((item) => item.value === id)?.label ??
                    "יכולת מהקטלוג"}
                </Badge>
              ))
            : "אין"}
        </span>
      </div>
      {rows(person.allowedHours).map((limit) => (
        <div className="history-row" key={limit.id}>
          <strong>הגבלת שעות</strong>
          <span>
            {displayDate(limit.start)} — {displayDate(limit.end)} ·{" "}
            {rows(limit.windows).map(describeWindow).join(" ; ")}
          </span>
        </div>
      ))}
    </div>
  );
}
