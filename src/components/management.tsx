"use client";
import { CatalogImpact } from "./duty-changes";
import { useState, type ReactNode } from "react";
import { graceEnd, graceWindowOpen, unitToday } from "@/domain/time";
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
  noHeldFilter,
  rankChoices,
  rankTracks,
} from "@/client/soldier-filters";
import { RankRequirements } from "./rank-requirements";
import { PeriodPlanning } from "./planning";
import {
  AddPeriod,
  CatalogEntryAdd,
  PersonnelHistory,
  ProfileEdit,
} from "./personnel-history";
import { HeldFilters } from "./held-filters";
import { AuditLink } from "./audit";
import { SoldierDeletion } from "./soldier-deletion";
import {
  ConditionToggles,
  SoldierConditions,
  WindowsEditor,
  capabilityOptions,
  describeWeekdays,
  describeWindow,
  genderHint,
  genders,
  newWindow,
  windowsOf,
} from "./eligibility-conditions";
import type { Gender, RankClause, Requirements } from "@/domain/types";
import { MAX_END_DAYS, defaultHoursRange } from "@/domain/default-hours";
import {
  defaultHoursOf,
  describeDefaultHours,
  readDefaultHours,
  relevantHoursExemptions,
} from "@/client/default-hours";
/** The phone format the server accepts (decision 222). */
export const phoneHint = "נייד ישראלי שמתחיל ב־05, או מספר בינלאומי שמתחיל ב־+";
/** Saving a second soldier with the same first and last name is allowed after this. */
export const duplicateNameField: Field = {
  name: "duplicateNameConfirmed",
  label: "לשמור גם אם כבר רשום חייל עם אותו שם פרטי ושם משפחה",
  type: "checkbox",
  full: true,
  hint: "אם קיים שם זהה, השמירה תיעצר עם אזהרה עד שמסמנים כאן",
};
// A record from before decision 222 may lack a part; the form fills what it can
// from the full name, and an edit cannot clear a part that is stored.
const nameParts = (s?: Row) => {
  const [first = "", ...rest] = str(s?.name).split(" ");
  return {
    firstName: str(s?.firstName, first),
    lastName: str(s?.lastName, rest.join(" ")),
  };
};
/**
 * The service path (decision 227): a soldier starts in mandatory service or
 * as KAMA, and moves forward only, to career or to officer, on a date that
 * may be past or future. Career service is a career date, not a separate field.
 */
const serviceFields = (s?: Row): Field[] => {
  const base = str(obj(s?.service).basePopulation, s ? "" : "mandatory");
  return [
    {
      name: "startPopulation",
      label: "סוג גיוס",
      type: "select",
      required: base !== "career",
      options: [
        { value: "mandatory", label: "חובה" },
        { value: "academic", label: "קמ״א" },
      ],
      value: base === "career" ? "" : base,
      hint:
        base === "career"
          ? "נקלט כקבע או כקצין בלי תאריך מעבר. בחירה כאן תקבע מאיזו אוכלוסייה התחיל"
          : undefined,
    },
    {
      name: "enlistmentDate",
      label: "תאריך גיוס",
      type: "date",
      value: str(s?.enlistmentDate),
    },
    {
      name: "permanentDate",
      label: "כניסה לקבע",
      type: "date",
      value: str(s?.permanentDate),
      hint: "מהתאריך החייל באוכלוסיית קבע/קצינים; ריק = לא בקבע",
    },
    {
      name: "officerDate",
      label: "כניסה לקצונה",
      type: "date",
      value: str(s?.officerDate),
      hint: "מהתאריך החייל באוכלוסיית קבע/קצינים; ריק = לא קצין",
    },
    {
      name: "releaseDate",
      label: "יום אחרון בשירות",
      type: "date",
      value: str(s?.releaseDate),
    },
  ];
};
/** The soldier's service path at a glance, with the population it gives. */
function ServicePath({
  person,
  action,
  onDone,
}: {
  person: Row;
  action: Action;
  onDone: () => void;
}) {
  const base = str(obj(person.service).basePopulation, "mandatory");
  const today = unitToday();
  const dated = (value: unknown) => (value ? displayDate(value) : "—");
  const moves = [
    ...rows(person.populationHistory).map((entry) => ({
      date: str(entry.effectiveFrom),
      label: `מעבר ל${population(entry.population)}`,
      population: str(entry.population),
    })),
    ...(person.permanentDate
      ? [
          {
            date: str(person.permanentDate),
            label: "כניסה לקבע",
            population: "career",
          },
        ]
      : []),
    ...(person.officerDate
      ? [
          {
            date: str(person.officerDate),
            label: "כניסה לקצונה",
            population: "career",
          },
        ]
      : []),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const next = moves.find(
    (move) => move.date > today && move.population !== str(person.population)
  );
  return (
    <div className="stack">
      <ol className="service-path">
        <li>
          <strong>גיוס · {population(base)}</strong>
          <span>{dated(person.enlistmentDate)}</span>
        </li>
        {moves.map((move) => (
          <li key={`${move.label}-${move.date}`}>
            <strong>{move.label}</strong>
            <span>
              {displayDate(move.date)}
              {move.date > today ? " · עתידי" : ""}
            </span>
          </li>
        ))}
        <li>
          <strong>יום אחרון בשירות</strong>
          <span>{dated(person.releaseDate)}</span>
        </li>
      </ol>
      <p>
        אוכלוסיית שיבוץ היום: <strong>{population(person.population)}</strong>
        {next && (
          <>
            {" "}
            · מ־{displayDate(next.date)}: {population(next.population)}
          </>
        )}
      </p>
      <h3>עריכת מסלול השירות</h3>
      <p className="muted">
        מעבר הוא רק קדימה: מחובה או מקמ״א לקבע או לקצונה. תאריך יכול להיות בעבר,
        היום או בעתיד. שינוי שמזיז את אוכלוסיית השיבוץ מציג קודם את השיבוצים
        שהוא משפיע עליהם.
      </p>
      <ProfileEdit
        person={person}
        fields={[
          ...serviceFields(person),
          {
            name: "reason",
            label: "סיבת השינוי",
            type: "textarea",
            required: true,
            full: true,
          },
        ]}
        action={action}
        onDone={onDone}
      />
    </div>
  );
}
/**
 * The grace checkbox is shown while it can still matter: from an entered
 * arrival date until the month after it ends. Grace needs that date (without
 * it the soldier cannot be assigned), so a new soldier starts as eligible only
 * once it is entered (decision 225).
 */
const graceFields = (s: Row | undefined, arrival: string): Field[] =>
  (arrival && graceWindowOpen(arrival, unitToday())) ||
  (!arrival && s?.graceEligible)
    ? [
        {
          name: "graceEligible",
          label: "זכאי לחודש חסד מתאריך ההגעה",
          type: "checkbox",
          value: s ? Boolean(s.graceEligible) : true,
          hint: arrival
            ? `ללא תורנויות עד ${displayDate(graceEnd(arrival))}; אפשר לשנות עד אז`
            : "חסר תאריך הגעה, ולכן אי אפשר לשבץ את החייל",
        },
      ]
    : [];
const soldierFields = (
  state: AppState,
  s?: Row,
  arrival = str(s?.arrivalDate),
  onArrival?: (value: string) => void
): Field[] => [
  {
    name: "firstName",
    label: "שם פרטי",
    required: true,
    value: nameParts(s).firstName,
  },
  {
    name: "lastName",
    label: "שם משפחה",
    required: !s || Boolean(nameParts(s).lastName),
    value: nameParts(s).lastName,
  },
  // On an edit, gender changes in the conditions below, which first shows the
  // assignments the change affects.
  ...(s
    ? []
    : [
        {
          name: "gender",
          label: "מגדר",
          type: "select",
          required: true,
          options: genders,
        } satisfies Field,
      ]),
  {
    name: "email",
    label: "מייל מאושר להזמנה",
    type: "email",
    required: !s,
    value: str(s?.email),
  },
  {
    name: "phone",
    label: "טלפון נייד",
    type: "tel",
    required: !s || Boolean(s.phone),
    value: str(s?.phone),
    hint: phoneHint,
  },
  // The service path is edited in its own section of the profile (decision 227).
  ...(s ? [] : serviceFields()),
  ...(s ? [] : initialRankFields(state)),
  {
    name: "arrivalDate",
    label: "תאריך הגעה ליחידה",
    type: "date",
    value: str(s?.arrivalDate),
    onChange: onArrival,
  },
  ...graceFields(s, arrival),
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
  ...(s ? [] : [duplicateNameField]),
];
const rankOptions = (state: AppState) => rankChoices(rows(state.rankCatalog));
const initialRankFields = (state: AppState): Field[] => [
  {
    name: "rankId",
    label: "דרגה מאושרת (רשות)",
    type: "select",
    options: rankOptions(state),
    hint: rows(state.rankCatalog).length
      ? "אפשר לקלוט חייל ללא דרגה. בחירת דרגה מחייבת תאריך תחולה."
      : "עדיין אין דרגות לבחירה. אפשר להוסיף אותן במסך דרגות ופז״ם, או לקלוט ללא דרגה.",
  },
  {
    name: "rankEffectiveDate",
    label: "תאריך תחולת הדרגה",
    type: "date",
    hint: "ממלאים יחד עם הדרגה; אפשר להזין גם שינוי עתידי שכבר אושר.",
  },
];

function SoldierRankEdit({
  state,
  person,
  action,
  onDone,
}: {
  state: AppState;
  person: Row;
  action: Action;
  onDone: () => void;
}) {
  return (
    <section className="subsection" aria-label="עדכון דרגת החייל">
      <h3>עדכון דרגה מאושרת</h3>
      <p className="muted">
        השינוי נשמר בהיסטוריה לפי תאריך התחולה. שיבוצים שנפגעו יסומנו לטיפול.
      </p>
      {rows(state.rankCatalog).length ? (
        <Form
          fields={[
            {
              name: "rankId",
              label: "דרגה מאושרת",
              type: "select",
              required: true,
              options: rankOptions(state),
              value: person.rankId
                ? `${str(person.rankId)}|${str(person.rankTrack)}`
                : "",
            },
            {
              name: "effectiveDate",
              label: "תאריך תחולת הדרגה",
              type: "date",
              required: true,
            },
            {
              name: "reason",
              label: "סיבת עדכון הדרגה",
              required: true,
              full: true,
            },
          ]}
          submitLabel="שמירת הדרגה המאושרת"
          onSubmit={async (values) => {
            await action(
              "rank.set",
              { ...values, soldierId: person.id },
              person.version
            );
            onDone();
          }}
        />
      ) : (
        <Notice>
          כדי לבחור דרגה, יש להוסיף תחילה דרגות ב
          <Link className="text-link" href="/manage/ranks">
            דרגות ופז״ם
          </Link>
          .
        </Notice>
      )}
    </section>
  );
}
/** Who the soldier is at a glance, each fact as label and value. */
function ProfileFacts({ person }: { person: Row }) {
  const arrival = str(person.arrivalDate);
  const facts: [string, ReactNode][] = [
    [
      "מספר זיהוי",
      <bdi key="id" dir="ltr">
        {str(person.idNumber)}
      </bdi>,
    ],
    [
      "טלפון",
      <bdi key="phone" dir="ltr">
        {str(person.phone, "לא הוזן")}
      </bdi>,
    ],
    [
      "דרגה נוכחית",
      <span key="rank">
        {str(person.rankName, "דרגה חסרה")}
        {person.rankTrack ? ` · מסלול ${str(person.rankTrack)}` : null}
      </span>,
    ],
  ];
  // After the window closes the checkbox is gone; the month itself stays visible.
  if (person.graceEligible && arrival && !graceWindowOpen(arrival, unitToday()))
    facts.push([
      "חודש חסד",
      `${displayDate(arrival)} – ${displayDate(graceEnd(arrival))}`,
    ]);
  return (
    <dl className="profile-facts">
      {facts.map(([label, value]) => (
        <div key={label}>
          <dt>{label}:</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
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
  const [held, setHeld] = useState(noHeldFilter);
  const tracks = rankTracks(rows(state.rankCatalog));
  const [selectedRecord, setSelected] = useState<Row | null>(null);
  // The arrival date each form holds now, so the grace checkbox follows it.
  const [newArrival, setNewArrival] = useState("");
  const [editArrival, setEditArrival] = useState<{
    id: unknown;
    value: string;
  }>();
  const selected = selectedRecord
    ? (state.soldiers.find((person) => person.id === selectedRecord.id) ??
      selectedRecord)
    : null;
  const filtered = filterSoldiers(state.soldiers, {
    search,
    populations: shown,
    rank,
    held,
  });
  const isDefault =
    !rank &&
    !held.capability &&
    !held.exemption &&
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
            fields={soldierFields(state, undefined, newArrival, setNewArrival)}
            onOpen={() => setNewArrival("")}
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
              aria-label="חיפוש חייל לפי שם או מספר זיהוי"
              placeholder="שם או מספר זיהוי…"
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
                  <option key={r.id} value={`rank:${r.id}|${t.track}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <HeldFilters state={state} value={held} onChange={setHeld} />
          {!isDefault && (
            <button
              className="btn small secondary"
              onClick={() => {
                setShown(defaults);
                setRank("");
                setHeld(noHeldFilter());
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
            <table className="soldiers-table">
              <thead>
                <tr>
                  <th>שם</th>
                  <th>מספר זיהוי</th>
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
                        {s.isManager === true && <Badge>אחראי תורנויות</Badge>}
                      </span>
                    </td>
                    <td dir="ltr">{str(s.idNumber)}</td>
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
          <div className="profile-head">
            <div className="profile-badges">
              <Badge>{population(selected.population)}</Badge>
              <Status value={selected.serviceStatus || "active"} />
              <AuditLink id={selected.id} label="יומן הפעולות של החייל" />
            </div>
            <ProfileFacts person={selected} />
          </div>
          <ServiceDates person={selected} />
          <ProfileEdit
            person={selected}
            fields={soldierFields(
              state,
              selected,
              editArrival?.id === selected.id
                ? editArrival.value
                : str(selected.arrivalDate),
              (value) => setEditArrival({ id: selected.id, value })
            ).filter((f) => !["email", "currentScore"].includes(f.name))}
            action={action}
            onDone={() => setSelected(null)}
          />
          <SoldierRankEdit
            state={state}
            person={selected}
            action={action}
            onDone={() => setSelected(null)}
          />
          <details className="disclosure">
            <summary>מסלול שירות ואוכלוסיית שיבוץ</summary>
            <ServicePath
              key={String(selected.version)}
              person={selected}
              action={action}
              onDone={() => setSelected(null)}
            />
          </details>
          <details className="disclosure">
            <summary>כשירויות ופטורים</summary>
            <div className="stack">
              <PersonnelHistory
                state={state}
                action={action}
                person={selected}
                kinds={["capability", "exemption"]}
                empty="אין כשירויות או פטורים."
              />
              <Link
                className="text-link"
                href={`/manage/eligibility?soldier=${str(selected.id)}`}
              >
                שיוך כשירות או פטור במסך פטורים וכשירויות{" "}
                <ArrowLeft size={15} />
              </Link>
            </div>
          </details>
          <details className="disclosure">
            <summary>אי־פעילות והיסטוריית דרגות</summary>
            <div className="stack">
              <PersonnelHistory
                state={state}
                action={action}
                person={selected}
                kinds={["inactive"]}
                empty="אין תקופות אי־פעילות."
              />
              {["rankHistory"].map((key) =>
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
            <summary>תנאי התאמה אישיים: מגדר</summary>
            <div className="stack">
              <SoldierConditions
                key={String(selected.version)}
                action={action}
                person={selected}
              />
            </div>
          </details>
          <details className="disclosure">
            <summary>ניהול כתובת מייל וחשבון</summary>
            <p className="account-email">
              כתובת מייל: <bdi dir="ltr">{str(selected.email, "—")}</bdi>
            </p>
            <div className="account-actions">
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
              <div className="danger-zone">
                <small className="muted">
                  מוחקת את פרטי הקשר והמידע הרגיש. השם, מספר הזיהוי וההיסטוריה
                  נשמרים.
                </small>
                <SoldierDeletion
                  person={selected}
                  action={action}
                  self={selected.id === state.actor.soldierId}
                  onDone={() => setSelected(null)}
                />
              </div>
            </div>
          </details>
        </Modal>
      )}
    </>
  );
}
/** An hours exemption carries fixed daily windows (decision 226). */
const isHours = (entry: Row) => rows(entry.windows).length > 0;
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
              defaultHours: defaultHours.hours,
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
                  hint={genderHint}
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
                  legend={`כשירויות נדרשות לתפקיד ${i + 1}`}
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
                {defaultHoursOf(type) && (
                  <div className="meta-line">
                    <Clock3 size={15} />
                    שעות: {describeDefaultHours(defaultHoursOf(type)!)}
                  </div>
                )}
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
/**
 * A new instance starts from its type's default hours when the type has them
 * (decision 229): a start date fills both moments, and each stays editable.
 */
function NewDutyForm({ state, action }: { state: AppState; action: Action }) {
  const [typeId, setTypeId] = useState("");
  const [date, setDate] = useState("");
  const [times, setTimes] = useState({ start: "", end: "" });
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
          start: times.start,
          end: times.end,
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
  return (
    <>
      <div className="two-columns">
        <Panel title="תורנות חדשה" subtitle="המופע יישמר כטיוטה משותפת לאחראים">
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
