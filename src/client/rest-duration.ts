/**
 * Rest windows are stored in minutes and entered as hours: "12", "0:30" or
 * "1.5" (decision 231). The server and the eligibility rules still see minutes.
 */
export function restHoursInput(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Reads one rest field of a form. An empty field means no rest. */
export function readRestHours(
  text: string,
  label: string
): { minutes: number; error?: string } {
  const value = text.trim().replace(",", ".");
  const error = `${label}: יש להזין שעות, למשל 12, 1.5 או 0:30`;
  if (!value) return { minutes: 0 };
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(value);
  if (clock) return { minutes: Number(clock[1]) * 60 + Number(clock[2]) };
  if (!/^\d{1,3}(\.\d+)?$/.test(value)) return { minutes: 0, error };
  const minutes = Number(value) * 60;
  // 1.5 hours is 90 minutes; 0.33 hours is not a whole minute.
  if (Math.abs(minutes - Math.round(minutes)) > 1e-9)
    return {
      minutes: 0,
      error: `${label}: השעות חייבות להתחלק לדקות שלמות, למשל 0:20`,
    };
  return { minutes: Math.round(minutes) };
}

/** A rest window for display: "ללא", "30 דקות", "שעתיים", "12 שעות", "1:30 שעות". */
export function describeRest(minutes: number): string {
  if (minutes <= 0) return "ללא";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return `${rest} דקות`;
  if (rest) return `${restHoursInput(minutes)} שעות`;
  return hours === 1 ? "שעה" : hours === 2 ? "שעתיים" : `${hours} שעות`;
}

export const restHint = "בשעות: 12, 1.5 או 0:30. ריק או 0 הוא ללא מנוחה";
