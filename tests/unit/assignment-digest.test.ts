import { describe, expect, it } from "vitest";
import {
  DIGEST_WINDOW_MS,
  IMMEDIATE_WITHIN_MS,
  digestMail,
  dutySpan,
  groupCount,
  isImmediate,
  netGroups,
  noticeAnnouncement,
  singleAnnouncement,
  type AssignmentChange,
  type DutyFacts,
} from "../../src/domain/assignment-digest";

const NOW = new Date("2026-10-04T06:00:00.000Z");
const BASE = "https://shifts.example.org";
const WINDOW = "7f2c1a52-0000-4000-8000-000000000001";

/** A duty that starts `hours` after NOW and lasts eight hours. */
function facts(
  id: string,
  hours: number,
  extra: Partial<DutyFacts> = {}
): DutyFacts {
  const start = new Date(NOW.getTime() + hours * 3_600_000);
  return {
    id,
    name: `תורנות ${id}`,
    start: start.toISOString(),
    end: new Date(start.getTime() + 8 * 3_600_000).toISOString(),
    status: "published",
    held: true,
    ...extra,
  };
}
const map = (...items: DutyFacts[]) =>
  new Map(items.map((item) => [item.id, item]));
const ev = (dutyId: string, change: AssignmentChange) => ({ dutyId, change });
const names = (lines: { dutyId: string }[]) => lines.map((l) => l.dutyId);

describe("the window and the two hour rule", () => {
  it("keeps the agreed lengths", () => {
    expect(DIGEST_WINDOW_MS).toBe(10 * 60_000);
    expect(IMMEDIATE_WITHIN_MS).toBe(2 * 3_600_000);
  });

  it("sends a duty starting within two hours at once, the boundary included", () => {
    const at = (offset: number) =>
      new Date(NOW.getTime() + IMMEDIATE_WITHIN_MS + offset).toISOString();
    expect(isImmediate(NOW, at(0))).toBe(true);
    expect(isImmediate(NOW, at(-1))).toBe(true);
    expect(isImmediate(NOW, at(1))).toBe(false);
    // A start that is already behind the event is as urgent as it gets.
    expect(isImmediate(NOW, new Date(NOW.getTime() - 1).toISOString())).toBe(
      true
    );
  });
});

describe("what a window says, from the state at delivery", () => {
  it("puts a published duty the soldier still holds among the new ones and sorts by start", () => {
    const groups = netGroups(
      [ev("late", "new"), ev("early", "new")],
      map(facts("late", 30), facts("early", 26)),
      NOW,
      false
    );
    expect(names(groups.new)).toEqual(["early", "late"]);
    expect(groupCount(groups)).toBe(2);
  });

  it("merges several versions of one duty into one line", () => {
    const groups = netGroups(
      [ev("a", "new"), ev("a", "updated"), ev("a", "updated")],
      map(facts("a", 30)),
      NOW,
      false
    );
    expect(names(groups.new)).toEqual(["a"]);
    expect(groups.updated).toEqual([]);
  });

  it("leaves out a duty announced as new and gone by delivery, but the site notice keeps it as cancelled", () => {
    const events = [ev("a", "new"), ev("a", "cancelled"), ev("b", "new")];
    const state = map(
      facts("a", 30, { status: "cancelled", held: false }),
      facts("b", 31)
    );
    expect(groupCount(netGroups(events, state, NOW, false))).toBe(1);
    const notice = netGroups(events, state, NOW, true);
    expect(names(notice.new)).toEqual(["b"]);
    expect(names(notice.cancelled)).toEqual(["a"]);
    // The same when the soldier was only taken out of a duty that still stands.
    const removed = netGroups(
      [ev("a", "new")],
      map(facts("a", 30, { held: false })),
      NOW,
      false
    );
    expect(groupCount(removed)).toBe(0);
  });

  it("reads a duty the soldier knew before the window as updated or cancelled", () => {
    const groups = netGroups(
      [ev("kept", "updated"), ev("lost", "updated"), ev("gone", "cancelled")],
      map(
        facts("kept", 30),
        facts("lost", 31, { held: false }),
        facts("gone", 32, { status: "cancelled", held: false })
      ),
      NOW,
      false
    );
    expect(names(groups.updated)).toEqual(["kept"]);
    expect(names(groups.cancelled)).toEqual(["lost", "gone"]);
    expect(groups.cancelled[1].dutyCancelled).toBe(true);
    expect(groups.cancelled[0].dutyCancelled).toBe(false);
    // Taken out and put back inside the window: still held, so updated.
    const back = netGroups(
      [ev("a", "cancelled"), ev("a", "new")],
      map(facts("a", 30)),
      NOW,
      false
    );
    expect(names(back.updated)).toEqual(["a"]);
  });

  it("drops a duty that ended before delivery and one that no longer exists", () => {
    const groups = netGroups(
      [ev("over", "new"), ev("missing", "new"), ev("open", "new")],
      map(facts("over", -9), facts("open", 1)),
      NOW,
      false
    );
    expect(names(groups.new)).toEqual(["open"]);
    // A duty that began but has not ended is still announced.
    expect(
      names(netGroups([ev("on", "new")], map(facts("on", -2)), NOW, false).new)
    ).toEqual(["on"]);
  });
});

describe("the times in the text", () => {
  it("writes the span in Israel time, on one line for one day", () => {
    expect(
      dutySpan("2026-10-06T05:00:00.000Z", "2026-10-06T13:00:00.000Z")
    ).toBe("06.10.2026 08:00–16:00");
  });

  it("writes both dates when the duty crosses midnight", () => {
    expect(
      dutySpan("2026-10-06T19:00:00.000Z", "2026-10-07T03:00:00.000Z")
    ).toBe("06.10.2026 22:00 – 07.10.2026 06:00");
  });

  it("follows the clock change: a night that loses an hour still reads 22:00 to 06:00", () => {
    // Israel moves to summer time on Friday 27.03.2026 at 02:00.
    expect(
      dutySpan("2026-03-26T20:00:00.000Z", "2026-03-27T03:00:00.000Z")
    ).toBe("26.03.2026 22:00 – 27.03.2026 06:00");
    // And back on Sunday 25.10.2026, a night of nine hours.
    expect(
      dutySpan("2026-10-24T19:00:00.000Z", "2026-10-25T04:00:00.000Z")
    ).toBe("24.10.2026 22:00 – 25.10.2026 06:00");
  });
});

describe("the mail", () => {
  const line = (id: string, hours: number, held = true) =>
    facts(id, hours, { held });

  it("keeps the structure of a lone publication mail for one duty", () => {
    const groups = netGroups([ev("a", "new")], map(line("a", 30)), NOW, false);
    expect(digestMail(groups, BASE, WINDOW)).toEqual({
      title: "פורסם שיבוץ לתורנות",
      body: "שובצת לתורנות תורנות a",
      href: "/duties/a",
    });
  });

  it("lists every duty with its time and link, in groups, and ends with the page of all assignments", () => {
    const state = map(
      line("a", 30),
      line("b", 31),
      line("c", 32, false),
      line("d", 33)
    );
    const groups = netGroups(
      [ev("a", "new"), ev("b", "new"), ev("c", "updated"), ev("d", "updated")],
      state,
      NOW,
      false
    );
    const mail = digestMail(groups, BASE, WINDOW)!;
    expect(mail.title).toBe("עדכונים ב־4 תורנויות שלך");
    expect(mail.href).toBeNull();
    const lines = mail.body.split("\n");
    expect(lines.indexOf("שיבוצים חדשים:")).toBeLessThan(
      lines.indexOf("עודכנו:")
    );
    expect(lines.indexOf("עודכנו:")).toBeLessThan(lines.indexOf("בוטלו:"));
    // Each duty on its own line with its time, and the link under it.
    expect(mail.body).toContain("• תורנות a — 05.10.2026 15:00");
    expect(mail.body).toContain(`${BASE}/duties/a`);
    expect(mail.body).toContain(`${BASE}/duties/d`);
    expect(
      mail.body
        .trimEnd()
        .endsWith(
          `לכל השיבוצים שלי (נדרשת כניסה): ${BASE}/my-assignments?mail=${WINDOW}`
        )
    ).toBe(true);
    expect(mail.body).not.toContain("נקודות");
  });

  it("titles a window of new duties by their number", () => {
    const groups = netGroups(
      [ev("a", "new"), ev("b", "new"), ev("c", "new")],
      map(line("a", 30), line("b", 31), line("c", 32)),
      NOW,
      false
    );
    expect(digestMail(groups, BASE, WINDOW)!.title).toBe("שובצת ל־3 תורנויות");
  });

  it("sends nothing when nothing is left", () => {
    const groups = netGroups(
      [ev("a", "new"), ev("a", "cancelled")],
      map(facts("a", 30, { status: "cancelled", held: false })),
      NOW,
      false
    );
    expect(digestMail(groups, BASE, WINDOW)).toBeNull();
  });
});

describe("the site notice", () => {
  it("reads like the lone notices for one duty", () => {
    const groups = netGroups([ev("a", "new")], map(facts("a", 30)), NOW, true);
    expect(noticeAnnouncement(groups)).toEqual(
      singleAnnouncement("new", {
        dutyId: "a",
        name: "תורנות a",
        dutyCancelled: false,
      })
    );
    const cancelled = netGroups(
      [ev("a", "cancelled")],
      map(facts("a", 30, { status: "cancelled", held: false })),
      NOW,
      true
    );
    expect(noticeAnnouncement(cancelled)).toMatchObject({
      title: "התורנות בוטלה",
      href: "/duties/a",
    });
    const removed = netGroups(
      [ev("a", "cancelled")],
      map(facts("a", 30, { held: false })),
      NOW,
      true
    );
    expect(noticeAnnouncement(removed)).toMatchObject({
      title: "עודכנה תורנות שפורסמה",
      body: "השיבוץ שלך לתורנות תורנות a הוסר במסגרת עדכון שפורסם.",
    });
  });

  it("counts new duties as 'N' and leads to the page of all assignments", () => {
    const groups = netGroups(
      [ev("a", "new"), ev("b", "new"), ev("c", "new")],
      map(facts("a", 30), facts("b", 31), facts("c", 32)),
      NOW,
      true
    );
    expect(noticeAnnouncement(groups)).toMatchObject({
      title: "שובצת ל־3 תורנויות",
      href: "/my-assignments",
    });
  });

  it("counts each group when the window holds more than new duties", () => {
    const groups = netGroups(
      [ev("a", "new"), ev("b", "updated"), ev("c", "cancelled")],
      map(
        facts("a", 30),
        facts("b", 31),
        facts("c", 32, { status: "cancelled", held: false })
      ),
      NOW,
      true
    );
    const notice = noticeAnnouncement(groups)!;
    expect(notice.title).toBe("עדכונים ב־3 תורנויות שלך");
    expect(notice.body).toContain("שיבוצים חדשים: 1 · עודכנו: 1 · בוטלו: 1");
    expect(notice.href).toBe("/my-assignments");
  });
});
