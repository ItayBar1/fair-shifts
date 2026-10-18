import { AppError } from "./errors";
import { checkRecordData, type RecordKind } from "../domain/record-kinds";

/**
 * The data a record of this kind may hold (decision 237). A write that does
 * not fit stops the whole action, so nothing half-valid is saved. The log
 * names the fields only: values may be personal.
 */
export function recordData<T extends Record<string, unknown>>(
  kind: RecordKind,
  data: T
): T {
  const checked = checkRecordData(kind, data);
  if (checked.ok) return data;
  console.error(
    `Record data rejected kind=${kind} ${checked.problems.slice(0, 5).join(" ")}`
  );
  throw new AppError(
    "invalid_record",
    "הפעולה לא הושלמה בגלל מידע לא תקין. לא נשמר דבר",
    500
  );
}
