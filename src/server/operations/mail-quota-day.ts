import { DateTime } from "luxon";

export function quotaDay(now: Date) {
  return DateTime.fromJSDate(now)
    .setZone(process.env.MAIL_QUOTA_TIME_ZONE ?? "UTC")
    .toISODate()!;
}
