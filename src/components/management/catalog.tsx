"use client";
import { CatalogImpact } from "../duty-changes";
import { useState } from "react";
import { Plus, Clock3 } from "lucide-react";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  rows,
  obj,
} from "@/client/types";
import {
  Empty,
  Panel,
  Modal,
  Form,
  Notice,
  populations,
  type Field,
} from "../ui";
import { RankRequirements } from "../rank-requirements";
import {
  capabilityOptions,
  describeWeekdays,
  genderHint,
  genders,
} from "../eligibility-conditions";
import type { RankClause } from "@/domain/types";
import { MAX_END_DAYS } from "@/domain/default-hours";
import {
  defaultHoursOf,
  describeDefaultHours,
  readDefaultHours,
  relevantHoursExemptions,
} from "@/client/default-hours";
import {
  describeRest,
  readRestHours,
  restHint,
  restHoursInput,
} from "@/client/rest-duration";
import { isHours } from "./eligibility";

function CatalogForm({
  state,
  initial,
  action,
  onDone,
}: {
  state: AppState;
  initial?: Row;
  action: Action;
  onDone: () => void;
}) {
  const [rankClauses, setRankClauses] = useState<RankClause[]>(
    Array.isArray(initial?.ranks) ? (initial.ranks as RankClause[]) : []
  );
  const [bonus, setBonus] = useState(false);
  const saved = defaultHoursOf(initial);
  const [hoursInput, setHoursInput] = useState({
    start: saved?.startTime ?? "",
    end: saved?.endTime ?? "",
    days: String(saved?.endDays ?? 0),
  });
  const hours = readDefaultHours(
    hoursInput.start,
    hoursInput.end,
    hoursInput.days
  );
  const relevant = hours.hours
    ? relevantHoursExemptions(hours.hours, rows(state.eligibilityCatalog))
    : [];
  const pricing = obj(initial?.pricing);
  const fields: Field[] = [
    {
      name: "name",
      label: "שם סוג התורנות",
      required: true,
      value: str(initial?.name),
    },
    {
      name: "populations",
      label: "אוכלוסיות מותרות",
      type: "multiselect",
      required: true,
      options: populations,
      value: Array.isArray(initial?.populations)
        ? initial.populations.map(String)
        : populations.map((p) => p.value),
    },
    {
      name: "mode",
      label: "אופן התמחור",
      type: "select",
      required: true,
      options: [
        { value: "fixed", label: "מחיר קבוע לביצוע" },
        { value: "daily", label: "מחיר לכל 24 שעות" },
      ],
      value: str(pricing.mode, "fixed"),
    },
    {
      name: "base",
      label: "ניקוד בסיס",
      type: "number",
      required: true,
      min: 0,
      step: "0.01",
      // A new type starts at one point a duty and one a call-up (decision 230).
      value: initial ? num(pricing.base ?? pricing.amount) : 1,
    },
    {
      name: "callUp",
      label: "סכום הזנקה שמור (רשות)",
      type: "number",
      min: 0,
      step: "0.01",
      value: initial ? str(pricing.callUp) : "1",
      hint: "מוצע לאחראי כשהוא מסמן הזנקה; אפשר לשנות, או לרוקן כדי לא לשמור סכום",
    },
    {
      name: "restBefore",
      label: "מנוחה לפני (שעות)",
      value: restHoursInput(num(initial?.restBeforeMinutes)),
      hint: restHint,
    },
    {
      name: "restAfter",
      label: "מנוחה אחרי (שעות)",
      value: restHoursInput(num(initial?.restAfterMinutes)),
      hint: restHint,
    },
    {
      name: "defaultStart",
      label: "שעת התחלה",
      type: "time",
      group: "שעות ברירת מחדל (רשות)",
      value: hoursInput.start,
      hint: "ממלאות מראש מופע חדש; אפשר לשנות במופע",
      onChange: (start) => setHoursInput((input) => ({ ...input, start })),
    },
    {
      name: "defaultEnd",
      label: "שעת סיום",
      type: "time",
      group: "שעות ברירת מחדל (רשות)",
      value: hoursInput.end,
      onChange: (end) => setHoursInput((input) => ({ ...input, end })),
    },
    {
      name: "defaultEndDays",
      label: "ימים עד הסיום",
      type: "number",
      group: "שעות ברירת מחדל (רשות)",
      min: 0,
      max: MAX_END_DAYS,
      value: hoursInput.days,
      hint: "0 — באותו יום, 1 — למחרת",
      onChange: (days) => setHoursInput((input) => ({ ...input, days })),
    },
    {
      name: "defaultHoursRelevance",
      label: "פטורי שעות רלוונטיים",
      type: "custom",
      group: "שעות ברירת מחדל (רשות)",
      custom: hours.error ? (
        <Notice tone="danger">{hours.error}</Notice>
      ) : !hours.hours ? (
        <small className="muted">
          בלי שעות ברירת מחדל מזינים את המועדים בכל מופע
        </small>
      ) : relevant.length ? (
        <Notice tone="warning">
          חייל שמחזיק באחד מפטורי השעות האלה אינו מתאים לתורנות בשעות{" "}
          {describeDefaultHours(hours.hours)}. הוא לא ישובץ אוטומטית, ובשיבוץ
          ידני נדרש אישור חריג:
          <ul>
            {relevant.map((entry) => (
              <li key={entry.id}>
                {entry.name} — בתורנות שמתחילה{" "}
                {entry.weekdays.length === 7
                  ? "בכל יום"
                  : `בימי ${describeWeekdays(entry.weekdays)}`}
              </li>
            ))}
          </ul>
        </Notice>
      ) : (
        <small className="muted">
          אף פטור שעות בקטלוג אינו חוסם תורנות בשעות{" "}
          {describeDefaultHours(hours.hours)}
        </small>
      ),
    },
    {
      name: "description",
      label: "הסבר והנחיות ברירת מחדל",
      type: "textarea",
      full: true,
      value: str(initial?.description),
    },
    {
      name: "exemptionIds",
      label: "פטורים פוסלים",
      type: "multiselect",
      // An hours exemption applies to every duty, so a type does not pick it.
      options: rows(state.eligibilityCatalog)
        .filter((r) => r.kind === "exemption" && !isHours(r))
        .map((r) => ({ value: r.id, label: str(r.name) })),
      value: Array.isArray(initial?.exemptionIds)
        ? initial.exemptionIds.map(String)
        : [],
    },
    {
      name: "genders",
      label: "מגדר מותר",
      type: "multiselect",
      options: genders,
      value: Array.isArray(initial?.genders) ? initial.genders.map(String) : [],
      hint: genderHint,
    },
    {
      name: "capabilityIds",
      label: "כשירויות נדרשות",
      type: "multiselect",
      options: capabilityOptions(state),
      value: Array.isArray(initial?.capabilityIds)
        ? initial.capabilityIds.map(String)
        : [],
      hint: "כל כשירות נדרשת חייבת להיות בתוקף לכל משך התורנות",
    },
  ];
  if (bonus)
    fields.push(
      { name: "bonusName", label: "שם תוספת הזמן", required: true },
      {
        name: "bonusPoints",
        label: "נקודות לתוספת",
        type: "number",
        required: true,
        min: 0,
        step: "0.01",
      },
      {
        name: "windowStart",
        label: "תחילת החלון היומי",
        type: "time",
        required: true,
      },
      {
        name: "windowEnd",
        label: "סיום החלון היומי",
        type: "time",
        required: true,
      },
      {
        name: "bonusDays",
        label: "ימי תחולה",
        hint: "0=ראשון, 6=שבת. מופרדים בפסיק",
        value: "0,1,2,3,4,5,6",
        required: true,
      },
      {
        name: "minimumHours",
        label: "מינימום שעות בחלון",
        type: "number",
        min: 0,
        step: "0.25",
        value: 0,
        hint: "0 — מספיקה חפיפה כלשהי",
      },
      {
        name: "recurrence",
        label: "ספירת התוספת",
        type: "select",
        required: true,
        options: [
          { value: "per_day", label: "לכל חלון יומי מתאים" },
          { value: "once", label: "פעם אחת לביצוע" },
        ],
        value: "per_day",
      }
    );
  return (
    <>
      <Form
        fields={fields}
        onSubmit={async (v) => {
          const defaultHours = readDefaultHours(
            str(v.defaultStart),
            str(v.defaultEnd),
            str(v.defaultEndDays)
          );
          if (defaultHours.error) throw new Error(defaultHours.error);
          const restBefore = readRestHours(str(v.restBefore), "מנוחה לפני");
          const restAfter = readRestHours(str(v.restAfter), "מנוחה אחרי");
          if (restBefore.error) throw new Error(restBefore.error);
          if (restAfter.error) throw new Error(restAfter.error);
          const supplements = bonus
            ? [
                ...rows(pricing.supplements),
                {
                  id: crypto.randomUUID(),
                  name: v.bonusName,
                  points: v.bonusPoints,
                  windowStart: v.windowStart,
                  windowEnd: v.windowEnd,
                  weekdays: str(v.bonusDays).split(",").map(Number),
                  minimumHours: v.minimumHours,
                  recurrence: v.recurrence,
                },
              ]
            : rows(pricing.supplements);
          await action(
            "dutyType.save",
            {
              id: initial?.id,
              name: v.name,
              description: v.description,
              populations: v.populations,
              ranks: rankClauses,
              pricing: {
                mode: v.mode,
                base: v.base,
                callUp: v.callUp,
                supplements,
              },
              restBeforeMinutes: restBefore.minutes,
              restAfterMinutes: restAfter.minutes,
              defaultHours: defaultHours.hours,
              exemptionIds: v.exemptionIds,
              genders: v.genders,
              capabilityIds: v.capabilityIds,
            },
            initial?.version
          );
          onDone();
        }}
      >
        <RankRequirements
          catalog={rows(state.rankCatalog)}
          value={rankClauses}
          onChange={setRankClauses}
          label="תנאי דרגה לסוג התורנות"
        />
        <label className="check-field inline">
          <input
            type="checkbox"
            checked={bonus}
            onChange={(e) => setBonus(e.target.checked)}
          />
          הגדרת תוספת זמן
        </label>
        <p className="muted">
          שינוי המחירון יחול על תורנויות חדשות. מופעים קיימים שומרים את הכללים
          שנקבעו להם.
        </p>
      </Form>
    </>
  );
}
export function CatalogView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const [editing, setEditing] = useState<Row | true | null>(null);
  return (
    <>
      <div className="page-actions">
        <button className="btn primary" onClick={() => setEditing(true)}>
          <Plus size={17} />
          סוג תורנות חדש
        </button>
      </div>
      {state.dutyTypes.length ? (
        <div className="catalog-grid">
          {state.dutyTypes.map((type) => (
            <Panel key={type.id}>
              <div className="catalog-card">
                <h2>{str(type.name)}</h2>
                <p>{str(type.description, "לא נוספו הנחיות")}</p>
                <div className="price-line">
                  <strong>
                    {num(obj(type.pricing).base ?? obj(type.pricing).amount)}
                  </strong>
                  <span>
                    נקודות{" "}
                    {obj(type.pricing).mode === "daily"
                      ? "ל־24 שעות"
                      : "לביצוע"}
                  </span>
                </div>
                {defaultHoursOf(type) && (
                  <div className="meta-line">
                    <Clock3 size={15} />
                    שעות: {describeDefaultHours(defaultHoursOf(type)!)}
                  </div>
                )}
                <div className="meta-line">
                  <Clock3 size={15} />
                  מנוחה: {describeRest(num(type.restBeforeMinutes))} לפני ·{" "}
                  {describeRest(num(type.restAfterMinutes))} אחרי
                </div>
                <button
                  className="btn secondary full-width"
                  onClick={() => setEditing(type)}
                >
                  פרטים ועריכה
                </button>
                <CatalogImpact state={state} action={action} catalog={type} />
              </div>
            </Panel>
          ))}
        </div>
      ) : (
        <Panel>
          <Empty
            title="מתחילים בהגדרת סוג תורנות"
            text="מגדירים פעם אחת תנאי התאמה, ניקוד ומנוחה. מספר המקומות והתפקידים נקבעים בכל מופע."
            action={
              <button className="btn primary" onClick={() => setEditing(true)}>
                <Plus size={17} />
                יצירת סוג תורנות
              </button>
            }
          />
        </Panel>
      )}
      {editing && (
        <Modal
          title={editing === true ? "סוג תורנות חדש" : "עריכת סוג תורנות"}
          wide
          onClose={() => setEditing(null)}
        >
          <CatalogForm
            state={state}
            initial={editing === true ? undefined : editing}
            action={action}
            onDone={() => setEditing(null)}
          />
        </Modal>
      )}
    </>
  );
}
