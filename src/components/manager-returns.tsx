"use client";
import { useState } from "react";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  rows,
  displayDate,
  personName,
} from "@/client/types";
import { ActionDialog, Badge, Form, Modal, Notice, Panel } from "./ui";

/**
 * Managers who are soldiers again (decision 192). Their balance stood still while
 * they were managers, and from now on they are assigned with it, so each waits for
 * the manager's decision: set a balance with a preview, or leave it as it is.
 */
export function ManagerReturns({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const pending = rows(state.managerReturns).filter(
    (row) => row.status === "pending"
  );
  return (
    <Panel
      title="אחראים שחזרו להיות חיילים"
      subtitle="היתרה לא השתנתה בזמן שהיו אחראים, ומעכשיו הם משובצים שוב. כאן מחליטים אם לקבוע להם יתרה."
    >
      {pending.map((item) => (
        <div className="slot-row" key={item.id} data-testid="manager-return">
          <span className="grow">
            <strong>{personName(state, item.soldierId)}</strong>
            <small>
              חזר להיות חייל ב־{displayDate(item.openedAt, true)} · יתרה מוקפאת{" "}
              {num(item.balanceAtReturn)} · יתרה כיום{" "}
              {num(
                state.soldiers.find((row) => row.id === item.soldierId)
                  ?.currentScore
              )}
            </small>
          </span>
          <Badge tone="warning">ממתין להחלטה</Badge>
          <SetBalance state={state} action={action} item={item} />
          <ActionDialog
            title="השארת היתרה"
            buttonLabel="להשאיר את היתרה"
            description="היתרה נשארת כמות שהיא, וההחלטה נרשמת ביומן הפעולות."
            fields={[
              {
                name: "reason",
                label: "סיבה",
                type: "textarea",
                required: true,
                full: true,
              },
            ]}
            action={action}
            type="manager.return.keep"
            payload={{ id: item.id }}
            version={num(item.version)}
          />
        </div>
      ))}
    </Panel>
  );
}

/** The balance tool of the scores screen, with its preview, for one returned manager. */
function SetBalance({
  state,
  action,
  item,
}: {
  state: AppState;
  action: Action;
  item: Row;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const close = () => {
    setOpen(false);
    setPreview(null);
  };
  return (
    <>
      <button className="btn secondary" onClick={() => setOpen(true)}>
        קביעת יתרה
      </button>
      {open && (
        <Modal
          title={`קביעת יתרה — ${personName(state, item.soldierId)}`}
          onClose={close}
        >
          {!preview ? (
            <Form
              fields={[
                {
                  name: "value",
                  label: "היתרה החדשה",
                  type: "number",
                  required: true,
                  min: 0,
                  step: "1",
                  value: input.value === undefined ? "" : num(input.value),
                },
                {
                  name: "reason",
                  label: "סיבה",
                  type: "textarea",
                  required: true,
                  full: true,
                  value: str(input.reason),
                },
              ]}
              submitLabel="תצוגה מקדימה"
              onSubmit={async (values) => {
                const payload = {
                  soldierIds: [str(item.soldierId)],
                  operation: "set",
                  value: values.value,
                  reason: values.reason,
                };
                const result = await action("score.preview", payload);
                setInput(payload);
                setPreview(result);
              }}
            />
          ) : (
            <>
              <Notice>
                השינוי יישמר רק לאחר האישור. אחרי האישור הפריט נסגר.
              </Notice>
              {rows(preview.rows).map((row) => (
                <p key={str(row.soldierId)}>
                  {personName(state, row.soldierId)}: {num(row.before)} ←{" "}
                  {num(row.after)}
                </p>
              ))}
              <div className="form-actions">
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      await action("score.apply", {
                        ...input,
                        token: preview.token,
                      });
                      close();
                    } catch {
                      /* Workspace renders errors. */
                    }
                  }}
                >
                  אישור שינוי היתרה
                </button>
                <button
                  className="btn secondary"
                  onClick={() => setPreview(null)}
                >
                  חזרה לעריכה
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
