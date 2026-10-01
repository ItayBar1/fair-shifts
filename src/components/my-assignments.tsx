"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  assignmentDate,
  type AssignmentItem,
  type CancelledItem,
} from "@/domain/my-assignments";
import { Badge, Empty, Notice, Panel } from "./ui";

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
    <li className={`my-assignment ${item.highlighted ? "mail-highlight" : ""}`}>
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
          <dt>תפקיד</dt>
          <dd>{item.role || "—"}</dd>
        </div>
        <div>
          <dt>מועד</dt>
          <dd>
            <time dateTime={item.start}>{assignmentDate(item.start)}</time> עד{" "}
            <time dateTime={item.end}>{assignmentDate(item.end)}</time>
          </dd>
        </div>
        <div>
          <dt>מיקום</dt>
          <dd>{item.location || "לא צוין"}</dd>
        </div>
      </dl>
      <Link className="text-link" href={`/duties/${item.dutyId}`}>
        לפרטי התורנות
      </Link>
    </li>
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
  return (
    <>
      <Panel
        title="השיבוצים הקרובים שלי"
        subtitle="תורנויות שפורסמו וטרם הסתיימו, לפי תחילת תקופת הביצוע שלך"
      >
        {feed.current.length ? (
          <ol className="my-assignment-list">
            {feed.current.map((item) => (
              <AssignmentCard key={item.assignmentId} item={item} />
            ))}
          </ol>
        ) : (
          <Empty
            title="אין לך שיבוצים קרובים"
            text="שיבוצים חדשים יופיעו כאן אחרי פרסום התורנות."
          />
        )}
      </Panel>
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
