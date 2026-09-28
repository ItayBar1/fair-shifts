import {
  type AppState,
  obj,
  rows,
  str,
  displayDate,
  population,
} from "./types";

export function importValue(value: unknown, key: string, state: AppState) {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "boolean") return value ? "כן" : "לא";
  if (key === "population" || key === "service.basePopulation")
    return population(value);
  if (key === "serviceType" || key === "service.type")
    return value === "career" ? "קבע" : "חובה";
  if (Array.isArray(value))
    return (
      value
        .map((item) => {
          const row = obj(item);
          return row.population
            ? `${population(row.population)} מ־${displayDate(row.effectiveFrom)}`
            : `${str(rows(state.rankCatalog).find((rank) => rank.id === row.rankId)?.name, "דרגה מההיסטוריה")} מ־${displayDate(row.effectiveFrom)}`;
        })
        .join("; ") || "—"
    );
  return str(value);
}
