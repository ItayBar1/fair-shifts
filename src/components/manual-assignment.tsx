"use client";
import { useState } from "react";
import {
  type AppState,
  type Action,
  type Row,
  assignableSoldiers,
  str,
  rows,
  obj,
  num,
} from "@/client/types";
import { Modal, Form, Notice, type Field } from "./ui";
import { callUpFields, callUpValue } from "./call-up";
export function ManualAssignment({
  state,
  action,
  duty,
  slotId,
}: {
  state: AppState;
  action: Action;
  duty: Row;
  slotId: string;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const requirements = rows(preview?.requirements);
  const fields: Field[] = [
    {
      name: "soldierId",
      label: "בחירת חייל",
      type: "select",
      required: true,
      options: assignableSoldiers(state).map((row) => ({
        value: row.id,
        label: str(row.name),
      })),
    },
    ...callUpFields(duty),
  ];
  if (state.constraints.some((row) => row.pending))
    fields.push({
      name: "reviewPending",
      label: "מאשר להמשיך לפני השלמת סקירת האילוצים הממתינים",
      type: "checkbox",
      hint: "התנגשות עם אילוץ ממתין עדיין תדרוש אישור פרטני.",
    });
  const close = () => {
    setOpen(false);
    setPreview(null);
  };
  return (
    <>
      <button className="btn secondary" onClick={() => setOpen(true)}>
        שיבוץ ידני
      </button>
      {open && (
        <Modal title="שיבוץ ידני" onClose={close}>
          {!preview ? (
            <Form
              fields={fields}
              onSubmit={async (values) => {
                const payload = {
                  soldierId: values.soldierId,
                  reviewPending: values.reviewPending,
                  callUpBonus: callUpValue(values),
                  dutyId: duty.id,
                  slotId,
                };
                const result = await action(
                  "duty.assignment.preview",
                  payload,
                  duty.version
                );
                setInput(payload);
                setPreview(result);
              }}
            />
          ) : (
            <>
              <Notice>
                השיבוץ יישמר רק לאחר האישור. ניקוד צפוי:{" "}
                {num(obj(preview.price).points)} נקודות. בסיס:{" "}
                {str(obj(preview.price).base)}; הזנקה:{" "}
                {str(obj(preview.price).extras)}.
              </Notice>
              {rows(obj(preview.price).surcharges).map((row) => (
                <p key={str(row.id)}>
                  תוספת זמן: {num(row.count)} חלונות · {str(row.subtotal)}{" "}
                  נקודות
                </p>
              ))}
              {rows(preview.blockers).map((row, index) => (
                <Notice tone="danger" key={index}>
                  {str(row.message)}
                </Notice>
              ))}
              {preview.pendingReviewRequired && !input.reviewPending ? (
                <Notice tone="danger">
                  יש לחזור לבחירה ולאשר המשך לפני השלמת סקירת האילוצים.
                </Notice>
              ) : (
                preview.status !== "blocked" && (
                  <Form
                    fields={[
                      ...requirements.map((row, index): Field => ({
                        name: `approval${index}`,
                        label: str(row.message),
                        type: "checkbox",
                        required: true,
                      })),
                      ...(requirements.length
                        ? [
                            {
                              name: "approvalReason",
                              label: "סיבה לאישור החריגים הנקודתיים",
                              type: "textarea" as const,
                              required: true,
                              full: true,
                            },
                          ]
                        : []),
                      {
                        name: "confirmed",
                        label: "בדקתי את ההתאמה ואת הניקוד",
                        type: "checkbox",
                        required: true,
                      },
                    ]}
                    submitLabel="אישור השיבוץ"
                    onSubmit={async (values) => {
                      await action(
                        "duty.assign",
                        {
                          ...input,
                          previewToken: preview.previewToken,
                          approvalReason: values.approvalReason,
                          approvalKeys: requirements.map((row) => row.key),
                        },
                        duty.version
                      );
                      close();
                    }}
                  />
                )
              )}
              <button
                className="btn secondary"
                onClick={() => setPreview(null)}
              >
                חזרה לבחירת חייל
              </button>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
