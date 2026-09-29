"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import {
  type Action,
  type AppState,
  type Row,
  num,
  obj,
  personName,
  rows,
  str,
} from "@/client/types";
import type { Gender, RankClause, Requirements } from "@/domain/types";
import { Form, Notice } from "./ui";
import { RankRequirements } from "./rank-requirements";
import {
  ConditionToggles,
  capabilityOptions,
  describeWindow,
  genders,
} from "./eligibility-conditions";

type RoleItem = {
  key: string;
  name: string;
  count: number;
  requirements: Requirements;
};
type SurchargeItem = {
  key: string;
  id?: string;
  name: string;
  points: string;
  startTime: string;
  endTime: string;
  weekdays: string[];
  minimumHours: string;
  frequency: "per_window" | "once";
};
const weekdays = [
  { value: "7", label: "ראשון" },
  { value: "1", label: "שני" },
  { value: "2", label: "שלישי" },
  { value: "3", label: "רביעי" },
  { value: "4", label: "חמישי" },
  { value: "5", label: "שישי" },
  { value: "6", label: "שבת" },
];
const everyDay = weekdays.map((day) => day.value);

/** Roles in slot order, each with the conditions saved on its slots. */
export function rolesOf(slots: Row[]): RoleItem[] {
  const roles: RoleItem[] = [];
  for (const slot of slots) {
    const existing = roles.find((role) => role.name === str(slot.role));
    if (existing) existing.count++;
    else
      roles.push({
        key: crypto.randomUUID(),
        name: str(slot.role),
        count: 1,
        requirements: obj(slot.requirements) as Requirements,
      });
  }
  return roles;
}
function surchargesOf(pricing: Row): SurchargeItem[] {
  return rows(pricing.surcharges).map((item) => {
    const window = obj(item.window);
    const threshold = obj(item.threshold);
    return {
      key: item.id,
      id: item.id,
      name: str(item.name),
      points: str(item.points),
      startTime: str(window.startTime),
      endTime: str(window.endTime),
      weekdays: Array.isArray(window.weekdays)
        ? window.weekdays.map(String)
        : everyDay,
      minimumHours:
        threshold.kind === "minimum_hours" ? str(threshold.hours) : "0",
      frequency: item.frequency === "once" ? "once" : "per_window",
    };
  });
}
/** A short Hebrew description of an instance's pricing, for comparisons. */
export function describePricing(pricing: Row) {
  const base = `${str(pricing.basePoints)} ${pricing.mode === "daily" ? "ל־24 שעות" : "לביצוע"}`;
  const extras = rows(pricing.surcharges).map((item) => {
    const threshold = obj(item.threshold);
    return `${str(item.name)}: ${str(item.points)} ${item.frequency === "once" ? "פעם אחת" : "לכל חלון"} (${describeWindow(obj(item.window) as Row)}${threshold.kind === "minimum_hours" ? `, לפחות ${str(threshold.hours)} שעות` : ""})`;
  });
  const callUp =
    Number(pricing.callUpPoints) > 0
      ? [`הזנקה מוצעת: ${str(pricing.callUpPoints)}`]
      : [];
  return [base, ...extras, ...callUp].join(" · ");
}
export function describeComposition(slots: unknown) {
  return rolesOf(rows(slots))
    .map((role) => `${role.name} ×${role.count}`)
    .join(", ");
}

export function CompositionEditor({
  state,
  action,
  change,
  onDone,
}: {
  state: AppState;
  action: Action;
  change: Row;
  onDone: () => void;
}) {
  const proposed = obj(change.proposed);
  const slots = rows(proposed.slots);
  const seats = rows(change.seats);
  const pricing = obj(proposed.pricing) as Row;
  const [roles, setRoles] = useState<RoleItem[]>(() => rolesOf(slots));
  const [surcharges, setSurcharges] = useState<SurchargeItem[]>(() =>
    surchargesOf(pricing)
  );
  const [release, setRelease] = useState<string[]>([]);
  const occupied = slots.flatMap((slot) => {
    const seat = seats.find((seat) => seat.slotId === slot.id);
    return seat?.soldierId
      ? [{ slotId: slot.id, role: str(slot.role), soldierId: seat.soldierId }]
      : [];
  });
  const shortfalls = [...new Set(occupied.map((seat) => seat.role))].flatMap(
    (name) => {
      const holding = occupied.filter(
        (seat) => seat.role === name && !release.includes(seat.slotId)
      ).length;
      const quota = roles.find((role) => role.name === name)?.count ?? 0;
      return holding > quota ? [{ name, excess: holding - quota }] : [];
    }
  );
  const updateRole = (index: number, patch: Partial<RoleItem>) =>
    setRoles(
      roles.map((role, i) => (i === index ? { ...role, ...patch } : role))
    );
  const updateRequirements = (index: number, patch: Requirements) =>
    updateRole(index, {
      requirements: { ...roles[index]!.requirements, ...patch },
    });
  const updateSurcharge = (index: number, patch: Partial<SurchargeItem>) =>
    setSurcharges(
      surcharges.map((item, i) => (i === index ? { ...item, ...patch } : item))
    );
  const catalogOptions = (kind: string) =>
    rows(state.eligibilityCatalog)
      .filter((item) => item.kind === kind)
      .map((item) => ({ value: item.id, label: str(item.name) }));
  return (
    <Form
      fields={[
        {
          name: "mode",
          label: "אופן התמחור במופע",
          type: "select",
          required: true,
          options: [
            { value: "fixed", label: "מחיר קבוע לביצוע" },
            { value: "daily", label: "מחיר לכל 24 שעות" },
          ],
          value: str(pricing.mode, "fixed"),
        },
        {
          name: "basePoints",
          label: "ניקוד בסיס במופע",
          type: "number",
          required: true,
          min: 0,
          step: "0.01",
          value: str(pricing.basePoints),
        },
        {
          name: "callUpPoints",
          label: "סכום הזנקה שמור במופע (רשות)",
          type: "number",
          min: 0,
          step: "0.01",
          value: str(pricing.callUpPoints),
          hint: "מוצע כשמסמנים הזנקה במקום; אינו חל בלי סימון",
        },
        {
          name: "restBeforeMinutes",
          label: "מנוחה לפני (דקות)",
          type: "number",
          min: 0,
          value: num(proposed.restBeforeMinutes),
        },
        {
          name: "restAfterMinutes",
          label: "מנוחה אחרי (דקות)",
          type: "number",
          min: 0,
          value: num(proposed.restAfterMinutes),
        },
      ]}
      submitLabel="שמירת ההרכב והתמחור בהצעה"
      onSubmit={async (values) => {
        await action(
          "duty.change.rules",
          {
            id: change.id,
            roles: roles.map((role) => ({
              name: role.name.trim(),
              count: role.count,
              requirements: role.requirements,
            })),
            releaseSlotIds: release,
            pricing: {
              mode: values.mode,
              basePoints: values.basePoints,
              callUpPoints: values.callUpPoints,
              surcharges: surcharges.map((item) => ({
                id: item.id,
                name: item.name,
                points: item.points,
                window: {
                  startTime: item.startTime,
                  endTime: item.endTime,
                  weekdays: item.weekdays.map(Number),
                },
                threshold:
                  Number(item.minimumHours) > 0
                    ? { kind: "minimum_hours", hours: item.minimumHours }
                    : { kind: "any_overlap" },
                frequency: item.frequency,
              })),
            },
            restBeforeMinutes: num(values.restBeforeMinutes),
            restAfterMinutes: num(values.restAfterMinutes),
          },
          change.version
        );
        onDone();
      }}
    >
      <Notice>
        השינוי חל על מופע זה בלבד. סוג התורנות בקטלוג ומופעים אחרים אינם משתנים.
        הניקוד והשיבוצים משתנים רק לאחר בדיקת ההשפעה ואישור.
      </Notice>
      <div className="subsection">
        <h3>הרכב המופע</h3>
        {roles.map((role, index) => (
          <div className="role-editor" key={role.key}>
            <label className="field">
              <span>שם תפקיד</span>
              <input
                value={role.name}
                required
                onChange={(event) =>
                  updateRole(index, { name: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>מכסה</span>
              <input
                type="number"
                dir="ltr"
                min={1}
                max={120}
                required
                value={role.count}
                onChange={(event) =>
                  updateRole(index, { count: Number(event.target.value) })
                }
              />
            </label>
            <RankRequirements
              catalog={rows(state.rankCatalog)}
              value={(role.requirements.ranks ?? []) as RankClause[]}
              onChange={(ranks) => updateRequirements(index, { ranks })}
              label={`תנאי דרגה לתפקיד ${role.name || index + 1}`}
            />
            <div className="subsection">
              <ConditionToggles
                legend={`מגדר מותר לתפקיד ${role.name || index + 1}`}
                options={genders}
                value={role.requirements.genders ?? []}
                onChange={(value) =>
                  updateRequirements(index, { genders: value as Gender[] })
                }
              />
              <ConditionToggles
                legend={`יכולות נדרשות לתפקיד ${role.name || index + 1}`}
                options={capabilityOptions(state)}
                value={role.requirements.capabilityIds ?? []}
                onChange={(value) =>
                  updateRequirements(index, { capabilityIds: value })
                }
              />
              <ConditionToggles
                legend={`כשירויות נדרשות לתפקיד ${role.name || index + 1}`}
                options={catalogOptions("qualification")}
                value={role.requirements.qualificationIds ?? []}
                onChange={(value) =>
                  updateRequirements(index, { qualificationIds: value })
                }
              />
              <ConditionToggles
                legend={`פטורים פוסלים לתפקיד ${role.name || index + 1}`}
                options={catalogOptions("exemption")}
                value={role.requirements.blockingExemptionIds ?? []}
                onChange={(value) =>
                  updateRequirements(index, { blockingExemptionIds: value })
                }
              />
            </div>
            {roles.length > 1 && (
              <button
                type="button"
                className="btn secondary"
                onClick={() => setRoles(roles.filter((_, i) => i !== index))}
              >
                הסרת התפקיד
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setRoles([
              ...roles,
              {
                key: crypto.randomUUID(),
                name: "",
                count: 1,
                requirements: {},
              },
            ])
          }
        >
          <Plus size={15} />
          הוספת תפקיד
        </button>
      </div>
      {occupied.length > 0 && (
        <fieldset className="toggle-group">
          <legend>שחרור שיבוצים בהפחתת מכסה</legend>
          <p className="muted">
            מקום תפוס אינו מוסר בלי בחירה מפורשת. השחרור יחול רק לאחר בדיקת
            ההשפעה ואישור השינוי.
          </p>
          {occupied.map((seat) => (
            <label key={seat.slotId} className="toggle">
              <input
                type="checkbox"
                checked={release.includes(seat.slotId)}
                onChange={(event) =>
                  setRelease(
                    event.target.checked
                      ? [...release, seat.slotId]
                      : release.filter((id) => id !== seat.slotId)
                  )
                }
              />
              {`${personName(state, seat.soldierId)} (${seat.role})`}
            </label>
          ))}
        </fieldset>
      )}
      {shortfalls.map((item) => (
        <Notice key={item.name} tone="danger">
          {`בתפקיד ${item.name} יש יותר משובצים מהמכסה החדשה. יש לבחור ${item.excess} לשחרור.`}
        </Notice>
      ))}
      <div className="subsection">
        <h3>תוספות זמן במופע</h3>
        {surcharges.map((item, index) => (
          <div className="role-editor" key={item.key}>
            <label className="field">
              <span>שם התוספת</span>
              <input
                value={item.name}
                required
                onChange={(event) =>
                  updateSurcharge(index, { name: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>נקודות</span>
              <input
                type="number"
                dir="ltr"
                min={0}
                step="0.01"
                required
                value={item.points}
                onChange={(event) =>
                  updateSurcharge(index, { points: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>תחילת החלון היומי</span>
              <input
                type="time"
                dir="ltr"
                required
                value={item.startTime}
                onChange={(event) =>
                  updateSurcharge(index, { startTime: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>סיום החלון היומי</span>
              <input
                type="time"
                dir="ltr"
                required
                value={item.endTime}
                onChange={(event) =>
                  updateSurcharge(index, { endTime: event.target.value })
                }
              />
            </label>
            <label className="field">
              <span>מינימום שעות בחלון</span>
              <input
                type="number"
                dir="ltr"
                min={0}
                step="0.25"
                value={item.minimumHours}
                onChange={(event) =>
                  updateSurcharge(index, { minimumHours: event.target.value })
                }
              />
              <small>0 — מספיקה חפיפה כלשהי</small>
            </label>
            <label className="field">
              <span>ספירת התוספת</span>
              <select
                value={item.frequency}
                onChange={(event) =>
                  updateSurcharge(index, {
                    frequency:
                      event.target.value === "once" ? "once" : "per_window",
                  })
                }
              >
                <option value="per_window">לכל חלון יומי מתאים</option>
                <option value="once">פעם אחת לביצוע</option>
              </select>
            </label>
            <ConditionToggles
              legend={`ימי תחולה לתוספת ${item.name || index + 1}`}
              options={weekdays}
              value={item.weekdays}
              onChange={(value) => updateSurcharge(index, { weekdays: value })}
            />
            <button
              type="button"
              className="btn secondary"
              onClick={() =>
                setSurcharges(surcharges.filter((_, i) => i !== index))
              }
            >
              הסרת התוספת
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setSurcharges([
              ...surcharges,
              {
                key: crypto.randomUUID(),
                name: "",
                points: "0",
                startTime: "22:00",
                endTime: "06:00",
                weekdays: everyDay,
                minimumHours: "0",
                frequency: "per_window",
              },
            ])
          }
        >
          <Plus size={15} />
          הוספת תוספת זמן
        </button>
        <p className="muted">
          חלון שחוצה חצות נספר לפי יום תחילתו. הזנקה מסומנת לכל מקום בעריכת
          השיבוצים ואינה משנה את שאר המשתתפים; הסכום השמור רק מוצע.
        </p>
      </div>
    </Form>
  );
}
