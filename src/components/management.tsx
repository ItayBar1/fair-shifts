"use client";
import { CatalogImpact } from "./duty-changes";
import { useState } from "react";
import Link from "next/link";
import {
  Search,
  Plus,
  CalendarDays,
  ShieldCheck,
  ArrowLeft,
  Clock3,
} from "lucide-react";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  rows,
  obj,
  population,
  displayDate,
} from "@/client/types";
import {
  ActionDialog,
  Badge,
  Empty,
  Panel,
  Status,
  Modal,
  Form,
  Notice,
  populations,
  type Field,
} from "./ui";
import { DutyList, dutyStatus } from "./views";
import {
  defaultPopulations,
  filterSoldiers,
  rankTracks,
} from "@/client/soldier-filters";
import { RankRequirements } from "./rank-requirements";
import { PeriodPlanning } from "./planning";
import { AddPeriod, PersonnelHistory, ProfileEdit } from "./personnel-history";
import { AuditLink } from "./audit";
import {
  ConditionToggles,
  ConditionsSummary,
  SoldierConditions,
  capabilityOptions,
  genders,
} from "./eligibility-conditions";
import type { Gender, RankClause, Requirements } from "@/domain/types";
const soldierFields = (s?: Row): Field[] => [
  { name: "name", label: "שם מלא", required: true, value: str(s?.name) },
  {
    name: "personalNumber",
    label: "מספר אישי",
    required: true,
    value: str(s?.personalNumber),
    hint: "נשמר כטקסט, כולל אפסים בתחילת המספר",
  },
  {
    name: "email",
    label: "מייל מאושר להזמנה",
    type: "email",
    required: !s,
    value: str(s?.email),
  },
  {
    name: "population",
    label: "אוכלוסיית שיבוץ",
    type: "select",
    required: true,
    options: populations,
    value: str(s?.population),
  },
  {
    name: "serviceType",
    label: "סוג שירות",
    type: "select",
    required: true,
    options: [
      { value: "mandatory", label: "חובה" },
      { value: "career", label: "קבע" },
    ],
    value: str(s?.serviceType, "mandatory"),
  },
  { name: "phone", label: "טלפון", value: str(s?.phone) },
  {
    name: "enlistmentDate",
    label: "תאריך גיוס",
    type: "date",
    value: str(s?.enlistmentDate),
  },
  {
    name: "arrivalDate",
    label: "תאריך הגעה ליחידה",
    type: "date",
    value: str(s?.arrivalDate),
  },
  {
    name: "releaseDate",
    label: "יום אחרון בשירות",
    type: "date",
    value: str(s?.releaseDate),
  },
  {
    name: "officerDate",
    label: "תחילת קצונה רגילה",
    type: "date",
    value: str(s?.officerDate),
  },
  {
    name: "permanentDate",
    label: "תחילת שירות קבע",
    type: "date",
    value: str(s?.permanentDate),
  },
  {
    name: "graceEligible",
    label: "זכאי לחודש חסד מתאריך ההגעה",
    type: "checkbox",
    value: Boolean(s?.graceEligible),
    hint: "קליטת רשומה קיימת אינה מעניקה חסד אוטומטי",
  },
  {
    name: "address",
    label: "כתובת (רשות)",
    full: true,
    value: str(s?.address),
  },
  {
    name: "currentScore",
    label: "יתרת פתיחה",
    type: "number",
    min: 0,
    value: num(s?.currentScore ?? s?.score),
  },
];
/** Service dates derived by the server, shown so a manager sees them before planning. */
function ServiceDates({ person }: { person: Row }) {
  const facts = [
    person.serviceStatus === "service_ended" &&
      "השירות הסתיים והגישה לחשבון חסומה. הרשומה וההיסטוריה נשמרות; מחיקה היא החלטה נפרדת של אחראי.",
    person.graceUntil &&
      `חודש חסד: הזמינות לשיבוץ חוזרת ב־${displayDate(person.graceUntil)}. בסיומו אין איזון יתרה אוטומטי.`,
    person.releaseDate &&
      person.serviceStatus !== "service_ended" &&
      `יום אחרון בשירות ${displayDate(person.releaseDate)}; הגישה נחסמת בחצות שאחריו. תורנות שמתחילה מ־${displayDate(person.preReleaseFrom)} מחייבת אישור נקודתי.`,
  ].filter((fact): fact is string => Boolean(fact));
  if (!facts.length) return null;
  return (
    <Notice
      tone={person.serviceStatus === "service_ended" ? "warning" : "info"}
    >
      {facts.map((fact) => (
        <span className="service-fact" key={fact}>
          {fact}
        </span>
      ))}
    </Notice>
  );
}
export function SoldiersView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const [search, setSearch] = useState("");
  const defaults = defaultPopulations(state.actor.responsibility);
  const [shown, setShown] = useState<string[]>(defaults);
  const [rank, setRank] = useState("");
  const tracks = rankTracks(rows(state.rankCatalog));
  const [selectedRecord, setSelected] = useState<Row | null>(null);
  const selected = selectedRecord
    ? (state.soldiers.find((person) => person.id === selectedRecord.id) ??
      selectedRecord)
    : null;
  const filtered = filterSoldiers(state.soldiers, {
    search,
    populations: shown,
    rank,
  });
  const isDefault =
    !rank &&
    shown.length === defaults.length &&
    defaults.every((value) => shown.includes(value));
  return (
    <>
      <Panel
        title="חיילי היחידה"
        subtitle="נתוני השירות משמשים לבדיקת התאמה במועד התורנות"
        actions={
          <ActionDialog
            title="הוספת חייל"
            fields={soldierFields()}
            action={action}
            type="soldier.create"
            description="לאחר הקליטה החייל יוכל להתחבר באמצעות המייל המאושר."
          />
        }
      >
        <div className="filters">
          <label className="search">
            <Search size={17} />
            <input
              aria-label="חיפוש חייל לפי שם או מספר אישי"
              placeholder="שם או מספר אישי…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <fieldset className="toggle-group">
            <legend>אוכלוסיות מוצגות</legend>
            {populations.map((p) => (
              <label key={p.value} className="toggle">
                <input
                  type="checkbox"
                  checked={shown.includes(p.value)}
                  onChange={(e) =>
                    setShown(
                      e.target.checked
                        ? [...shown, p.value]
                        : shown.filter((value) => value !== p.value)
                    )
                  }
                />
                {p.label}
              </label>
            ))}
          </fieldset>
          <select
            aria-label="סינון לפי דרגה נוכחית"
            value={rank}
            onChange={(e) => setRank(e.target.value)}
          >
            <option value="">כל הדרגות</option>
            <option value="missing">דרגה חסרה</option>
            {tracks.map((t) => (
              <optgroup key={t.track} label={`מסלול ${t.track}`}>
                <option value={`track:${t.track}`}>
                  כל הדרגות במסלול {t.track}
                </option>
                {t.ranks.map((r) => (
                  <option key={r.id} value={`rank:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {!isDefault && (
            <button
              className="btn small secondary"
              onClick={() => {
                setShown(defaults);
                setRank("");
              }}
            >
              חזרה לברירת המחדל
            </button>
          )}
          <span className="muted" role="status">
            {filtered.length} חיילים מוצגים
          </span>
        </div>
        <p className="muted filter-note">
          הסינון משנה את התצוגה בלבד. שני האחראים רשאים לנהל את כל החיילים.
        </p>
        {filtered.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>שם</th>
                  <th>מספר אישי</th>
                  <th>אוכלוסייה</th>
                  <th>דרגה</th>
                  <th>שחרור</th>
                  <th>מצב</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="person">
                        <span className="avatar small">
                          {str(s.name).slice(0, 1)}
                        </span>
                        <strong>{str(s.name)}</strong>
                      </span>
                    </td>
                    <td dir="ltr">{str(s.personalNumber)}</td>
                    <td>{population(s.population)}</td>
                    <td>
                      {s.rankId ? (
                        <>
                          {str(s.rankName)}{" "}
                          <small className="muted">
                            · מסלול {str(s.rankTrack)}
                          </small>
                        </>
                      ) : (
                        <Badge tone="warning">דרגה חסרה</Badge>
                      )}
                    </td>
                    <td>{displayDate(s.releaseDate)}</td>
                    <td>
                      <Status value={s.serviceStatus || "active"} />
                    </td>
                    <td>
                      <button
                        className="btn small secondary"
                        onClick={() => setSelected(s)}
                      >
                        פרופיל ועריכה
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="לא נמצאו חיילים"
            text="מוסיפים חייל יחיד או מייבאים את רשימת היחידה מ־Excel."
            action={
              <Link className="text-link" href="/manage/imports">
                לייבוא חיילים <ArrowLeft size={15} />
              </Link>
            }
          />
        )}
      </Panel>
      {selected && (
        <Modal
          title={`פרופיל חייל · ${str(selected.name)}`}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="tabs-heading">
            <Badge>{population(selected.population)}</Badge>
            <Status value={selected.serviceStatus || "active"} />
            <span className="muted">
              מספר אישי {str(selected.personalNumber)}
            </span>
            <AuditLink id={selected.id} label="יומן הפעולות של החייל" />
          </div>
          <ServiceDates person={selected} />
          <ProfileEdit
            person={selected}
            fields={soldierFields(selected).filter(
              (f) => !["email", "currentScore"].includes(f.name)
            )}
            action={action}
            onDone={() => setSelected(null)}
          />
          <details className="disclosure">
            <summary>מועדי שירות, כשירות והיסטוריה</summary>
            <div className="stack">
              <PersonnelHistory
                state={state}
                action={action}
                person={selected}
              />
              {["populationHistory", "rankHistory"].map((key) =>
                rows(selected[key]).map((entry, i) => (
                  <div className="history-row" key={`${key}-${i}`}>
                    <strong>
                      {str(
                        entry.name ??
                          entry.value ??
                          entry.population ??
                          rows(state.rankCatalog).find(
                            (item) => item.id === entry.rankId
                          )?.name,
                        "תקופת שירות"
                      )}
                    </strong>
                    <span>בתוקף מ־{displayDate(entry.effectiveFrom)}</span>
                  </div>
                ))
              )}
              <h3>מעבר אוכלוסיית שיבוץ</h3>
              <AddPeriod
                state={state}
                action={action}
                fixed={{ soldierId: selected.id, kind: "population" }}
                fields={[
                  {
                    name: "value",
                    label: "אוכלוסייה חדשה",
                    type: "select",
                    required: true,
                    options: populations,
                  },
                  {
                    name: "startDate",
                    label: "בתוקף מתאריך",
                    type: "date",
                    required: true,
                  },
                  {
                    name: "reason",
                    label: "סיבת המעבר",
                    type: "textarea",
                    required: true,
                    full: true,
                  },
                ]}
                submitLabel="בדיקת השפעת המעבר"
              />
              <h3>הוספת תקופת אי־פעילות</h3>
              <AddPeriod
                state={state}
                action={action}
                fixed={{ soldierId: selected.id, kind: "inactive" }}
                fields={[
                  {
                    name: "startDate",
                    label: "אי־פעילות מתאריך",
                    type: "date",
                    required: true,
                  },
                  {
                    name: "endDate",
                    label: "אי־פעילות עד תאריך (כולל)",
                    type: "date",
                    required: true,
                  },
                  {
                    name: "reason",
                    label: "סיבת אי־הפעילות",
                    type: "textarea",
                    required: true,
                    full: true,
                  },
                ]}
                submitLabel="בדיקת השפעת אי־הפעילות"
              />
            </div>
          </details>
          <details className="disclosure">
            <summary>תנאי התאמה אישיים: מגדר, יכולות ושעות</summary>
            <div className="stack">
              <ConditionsSummary state={state} person={selected} />
              <SoldierConditions
                key={String(selected.version)}
                state={state}
                action={action}
                person={selected}
              />
            </div>
          </details>
          <details className="disclosure">
            <summary>ניהול כתובת מייל וחשבון</summary>
            <div className="stack">
              <ActionDialog
                title="שינוי כתובת מייל"
                fields={[
                  {
                    name: "email",
                    label: "כתובת המייל החדשה",
                    type: "email",
                    required: true,
                  },
                  { name: "reason", label: "סיבת השינוי", required: true },
                ]}
                action={action}
                type="account.email.request"
                payload={{ soldierId: selected.id }}
                version={selected.version}
                description="נשלח אימות לכתובת החדשה. החיבורים הקיימים יבוטלו לאחר האימות, וקישור Google ייבדק מחדש."
              />
              <ActionDialog
                title="אימות כתובת חדשה"
                fields={[
                  {
                    name: "code",
                    label: "קוד שנשלח לכתובת החדשה",
                    required: true,
                  },
                  {
                    name: "disconnectGoogle",
                    label:
                      "הבנתי שקישור Google הישן יוסר וכל החיבורים הקיימים יבוטלו",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                action={action}
                type="account.email.confirm"
                payload={{ soldierId: selected.id }}
                version={selected.version}
              />
              <ActionDialog
                title="מחיקת משתמש"
                buttonLabel="מחיקת המשתמש והמידע הרגיש"
                fields={[
                  {
                    name: "reason",
                    label: "סיבת המחיקה",
                    type: "textarea",
                    required: true,
                    full: true,
                  },
                  {
                    name: "confirmed",
                    label:
                      "הבנתי שפרטי הקשר והמידע הרגיש יימחקו, שיבוצים עתידיים יתפנו וההיסטוריה הנדרשת תישמר",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                action={action}
                type="soldier.delete"
                payload={{ id: selected.id }}
                version={selected.version}
                danger
              />
            </div>
          </details>
        </Modal>
      )}
    </>
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
  const peopleWithPeriods = state.soldiers.filter(
    (person) =>
      !person.deletedAt &&
      [person.qualifications, person.exemptions, person.inactivePeriods].some(
        (value) => rows(value).length
      )
  );
  return (
    <>
      <Notice>
        פטורים, כשירויות ויכולות מוזנים לאחר בדיקת האחראי. יכולות משויכות לחייל
        בפרופיל שלו, בלי תוקף. שינוי נתונים מסמן שיבוצים שנפגעו לטיפול ואינו
        מבטל אותם אוטומטית.
      </Notice>
      <div className="two-columns">
        <Panel
          title="סוגי פטורים, כשירויות ויכולות"
          actions={
            <ActionDialog
              title="הגדרה חדשה"
              fields={[
                {
                  name: "kind",
                  label: "סוג ההגדרה",
                  type: "select",
                  required: true,
                  options: [
                    { value: "qualification", label: "כשירות נדרשת" },
                    { value: "exemption", label: "פטור" },
                    { value: "capability", label: "יכולת (ללא תוקף)" },
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
                </span>
                <Badge>
                  {c.kind === "exemption"
                    ? "פטור"
                    : c.kind === "capability"
                      ? "יכולת"
                      : "כשירות"}
                </Badge>
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
              </div>
            ))
          ) : (
            <Empty
              title="הקטלוג עדיין ריק"
              text="מגדירים סוג פטור או כשירות, ואז משייכים אותו לחיילים ולסוגי תורנות."
            />
          )}
        </Panel>
        <Panel title="שיוך לחייל" subtitle="תוקף הכשירות נבדק לכל משך התורנות">
          <AddPeriod
            state={state}
            action={action}
            fields={[
              {
                name: "soldierId",
                label: "חייל",
                type: "select",
                required: true,
                options: state.soldiers
                  .filter((s) => !s.deletedAt)
                  .map((s) => ({ value: s.id, label: str(s.name) })),
              },
              {
                name: "kind",
                label: "מה משייכים",
                type: "select",
                required: true,
                options: [
                  { value: "qualification", label: "כשירות" },
                  { value: "exemption", label: "פטור" },
                ],
              },
              {
                name: "value",
                label: "סוג מהקטלוג",
                type: "select",
                required: true,
                options: catalogs
                  .filter((c) => c.kind !== "capability")
                  .map((c) => ({
                    value: c.id,
                    label: str(c.name),
                  })),
              },
              {
                name: "startDate",
                label: "תחילת תוקף",
                type: "date",
                required: true,
              },
              {
                name: "endDate",
                label: "סיום תוקף (כולל)",
                type: "date",
                required: true,
              },
              {
                name: "reason",
                label: "הערת אחראי",
                type: "textarea",
                full: true,
              },
            ]}
            submitLabel="בדיקת השפעת השיוך"
          />
        </Panel>
      </div>
      <Panel title="תקופות קיימות ועריכה">
        {!peopleWithPeriods.length && (
          <Empty
            title="אין תקופות קיימות"
            text="לאחר שיוך לחייל אפשר לשנות תוקף או להסיר תקופה, עם בדיקת ההשפעה על השיבוצים."
          />
        )}
        {peopleWithPeriods.map((person) => (
          <div className="subsection" key={person.id}>
            <h3>{str(person.name)}</h3>
            <PersonnelHistory state={state} action={action} person={person} />
          </div>
        ))}
      </Panel>
    </>
  );
}
export { RanksView } from "./ranks";
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
  const [roleItems, setRoles] = useState<
    { id: string; name: string; count: number; requirements: Requirements }[]
  >(
    initial
      ? rows(initial.roles).map((r) => ({
          id: str(r.id, crypto.randomUUID()),
          name: str(r.name),
          count: num(r.count, 1),
          requirements: obj(r.requirements),
        }))
      : [{ id: crypto.randomUUID(), name: "תורן", count: 1, requirements: {} }]
  );
  const [bonus, setBonus] = useState(false);
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
      value: num(pricing.base ?? pricing.amount),
    },
    {
      name: "callUp",
      label: "סכום הזנקה שמור (רשות)",
      type: "number",
      min: 0,
      step: "0.01",
      value: str(pricing.callUp),
      hint: "מוצע לאחראי כשהוא מסמן הזנקה; אפשר לאשר או להזין סכום אחר",
    },
    {
      name: "restBeforeMinutes",
      label: "מנוחה לפני (דקות)",
      type: "number",
      min: 0,
      value: num(initial?.restBeforeMinutes),
    },
    {
      name: "restAfterMinutes",
      label: "מנוחה אחרי (דקות)",
      type: "number",
      min: 0,
      value: num(initial?.restAfterMinutes),
    },
    {
      name: "description",
      label: "הסבר והנחיות ברירת מחדל",
      type: "textarea",
      full: true,
      value: str(initial?.description),
    },
    {
      name: "qualificationIds",
      label: "כשירויות נדרשות",
      type: "multiselect",
      options: rows(state.eligibilityCatalog)
        .filter((r) => r.kind === "qualification")
        .map((r) => ({ value: r.id, label: str(r.name) })),
      value: Array.isArray(initial?.qualificationIds)
        ? initial.qualificationIds.map(String)
        : [],
    },
    {
      name: "exemptionIds",
      label: "פטורים פוסלים",
      type: "multiselect",
      options: rows(state.eligibilityCatalog)
        .filter((r) => r.kind === "exemption")
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
      hint: "ללא בחירה — ללא תנאי מגדר",
    },
    {
      name: "capabilityIds",
      label: "יכולות נדרשות",
      type: "multiselect",
      options: capabilityOptions(state),
      value: Array.isArray(initial?.capabilityIds)
        ? initial.capabilityIds.map(String)
        : [],
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
              restBeforeMinutes: v.restBeforeMinutes,
              restAfterMinutes: v.restAfterMinutes,
              qualificationIds: v.qualificationIds,
              exemptionIds: v.exemptionIds,
              genders: v.genders,
              capabilityIds: v.capabilityIds,
              roles: roleItems,
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
        <div className="subsection">
          <h3>הרכב התורנות</h3>
          {roleItems.map((role, i) => (
            <div className="role-editor" key={role.id}>
              <label className="field">
                <span>שם תפקיד</span>
                <input
                  value={role.name}
                  required
                  onChange={(e) =>
                    setRoles(
                      roleItems.map((r, index) =>
                        index === i ? { ...r, name: e.target.value } : r
                      )
                    )
                  }
                />
              </label>
              <label className="field">
                <span>מקומות</span>
                <input
                  type="number"
                  min={1}
                  max={120}
                  required
                  value={role.count}
                  onChange={(e) =>
                    setRoles(
                      roleItems.map((r, index) =>
                        index === i
                          ? { ...r, count: Number(e.target.value) }
                          : r
                      )
                    )
                  }
                />
              </label>
              <RankRequirements
                catalog={rows(state.rankCatalog)}
                value={role.requirements.ranks ?? []}
                onChange={(ranks) =>
                  setRoles(
                    roleItems.map((r, index) =>
                      index === i
                        ? { ...r, requirements: { ...r.requirements, ranks } }
                        : r
                    )
                  )
                }
                label={`תנאי דרגה לתפקיד ${i + 1}`}
              />
              <div className="subsection">
                <ConditionToggles
                  legend={`מגדר מותר לתפקיד ${i + 1}`}
                  options={genders}
                  value={role.requirements.genders ?? []}
                  onChange={(value) =>
                    setRoles(
                      roleItems.map((r, index) =>
                        index === i
                          ? {
                              ...r,
                              requirements: {
                                ...r.requirements,
                                genders: value as Gender[],
                              },
                            }
                          : r
                      )
                    )
                  }
                />
                <ConditionToggles
                  legend={`יכולות נדרשות לתפקיד ${i + 1}`}
                  options={capabilityOptions(state)}
                  value={role.requirements.capabilityIds ?? []}
                  onChange={(value) =>
                    setRoles(
                      roleItems.map((r, index) =>
                        index === i
                          ? {
                              ...r,
                              requirements: {
                                ...r.requirements,
                                capabilityIds: value,
                              },
                            }
                          : r
                      )
                    )
                  }
                />
              </div>
              {roleItems.length > 1 && (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() =>
                    setRoles(roleItems.filter((_, index) => index !== i))
                  }
                >
                  הסרה
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setRoles([
                ...roleItems,
                {
                  id: crypto.randomUUID(),
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
                <span className="task-symbol teal">
                  <CalendarDays size={23} />
                </span>
                <Badge>
                  {rows(type.roles).reduce((n, r) => n + num(r.count, 1), 0)}{" "}
                  מקומות
                </Badge>
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
                <div className="meta-line">
                  <Clock3 size={15} />
                  מנוחה: {num(type.restBeforeMinutes)} דקות לפני ·{" "}
                  {num(type.restAfterMinutes)} אחרי
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
            text="מגדירים פעם אחת הרכב, תנאי התאמה וניקוד. כל מופע חדש יתחיל מההגדרות האלה."
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
export function PlanningView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  return (
    <>
      <div className="two-columns">
        <Panel title="תורנות חדשה" subtitle="המופע יישמר כטיוטה משותפת לאחראים">
          {state.dutyTypes.length ? (
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
                },
                { name: "name", label: "שם המופע", required: true },
                {
                  name: "start",
                  label: "תחילת התורנות",
                  type: "datetime-local",
                  required: true,
                },
                {
                  name: "end",
                  label: "סיום התורנות",
                  type: "datetime-local",
                  required: true,
                },
                { name: "location", label: "מיקום", required: true },
                {
                  name: "instructions",
                  label: "הנחיות",
                  type: "textarea",
                  full: true,
                },
              ]}
              onSubmit={(v) => action("duty.create", v)}
              submitLabel="יצירת טיוטה"
            />
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
        <PeriodPlanning state={state} action={action} />
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
