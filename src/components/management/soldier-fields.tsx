"use client";
import { type ReactNode } from "react";
import { graceEnd, graceWindowOpen, unitToday } from "@/domain/time";
import Link from "next/link";
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
import { Form, Notice, type Field } from "../ui";
import { rankChoices } from "@/client/soldier-filters";
import { ProfileEdit } from "../personnel-history";
import { genders } from "../eligibility-conditions";

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
export function ServicePath({
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
export const soldierFields = (
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

export function SoldierRankEdit({
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
export function ProfileFacts({ person }: { person: Row }) {
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
export function ServiceDates({ person }: { person: Row }) {
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
