"use client";
import { type AppState, displayDate, num, rows, str } from "@/client/types";
import { Panel } from "../ui";
import { BandAxis } from "./band-axis";

/**
 * How the viewer's own seats on a published duty were drawn (decision 240):
 * numbers only, the same axis as the fairness table, and nobody else's name
 * or score. The server sends a receipt only for a seat the viewer still holds.
 */
export function DrawReceipt({
  state,
  dutyId,
}: {
  state: AppState;
  dutyId: string;
}) {
  const receipts = rows(state.drawReceipts).filter(
    (row) => row.dutyId === dutyId
  );
  if (!receipts.length) return null;
  return (
    <Panel title="איך נבחרתי" subtitle="הגרלה אחידה בתוך הרצועה, במספרים">
      {receipts.map((row) => {
        const weight = num(row.weight);
        const minimum = num(row.minimum);
        const edge = minimum + weight;
        const score = num(row.score);
        const band = num(row.bandSize);
        return (
          <div className="draw-receipt" key={str(row.slotId)}>
            <BandAxis
              points={[]}
              minimum={minimum}
              edge={edge}
              you={score}
              // Room outside the band, so where the score fell can be read.
              extent={[
                Math.max(0, minimum - Math.ceil(weight / 2)),
                edge + weight,
              ]}
              label={`מינימום ${minimum}, גבול ${edge}, הניקוד שלך ${score}`}
            />
            <dl className="receipt-lines">
              <div>
                <dt>שווי המקום</dt>
                <dd>{weight}</dd>
              </div>
              <div>
                <dt>המינימום בין המתאימים</dt>
                <dd>{minimum}</dd>
              </div>
              <div>
                <dt>הרצועה: ניקוד קטן מ־</dt>
                <dd>{edge}</dd>
              </div>
              <div>
                <dt>המתאימים למקום</dt>
                <dd>{num(row.eligible)}</dd>
              </div>
              <div>
                <dt>ברצועה</dt>
                <dd>{band}</dd>
              </div>
              <div className="receipt-own">
                <dt>הניקוד שלך בזמן ההגרלה</dt>
                <dd>{score}</dd>
              </div>
            </dl>
            <p className="receipt-close">
              {band > 1
                ? `הבחירה נעשתה בהגרלה אחידה: לכל אחד מ־${band} שברצועה היה סיכוי שווה.`
                : "ברצועה לא היה מועמד נוסף, ולכן השיבוץ נקבע ישירות."}{" "}
              <small>{displayDate(row.drawnAt, true)}</small>
            </p>
          </div>
        );
      })}
    </Panel>
  );
}
