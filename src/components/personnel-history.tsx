"use client";
import { useState } from "react";
import Link from "next/link";
import {
  type AppState,
  type Action,
  type Row,
  rows,
  str,
  displayDate,
  population,
} from "@/client/types";
import { unitToday } from "@/client/soldier-filters";
import { Badge, Form, Modal, Notice, type Field } from "./ui";
import type { ReactNode } from "react";

type Kind = "capability" | "exemption" | "inactive";
const definitions = [
  { kind: "capability", field: "capabilities", label: "יכולת" },
  { kind: "exemption", field: "exemptions", label: "פטור" },
  { kind: "inactive", field: "inactivePeriods", label: "אי־פעילות" },
] as const;
const catalogIdOf = (entry: Row) =>
  str(entry.capabilityId ?? entry.exemptionId);
/**
 * The validity of a capability or an exemption: either date may be missing
 * (decision 224). A missing end means the entry is permanent.
 */
export function validityText(entry: Record<string, unknown>) {
  const start = str(entry.start);
  const end = str(entry.end);
  if (start && end) return `${displayDate(start)} — ${displayDate(end)}`;
  if (start) return `מ־${displayDate(start)} · קבוע, בלי תאריך סיום`;
  if (end) return `עד ${displayDate(end)}`;
  return "קבוע, בלי תאריכים";
}
function ValidityState({ entry }: { entry: Row }) {
  const today = unitToday();
  if (str(entry.end) && str(entry.end) < today)
    return <Badge tone="warning">פג תוקף</Badge>;
  if (str(entry.start) > today) return <Badge tone="info">טרם החל</Badge>;
  return null;
}
/**
 * A soldier's dated entries, each with edit and remove. `kinds` limits the
 * list, and `catalogId` keeps one catalog value only.
 */
export function PersonnelHistory({
  state,
  action,
  person,
  kinds = ["capability", "exemption", "inactive"],
  catalogId = "",
  empty = "אין יכולות, פטורים או תקופות אי־פעילות.",
}: {
  state: AppState;
  action: Action;
  person: Row;
  kinds?: Kind[];
  catalogId?: string;
  empty?: string;
}) {
  const [selected, select] = useState<{
    kind: Kind;
    index: number;
    entry: Row;
    operation: "replace" | "remove";
  } | null>(null);
  const catalog = rows(state.eligibilityCatalog);
  const entries = definitions
    .filter((definition) => kinds.includes(definition.kind))
    .flatMap((definition) =>
      rows(person[definition.field]).map((entry, index) => ({
        ...definition,
        entry,
        index,
        name:
          definition.kind === "inactive"
            ? "אי־פעילות"
            : str(
                catalog.find((item) => item.id === catalogIdOf(entry))?.name,
                "הגדרה מהקטלוג"
              ),
      }))
    )
    .filter((item) => !catalogId || catalogIdOf(item.entry) === catalogId);
  return (
    <>
      {entries.length ? (
        entries.map((item) => (
          <div className="history-row" key={`${item.kind}:${item.index}`}>
            <span>
              <strong>{item.name}</strong> <Badge>{item.label}</Badge>
            </span>
            <span>
              {item.kind === "inactive" ? (
                <>
                  {displayDate(item.entry.start)} —{" "}
                  {displayDate(item.entry.end)}
                </>
              ) : (
                <>
                  {validityText(item.entry)}{" "}
                  <ValidityState entry={item.entry} />
                </>
              )}
            </span>
            <button
              className="btn secondary small"
              aria-label={`עריכת ${item.name}`}
              onClick={() => select({ ...item, operation: "replace" })}
            >
              עריכה
            </button>
            <button
              className="btn secondary small"
              aria-label={`הסרת ${item.name}`}
              onClick={() => select({ ...item, operation: "remove" })}
            >
              הסרה
            </button>
          </div>
        ))
      ) : (
        <p className="muted">{empty}</p>
      )}
      {selected && (
        <TimelineEdit
          key={`${selected.kind}:${selected.index}:${selected.operation}`}
          state={state}
          action={action}
          person={person}
          selected={selected}
          onDone={() => select(null)}
        />
      )}
    </>
  );
}
function TimelineEdit({
  state,
  action,
  person,
  selected,
  onDone,
}: {
  state: AppState;
  action: Action;
  person: Row;
  selected: {
    kind: Kind;
    index: number;
    entry: Row;
    operation: "replace" | "remove";
  };
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const removing = selected.operation === "remove";
  // Capabilities and exemptions may stay open on either side (decision 224).
  const dated = selected.kind === "inactive";
  const fields: Field[] = [
    ...(!removing && selected.kind !== "inactive"
      ? [
          {
            name: "value",
            label: "סוג מהקטלוג",
            type: "select" as const,
            required: true,
            value: catalogIdOf(selected.entry),
            options: rows(state.eligibilityCatalog)
              .filter((item) => item.kind === selected.kind)
              .map((item) => ({ value: item.id, label: str(item.name) })),
          },
        ]
      : []),
    ...(!removing
      ? [
          {
            name: "startDate",
            label: "תחילת תוקף",
            type: "date" as const,
            required: dated,
            value: str(selected.entry.start),
            hint: dated ? undefined : "ריק = בלי תאריך התחלה",
          },
          {
            name: "endDate",
            label: "סיום תוקף (כולל)",
            type: "date" as const,
            required: dated,
            value: str(selected.entry.end),
            hint: dated ? undefined : "ריק = קבוע, בלי תאריך סיום",
          },
        ]
      : []),
    {
      name: "reason",
      label: "סיבת השינוי",
      type: "textarea",
      required: true,
      full: true,
    },
  ];
  const base = {
    soldierId: person.id,
    kind: selected.kind,
    index: selected.index,
    operation: selected.operation,
  };
  return (
    <Modal
      title={`${removing ? "הסרת" : "עריכת"} ${dated ? "תקופה" : selected.kind === "capability" ? "יכולת" : "פטור"} · ${str(person.name)}`}
      onClose={onDone}
      wide
    >
      <Notice>
        השיבוצים נשארים בתוקף. שינוי שפוגע בהתאמה מסמן אותם לטיפול אחראי; אינו
        מבטל אותם.
      </Notice>
      {preview ? (
        <>
          <h3>השפעה על שיבוצים קיימים</h3>
          <ImpactList impact={rows(preview.impact)} />
          <Form
            fields={[
              {
                name: "confirmed",
                label: "בדקתי את ההשפעה ומאשר את השינוי",
                type: "checkbox",
                required: true,
              },
            ]}
            submitLabel={removing ? "אישור הסרת התקופה" : "אישור שינוי התקופה"}
            onSubmit={async (values) => {
              await action(
                "soldier.timeline.edit",
                {
                  ...base,
                  ...input,
                  ...values,
                  previewToken: preview.previewToken,
                },
                person.version
              );
              onDone();
            }}
          />
          <button className="btn secondary" onClick={() => setPreview(null)}>
            חזרה לעריכה
          </button>
        </>
      ) : (
        <Form
          fields={fields}
          submitLabel="בדיקת השפעת השינוי"
          onSubmit={async (values) => {
            setInput(values);
            setPreview(
              await action(
                "soldier.timeline.edit.preview",
                { ...base, ...values },
                person.version
              )
            );
          }}
        />
      )}
    </Modal>
  );
}
export function ImpactList({
  impact,
  empty = "אין שיבוצים פעילים שהושפעו.",
}: {
  impact: Row[];
  empty?: ReactNode;
}) {
  if (!impact.length) return <p>{empty}</p>;
  return impact.map((item) => (
    <div className="subsection" key={str(item.assignmentId)}>
      <Link className="text-link" href={`/duties/${str(item.dutyId)}`}>
        {str(item.dutyName)}
      </Link>
      <p>
        {displayDate(item.start, true)}
        {item.end ? <> — {displayDate(item.end, true)}</> : null} ·{" "}
        <Badge tone={item.after === "eligible" ? "neutral" : "warning"}>
          {item.after === "eligible" ? "מתאים" : "דורש טיפול"}
        </Badge>
      </p>
      {rows(item.reasons).map((reason, index) => (
        <Notice key={index} tone="warning">
          {str(reason.message)}
        </Notice>
      ))}
    </div>
  ));
}
function Timeline({ segments }: { segments: Row[] }) {
  return (
    <ul>
      {segments.map((segment, index) => (
        <li key={index}>
          <strong>{population(segment.population)}</strong>{" "}
          {segment.from ? `מ־${displayDate(segment.from)}` : "מתחילת השירות"}
        </li>
      ))}
    </ul>
  );
}
/** The population timeline before and after a proposed change, side by side. */
export function PopulationChange({ change }: { change: unknown }) {
  const value = change as { before?: unknown; after?: unknown } | undefined;
  return (
    <div className="population-change">
      <div>
        <span className="muted">לפני השינוי</span>
        <Timeline segments={rows(value?.before)} />
      </div>
      <div>
        <span className="muted">אחרי השינוי</span>
        <Timeline segments={rows(value?.after)} />
      </div>
    </div>
  );
}
/** Only the assignments whose eligibility changes, with a count of the rest. */
export function AffectedAssignments({
  impact,
  empty,
}: {
  impact: Row[];
  empty: string;
}) {
  const affected = impact.filter((item) => item.affected === true);
  return (
    <>
      <ImpactList impact={affected} empty={empty} />
      {impact.length > affected.length && (
        <p className="muted">
          שיבוצים נוספים שנבדקו ואינם מושפעים: {impact.length - affected.length}
        </p>
      )}
    </>
  );
}
const periodLabels: Record<string, string> = {
  capability: "יכולת",
  exemption: "פטור",
  inactive: "תקופת אי־פעילות",
  population: "מעבר אוכלוסיית שיבוץ",
};
/**
 * Adds a capability, exemption or inactivity period, or a population
 * transition, only after the manager reviewed which reserved assignments it
 * affects. `fixed` supplies values the surrounding screen already knows, such
 * as the soldier or the period kind; `prepare` derives values from the form,
 * such as the kind of the chosen catalog value.
 */
export function AddPeriod({
  state,
  action,
  fields,
  fixed = {},
  prepare = (values) => values,
  submitLabel,
}: {
  state: AppState;
  action: Action;
  fields: Field[];
  fixed?: Record<string, unknown>;
  prepare?: (values: Record<string, unknown>) => Record<string, unknown>;
  submitLabel: string;
}) {
  const [draft, setDraft] = useState<{
    values: Record<string, unknown>;
    version?: number;
    preview: Record<string, unknown>;
  } | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  if (!draft)
    return (
      <Form
        fields={fields.map((field) =>
          field.name in values
            ? { ...field, value: values[field.name] as Field["value"] }
            : field
        )}
        submitLabel={submitLabel}
        onSubmit={async (input) => {
          const merged = prepare({ ...input, ...fixed });
          setValues(input);
          const version = state.soldiers.find(
            (item) => item.id === merged.soldierId
          )?.version;
          const preview = await action(
            "soldier.timeline.preview",
            merged,
            version
          );
          setDraft({ values: merged, version, preview });
        }}
      />
    );
  const { values: proposal, preview } = draft;
  const person = state.soldiers.find((item) => item.id === proposal.soldierId);
  const kind = str(proposal.kind);
  const transition = kind === "population";
  const impact = rows(preview.impact);
  const catalogName =
    kind === "inactive" || transition
      ? ""
      : str(
          rows(state.eligibilityCatalog).find(
            (item) => item.id === proposal.value
          )?.name,
          "הגדרה מהקטלוג"
        );
  return (
    <div
      className="stack"
      aria-label={transition ? "השפעת מעבר האוכלוסייה" : "השפעת התקופה החדשה"}
      role="region"
    >
      <h3>השינוי המוצע</h3>
      <p>
        <strong>{str(person?.name, "חייל")}</strong> ·{" "}
        <Badge>{periodLabels[kind] ?? kind}</Badge>
        {transition ? (
          <>
            {" "}
            ל{population(proposal.value)} מ־{displayDate(proposal.startDate)}
          </>
        ) : (
          <>
            {catalogName && <> {catalogName}</>} ·{" "}
            {kind === "inactive" ? (
              <>
                {displayDate(proposal.startDate)} —{" "}
                {displayDate(proposal.endDate)}
              </>
            ) : (
              validityText({ start: proposal.startDate, end: proposal.endDate })
            )}
          </>
        )}
      </p>
      {transition && <PopulationChange change={preview.population} />}
      <h3>
        {transition
          ? "שיבוצים שהמעבר משפיע עליהם"
          : "שיבוצים שהתקופה משפיעה עליהם"}
      </h3>
      <AffectedAssignments
        impact={impact}
        empty={
          transition
            ? "המעבר אינו משנה את ההתאמה של שיבוצים קיימים."
            : "התקופה אינה משנה את ההתאמה של שיבוצים קיימים."
        }
      />
      <Notice>
        השיבוצים נשארים בתוקף. שיבוץ שנפגע יסומן ״דורש טיפול״ באותה שמירה;
        אילוצים מאושרים, הכניסה לחשבון והיתרה אינם משתנים.
      </Notice>
      <Form
        fields={[
          {
            name: "confirmed",
            label: transition
              ? "בדקתי את ההשפעה ומאשר את מעבר האוכלוסייה"
              : "בדקתי את ההשפעה ומאשר את הוספת התקופה",
            type: "checkbox",
            required: true,
          },
        ]}
        submitLabel={
          transition ? "אישור מעבר האוכלוסייה" : "אישור הוספת התקופה"
        }
        onSubmit={async (confirmation) => {
          await action(
            "soldier.timeline",
            {
              ...proposal,
              ...confirmation,
              previewToken: preview.previewToken,
            },
            draft.version
          );
          setDraft(null);
          setValues({});
        }}
      />
      <button className="btn secondary" onClick={() => setDraft(null)}>
        חזרה לעריכה
      </button>
    </div>
  );
}
const entryKinds: Record<string, string> = {
  capability: "יכולת",
  exemption: "פטור",
};
/**
 * Gives a soldier a capability or an exemption from the catalog (decision 224).
 * The start defaults to today and the end stays empty, which keeps the entry
 * permanent. Without `soldierId` the manager also picks the soldier.
 */
export function CatalogEntryAdd({
  state,
  action,
  soldierId,
}: {
  state: AppState;
  action: Action;
  soldierId?: string;
}) {
  const catalog = rows(state.eligibilityCatalog)
    .filter((item) => str(item.kind) in entryKinds)
    .sort(
      (a, b) =>
        str(a.kind).localeCompare(str(b.kind)) ||
        str(a.name).localeCompare(str(b.name), "he")
    );
  if (!catalog.length)
    return (
      <Notice>
        עדיין לא הוגדרו יכולות או פטורים. מגדירים אותם ב
        <Link className="text-link" href="/manage/eligibility">
          פטורים ויכולות
        </Link>
        .
      </Notice>
    );
  return (
    <AddPeriod
      state={state}
      action={action}
      fixed={soldierId ? { soldierId } : {}}
      prepare={(values) => ({
        ...values,
        kind: catalog.find((item) => item.id === values.value)?.kind,
      })}
      fields={[
        ...(soldierId
          ? []
          : [
              {
                name: "soldierId",
                label: "חייל",
                type: "select" as const,
                required: true,
                options: state.soldiers
                  .filter((s) => !s.deletedAt)
                  .map((s) => ({ value: s.id, label: str(s.name) })),
              },
            ]),
        {
          name: "value",
          label: "סוג מהקטלוג",
          type: "select",
          required: true,
          options: catalog.map((item) => ({
            value: item.id,
            label: `${str(item.name)} · ${entryKinds[str(item.kind)]}`,
          })),
        },
        {
          name: "startDate",
          label: "תחילת תוקף",
          type: "date",
          value: unitToday(),
          hint: "ריק = בלי תאריך התחלה",
        },
        {
          name: "endDate",
          label: "סיום תוקף (כולל)",
          type: "date",
          hint: "ריק = קבוע, בלי תאריך סיום",
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
  );
}
/**
 * Saves the profile form directly unless the edit moves the soldier's
 * population (for example a career or officer start date). Then the manager
 * first reviews the affected assignments and confirms the save explicitly.
 */
export function ProfileEdit({
  person,
  fields,
  action,
  onDone,
}: {
  person: Row;
  fields: Field[];
  action: Action;
  onDone: () => void;
}) {
  const [review, setReview] = useState<{
    values: Record<string, unknown>;
    preview: Record<string, unknown>;
  } | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  if (!review)
    return (
      <Form
        fields={fields.map((field) =>
          field.name in values
            ? { ...field, value: values[field.name] as Field["value"] }
            : field
        )}
        onSubmit={async (input) => {
          setValues(input);
          const payload = { id: person.id, ...input };
          const preview = await action(
            "soldier.update.preview",
            payload,
            person.version
          );
          if (preview.populationMoves !== true) {
            await action("soldier.update", payload, person.version);
            onDone();
            return;
          }
          setReview({ values: payload, preview });
        }}
      />
    );
  const { preview } = review;
  return (
    <div className="stack" aria-label="השפעת עריכת הפרופיל" role="region">
      <h3>השינוי מזיז את אוכלוסיית השיבוץ</h3>
      <PopulationChange change={preview.population} />
      <h3>שיבוצים שהמעבר משפיע עליהם</h3>
      <AffectedAssignments
        impact={rows(preview.impact)}
        empty="המעבר אינו משנה את ההתאמה של שיבוצים קיימים."
      />
      <Notice>
        השיבוצים נשארים בתוקף. שיבוץ שנפגע יסומן ״דורש טיפול״ באותה שמירה;
        מעברים קודמים, אילוצים מאושרים והיתרה אינם משתנים.
      </Notice>
      <Form
        fields={[
          {
            name: "confirmed",
            label: "בדקתי את ההשפעה ומאשר את שמירת הפרופיל",
            type: "checkbox",
            required: true,
          },
        ]}
        submitLabel="אישור ושמירת הפרופיל"
        onSubmit={async (confirmation) => {
          await action(
            "soldier.update",
            {
              ...review.values,
              ...confirmation,
              previewToken: preview.previewToken,
            },
            person.version
          );
          onDone();
        }}
      />
      <button className="btn secondary" onClick={() => setReview(null)}>
        חזרה לעריכה
      </button>
    </div>
  );
}
