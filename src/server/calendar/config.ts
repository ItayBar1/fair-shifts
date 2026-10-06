/**
 * The calendar sync is switched on in the deployment (decision 205) once the Google
 * client carries the permission: until then the sign-in asks for nothing new and the
 * screens show no calendar option.
 */
export const calendarSyncEnabled = () =>
  process.env.GOOGLE_CALENDAR_SYNC === "true";

/** The address of the site, for the link inside each event. */
export const siteUrl = () =>
  (process.env.BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
