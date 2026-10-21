"use client";
import { useState } from "react";
import Link from "next/link";
import { type AppState, type Action, str } from "@/client/types";
import { Empty, Panel, Form } from "../ui";
import { DutyList, dutyStatus } from "../views";
import { PeriodPlanning } from "../planning";
import { defaultHoursRange } from "@/domain/default-hours";
import { RolesEditor, type RoleItem } from "../instance-composition";
import { defaultHoursOf, describeDefaultHours } from "@/client/default-hours";

/**
 * A new instance starts from its type's default hours when the type has them
 * (decision 229): a start date fills both moments, and each stays editable.
 */
function NewDutyForm({ state, action }: { state: AppState; action: Action }) {
  const [typeId, setTypeId] = useState("");
  const [date, setDate] = useState("");
  const [times, setTimes] = useState({ start: "", end: "" });
  // Seats are set on the instance, not in the catalog (decision 232).
  const [seats, setSeats] = useState("1");
  const [roles, setRoles] = useState<RoleItem[] | null>(null);
  const typeHours = (id: string) =>
    defaultHoursOf(state.dutyTypes.find((type) => type.id === id));
  const hours = typeHours(typeId);
  const fill = (day: string, from = hours) => {
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(day))
      setTimes(defaultHoursRange(day, from));
  };
  const moment = (name: "start" | "end", label: string) => (
    <label className="field">
      <span>
        {label}
        <span aria-hidden="true" className="required">
          {" "}
          *
        </span>
      </span>
      <input
        aria-label={label}
        type="datetime-local"
        dir="ltr"
        required
        value={times[name]}
        onChange={(e) => setTimes({ ...times, [name]: e.target.value })}
      />
    </label>
  );
  return (
    <Form
      fields={[
        {
          name: "typeId",
          label: "סוג תורנות",
          type: "select",
          required: true,
          options: state.dutyTypes.map((t) => ({
            value: t.id,
            label: str(t.name),
          })),
          onChange: (id) => {
            setTypeId(id);
            fill(date, typeHours(id));
          },
        },
        { name: "name", label: "שם המופע", required: true },
        {
          name: "times",
          label: "מועדי התורנות",
          type: "custom",
          custom: (
            <div className="form-grid">
              {hours && (
                <label className="field full">
                  <span>תאריך התחלה</span>
                  <input
                    aria-label="תאריך התחלה"
                    type="date"
                    dir="ltr"
                    value={date}
                    onChange={(e) => {
                      setDate(e.target.value);
                      fill(e.target.value);
                    }}
                  />
                  <small>
                    ממלא את המועדים לפי שעות ברירת המחדל של הסוג:{" "}
                    {describeDefaultHours(hours)}. אפשר לשנות אותם.
                  </small>
                </label>
              )}
              {moment("start", "תחילת התורנות")}
              {moment("end", "סיום התורנות")}
            </div>
          ),
        },
        {
          name: "composition",
          label: "מקומות ותפקידים",
          type: "custom",
          custom: (
            <div className="subsection">
              {roles ? (
                <RolesEditor state={state} roles={roles} onChange={setRoles} />
              ) : (
                <label className="field">
                  <span>
                    מספר מקומות
                    <span aria-hidden="true" className="required">
                      {" "}
                      *
                    </span>
                  </span>
                  <input
                    aria-label="מספר מקומות"
                    type="number"
                    dir="ltr"
                    min={1}
                    max={120}
                    required
                    value={seats}
                    onChange={(e) => setSeats(e.target.value)}
                  />
                </label>
              )}
              <label className="check-field inline">
                <input
                  type="checkbox"
                  checked={Boolean(roles)}
                  onChange={(e) => {
                    if (e.target.checked)
                      setRoles([
                        {
                          key: crypto.randomUUID(),
                          name: "תורן",
                          count: Number(seats) || 1,
                          requirements: {},
                        },
                      ]);
                    else {
                      setSeats(
                        String(
                          roles?.reduce((sum, role) => sum + role.count, 0) || 1
                        )
                      );
                      setRoles(null);
                    }
                  }}
                />
                חלוקה לתפקידים, עם מכסה ותנאי התאמה לכל תפקיד
              </label>
            </div>
          ),
        },
        { name: "location", label: "מיקום", required: true },
        {
          name: "instructions",
          label: "הנחיות",
          type: "textarea",
          full: true,
        },
      ]}
      onSubmit={(v) =>
        action("duty.create", {
          ...v,
          times: undefined,
          composition: undefined,
          start: times.start,
          end: times.end,
          roles: roles
            ? roles.map((role) => ({
                name: role.name.trim(),
                count: role.count,
                requirements: role.requirements,
              }))
            : [{ name: "תורן", count: Number(seats) }],
        })
      }
      submitLabel="יצירת טיוטה"
    />
  );
}
export function PlanningView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  // One task at a time (decision 242): a new duty, or filling a period.
  // "#period" opens the second, so a link can lead straight to it.
  const [mode, setMode] = useState<"new" | "period">(() =>
    typeof window !== "undefined" && window.location.hash === "#period"
      ? "period"
      : "new"
  );
  const tabs = [
    { id: "new" as const, label: "תורנות חדשה" },
    { id: "period" as const, label: "מילוי חוסרים לתקופה" },
  ];
  return (
    <>
      <div className="ledger-tabs" role="tablist" aria-label="מה מתכננים">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`planning-tab-${tab.id}`}
            aria-selected={mode === tab.id}
            aria-controls={`planning-panel-${tab.id}`}
            className={mode === tab.id ? "selected" : ""}
            onClick={() => setMode(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`planning-panel-${mode}`}
        aria-labelledby={`planning-tab-${mode}`}
      >
        {mode === "new" ? (
          <Panel
            title="תורנות חדשה"
            subtitle="המופע יישמר כטיוטה משותפת לאחראים"
          >
            {state.dutyTypes.length ? (
              <NewDutyForm state={state} action={action} />
            ) : (
              <Empty
                title="צריך להגדיר קודם סוג תורנות"
                action={
                  <Link className="btn primary" href="/manage/catalog">
                    לקטלוג התורנויות
                  </Link>
                }
              />
            )}
          </Panel>
        ) : (
          <PeriodPlanning state={state} action={action} />
        )}
      </div>
      <Panel
        title="תורנויות בתכנון"
        subtitle="פתיחת תורנות מאפשרת שיבוץ ידני, הגרלה ופרסום"
      >
        <DutyList
          state={state}
          duties={state.duties.filter((d) => dutyStatus(d) !== "cancelled")}
        />
      </Panel>
    </>
  );
}
