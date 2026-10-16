import { DateTime } from "luxon";
import { UNIT_ZONE } from "@/domain/time";
import { rankMemberships } from "@/domain/rank-tracks";
import { type Row, str, rows } from "./types";

export const filterPopulations = ["mandatory", "career", "academic"] as const;
export type FilterPopulation = (typeof filterPopulations)[number];

// Display filter only: managers still see and manage every soldier.
export function defaultPopulations(
  responsibility?: string
): FilterPopulation[] {
  if (responsibility === "mandatory" || responsibility === "career")
    return [responsibility, "academic"];
  return [...filterPopulations];
}

export type RankTrack = {
  track: string;
  ranks: { id: string; name: string }[];
};
/** Each track with its ranks in order; a rank in several tracks is listed in each. */
export function rankTracks(catalog: Row[]): RankTrack[] {
  const tracks = new Map<string, { row: Row; order: number }[]>();
  for (const row of catalog)
    for (const { track, order } of rankMemberships(row))
      tracks.set(track, [...(tracks.get(track) ?? []), { row, order }]);
  return [...tracks.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "he"))
    .map(([track, items]) => ({
      track,
      ranks: items
        .sort((a, b) => a.order - b.order)
        .map(({ row }) => ({ id: row.id, name: str(row.name) })),
    }));
}
/** One choice per rank and track, for picking a soldier's rank. */
export function rankChoices(catalog: Row[]) {
  return rankTracks(catalog).flatMap(({ track, ranks }) =>
    ranks.map((rank) => ({
      value: `${rank.id}|${track}`,
      label: `${rank.name} · ${track}`,
    }))
  );
}

/** Today's date in Israel, the default of a validity filter or a new start date. */
export function unitToday() {
  return DateTime.now().setZone(UNIT_ZONE).toISODate()!;
}

/**
 * Whether a dated catalog entry applies on the day. A missing start applies from
 * always, a missing end is permanent (decision 224); both ends are inclusive.
 */
export function validOn(entry: Row, date: string) {
  const start = str(entry.start);
  const end = str(entry.end);
  return (!start || start <= date) && (!end || date <= end);
}

/**
 * Show only soldiers who hold a capability or an exemption, valid on `date`.
 * An empty date counts every entry whatever its dates. Managers only: the
 * soldier's own state carries no exemptions.
 */
export type HeldFilter = {
  capability: string;
  exemption: string;
  date: string;
};
export const noHeldFilter = (): HeldFilter => ({
  capability: "",
  exemption: "",
  date: unitToday(),
});
export function holds(soldier: Row, filter: HeldFilter) {
  const held = (field: string, key: string, id: string) =>
    !id ||
    rows(soldier[field]).some(
      (entry) =>
        entry[key] === id && (!filter.date || validOn(entry, filter.date))
    );
  return (
    held("capabilities", "capabilityId", filter.capability) &&
    held("exemptions", "exemptionId", filter.exemption)
  );
}

// "" = all, "missing" = no current rank, "track:<name>" or "rank:<id>|<track>".
export type SoldierFilters = {
  search: string;
  populations: readonly string[];
  rank: string;
  held?: HeldFilter;
};
export function matchesRank(soldier: Row, rank: string) {
  if (!rank) return true;
  if (rank === "missing") return !str(soldier.rankId);
  if (rank.startsWith("track:"))
    return str(soldier.rankTrack) === rank.slice("track:".length);
  if (rank.startsWith("rank:")) {
    const [rankId, track] = rank.slice("rank:".length).split(/\|(.*)/s);
    return (
      str(soldier.rankId) === rankId &&
      (track === undefined || str(soldier.rankTrack) === track)
    );
  }
  return false;
}
export function filterSoldiers(soldiers: Row[], filters: SoldierFilters) {
  const search = filters.search.trim();
  return soldiers.filter(
    (s) =>
      !s.deletedAt &&
      (!search || str(s.name).includes(search) || str(s.idNumber) === search) &&
      filters.populations.includes(str(s.population)) &&
      matchesRank(s, filters.rank) &&
      (!filters.held || holds(s, filters.held))
  );
}
