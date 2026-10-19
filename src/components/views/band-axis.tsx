"use client";
/**
 * The draw rule drawn as geometry (decision 241): scores on one axis, the
 * minimum as a line in ink and the band up to (not including) minimum + value
 * hatched, with the viewer marked. The fairness table, a soldier's draw receipt
 * and the managers' draw history share it, so it is learned once.
 */
export type AxisPoint = { score: number; count: number; you?: boolean };

export function BandAxis({
  points,
  minimum,
  edge,
  you,
  extent,
  label,
}: {
  /** Scores and how many people hold each; omitted where names would leak. */
  points: AxisPoint[];
  minimum?: number;
  /** minimum + the seat's value; the band is every score below it. */
  edge?: number;
  /** The viewer's own score, when it should be marked. */
  you?: number;
  /** A wider range to draw, so a band has room around it. */
  extent?: [number, number];
  /** What the axis says, for a screen reader, in one sentence. */
  label: string;
}) {
  const values = [
    ...points.map((p) => p.score),
    ...(minimum === undefined ? [] : [minimum]),
    ...(edge === undefined ? [] : [edge]),
    ...(you === undefined ? [] : [you]),
    ...(extent ?? []),
  ];
  if (!values.length) return null;
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = Math.max(high - low, 4);
  const pad = span * 0.06;
  const at = (score: number) =>
    `${(((score - low + pad) / (span + 2 * pad)) * 100).toFixed(2)}%`;
  const tallest = Math.max(1, ...points.map((p) => p.count));
  return (
    <figure className="band-axis" role="img" aria-label={label}>
      <div className="band-track" aria-hidden="true">
        {minimum !== undefined && edge !== undefined && (
          <span
            className="band-zone"
            style={{
              insetInlineStart: at(minimum),
              width: `calc(${at(edge)} - ${at(minimum)})`,
            }}
          />
        )}
        {points.map((p) => (
          <span
            key={p.score}
            className={`band-stack ${p.you ? "is-you" : ""}`}
            style={{
              insetInlineStart: at(p.score),
              height: `${Math.max(12, (p.count / tallest) * 100)}%`,
            }}
          />
        ))}
        {minimum !== undefined && (
          <span
            className="band-line minimum"
            style={{ insetInlineStart: at(minimum) }}
          >
            <small>מינימום {minimum}</small>
          </span>
        )}
        {edge !== undefined && (
          <span
            className="band-line edge"
            style={{ insetInlineStart: at(edge) }}
          >
            <small>גבול {edge}</small>
          </span>
        )}
        {you !== undefined && (
          <span className="band-you" style={{ insetInlineStart: at(you) }}>
            <small>אני · {you}</small>
          </span>
        )}
      </div>
      <div className="band-scale" aria-hidden="true">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </figure>
  );
}
