import { rankMemberships } from "@/domain/rank-tracks";
import { type Row, str } from "./types";

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

// "" = all, "missing" = no current rank, "track:<name>" or "rank:<id>|<track>".
export type SoldierFilters = {
  search: string;
  populations: readonly string[];
  rank: string;
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
      matchesRank(s, filters.rank)
  );
}
