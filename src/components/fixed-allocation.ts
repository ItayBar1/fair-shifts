import { type AppState, obj, personName, rows, str } from "@/client/types";
import type { Field } from "./ui";

/** Fields shared by transfer and swap reviews after a duty has started. */
export function allocationFields(
  execution: Record<string, unknown>,
  state: AppState,
  prefix: string
): Field[] {
  return rows(execution.allocation).flatMap((part, index): Field[] => {
    const name = personName(state, part.soldierId);
    return [
      ...(execution.fixedBaseTotal !== undefined
        ? [
            {
              name: `${prefix}base${index}`,
              label: `חלק מהבסיס הקבוע ל${name}`,
              type: "text" as const,
              required: true,
              value: str(part.fixedBase),
            },
          ]
        : []),
      {
        name: `${prefix}extra${index}`,
        label: `תוספת קבועה ל${name}`,
        type: "text",
        required: true,
        value: str(part.fixedExtra, "0"),
      },
    ];
  });
}

export function allocationValues(
  execution: Record<string, unknown>,
  values: Record<string, unknown>,
  prefix: string
) {
  return rows(execution.allocation).map((part, index) => ({
    soldierId: str(part.soldierId),
    ...(execution.fixedBaseTotal !== undefined && {
      fixedBase: str(values[`${prefix}base${index}`]),
    }),
    fixedExtra: str(values[`${prefix}extra${index}`]),
  }));
}

export const allocationSummary = (execution: Record<string, unknown>) => {
  const value = obj(execution);
  return `בסיס קבוע ${str(value.fixedBaseTotal, "יחסי לזמן")}, תוספת קבועה ${str(value.fixedExtraTotal, "0")}. יש לחלק כל סכום במלואו פעם אחת בין המבצעים.`;
};
