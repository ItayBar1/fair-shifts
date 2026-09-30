"use client";
import { useState } from "react";
import { DateTime } from "luxon";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  rows,
  obj,
  displayDate,
  personName,
} from "@/client/types";
import { Badge, Modal, Notice, Panel } from "./ui";

// Execution periods of a seat in a duty that started (decision 183).

const ZONE = "Asia/Jerusalem";
// A typed wall-clock time is Israel time, whatever the browser's own time zone.
const moment = (value: string) => DateTime.fromISO(value, { zone: ZONE });
const local = (value: string) => moment(value).toFormat("yyyy-MM-dd'T'HH:mm");

type Segment = { soldierId: string | null; start: string; end: string };

const SEAT = ["reserved", "held", "credited"];

/** The recorded segments of a seat: performers by their actual period, then parts not performed. */
export function seatSegments(state: AppState, duty: Row, slotId: string) {
  const performed = state.assignments
    .filter(
      (row) =>
        row.dutyId === duty.id &&
        row.slotId === slotId &&
        SEAT.includes(str(row.status))
    )
    .map((row) => {
      const performance = obj(row.performance);
      const credited = row.status === "credited";
      return {
        soldierId: str(performance.performerId, str(row.soldierId)),
        start: str(
          credited ? performance.start : undefined,
          str(row.performedStart, str(duty.start))
        ),
        end: str(
          credited ? performance.end : undefined,
          str(row.performedEnd, str(duty.end))
        ),
        credited,
        points: credited
          ? num(performance.points, num(row.points))
          : num(row.points),
        rowId: row.id,
      };
    });
  const seat = rows(state.seatExecutions).find(
    (row) => row.dutyId === duty.id && row.slotId === slotId
  );
  const skipped = rows(seat?.notPerformed).map((part) => ({
    soldierId: null as string | null,
    start: str(part.start),
    end: str(part.end),
    credited: false,
    points: 0,
    rowId: "",
  }));
  return [...performed, ...skipped].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );
}

const kindLabels: Record<string, string> = {
  keep: "ללא שינוי",
  update: "עדכון תקופה",
  create: "מבצע חדש",
  cancel: "הסרה מהשיבוץ",
  late: "זקיפת ביצוע שהסתיים",
  correct: "תיקון ביצוע שנזקף",
  remove: "ביטול ביצוע שנזקף",
};

export function ExecutionPeriods({
  state,
  action,
  duty,
}: {
  state: AppState;
  action: Action;
  duty: Row;
}) {
  const slots = rows(duty.slots);
  const history = rows(state.executionChanges)
    .filter((row) => row.dutyId === duty.id)
    .sort((a, b) => str(b.recordedAt).localeCompare(str(a.recordedAt)));
  return (
    <Panel
      title="תקופות ביצוע"
      subtitle="מי ביצע בפועל כל חלק של התורנות. כל רגע בתורנות שייך למבצע אחד או מסומן ״לא בוצע״; בתעריף יומי הניקוד יחסי לזמן בפועל."
    >
      {slots.map((slot) => {
        const segments = seatSegments(state, duty, slot.id);
        return (
          <div className="slot-row execution-seat" key={slot.id}>
            <span className="grow">
              <strong>{str(slot.name ?? slot.role, "תורן")}</strong>
              {segments.length ? (
                segments.map((segment, index) => (
                  <small key={index}>
                    {segment.soldierId
                      ? personName(state, segment.soldierId)
                      : "לא בוצע"}{" "}
                    · {displayDate(segment.start, true)} —{" "}
                    {displayDate(segment.end, true)}
                    {segment.soldierId ? ` · ${segment.points} נקודות` : ""}
                    {segment.credited ? " · נזקף" : ""}
                  </small>
                ))
              ) : (
                <small>מקום פנוי</small>
              )}
            </span>
            <SeatEditor
              state={state}
              action={action}
              duty={duty}
              slot={slot}
              segments={segments}
            />
          </div>
        );
      })}
      {history.length > 0 && (
        <div className="table-scroll">
          <table>
            <caption>היסטוריית תקופות ביצוע</caption>
            <thead>
              <tr>
                <th>נרשם</th>
                <th>מבצע השינוי</th>
                <th>מקום</th>
                <th>אחרי</th>
                <th>סיבה</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td>{displayDate(row.recordedAt, true)}</td>
                  <td>{str(row.actorName)}</td>
                  <td>{str(row.role, "תורן")}</td>
                  <td>
                    {rows(row.after)
                      .map(
                        (segment) =>
                          `${segment.soldierId ? personName(state, segment.soldierId) : "לא בוצע"} ${displayDate(segment.start, true)}–${displayDate(segment.end, true)}`
                      )
                      .join(" · ")}
                  </td>
                  <td>{str(row.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function SeatEditor({
  state,
  action,
  duty,
  slot,
  segments: recorded,
}: {
  state: AppState;
  action: Action;
  duty: Row;
  slot: Row;
  segments: ReturnType<typeof seatSegments>;
}) {
  const initial = (): Segment[] =>
    recorded.length
      ? recorded.map(({ soldierId, start, end }) => ({ soldierId, start, end }))
      : [{ soldierId: null, start: str(duty.start), end: str(duty.end) }];
  const [open, setOpen] = useState(false);
  const [segments, setSegments] = useState<Segment[]>(initial);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [reviewPending, setReviewPending] = useState(false);
  const [approvalKeys, setApprovalKeys] = useState<string[]>([]);
  const [approvalReason, setApprovalReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const soldiers = state.soldiers.filter((row) => !row.deletedAt);
  const close = () => {
    setOpen(false);
    setPreview(null);
    setSegments(initial());
    setError("");
  };
  const edit = (next: Segment[]) => {
    setSegments(next);
    setPreview(null);
  };
  const payload = () => ({
    dutyId: duty.id,
    slotId: slot.id,
    segments: segments.map((segment) => ({
      soldierId: segment.soldierId,
      start: segment.start,
      end: segment.end,
    })),
    reason,
    reviewPending,
  });
  const run = async (work: () => Promise<void>) => {
    setError("");
    setPending(true);
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "הפעולה לא הושלמה. אפשר לנסות שוב."
      );
    } finally {
      setPending(false);
    }
  };
  const setBoundary = (index: number, value: string) => {
    const next = segments.map((segment) => ({ ...segment }));
    next[index]!.end = value;
    next[index + 1]!.start = value;
    edit(next);
  };
  const splitLast = () => {
    const next = segments.map((segment) => ({ ...segment }));
    const last = next.at(-1)!;
    const from = moment(last.start);
    const to = moment(last.end);
    const middle = from
      .plus({ milliseconds: to.diff(from).as("milliseconds") / 2 })
      .startOf("hour");
    const at = middle > from ? middle : from.plus({ minutes: 1 });
    const iso = at.toISO()!;
    last.end = iso;
    next.push({ soldierId: null, start: iso, end: str(duty.end) });
    edit(next);
  };
  const removeAt = (index: number) => {
    const next = segments.map((segment) => ({ ...segment }));
    const [gone] = next.splice(index, 1);
    if (index > 0) next[index - 1]!.end = gone!.end;
    else next[0]!.start = gone!.start;
    edit(next);
  };
  const changes = rows(preview?.changes);
  const requirements = changes.flatMap((change) =>
    rows(obj(change.eligibility).requirements).map((requirement) => ({
      key: str(requirement.key),
      message: str(requirement.message),
      name: str(change.name),
    }))
  );
  return (
    <>
      <button className="btn secondary" onClick={() => setOpen(true)}>
        עריכת תקופות ביצוע
      </button>
      {open && (
        <Modal
          title={`תקופות ביצוע · ${str(slot.name ?? slot.role, "תורן")}`}
          onClose={close}
          wide
        >
          <p className="muted">
            {displayDate(duty.start, true)} — {displayDate(duty.end, true)}. כל
            תקופה מסתיימת כשהבאה מתחילה, כך שאין זמן ללא שיוך.
          </p>
          {recorded.some((segment) => segment.credited) && (
            <Notice tone="info">
              תקופה שכבר נזקפה משתנה לפי כללי תיקון העבר: אם מאז הביצוע היה
              נרמול, קביעת יתרה או חיתוך באפס, היתרה לא תשתנה אוטומטית ותיפתח
              הכרעה.
            </Notice>
          )}
          <ol className="execution-segments">
            {segments.map((segment, index) => (
              <li key={index} className="execution-segment">
                <label className="field">
                  <span>מבצע בתקופה {index + 1}</span>
                  <span className="select-wrap">
                    <select
                      aria-label={`מבצע בתקופה ${index + 1}`}
                      value={segment.soldierId ?? ""}
                      onChange={(event) => {
                        const next = segments.map((item) => ({ ...item }));
                        next[index]!.soldierId = event.target.value || null;
                        edit(next);
                      }}
                    >
                      <option value="">לא בוצע</option>
                      {soldiers.map((row) => (
                        <option key={row.id} value={row.id}>
                          {str(row.name)}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
                <label className="field">
                  <span>התחלה</span>
                  <input
                    aria-label={`תחילת תקופה ${index + 1}`}
                    type="datetime-local"
                    dir="ltr"
                    value={local(segment.start)}
                    disabled
                  />
                </label>
                <label className="field">
                  <span>סיום</span>
                  <input
                    aria-label={`סיום תקופה ${index + 1}`}
                    type="datetime-local"
                    dir="ltr"
                    value={local(segment.end)}
                    disabled={index === segments.length - 1}
                    onChange={(event) =>
                      event.target.value &&
                      setBoundary(index, event.target.value)
                    }
                  />
                </label>
                {segments.length > 1 && (
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => removeAt(index)}
                  >
                    הסרת תקופה
                  </button>
                )}
              </li>
            ))}
          </ol>
          <button type="button" className="btn secondary" onClick={splitLast}>
            הוספת תקופה
          </button>
          <label className="field full">
            <span>
              סיבה<span className="required"> *</span>
            </span>
            <textarea
              aria-label="סיבה"
              value={reason}
              rows={2}
              onChange={(event) => {
                setReason(event.target.value);
                setPreview(null);
              }}
            />
          </label>
          {!preview ? (
            <div className="form-actions">
              <button
                className="btn primary"
                disabled={pending || !reason.trim()}
                onClick={() =>
                  run(async () => {
                    const result = await action("execution.preview", payload());
                    setPreview(result);
                    setApprovalKeys([]);
                    setConfirmed(false);
                  })
                }
              >
                תצוגת השפעה
              </button>
            </div>
          ) : (
            <>
              <div className="table-scroll">
                <table>
                  <caption>השפעה לפני שמירה</caption>
                  <thead>
                    <tr>
                      <th>חייל</th>
                      <th>שינוי</th>
                      <th>תקופה</th>
                      <th>חישוב</th>
                      <th>ניקוד</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changes.map((change) => {
                      const price = obj(change.price);
                      const to = obj(change.to);
                      const effect = obj(change.effect);
                      return (
                        <tr key={str(change.soldierId)}>
                          <td>{str(change.name)}</td>
                          <td>{kindLabels[str(change.kind)] ?? ""}</td>
                          <td>
                            {to.start
                              ? `${displayDate(to.start, true)} — ${displayDate(to.end, true)}`
                              : "—"}
                          </td>
                          <td>
                            {change.price ? (
                              <>
                                בסיס {str(price.base)}
                                {rows(price.surcharges)
                                  .filter((item) => num(item.count) > 0)
                                  .map(
                                    (item) =>
                                      ` + תוספת ${num(item.count)}×=${str(item.subtotal)}`
                                  )
                                  .join("")}{" "}
                                = {str(price.totalExact)} ← {num(price.points)}
                              </>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            {num(change.pointsBefore)} ←{" "}
                            {change.kind === "cancel" ||
                            change.kind === "remove"
                              ? 0
                              : num(price.points, num(change.pointsBefore))}
                            {Boolean(change.effect) &&
                              (effect.status === "automatic" ? (
                                <small>
                                  {" "}
                                  · יתרה {num(effect.balance)} ←{" "}
                                  {num(effect.after)}
                                  {effect.clamped ? " (נעצר באפס)" : ""}
                                </small>
                              ) : (
                                <Badge tone="warning">ממתין להכרעה</Badge>
                              ))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {changes
                .filter(
                  (change) => obj(change.effect).status === "decision_required"
                )
                .map((change) => (
                  <Notice tone="warning" key={`d${str(change.soldierId)}`}>
                    היתרה של {str(change.name)} לא תשתנה אוטומטית
                    {rows(obj(change.effect).barriers).length
                      ? `: מאז הביצוע ${rows(obj(change.effect).barriers)
                          .map(
                            (row) =>
                              `${str(row.reason)} (${displayDate(row.effectiveAt, true)})`
                          )
                          .join(" · ")}`
                      : " כי קיימת הכרעה פתוחה"}
                    . תיפתח הכרעה ממתינה ותזכורת לאחראים.
                  </Notice>
                ))}
              {changes
                .filter((change) => rows(change.findings).length)
                .map((change) => (
                  <Notice tone="warning" key={`f${str(change.soldierId)}`}>
                    ממצאי התאמה ל{str(change.name)} בתקופה שהסתיימה (אינם חוסמים
                    רישום היסטורי):{" "}
                    {rows(change.findings)
                      .map((row) => str(row.message))
                      .join(" · ")}
                  </Notice>
                ))}
              {changes
                .filter(
                  (change) => rows(obj(change.eligibility).blockers).length
                )
                .map((change) => (
                  <Notice tone="danger" key={`b${str(change.soldierId)}`}>
                    {str(change.name)} אינו עומד בתנאי התורנות לתקופה שנבחרה:{" "}
                    {rows(obj(change.eligibility).blockers)
                      .map((row) => str(row.message))
                      .join(" · ")}
                  </Notice>
                ))}
              {preview.reviewPendingRequired === true && (
                <label className="field check-field">
                  <input
                    type="checkbox"
                    aria-label="המשך לפני סקירת האילוצים הממתינים"
                    checked={reviewPending}
                    onChange={(event) => {
                      setReviewPending(event.target.checked);
                      setPreview(null);
                    }}
                  />
                  <span>המשך לפני סקירת האילוצים הממתינים</span>
                </label>
              )}
              {requirements.length > 0 && (
                <fieldset className="approval-list">
                  <legend>אישור חריגים</legend>
                  {requirements.map((requirement) => (
                    <label
                      className="field check-field"
                      key={str(requirement.key)}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${requirement.name}: ${str(requirement.message)}`}
                        checked={approvalKeys.includes(str(requirement.key))}
                        onChange={(event) =>
                          setApprovalKeys((keys) =>
                            event.target.checked
                              ? [...keys, str(requirement.key)]
                              : keys.filter((key) => key !== requirement.key)
                          )
                        }
                      />
                      <span>
                        {requirement.name}: {str(requirement.message)}
                      </span>
                    </label>
                  ))}
                  <label className="field full">
                    <span>סיבת אישור החריגים</span>
                    <textarea
                      aria-label="סיבת אישור החריגים"
                      rows={2}
                      value={approvalReason}
                      onChange={(event) =>
                        setApprovalReason(event.target.value)
                      }
                    />
                  </label>
                </fieldset>
              )}
              <label className="field check-field">
                <input
                  type="checkbox"
                  aria-label="בדקתי את התקופות ואת השפעתן"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>בדקתי את התקופות ואת השפעתן</span>
              </label>
              <div className="form-actions">
                <button
                  className="btn primary"
                  disabled={pending || !confirmed || preview.blocked === true}
                  onClick={() =>
                    run(async () => {
                      await action("execution.apply", {
                        ...payload(),
                        token: preview.token,
                        approvalKeys,
                        ...(approvalReason.trim() && { approvalReason }),
                      });
                      close();
                    })
                  }
                >
                  שמירת תקופות הביצוע
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
          {error && <Notice tone="danger">{error}</Notice>}
        </Modal>
      )}
    </>
  );
}

/** Cancellation requests referred to execution handling, until their seat is recorded. */
export function referredRequests(state: AppState) {
  return state.requests.filter(
    (row) =>
      row.type === "cancellation" &&
      row.status === "referred" &&
      !row.executionId
  );
}
