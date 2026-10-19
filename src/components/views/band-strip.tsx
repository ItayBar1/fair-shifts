"use client";
import { useState } from "react";
import { type AppState, type Row, num, obj } from "@/client/types";
import { BandAxis, type AxisPoint } from "./band-axis";

/**
 * The fairness table's head (decision 241): every ranked score on one axis,
 * the table's minimum, the viewer's place, and for a manager the band a duty
 * type of the catalog would draw from. The table's minimum is not a draw's
 * minimum: a draw counts only the soldiers who fit the seat, and says so.
 */
export function BandStrip({
  state,
  ranked,
}: {
  state: AppState;
  ranked: (Row & { shown: number })[];
}) {
  const manager = state.actor.role === "manager";
  const values = [
    ...new Set(
      state.dutyTypes
        .map((type) =>
          num(
            obj(type.pricing).basePoints ??
              obj(type.pricing).base ??
              obj(type.pricing).amount
          )
        )
        .filter((value) => value > 0)
    ),
  ].sort((a, b) => a - b);
  const [weight, setWeight] = useState<number | null>(null);
  const chosen = manager ? (weight ?? values[0] ?? null) : null;
  if (!ranked.length) return null;
  const counts = new Map<number, number>();
  for (const row of ranked)
    counts.set(row.shown, (counts.get(row.shown) ?? 0) + 1);
  const self = ranked.find((row) => row.id === state.actor.soldierId);
  const points: AxisPoint[] = [...counts].map(([score, count]) => ({
    score,
    count,
    you: self?.shown === score,
  }));
  const minimum = Math.min(...ranked.map((row) => row.shown));
  const edge = chosen === null ? undefined : minimum + chosen;
  const inBand =
    edge === undefined ? 0 : ranked.filter((row) => row.shown < edge).length;
  return (
    <section className="band-strip" aria-labelledby="band-strip-title">
      <div className="band-strip-head">
        <h2 id="band-strip-title">פיזור הניקוד</h2>
        <p>
          {self
            ? self.shown === minimum
              ? "הניקוד שלך הוא המינימום בטבלה."
              : `הניקוד שלך גבוה מהמינימום בטבלה ב־${self.shown - minimum} נקודות.`
            : `${ranked.length} חיילים · המינימום בטבלה ${minimum}.`}{" "}
          בהגרלה, מי שהניקוד שלו קטן מהמינימום בין המתאימים ועוד שווי המקום נכנס
          לרצועה, ולכל אחד ברצועה סיכוי שווה.
        </p>
      </div>
      {manager && values.length > 0 && (
        <div
          className="band-weights"
          role="group"
          aria-label="שווי מקום לדוגמה"
        >
          <span>רצועה לתורנות בשווי</span>
          {values.slice(0, 6).map((value) => (
            <button
              key={value}
              type="button"
              className={value === chosen ? "selected" : ""}
              aria-pressed={value === chosen}
              onClick={() => setWeight(value)}
            >
              {value}
            </button>
          ))}
        </div>
      )}
      <BandAxis
        points={points}
        minimum={minimum}
        edge={edge}
        you={self?.shown}
        label={`פיזור הניקוד: מ־${minimum} עד ${Math.max(...ranked.map((row) => row.shown))}${
          self ? `, הניקוד שלך ${self.shown}` : ""
        }${edge === undefined ? "" : `, ברצועה עד ${edge} (לא כולל): ${inBand} חיילים`}`}
      />
      {edge !== undefined && (
        <p className="band-note">
          בתורנות בשווי {chosen}, אילו כולם התאימו: {inBand} ברצועה (ניקוד קטן
          מ־{edge}). בהגרלה אמיתית המינימום נקבע רק בין המתאימים למקום.
        </p>
      )}
    </section>
  );
}
