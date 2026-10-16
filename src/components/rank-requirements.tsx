"use client";
import type { RankClause } from "@/domain/types";
import { type Row, str } from "@/client/types";
import { rankMemberships, membershipIn } from "@/domain/rank-tracks";
export function RankRequirements({
  catalog,
  value,
  onChange,
  label,
}: {
  catalog: Row[];
  value: RankClause[];
  onChange: (value: RankClause[]) => void;
  label: string;
}) {
  const tracks = [
    ...new Set(
      catalog.flatMap((row) => rankMemberships(row).map((m) => m.track))
    ),
  ].sort((a, b) => a.localeCompare(b, "he"));
  const update = (index: number, clause: RankClause) =>
    onChange(value.map((row, i) => (i === index ? clause : row)));
  return (
    <div className="subsection">
      <h3>{label}</h3>
      <p className="muted">
        ללא תנאי — כל דרגה. כמה תנאים כאן הם חלופות; תנאי סוג התורנות ותנאי
        התפקיד נדרשים יחד.
      </p>
      {value.map((clause, index) => {
        // Each rank with its place in this clause's track.
        const ranks = catalog
          .flatMap((row) => {
            const membership = membershipIn(row, clause.trackId);
            return membership
              ? [{ id: row.id, name: row.name, order: membership.order }]
              : [];
          })
          .sort((a, b) => a.order - b.order);
        return (
          <div className="stack" key={index}>
            <label className="field">
              <span>מסלול לתנאי {index + 1}</span>
              <select
                aria-label={`${label} מסלול ${index + 1}`}
                value={clause.trackId}
                onChange={(event) =>
                  update(index, { trackId: event.target.value, rankIds: [] })
                }
                required
              >
                <option value="">בחירה…</option>
                {tracks.map((track) => (
                  <option key={track}>{track}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>אופן בדיקת דרגה</span>
              <select
                value={clause.rankIds ? "list" : "range"}
                onChange={(event) =>
                  update(
                    index,
                    event.target.value === "list"
                      ? { trackId: clause.trackId, rankIds: [] }
                      : {
                          trackId: clause.trackId,
                          minOrder: ranks[0]?.order ?? 0,
                        }
                  )
                }
              >
                <option value="list">דרגה מדויקת או רשימה</option>
                <option value="range">מינימום, מקסימום או טווח</option>
              </select>
            </label>
            {clause.rankIds ? (
              <label className="field">
                <span>דרגות מותרות</span>
                <select
                  aria-label={`${label} דרגות ${index + 1}`}
                  multiple
                  required
                  value={clause.rankIds}
                  onChange={(event) =>
                    update(index, {
                      ...clause,
                      rankIds: Array.from(
                        event.target.selectedOptions,
                        (option) => option.value
                      ),
                    })
                  }
                >
                  {ranks.map((rank) => (
                    <option key={rank.id} value={rank.id}>
                      {str(rank.name)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="form-grid">
                {(["minOrder", "maxOrder"] as const).map((bound) => (
                  <label className="field" key={bound}>
                    <span>{bound === "minOrder" ? "מדרגה" : "עד דרגה"}</span>
                    <select
                      value={clause[bound] ?? ""}
                      onChange={(event) =>
                        update(index, {
                          ...clause,
                          [bound]:
                            event.target.value === ""
                              ? undefined
                              : Number(event.target.value),
                        })
                      }
                    >
                      <option value="">ללא גבול</option>
                      {ranks.map((rank) => (
                        <option key={rank.id} value={rank.order}>
                          {str(rank.name)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <button
              className="btn secondary"
              type="button"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
            >
              הסרת תנאי דרגה
            </button>
          </div>
        );
      })}
      <button
        className="btn secondary"
        type="button"
        disabled={!catalog.length}
        onClick={() =>
          onChange([...value, { trackId: tracks[0] ?? "", rankIds: [] }])
        }
      >
        הוספת תנאי דרגה
      </button>
    </div>
  );
}
