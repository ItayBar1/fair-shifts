"use client";
import { DutyChanges } from "../duty-changes";
import { LoadOlder } from "../load-older";
import Link from "next/link";
import { ManualAssignment } from "../manual-assignment";
import {
  PerformanceCorrections,
  performanceOf,
} from "../performance-corrections";
import { LotteryButton, LotteryHistory } from "../planning";
import { ScoreDecisions } from "../score-decisions";
import { ExecutionPeriods } from "../execution-periods";
import { deletedSeats } from "@/client/deleted-seats";
import { describeRest } from "@/client/rest-duration";
import { TransferOffer } from "../transfers";
import { SwapOffer } from "../swaps";
import {
  CancellationRequestButton,
  CancellationRequests,
} from "../cancellation-requests";
import {
  CalendarDays,
  UsersRound,
  Clock3,
  ChevronRight,
  MapPin,
} from "lucide-react";
import {
  type AppState,
  type Action,
  str,
  num,
  obj,
  personName,
  displayDate,
} from "@/client/types";
import { ActionDialog, Badge, Empty, Panel, Status, Notice } from "../ui";
import { AuditLink } from "../audit";
import { concernReason } from "./dashboard";
import { DrawReceipt } from "./draw-receipt";
import {
  activeAssignments,
  dutyEnd,
  dutySlots,
  dutyStart,
  dutyStatus,
} from "./duty-helpers";

export function DutyDetail({
  state,
  action,
  id,
}: {
  state: AppState;
  action: Action;
  id: string;
}) {
  const duty = state.duties.find((d) => d.id === id);
  if (!duty)
    return (
      <>
        <Empty
          title="התורנות לא נמצאה"
          text="ייתכן שהוסרה, שאינה זמינה לחשבון שלך או שהיא ישנה יותר מהמוצג."
        />
        <LoadOlder what="תורנויות" />
      </>
    );
  const manager = state.actor.role === "manager";
  const assignments = activeAssignments(state, id);
  const slots = dutySlots(duty);
  const future =
    new Date(dutyStart(duty)).getTime() >
    new Date(str(state.serverNow)).getTime();
  return (
    <>
      <Link className="text-link back-link" href="/calendar">
        <ChevronRight size={15} />
        חזרה ללוח התורנויות
      </Link>
      <Panel>
        <div className="duty-hero">
          <span className="large-symbol">
            <CalendarDays size={31} />
          </span>
          <div>
            <div className="inline">
              <Status value={dutyStatus(duty)} />
              {(duty.needsReview === true ||
                assignments.some(
                  (item) =>
                    Array.isArray(item.needsAttention) &&
                    item.needsAttention.length > 0
                )) && <Badge tone="warning">דורשת טיפול</Badge>}
            </div>
            <h2>{str(duty.name)}</h2>
            <div className="meta-line">
              <span>
                <MapPin size={16} />
                {str(duty.location, "לא הוגדר מיקום")}
              </span>
              <span>
                <Clock3 size={16} />
                {displayDate(dutyStart(duty), true)} —{" "}
                {displayDate(dutyEnd(duty), true)}
              </span>
            </div>
          </div>
        </div>
        {duty.instructions ? (
          <div className="instruction-box">
            <h3>מה צריך לדעת</h3>
            <p>{str(duty.instructions)}</p>
          </div>
        ) : null}
        {manager && dutyStatus(duty) === "draft" && !future && (
          <Notice tone="warning">
            מועד תחילת הטיוטה חלף. היא נשארת לטיפול עם השיבוצים והניקוד השמור;
            ניתן לבטל אותה או לטפל בתיעוד הביצוע.
          </Notice>
        )}
        <div className="duty-offers">
          <TransferOffer state={state} action={action} duty={duty} />
          <SwapOffer state={state} action={action} duty={duty} />
          <CancellationRequestButton
            state={state}
            action={action}
            duty={duty}
          />
        </div>
        {manager && (
          <div className="panel-actions">
            <AuditLink id={id} label="יומן הפעולות של התורנות" />
            {dutyStatus(duty) === "draft" && future && (
              <ActionDialog
                title="פרסום התורנות"
                buttonLabel="פרסום לחיילים"
                description={`הפרסום כותב את התורנות בלוח היחידתי, ומעכשיו היא גלויה לכל החיילים. מאוישים ${assignments.length} מתוך ${dutySlots(duty).length} מקומות${dutySlots(duty).length > assignments.length ? `, ${dutySlots(duty).length - assignments.length} פנויים` : ""}, והמשובצים יקבלו הודעה.`}
                fields={[
                  {
                    name: "confirmed",
                    label: "בדקתי את הפרטים והשיבוצים",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                action={action}
                type="duty.publish"
                payload={{ id }}
                version={duty.version}
              />
            )}
            {(dutyStatus(duty) === "draft" ||
              (dutyStatus(duty) === "published" && future)) && (
              <ActionDialog
                title="ביטול תורנות"
                description={`הביטול יפנה ${assignments.length} שיבוצים וישחרר ${assignments.reduce((sum, item) => sum + num(item.points), 0)} נקודות שמורות. ניקוד נוכחי והיסטוריה יישמרו.`}
                buttonLabel="ביטול תורנות"
                fields={[
                  {
                    name: "reason",
                    label: "סיבת הביטול",
                    type: "textarea",
                    required: true,
                    full: true,
                  },
                  {
                    name: "confirmed",
                    label: "מאשר לבטל ולפנות את השיבוצים",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                action={action}
                type="duty.cancel"
                payload={{ id }}
                version={duty.version}
                danger
              />
            )}
          </div>
        )}
      </Panel>
      <Panel
        title="צוות התורנות"
        subtitle={`${assignments.length} משובצים${slots.length ? ` מתוך ${slots.length} מקומות` : ""}`}
      >
        {slots.length ? (
          slots.map((slot) => {
            const seat = assignments.filter((a) => a.slotId === slot.id);
            // A seat split into execution periods lists every performer by their period.
            if (seat.length > 1 || seat[0]?.performedStart)
              return (
                <div className="slot-row" key={slot.id}>
                  <span className="avatar">
                    <UsersRound size={18} />
                  </span>
                  <span className="grow">
                    <strong>{str(slot.name ?? slot.roleName, "תורן")}</strong>
                    {[...seat]
                      .sort((a, b) =>
                        str(a.performedStart).localeCompare(
                          str(b.performedStart)
                        )
                      )
                      .map((a) => (
                        <small key={a.id}>
                          {personName(state, a.soldierId)} ·{" "}
                          {displayDate(
                            a.performedStart ?? dutyStart(duty),
                            true
                          )}{" "}
                          — {displayDate(a.performedEnd ?? dutyEnd(duty), true)}{" "}
                          · {num(a.points)} נקודות
                        </small>
                      ))}
                  </span>
                  <Badge tone="info">כמה מבצעים</Badge>
                </div>
              );
            const assignment = seat[0];
            return (
              <div className="slot-row" key={slot.id}>
                <span className={`avatar ${assignment ? "" : "empty-avatar"}`}>
                  {assignment ? (
                    personName(state, assignment.soldierId).slice(0, 1)
                  ) : (
                    <UsersRound size={18} />
                  )}
                </span>
                <span className="grow">
                  <strong>
                    {assignment
                      ? personName(state, assignment.soldierId)
                      : "מקום פנוי"}
                  </strong>
                  <small>
                    {str(slot.name ?? slot.roleName, "תורן")}
                    {assignment
                      ? ` · ${num(assignment.points ?? assignment.reservedPoints ?? assignment.score)} נקודות`
                      : ""}
                    {assignment?.performance
                      ? ` · בוצע בפועל: ${personName(state, performanceOf(assignment, duty).performerId)}, ${performanceOf(assignment, duty).points} נקודות`
                      : ""}
                  </small>
                </span>
                {assignment ? (
                  <>
                    <Status value={assignment.status} />
                    {manager && deletedSeats(state, id).includes(assignment) ? (
                      <Badge tone="danger">דחוף: החייל נמחק</Badge>
                    ) : (
                      (assignment.needsReview === true ||
                        (Array.isArray(assignment.needsAttention) &&
                          assignment.needsAttention.length > 0)) && (
                        <Badge tone="warning">דורש טיפול</Badge>
                      )
                    )}
                    {manager &&
                      Array.isArray(assignment.needsAttention) &&
                      assignment.needsAttention.includes("manager") && (
                        <small className="muted">
                          {concernReason(assignment)}
                        </small>
                      )}
                    {manager && <AuditLink id={assignment.id} />}
                  </>
                ) : (
                  manager &&
                  dutyStatus(duty) === "draft" && (
                    <>
                      <ManualAssignment
                        state={state}
                        action={action}
                        duty={duty}
                        slotId={slot.id}
                      />
                      <LotteryButton
                        state={state}
                        action={action}
                        duty={duty}
                        slotId={slot.id}
                      />
                    </>
                  )
                )}
              </div>
            );
          })
        ) : assignments.length ? (
          assignments.map((a) => (
            <div className="slot-row" key={a.id}>
              <span className="avatar">
                {personName(state, a.soldierId).slice(0, 1)}
              </span>
              <strong className="grow">{personName(state, a.soldierId)}</strong>
              <Status value={a.status} />
            </div>
          ))
        ) : (
          <Empty
            title="עדיין אין משובצים"
            text="האחראי יעדכן את צוות התורנות לפני הפרסום."
          />
        )}
      </Panel>
      {manager && (
        <Panel title="תמחור וכללי התאמה">
          <div className="detail-grid">
            <div>
              <small>תעריף בסיס</small>
              <strong>
                {num(
                  obj(duty.pricing).basePoints ??
                    obj(duty.pricing).base ??
                    obj(duty.pricing).amount
                )}{" "}
                נקודות
              </strong>
            </div>
            <div>
              <small>אופן חישוב</small>
              <strong>
                {obj(duty.pricing).mode === "daily" ? "לכל 24 שעות" : "לביצוע"}
              </strong>
            </div>
            <div>
              <small>מנוחה לפני</small>
              <strong>{describeRest(num(duty.restBeforeMinutes))}</strong>
            </div>
            <div>
              <small>מנוחה אחרי</small>
              <strong>{describeRest(num(duty.restAfterMinutes))}</strong>
            </div>
          </div>
        </Panel>
      )}
      {manager && (
        <CancellationRequests state={state} action={action} dutyId={id} />
      )}
      {manager &&
        future &&
        ["published", "draft"].includes(str(dutyStatus(duty))) && (
          <DutyChanges state={state} action={action} duty={duty} />
        )}
      {manager && dutyStatus(duty) === "published" && !future && (
        <ExecutionPeriods state={state} action={action} duty={duty} />
      )}
      {manager && dutyStatus(duty) === "published" && !future && (
        <PerformanceCorrections state={state} action={action} duty={duty} />
      )}
      {manager && <ScoreDecisions state={state} action={action} dutyId={id} />}
      {manager && <LotteryHistory state={state} action={action} dutyId={id} />}
      {!manager && <DrawReceipt state={state} dutyId={id} />}
    </>
  );
}
