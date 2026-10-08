"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Clock3, MapPin, UserRound } from "lucide-react";
import {
  assignmentRange,
  type AssignmentItem,
  type CancelledItem,
} from "@/domain/my-assignments";
import { Badge, Empty, Notice, Panel } from "./ui";

const dayName = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  weekday: "long",
});
const dayOfMonth = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  day: "numeric",
});
const monthName = new Intl.DateTimeFormat("he-IL", {
  timeZone: "Asia/Jerusalem",
  month: "long",
});

type Feed = { current: AssignmentItem[]; cancelled: CancelledItem[] };
function AssignmentCard({
  item,
  cancelled = false,
}: {
  item: AssignmentItem | CancelledItem;
  cancelled?: boolean;
}) {
  const active = !cancelled ? (item as AssignmentItem) : undefined;
  return (
    <li
      className={`my-assignment ${item.highlighted ? "mail-highlight" : ""} ${cancelled ? "cancelled" : ""}`}
    >
      <div className="my-assignment-heading">
        <h3>{item.name}</h3>
        <div className="my-assignment-badges">
          {item.highlighted ? <Badge tone="info">במייל הזה</Badge> : null}
          {active?.badge ? (
            <Badge tone="info">
              {active.badge === "new" ? "חדש" : "עודכן"}
            </Badge>
          ) : null}
          {active?.inProgress ? <Badge tone="success">מתבצעת</Badge> : null}
          {cancelled ? <Badge tone="danger">בוטל או הוסר</Badge> : null}
        </div>
      </div>
      <dl className="my-assignment-details">
        <div>
          <dt>
            <Clock3 size={15} aria-hidden="true" />
            <span className="visually-hidden">מועד</span>
          </dt>
          <dd>
            <time dateTime={item.start}>
              {assignmentRange(item.start, item.end)}
            </time>
          </dd>
        </div>
        <div>
          <dt>
            <MapPin size={15} aria-hidden="true" />
            <span className="visually-hidden">מיקום</span>
          </dt>
          <dd>{item.location || "לא צוין"}</dd>
        </div>
        <div>
          <dt>
            <UserRound size={15} aria-hidden="true" />
            <span className="visually-hidden">תפקיד</span>
          </dt>
          <dd>{item.role || "—"}</dd>
        </div>
      </dl>
      <Link className="text-link" href={`/duties/${item.dutyId}`}>
        לפרטי התורנות <ChevronLeft size={15} aria-hidden="true" />
      </Link>
    </li>
  );
}
/** The next duty first and large: the day it falls on answers "when". */
function NextAssignment({ item }: { item: AssignmentItem }) {
  const start = new Date(item.start);
  return (
    <section className="next-assignment" aria-labelledby="next-assignment">
      <div className="next-date" aria-hidden="true">
        <strong>{dayOfMonth.format(start)}</strong>
        <span>{monthName.format(start)}</span>
      </div>
      <div className="next-body">
        <h2 className="next-label" id="next-assignment">
          {item.inProgress ? "מתבצעת עכשיו" : "התורנות הבאה שלך"} ·{" "}
          {dayName.format(start)}
        </h2>
        <ol className="my-assignment-list">
          <AssignmentCard item={item} />
        </ol>
      </div>
    </section>
  );
}

export function MyAssignmentsView() {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState("");
  const requested = useRef(false);
  useEffect(() => {
    if (requested.current) return;
    requested.current = true;
    const mail = new URLSearchParams(window.location.search).get("mail");
    const query = mail ? `?mail=${encodeURIComponent(mail)}` : "";
    void fetch(`/api/v1/my-assignments${query}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok)
          throw new Error(data.error?.message ?? "לא ניתן לטעון את השיבוצים");
        setFeed(data);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "לא ניתן לטעון את השיבוצים"
        )
      );
  }, []);
  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!feed) return <p role="status">טוענים את השיבוצים…</p>;
  const [next, ...later] = feed.current;
  return (
    <>
      {next ? (
        <NextAssignment item={next} />
      ) : (
        <Panel>
          <Empty
            title="אין לך שיבוצים קרובים"
            text="שיבוצים חדשים יופיעו כאן אחרי פרסום התורנות."
          />
        </Panel>
      )}
      {later.length ? (
        <Panel
          title="אחר כך"
          subtitle="תורנויות שפורסמו וטרם הסתיימו, לפי תחילת תקופת הביצוע שלך"
        >
          <ol className="my-assignment-list">
            {later.map((item) => (
              <AssignmentCard key={item.assignmentId} item={item} />
            ))}
          </ol>
        </Panel>
      ) : null}
      {feed.cancelled.length ? (
        <Panel
          title="בוטלו מאז הביקור הקודם"
          subtitle="שיבוצים שהוסרת מהם מאז הביקור הקודם או שמופיעים במייל הזה"
        >
          <ol className="my-assignment-list">
            {feed.cancelled.map((item) => (
              <AssignmentCard key={item.dutyId} item={item} cancelled />
            ))}
          </ol>
        </Panel>
      ) : null}
      <Link className="btn secondary" href="/calendar?mine=1">
        להיסטוריה שלי בלוח התורנויות
      </Link>
    </>
  );
}
