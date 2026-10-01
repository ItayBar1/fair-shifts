"use client";
import { useState } from "react";
import { DateTime } from "luxon";
import Link from "next/link";
import {
  type Action,
  type AppState,
  type Row,
  assignableSoldiers,
  str,
  rows,
  obj,
  num,
  personName,
  displayDate,
} from "@/client/types";
import { ActionDialog, Form, Modal, Notice, Panel, type Field } from "./ui";
import { callUpFields, callUpValue } from "./call-up";
import {
  CompositionEditor,
  describeComposition,
  describePricing,
} from "./instance-composition";

export function CatalogImpact({
  state,
  action,
  catalog,
}: {
  state: AppState;
  action: Action;
  catalog: Row;
}) {
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  return (
    <>
      <Form
        fields={[]}
        submitLabel="בדיקת השפעה על מופעים קיימים"
        onSubmit={async () =>
          setPreview(
            await action(
              "dutyType.impact.preview",
              { id: catalog.id },
              catalog.version
            )
          )
        }
      />
      {preview && (
        <Modal
          title="השפעת הקטלוג על תורנויות קיימות"
          wide
          onClose={() => setPreview(null)}
        >
          <Notice>
            שינוי הקטלוג אינו משנה מופעים קיימים. ניתן ליצור הצעת שינוי ולבחור
            החלה מפורשת מהקטלוג. תנאים הדורשים חריגה יחייבו אישור חדש.
          </Notice>
          {rows(preview.duties).length ? (
            rows(preview.duties).map((duty) => (
              <div className="subsection" key={duty.id}>
                <h3>
                  <Link className="text-link" href={`/duties/${duty.id}`}>
                    {str(duty.name)}
                  </Link>
                </h3>
                <p>
                  {displayDate(duty.start, true)} · מספר מקומות:{" "}
                  {num(duty.beforeSlots)} ← {num(duty.afterSlots)}
                </p>
                {rows(duty.checks).map((check, index) => (
                  <p key={index}>
                    {personName(state, check.soldierId)}:{" "}
                    {check.removed
                      ? "המקום הוסר מההרכב; נדרש טיפול מפורש בשיבוץ"
                      : `${num(check.beforePoints)} ← ${num(check.afterPoints)} נקודות; ${
                          rows(check.reasons)
                            .map((reason) => str(reason.message))
                            .join("; ") || "מתאים לפי הנתונים הנוכחיים"
                        }`}
                  </p>
                ))}
              </div>
            ))
          ) : (
            <p>אין מופעים עתידיים מסוג זה.</p>
          )}
        </Modal>
      )}
    </>
  );
}

export function DutyChanges({
  state,
  action,
  duty,
}: {
  state: AppState;
  action: Action;
  duty: Row;
}) {
  const draft = duty.status === "draft";
  const changes = rows(state.dutyChanges).filter(
    (change) => change.dutyId === duty.id && change.status === "open"
  );
  return (
    <Panel
      title="הצעות לשינוי התורנות"
      actions={
        <ActionDialog
          title={draft ? "עריכת טיוטה" : "יצירת הצעת שינוי"}
          action={action}
          type="duty.change.create"
          payload={{ dutyId: duty.id }}
          version={duty.version}
          fields={[
            { name: "reason", label: "סיבת השינוי", required: true },
            {
              name: "applyCatalog",
              label: "להחיל את המחירון, ההרכב וכללי ההתאמה העדכניים מהקטלוג",
              type: "checkbox",
            },
          ]}
          description={
            draft
              ? "השיבוצים והניקוד השמור ישתנו רק לאחר בדיקת ההשפעה ושמירת השינוי בטיוטה."
              : "התורנות המפורסמת נשארת מחייבת עד בדיקת ההשפעה ועדכן ופרסם."
          }
        />
      }
    >
      {!changes.length && (
        <p>
          {draft
            ? "אפשר לבדוק את שינוי הפרטים והשיבוצים ולשמור בטיוטה. פרסום לחיילים מתבצע בנפרד."
            : "אפשר לשמור הצעה, לבדוק את השפעתה ולפרסם אותה לאחר טיפול בשיבוצים."}
        </p>
      )}
      {changes.map((change) => (
        <ChangeEditor
          key={`${change.id}:${change.version}`}
          state={state}
          action={action}
          duty={duty}
          change={change}
        />
      ))}
    </Panel>
  );
}
function ChangeEditor({
  state,
  action,
  duty,
  change,
}: {
  state: AppState;
  action: Action;
  duty: Row;
  change: Row;
}) {
  const draft = duty.status === "draft";
  const [editing, setEditing] = useState(false);
  const [editingRules, setEditingRules] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const proposed = obj(change.proposed);
  const seats = rows(change.seats);
  const slots = rows(proposed.slots);
  const stale = change.baseVersion !== duty.version;
  const local = (value: unknown) =>
    DateTime.fromISO(str(value))
      .setZone("Asia/Jerusalem")
      .toFormat("yyyy-MM-dd'T'HH:mm");
  const fields: Field[] = [
    {
      name: "name",
      label: "שם התורנות המוצע",
      required: true,
      value: str(proposed.name),
    },
    { name: "location", label: "המיקום המוצע", value: str(proposed.location) },
    {
      name: "start",
      label: "תחילת התורנות המוצעת",
      type: "datetime-local",
      required: true,
      value: local(proposed.start),
    },
    {
      name: "end",
      label: "סיום התורנות המוצעת",
      type: "datetime-local",
      required: true,
      value: local(proposed.end),
    },
    {
      name: "instructions",
      label: "הנחיות מוצעות",
      type: "textarea",
      full: true,
      value: str(proposed.instructions),
    },
    {
      name: "reason",
      label: "סיבת השינוי",
      required: true,
      value: str(change.reason),
      full: true,
    },
    ...slots.flatMap((slot, index): Field[] => {
      const seat = seats.find((seat) => seat.slotId === slot.id);
      return [
        {
          name: `soldier${index}`,
          label: `מקום ${index + 1}: ${str(slot.role)}`,
          type: "select",
          value: str(seat?.soldierId, "vacant") || "vacant",
          options: [
            { value: "vacant", label: "להשאיר פנוי / להסיר את השיבוץ" },
            // A manager is never assigned (decision 192). One who still holds the
            // seat shows, marked, so the proposal can give it to someone else.
            ...assignableSoldiers(state, [seat?.soldierId]).map((person) => ({
              value: person.id,
              label: person.isManager
                ? `${str(person.name)} — אחראי, יש להחליף`
                : str(person.name),
            })),
          ],
        },
        ...callUpFields(
          { id: str(change.id), pricing: proposed.pricing },
          {
            prefix: `seat${index}`,
            label: `הזנקה במקום ${index + 1}`,
            current: seat?.extraPoints,
          }
        ),
      ];
    }),
  ];
  const checks = rows(preview?.checks);
  const requirements: Row[] = checks.flatMap((check) =>
    rows(check.requirements).map((reason) => ({
      ...reason,
      soldierId: check.soldierId,
    }))
  );
  const blocked =
    Boolean(preview?.pendingReviewRequired) ||
    checks.some((check) => check.status === "blocked");
  const assignmentSummary = (assignments: unknown, snapshot: unknown) =>
    rows(assignments)
      .map(
        (assignment) =>
          `${str(rows(obj(snapshot).slots).find((slot) => slot.id === assignment.slotId)?.role, "תורן")}: ${num(assignment.points)} נקודות שמורות`
      )
      .join("; ");
  return (
    <div className="subsection">
      <h3>{str(proposed.name)}</h3>
      <p>
        {str(change.reason)} · {displayDate(proposed.start, true)} —{" "}
        {displayDate(proposed.end, true)}
      </p>
      {change.catalogVersion ? (
        <Notice>
          ההצעה כוללת כללי קטלוג מגרסה {num(change.catalogVersion)}. מקומות
          שהוסרו מההרכב יופיעו בהשוואת השיבוצים.
        </Notice>
      ) : null}
      {change.requestId ? (
        <RequestNotice state={state} requestId={change.requestId} />
      ) : null}
      {stale ? (
        <Notice tone="danger">
          התורנות השתנתה מאז יצירת ההצעה. יש לבטל את ההצעה וליצור אחת מתוך הגרסה
          העדכנית.
        </Notice>
      ) : (
        <>
          <button className="btn secondary" onClick={() => setEditing(true)}>
            עריכת ההצעה והשיבוצים
          </button>
          <button
            className="btn secondary"
            onClick={() => setEditingRules(true)}
          >
            עריכת הרכב ותמחור למופע
          </button>
          <Form
            fields={[
              {
                name: "reviewPending",
                label: "מאשר להתקדם לפני השלמת סקירת האילוצים הממתינים",
                type: "checkbox",
              },
            ]}
            submitLabel="בדיקת השפעת השינוי"
            onSubmit={async (values) => {
              setReviewPending(Boolean(values.reviewPending));
              setPreview(
                await action(
                  "duty.change.preview",
                  { id: change.id, ...values },
                  change.version
                )
              );
            }}
          />
        </>
      )}
      <ActionDialog
        title="ביטול הצעת השינוי"
        fields={[]}
        action={action}
        type="duty.change.discard"
        payload={{ id: change.id }}
        version={change.version}
      />
      {editingRules && (
        <Modal
          title="הרכב ותמחור למופע זה"
          wide
          onClose={() => setEditingRules(false)}
        >
          <CompositionEditor
            state={state}
            action={action}
            change={change}
            onDone={() => setEditingRules(false)}
          />
        </Modal>
      )}
      {editing && (
        <Modal title="עריכת הצעת שינוי" wide onClose={() => setEditing(false)}>
          <Form
            fields={fields}
            submitLabel="שמירת הצעה בלבד"
            onSubmit={async (values) => {
              await action(
                "duty.change.save",
                {
                  id: change.id,
                  ...values,
                  seats: slots.map((slot, index) => ({
                    slotId: slot.id,
                    soldierId:
                      values[`soldier${index}`] === "vacant"
                        ? null
                        : values[`soldier${index}`],
                    extraPoints: callUpValue(values, `seat${index}`),
                  })),
                },
                change.version
              );
              setEditing(false);
            }}
          />
        </Modal>
      )}
      {preview && (
        <Modal
          title={draft ? "השוואה לפני שמירת הטיוטה" : "השוואה לפני עדכן ופרסם"}
          wide
          onClose={() => setPreview(null)}
        >
          <Notice>
            הגרסה הקיימת מחייבת עד לאישור הסופי. חריגים מהגרסה הקודמת אינם
            מועברים אוטומטית.
          </Notice>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>פרט</th>
                  <th>לפני</th>
                  <th>אחרי</th>
                </tr>
              </thead>
              <tbody>
                {(
                  ["name", "start", "end", "location", "instructions"] as const
                ).map((key, index) => (
                  <tr key={key}>
                    <th>{["שם", "התחלה", "סיום", "מיקום", "הנחיות"][index]}</th>
                    <td>
                      {key === "start" || key === "end"
                        ? displayDate(obj(preview.before)[key], true)
                        : str(obj(preview.before)[key])}
                    </td>
                    <td>
                      {key === "start" || key === "end"
                        ? displayDate(obj(preview.after)[key], true)
                        : str(obj(preview.after)[key])}
                    </td>
                  </tr>
                ))}
                <tr>
                  <th>הרכב</th>
                  {[preview.before, preview.after].map((snapshot, index) => (
                    <td key={index}>
                      {describeComposition(obj(snapshot).slots)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>תמחור</th>
                  {[preview.before, preview.after].map((snapshot, index) => (
                    <td key={index}>
                      {describePricing(obj(obj(snapshot).pricing) as Row)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th>מנוחה לפני / אחרי</th>
                  {[preview.before, preview.after].map((snapshot, index) => (
                    <td key={index}>
                      {num(obj(snapshot).restBeforeMinutes)} /{" "}
                      {num(obj(snapshot).restAfterMinutes)} דקות
                    </td>
                  ))}
                </tr>
                {rows(preview.affected).map((person) => (
                  <tr key={str(person.soldierId)}>
                    <th>{personName(state, person.soldierId)}</th>
                    <td>
                      {assignmentSummary(person.before, preview.before) ||
                        "לא משובץ"}
                    </td>
                    <td>
                      {assignmentSummary(person.after, preview.after) ||
                        "השיבוץ יוסר"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>פירוט הניקוד לכל מקום</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>מקום</th>
                  <th>בסיס</th>
                  <th>תוספות זמן</th>
                  <th>הזנקה</th>
                  <th>סכום מדויק</th>
                  <th>ניקוד</th>
                </tr>
              </thead>
              <tbody>
                {rows(preview.seatPrices).map((seat) => {
                  const price = obj(seat.price);
                  const surcharges = rows(
                    obj(obj(preview.after).pricing).surcharges
                  );
                  return (
                    <tr key={str(seat.slotId)}>
                      <th>
                        {str(seat.role)} ·{" "}
                        {seat.soldierId
                          ? personName(state, seat.soldierId)
                          : "פנוי"}
                      </th>
                      <td>{str(price.base)}</td>
                      <td>
                        {rows(price.surcharges)
                          .filter((item) => num(item.count))
                          .map(
                            (item) =>
                              `${str(surcharges.find((rule) => rule.id === item.id)?.name, "תוספת")}: ${num(item.count)} ${num(item.count) === 1 ? "חלון" : "חלונות"} = ${str(item.subtotal)}`
                          )
                          .join("; ") || "—"}
                      </td>
                      <td>{str(price.extras)}</td>
                      <td>{str(price.totalExact)}</td>
                      <td>{num(price.points)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted">
            הרכיבים מחוברים בדיוק ומעוגלים פעם אחת, חצי כלפי מעלה.
          </p>
          {preview.pendingReviewRequired ? (
            <Notice tone="danger">
              יש לחזור ולאשר המשך לפני סקירת האילוצים הממתינים.
            </Notice>
          ) : null}
          {checks.map((check) => (
            <div key={str(check.slotId)}>
              <h3>
                {personName(state, check.soldierId)} · {num(check.points)}{" "}
                נקודות
              </h3>
              <p>
                בסיס: {str(obj(check.price).base)} · הזנקה:{" "}
                {str(obj(check.price).extras)}
              </p>
              {rows(obj(check.price).surcharges).map((bonus, index) => (
                <p key={index}>
                  תוספת זמן: {num(bonus.count)} חלונות · {str(bonus.subtotal)}{" "}
                  נקודות
                </p>
              ))}
              {rows(check.blockers).map((reason, index) => (
                <Notice key={index} tone="danger">
                  {str(reason.message)}
                </Notice>
              ))}
            </div>
          ))}
          {blocked ? (
            <Notice tone="danger">
              יש לחזור להצעה ולטפל בשיבוצים החסומים לפני השלמת השינוי.
            </Notice>
          ) : (
            <Form
              fields={[
                ...requirements.map((reason, index): Field => ({
                  name: `approval${index}`,
                  label: `${personName(state, reason.soldierId)}: ${str(reason.message)}`,
                  type: "checkbox",
                  required: true,
                })),
                {
                  name: "confirmed",
                  label: draft
                    ? "בדקתי את השינויים, הסרת השיבוצים והניקוד ומאשר לשמור בטיוטה"
                    : "בדקתי את השינויים, הסרת השיבוצים והניקוד ומאשר לפרסם",
                  type: "checkbox",
                  required: true,
                },
              ]}
              submitLabel={draft ? "שמירת השינוי בטיוטה" : "עדכן ופרסם"}
              onSubmit={async (values) => {
                await action(
                  draft ? "duty.change.apply" : "duty.change.publish",
                  {
                    id: change.id,
                    ...values,
                    reviewPending,
                    previewToken: preview.previewToken,
                    approvalKeys: requirements.map((reason) => reason.key),
                  },
                  change.version
                );
                setPreview(null);
              }}
            />
          )}
        </Modal>
      )}
    </div>
  );
}
/** A proposal opened from a soldier's cancellation or postponement request. */
function RequestNotice({
  state,
  requestId,
}: {
  state: AppState;
  requestId: unknown;
}) {
  const request = state.requests.find((row) => row.id === requestId);
  if (!request) return null;
  const kind = request.kind === "postpone" ? "הדחייה" : "הביטול";
  return request.status === "pending" ? (
    <Notice>
      ההצעה מטפלת בבקשת {kind} של {personName(state, request.soldierId)}. הבקשה
      תסומן כהושלמה ב״עדכן ופרסם״ אם החייל יוסר מהתורנות או שמועדה ישתנה; אחרת
      היא תישאר ממתינה.
    </Notice>
  ) : (
    <Notice tone="warning">
      בקשת {kind} של {personName(state, request.soldierId)} כבר הוכרעה. פרסום
      ההצעה לא ישנה את ההכרעה.
    </Notice>
  );
}
