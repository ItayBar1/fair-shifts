import { type Row, obj, str } from "@/client/types";
import type { Field } from "./ui";

/** The call-up amount saved in a duty's pricing, if any. */
export function savedCallUp(duty: Row) {
  const value = str(obj(duty.pricing).callUpPoints);
  return Number(value) > 0 ? value : "";
}

/**
 * A call-up is the manager's decision for one seat. When the duty has a saved
 * amount it is suggested in the amount field; the manager approves or changes it.
 */
export function callUpFields(
  duty: Row,
  options: { prefix?: string; label?: string; current?: unknown } = {}
): Field[] {
  const prefix = options.prefix ?? "";
  const saved = savedCallUp(duty);
  const current = Number(options.current ?? 0);
  return [
    {
      name: `${prefix}callUp`,
      label: options.label ?? "הזנקה",
      type: "select",
      required: true,
      value: current > 0 ? "yes" : "no",
      options: [
        { value: "no", label: "ללא הזנקה" },
        { value: "yes", label: "שיבוץ זה הוא הזנקה" },
      ],
    },
    {
      name: `${prefix}callUpAmount`,
      label: `${options.label ?? "הזנקה"}: סכום`,
      type: "number",
      min: 0,
      step: "0.01",
      value: current > 0 ? current : saved,
      hint: saved
        ? `הסכום השמור לתורנות: ${saved}. אפשר לאשר אותו או להזין סכום אחר`
        : "אין סכום שמור לתורנות. בהזנקה יש להזין סכום",
    },
  ];
}

/** The personal extra the fields describe: zero unless a call-up was marked. */
export function callUpValue(values: Record<string, unknown>, prefix = "") {
  if (values[`${prefix}callUp`] !== "yes") return 0;
  const amount = Number(values[`${prefix}callUpAmount`]);
  if (values[`${prefix}callUpAmount`] === "" || !(amount > 0))
    throw new Error("בהזנקה יש לאשר את הסכום השמור או להזין סכום חיובי");
  return amount;
}
