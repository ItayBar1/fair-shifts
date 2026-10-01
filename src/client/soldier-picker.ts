import { DateTime } from "luxon";
import { matchesRank, populationFits, rankAt } from "@/domain/eligibility";
import {
  UNIT_ZONE,
  coveredByRanges,
  datesToInstants,
  interval,
  overlaps,
} from "@/domain/time";
import type {
  InstantRange,
  Population,
  Requirements,
  Soldier,
} from "@/domain/types";
import { rankTracks } from "./soldier-filters";
import { type Row, num, obj, rows, str } from "./types";

/**
 * The finder behind the soldier picker (decision 193). It only helps a manager find
 * someone: the server still decides eligibility after the choice. Every date rule
 * is the one `evaluateEligibility` applies, over the range of the duty or the
 * execution period being filled, in Israel time.
 */

/** The rank filter's value for a soldier who has no rank at the start of the range. */
export const NO_RANK = "missing";

export const filterGroups = [
  "populations",
  "genders",
  "exemptions",
  "qualifications",
  "capabilities",
  "ranks",
] as const;
export type FilterGroup = (typeof filterGroups)[number];

export type PickerFilters = {
  search: string;
  /** Population over the whole range (any change inside it counts), as in the eligibility check. */
  populations: string[];
  genders: string[];
  /** Exemption ids: hides a soldier whose exemption applies at any moment of the range. */
  exemptions: string[];
  /** Qualification ids: each must be valid for the whole range. */
  qualifications: string[];
  /** Capability ids: each must be held. Capabilities have no validity dates. */
  capabilities: string[];
  /** Rank ids at the start of the range, or `NO_RANK`. */
  ranks: string[];
};

export const emptyFilters: PickerFilters = {
  search: "",
  populations: [],
  genders: [],
  exemptions: [],
  qualifications: [],
  capabilities: [],
  ranks: [],
};

export type PickerSoldier = Pick<
  Soldier,
  | "id"
  | "name"
  | "personalNumber"
  | "service"
  | "populationHistory"
  | "rankHistory"
  | "qualifications"
  | "exemptions"
  | "gender"
  | "capabilities"
>;

const list = <T>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]) : [];
const optionalDate = (value: unknown) => str(value) || undefined;

/** A manager's soldier row (the unit's own record spread into the state) as the rules read it. */
export function pickerSoldier(row: Row): PickerSoldier {
  const service = obj(row.service);
  const base = str(service.basePopulation, str(row.population, "mandatory"));
  const gender = str(row.gender);
  return {
    id: row.id,
    name: str(row.name),
    personalNumber: str(row.personalNumber),
    service: {
      type: service.type === "career" ? "career" : "mandatory",
      basePopulation: (["mandatory", "career", "academic"].includes(base)
        ? base
        : "mandatory") as Population,
      graceEligible: service.graceEligible === true,
      permanentFrom: optionalDate(service.permanentFrom),
      officerFrom: optionalDate(service.officerFrom),
    },
    populationHistory: list(row.populationHistory),
    rankHistory: list(row.rankHistory),
    qualifications: list(row.qualifications),
    exemptions: list(row.exemptions),
    gender:
      gender === "male" || gender === "female" || gender === "other"
        ? gender
        : undefined,
    capabilities: list<string>(row.capabilities).map(String),
  };
}

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    // Hebrew points and cantillation marks never decide a match.
    .replace(/[\u0591-\u05c7]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Every word typed must appear in the name or in the personal number, in any order. */
export function matchesSearch(
  soldier: Pick<PickerSoldier, "name" | "personalNumber">,
  search: string
): boolean {
  const words = normalize(search).split(" ").filter(Boolean);
  if (!words.length) return true;
  const name = normalize(soldier.name);
  const number = normalize(soldier.personalNumber);
  return words.every((word) => name.includes(word) || number.includes(word));
}

/**
 * A form's date-time as an instant with its offset. A typed wall-clock time
 * (`2026-10-05T08:00`) is Israel time, whatever the browser's own time zone;
 * a value that already carries an offset keeps its moment. Empty when invalid.
 */
export function asInstant(value: string): string {
  const parsed = DateTime.fromISO(value, { zone: UNIT_ZONE });
  return parsed.isValid ? (parsed.toISO() ?? "") : "";
}

/** The range as instants, or null while its times are missing or reversed (mid-edit). */
export function pickerRange(range: InstantRange) {
  try {
    return interval(range);
  } catch {
    return null;
  }
}

/**
 * Whether a soldier passes every active filter for the range. Filters combine with
 * AND. While the range is not valid the date-based filters are skipped, since the
 * server rejects such a range anyway.
 */
export function matchesFilters(
  soldier: PickerSoldier,
  filters: PickerFilters,
  range: InstantRange
): boolean {
  if (!matchesSearch(soldier, filters.search)) return false;
  if (
    filters.genders.length &&
    !(soldier.gender && filters.genders.includes(soldier.gender))
  )
    return false;
  if (filters.capabilities.some((id) => !soldier.capabilities?.includes(id)))
    return false;
  const target = pickerRange(range);
  if (!target) return true;
  if (
    filters.populations.length &&
    !populationFits(soldier, range, filters.populations as Population[])
  )
    return false;
  if (
    filters.exemptions.length &&
    soldier.exemptions.some(
      (exemption) =>
        filters.exemptions.includes(exemption.exemptionId) &&
        overlaps(target, datesToInstants(exemption))
    )
  )
    return false;
  for (const qualificationId of filters.qualifications) {
    const held = soldier.qualifications
      .filter((item) => item.qualificationId === qualificationId)
      .map(datesToInstants);
    if (!coveredByRanges(target, held)) return false;
  }
  if (filters.ranks.length) {
    const rank = rankAt(soldier, range.start);
    if (!filters.ranks.includes(rank ? rank.rankId : NO_RANK)) return false;
  }
  return true;
}

const byName = (a: Row, b: Row) => str(a.name).localeCompare(str(b.name), "he");

/**
 * The people to list: `candidates` (already without deleted soldiers and managers)
 * by name, narrowed by the filters. The current choice always stays listed, so a
 * filter never silently drops it.
 */
export function pickerResults(
  candidates: Row[],
  filters: PickerFilters,
  range: InstantRange,
  selected = ""
): Row[] {
  return [...candidates]
    .sort(byName)
    .filter(
      (row) =>
        row.id === selected ||
        matchesFilters(pickerSoldier(row), filters, range)
    );
}

/** The soldier's rank id at the start of the range; undefined when none applies. */
export function rankIdAtStart(
  row: Row,
  range: InstantRange
): string | undefined {
  try {
    return rankAt(pickerSoldier(row), range.start)?.rankId;
  } catch {
    return undefined;
  }
}

export type PickerOption = { value: string; label: string };
export type PickerOptions = {
  exemptions: PickerOption[];
  qualifications: PickerOption[];
  capabilities: PickerOption[];
  ranks: { track: string; ranks: PickerOption[] }[];
};

/** The choices of each filter, read from the catalogs, so a new catalog value needs no code. */
export function pickerOptions(
  catalogs: Record<string, unknown>
): PickerOptions {
  const named = (kind: string) =>
    rows(catalogs.eligibilityCatalog)
      .filter((item) => item.kind === kind)
      .map((item) => ({ value: item.id, label: str(item.name) }))
      .sort((a, b) => a.label.localeCompare(b.label, "he"));
  return {
    exemptions: named("exemption"),
    qualifications: named("qualification"),
    capabilities: named("capability"),
    ranks: rankTracks(rows(catalogs.rankCatalog)).map(({ track, ranks }) => ({
      track,
      ranks: ranks.map((rank) => ({ value: rank.id, label: rank.name })),
    })),
  };
}

const intersection = (lists: string[][]) =>
  lists.length
    ? lists.reduce((a, b) => a.filter((item) => b.includes(item)))
    : [];
const union = (lists: string[][]) => [...new Set(lists.flat())];

/**
 * The filters the picker opens with: everything the duty and the role require
 * (both apply), and the exemptions that block the duty hidden. The manager can
 * clear or change each one. A requirement that cannot be expressed (an empty
 * overlap between the duty's and the role's) leaves that filter off.
 */
export function defaultFilters(
  requirements: Requirements[],
  rankCatalog: Row[]
): PickerFilters {
  const populations = requirements.flatMap((set) =>
    set.populations?.length ? [set.populations as string[]] : []
  );
  const genders = requirements.flatMap((set) =>
    set.genders?.length ? [set.genders as string[]] : []
  );
  const ranks = requirements.flatMap((set) =>
    set.ranks?.length
      ? [
          rankCatalog
            .filter((rank) =>
              matchesRank(
                {
                  effectiveFrom: "",
                  rankId: rank.id,
                  trackId: str(rank.track),
                  order: num(rank.order),
                },
                set.ranks ?? []
              )
            )
            .map((rank) => rank.id),
        ]
      : []
  );
  return {
    ...emptyFilters,
    populations: intersection(populations),
    genders: intersection(genders),
    exemptions: union(
      requirements.map((set) => set.blockingExemptionIds ?? [])
    ),
    qualifications: union(
      requirements.map((set) => set.qualificationIds ?? [])
    ),
    capabilities: union(requirements.map((set) => set.capabilityIds ?? [])),
    ranks: intersection(ranks),
  };
}

/** The requirements a duty, a slot or a proposal row carries. */
export const requirementsOf = (row?: Record<string, unknown>): Requirements =>
  obj(row?.requirements) as Requirements;

export const activeGroups = (filters: PickerFilters): FilterGroup[] =>
  filterGroups.filter((group) => filters[group].length > 0);

/** The filters with every group cleared; the search text stays. */
export const clearedFilters = (filters: PickerFilters): PickerFilters => ({
  ...emptyFilters,
  search: filters.search,
});

/** Whether two filter sets select the same groups and values, whatever their order. */
export const sameFilters = (a: PickerFilters, b: PickerFilters) =>
  filterGroups.every(
    (group) =>
      a[group].length === b[group].length &&
      a[group].every((value) => b[group].includes(value))
  );
