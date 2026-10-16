/** A rank's place in one track. A rank may sit in several tracks (decision 223). */
export interface RankMembership {
  track: string;
  order: number;
}

/** The tracks of a catalog rank; a record saved before tracks were managed holds one. */
export function rankMemberships(
  data: Record<string, unknown>
): RankMembership[] {
  if (Array.isArray(data.tracks))
    return (data.tracks as Record<string, unknown>[])
      .filter((row) => typeof row?.track === "string" && row.track)
      .map((row) => ({ track: String(row.track), order: Number(row.order) }));
  return typeof data.track === "string" && data.track
    ? [{ track: data.track, order: Number(data.order) }]
    : [];
}

export function membershipIn(
  data: Record<string, unknown>,
  track: string
): RankMembership | undefined {
  return rankMemberships(data).find((row) => row.track === track);
}

/** Tracks two ranks share, where the second is higher; a transition stays inside one. */
export function sharedHigherTracks(
  from: Record<string, unknown>,
  to: Record<string, unknown>
): string[] {
  return rankMemberships(from)
    .filter((row) => {
      const target = membershipIn(to, row.track);
      return target !== undefined && target.order > row.order;
    })
    .map((row) => row.track);
}

/** A rank picked in a form carries its track after "|" when it sits in several. */
export function splitRankChoice(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const value = payload as Record<string, unknown>;
  if (typeof value.rankId !== "string" || !value.rankId.includes("|"))
    return payload;
  const at = value.rankId.indexOf("|");
  return {
    ...value,
    rankId: value.rankId.slice(0, at),
    trackId: value.rankId.slice(at + 1),
  };
}

/** Walks stored conditions and returns every rank clause in them. */
export function rankClausesIn(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(rankClausesIn);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own =
    typeof record.trackId === "string" &&
    ("rankIds" in record || "minOrder" in record || "maxOrder" in record)
      ? [record]
      : [];
  return [...own, ...Object.values(record).flatMap(rankClausesIn)];
}
