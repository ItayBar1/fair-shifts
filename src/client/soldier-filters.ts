import { type Row, str, num } from "./types";

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
export function rankTracks(catalog: Row[]): RankTrack[] {
  const tracks = new Map<string, Row[]>();
  for (const row of catalog) {
    const track = str(row.track);
    if (!track) continue;
    tracks.set(track, [...(tracks.get(track) ?? []), row]);
  }
  return [...tracks.entries()]
    .sort(([a], [b]) => a.localeCompare(b, "he"))
    .map(([track, items]) => ({
      track,
      ranks: items
        .sort((a, b) => num(a.order) - num(b.order))
        .map((row) => ({ id: row.id, name: str(row.name) })),
    }));
}

// "" = all, "missing" = no current rank, "track:<name>" or "rank:<id>".
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
  if (rank.startsWith("rank:"))
    return str(soldier.rankId) === rank.slice("rank:".length);
  return false;
}
export function filterSoldiers(soldiers: Row[], filters: SoldierFilters) {
  const search = filters.search.trim();
  return soldiers.filter(
    (s) =>
      !s.deletedAt &&
      (!search ||
        str(s.name).includes(search) ||
        str(s.personalNumber).includes(search)) &&
      filters.populations.includes(str(s.population)) &&
      matchesRank(s, filters.rank)
  );
}
