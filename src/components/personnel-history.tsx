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
import { Badge, Form, Modal, Notice, type Field } from "./ui";
import type { ReactNode } from "react";

type Kind = "qualification" | "exemption" | "inactive";
const definitions = [
  { kind: "qualification", field: "qualifications", label: "כשירות" },
  { kind: "exemption", field: "exemptions", label: "פטור" },
  { kind: "inactive", field: "inactivePeriods", label: "אי־פעילות" },
] as const;
export function PersonnelHistory({
  state,
  action,
  person,
}: {
  state: AppState;
  action: Action;
  person: Row;
}) {
  const [selected, select] = useState<{
    kind: Kind;
    index: number;
    entry: Row;
    operation: "replace" | "remove";
  } | null>(null);
  const catalog = rows(state.eligibilityCatalog);
  const entries = definitions.flatMap((definition) =>
    rows(person[definition.field]).map((entry, index) => ({
      ...definition,
      entry,
      index,
      name:
        definition.kind === "inactive"
          ? "אי־פעילות"
          : str(
              catalog.find(
                (item) =>
                  item.id === (entry.qualificationId ?? entry.exemptionId)
              )?.name,
              "הגדרה מהקטלוג"
            ),
    }))
  );
  return (
    <>
      {entries.length ? (
        entries.map((item) => (
          <div className="history-row" key={`${item.kind}:${item.index}`}>
            <span>
              <strong>{item.name}</strong> <Badge>{item.label}</Badge>
            </span>
            <span>
              {displayDate(item.entry.start)} — {displayDate(item.entry.end)}
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
        <p className="muted">אין תקופות כשירות, פטור או אי־פעילות.</p>
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
  const fields: Field[] = [
    ...(!removing && selected.kind !== "inactive"
      ? [
          {
            name: "value",
            label: "סוג מהקטלוג",
            type: "select" as const,
            required: true,
            value: str(
              selected.entry.qualificationId ?? selected.entry.exemptionId
            ),
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
            required: true,
            value: str(selected.entry.start),
          },
          {
            name: "endDate",
            label: "סיום תוקף (כולל)",
            type: "date" as const,
            required: true,
            value: str(selected.entry.end),
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
      title={`${removing ? "הסרת" : "עריכת"} תקופה · ${str(person.name)}`}
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
  qualification: "כשירות",
  exemption: "פטור",
  inactive: "תקופת אי־פעילות",
  population: "מעבר אוכלוסיית שיבוץ",
};
/**
 * Adds a qualification, exemption or inactivity period, or a population
 * transition, only after the manager reviewed which reserved assignments it
 * affects. `fixed` supplies values the surrounding screen already knows, such
 * as the soldier or the period kind.
 */
export function AddPeriod({
  state,
  action,
  fields,
  fixed = {},
  submitLabel,
}: {
  state: AppState;
  action: Action;
  fields: Field[];
  fixed?: Record<string, unknown>;
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
          const merged = { ...input, ...fixed };
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
            {displayDate(proposal.startDate)} — {displayDate(proposal.endDate)}
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
