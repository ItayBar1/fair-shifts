/**
 * One mail and one site notice for several assignments (decision 197).
 *
 * Every announcement of a published assignment, change or cancellation waits in a
 * window of ten minutes that opens at the first one for a recipient. What is sent
 * is built from the state at delivery time, never from the events as they came.
 */
import { instant } from "./time";

export const DIGEST_KIND = "publication-digest";
/** From the first event of a recipient; later events join it and never extend it. */
export const DIGEST_WINDOW_MS = 10 * 60_000;
/** A duty starting this soon after the event is announced at once and apart. */
export const IMMEDIATE_WITHIN_MS = 2 * 60 * 60_000;
/** The page the mail button and the site notice lead to (#96). */
export const MY_ASSIGNMENTS_PATH = "/my-assignments";
/** Names the window, so the page can highlight what that mail listed (#96). */
export const DIGEST_PARAM = "mail";

export type AssignmentChange = "new" | "updated" | "cancelled";
export const groupOrder = ["new", "updated", "cancelled"] as const;
export type Group = (typeof groupOrder)[number];
const groupLabel: Record<Group, string> = {
  new: "שיבוצים חדשים",
  updated: "עודכנו",
  cancelled: "בוטלו",
};

/** Whether the duty starts within two hours of the event (the start may not lie before it). */
export function isImmediate(eventAt: Date, startsAt: string) {
  return (
    instant(startsAt).toMillis() - eventAt.getTime() <= IMMEDIATE_WITHIN_MS
  );
}

export interface DigestEvent {
  dutyId: string;
  change: AssignmentChange;
}
/** What is true now of one duty, for one recipient. */
export interface DutyFacts {
  id: string;
  name: string;
  start: string;
  end: string;
  status: string;
  /** The recipient still holds a seat in the duty. */
  held: boolean;
}
export interface DigestLine {
  dutyId: string;
  name: string;
  start: string;
  end: string;
  /** The duty itself was cancelled, as opposed to the recipient being taken out of it. */
  dutyCancelled: boolean;
}
export type DigestGroups = Record<Group, DigestLine[]>;

/**
 * The net result of a window, one line per duty, in the group the recipient
 * should read it in. Events arrive oldest first.
 *
 * A duty announced as new and gone again by delivery was never known to the
 * recipient and is left out of the mail (`keepVanished` false). The site notice
 * keeps it as cancelled, because its first announcement was already shown. A duty
 * first announced as changed or cancelled was known before the window, so it is
 * "updated" while the recipient still holds it and "cancelled" otherwise. A duty
 * that ended is never listed.
 */
export function netGroups(
  events: readonly DigestEvent[],
  facts: ReadonlyMap<string, DutyFacts>,
  now: Date,
  keepVanished: boolean
): DigestGroups {
  const groups: DigestGroups = { new: [], updated: [], cancelled: [] };
  const first = new Map<string, AssignmentChange>();
  for (const event of events)
    if (!first.has(event.dutyId)) first.set(event.dutyId, event.change);
  for (const [dutyId, opening] of first) {
    const duty = facts.get(dutyId);
    if (!duty || instant(duty.end).toMillis() <= now.getTime()) continue;
    const dutyCancelled = duty.status === "cancelled";
    const live = duty.status === "published" && duty.held;
    const line: DigestLine = {
      dutyId,
      name: duty.name,
      start: duty.start,
      end: duty.end,
      dutyCancelled,
    };
    if (opening === "new") {
      if (live) groups.new.push(line);
      else if (keepVanished) groups.cancelled.push(line);
    } else (live ? groups.updated : groups.cancelled).push(line);
  }
  for (const group of groupOrder)
    groups[group].sort(
      (a, b) =>
        instant(a.start).toMillis() - instant(b.start).toMillis() ||
        a.name.localeCompare(b.name, "he") ||
        a.dutyId.localeCompare(b.dutyId)
    );
  return groups;
}

export const groupCount = (groups: DigestGroups) =>
  groupOrder.reduce((sum, group) => sum + groups[group].length, 0);

export const dutyPath = (dutyId: string) => `/duties/${dutyId}`;

/** The start and end in Israel time, on one line. */
export function dutySpan(start: string, end: string) {
  const from = instant(start);
  const to = instant(end);
  return from.hasSame(to, "day")
    ? `${from.toFormat("dd.MM.yyyy HH:mm")}–${to.toFormat("HH:mm")}`
    : `${from.toFormat("dd.MM.yyyy HH:mm")} – ${to.toFormat("dd.MM.yyyy HH:mm")}`;
}

export interface Announcement {
  title: string;
  body: string;
  href: string;
}

/** The text of a single announcement, as a lone publication, change or cancellation has always read. */
export function singleAnnouncement(
  group: Group,
  line: Pick<DigestLine, "dutyId" | "name" | "dutyCancelled">
): Announcement {
  const href = dutyPath(line.dutyId);
  if (group === "new")
    return {
      title: "פורסם שיבוץ לתורנות",
      body: `שובצת לתורנות ${line.name}`,
      href,
    };
  if (group === "updated")
    return {
      title: "עודכנה תורנות שפורסמה",
      body: `עודכן השיבוץ לתורנות ${line.name}. יש לבדוק את הפרטים החדשים.`,
      href,
    };
  return line.dutyCancelled
    ? {
        title: "התורנות בוטלה",
        body: `התורנות ${line.name} בוטלה. השיבוץ שלך לתורנות זו אינו בתוקף.`,
        href,
      }
    : {
        title: "עודכנה תורנות שפורסמה",
        body: `השיבוץ שלך לתורנות ${line.name} הוסר במסגרת עדכון שפורסם.`,
        href,
      };
}

function summary(groups: DigestGroups) {
  const total = groupCount(groups);
  const title =
    groups.new.length === total
      ? `שובצת ל־${total} תורנויות`
      : `עדכונים ב־${total} תורנויות שלך`;
  return { total, title };
}

/**
 * The site notice of a window: the single text for one duty, otherwise one line of
 * counts that leads to the page of all assignments.
 */
export function noticeAnnouncement(groups: DigestGroups): Announcement | null {
  const { total, title } = summary(groups);
  if (total === 0) return null;
  if (total === 1) {
    const group = groupOrder.find((item) => groups[item].length)!;
    return singleAnnouncement(group, groups[group][0]);
  }
  const counts = groupOrder
    .filter((group) => groups[group].length)
    .map((group) => `${groupLabel[group]}: ${groups[group].length}`)
    .join(" · ");
  return {
    title,
    body: `${counts}. הפרטים בעמוד ״השיבוצים שלי״.`,
    href: MY_ASSIGNMENTS_PATH,
  };
}

/** A link in the mail, absolute because the mail is read outside the site. */
const absolute = (path: string, baseUrl: string) =>
  new URL(path, baseUrl).toString();

/**
 * The mail of a window. One duty keeps the structure of a lone publication mail,
 * with the usual link to the duty (`href` set). Several duties list each one with
 * its time and a link, and end with the link to the page of all assignments, so
 * the body carries every link and `href` is empty. There are no points, reasons
 * or other soldiers in it. Null when nothing is left to announce.
 */
export function digestMail(
  groups: DigestGroups,
  baseUrl: string,
  windowId: string
): { title: string; body: string; href: string | null } | null {
  const { total, title } = summary(groups);
  if (total === 0) return null;
  if (total === 1) {
    const group = groupOrder.find((item) => groups[item].length)!;
    return singleAnnouncement(group, groups[group][0]);
  }
  const sections = groupOrder
    .filter((group) => groups[group].length)
    .map((group) =>
      [
        `${groupLabel[group]}:`,
        ...groups[group].map(
          (line) =>
            `• ${line.name} — ${dutySpan(line.start, line.end)}\n  ${absolute(dutyPath(line.dutyId), baseUrl)}`
        ),
      ].join("\n")
    );
  const all = absolute(
    `${MY_ASSIGNMENTS_PATH}?${DIGEST_PARAM}=${windowId}`,
    baseUrl
  );
  return {
    title,
    body: `${sections.join("\n\n")}\n\nלכל השיבוצים שלי (נדרשת כניסה): ${all}`,
    href: null,
  };
}
