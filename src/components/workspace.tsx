"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  CalendarDays,
  CalendarCheck2,
  Scale,
  CalendarOff,
  ArrowLeftRight,
  Bell,
  Settings,
  UsersRound,
  ListChecks,
  ClipboardList,
  ShieldCheck,
  Award,
  Upload,
  History,
  Wrench,
  LogOut,
  Menu,
  X,
  RefreshCw,
  ChevronLeft,
  CircleHelp,
  Send,
} from "lucide-react";
import { type AppState, type Action, str, obj } from "@/client/types";
import { unreadCount } from "@/client/notifications";
import { Notice, Empty } from "./ui";
import { CalendarView, DutyDetail, FairnessView, Dashboard } from "./views";
import { MyAssignmentsView } from "./my-assignments";
import { PublishDrafts } from "./publish-drafts";
import {
  SoldiersView,
  EligibilityView,
  RanksView,
  CatalogView,
  PlanningView,
} from "./management";
import {
  ConstraintsView,
  RequestsView,
  NotificationsView,
  SettingsView,
  ScoresView,
  ImportsView,
  AuditView,
  TechnicalView,
} from "./workflows";
const commonLinks = [
  { path: "/calendar", title: "לוח התורנויות", icon: CalendarDays },
  { path: "/my-assignments", title: "השיבוצים שלי", icon: CalendarCheck2 },
  { path: "/fairness", title: "טבלת הצדק", icon: Scale },
  { path: "/constraints", title: "האילוצים שלי", icon: CalendarOff },
  { path: "/requests", title: "החלפות ובקשות", icon: ArrowLeftRight },
  { path: "/notifications", title: "הודעות", icon: Bell },
];
const managementLinks = [
  { path: "/manage", title: "מרכז טיפול", icon: ListChecks },
  { path: "/manage/soldiers", title: "חיילי היחידה", icon: UsersRound },
  { path: "/manage/eligibility", title: "פטורים וכשירויות", icon: ShieldCheck },
  { path: "/manage/ranks", title: "דרגות ופז״ם", icon: Award },
  { path: "/manage/constraints", title: "סבבי אילוצים", icon: CalendarOff },
  { path: "/manage/catalog", title: "קטלוג תורנויות", icon: ClipboardList },
  { path: "/manage/planning", title: "תכנון ושיבוץ", icon: CalendarDays },
  { path: "/manage/publish", title: "פרסום טיוטות", icon: Send },
  { path: "/manage/scores", title: "ניקוד והיסטוריה", icon: Scale },
  { path: "/manage/imports", title: "ייבוא חיילים", icon: Upload },
  { path: "/manage/audit", title: "יומן פעולות", icon: History },
];
const technicalLinks = [
  { path: "/technical", title: "תמונת מצב", icon: Wrench },
  {
    path: "/technical/permissions",
    title: "חשבונות והרשאות",
    icon: UsersRound,
  },
  { path: "/technical/locked", title: "חשבונות נעולים", icon: ShieldCheck },
  { path: "/technical/recovery", title: "שחזור גישה", icon: History },
  { path: "/technical/mail", title: "משלוחי מייל", icon: Bell },
  { path: "/technical/backups", title: "גיבוי ושחזור", icon: Upload },
  { path: "/technical/audit", title: "יומן תפעול", icon: ClipboardList },
  { path: "/notifications", title: "הודעות", icon: Bell },
];
const descriptions: Record<string, string> = {
  "/calendar": "כל התורנויות במקום אחד. תמונה משותפת, ברורה ועדכנית.",
  "/my-assignments": "התורנויות שפורסמו עבורך, ועדכונים מאז הביקור הקודם.",
  "/fairness": "חלוקה שקופה מתחילה במידע משותף.",
  "/manage": "מה שדורש החלטה, ומה שכבר מוכן להמשך.",
  "/manage/planning": "מתכננים את התקופה וממלאים את המקומות הפנויים.",
  "/manage/publish": "מפרסמים כמה טיוטות יחד. החסומות נשארות טיוטה.",
  "/manage/soldiers": "פרטי החיילים והנתונים שעליהם נשען השיבוץ.",
  "/constraints": "מגישים בזמן, עוקבים אחרי ההחלטה.",
  "/requests": "הסכמות, החלפות ובקשות במקום אחד.",
  "/manage/catalog": "סוגי התורנויות, התנאים והמחירון של היחידה.",
  "/manage/constraints": "חלון הגשה אחד לכל היחידה.",
  "/notifications": "כל העדכונים שחשוב להכיר.",
  "/settings": "הדרך שבה המערכת נשארת איתך בקשר.",
};
async function fetchState(): Promise<AppState | null> {
  const response = await fetch("/api/v1/state", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.status === 401) return null;
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      str(obj(data.error).message, "לא ניתן לטעון את המידע כרגע.")
    );
  return data;
}
export function Workspace({
  path,
  calendarMine = false,
}: {
  path: string;
  calendarMine?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [menu, setMenu] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const reload = useCallback(async () => {
    const data = await fetchState();
    if (!data) {
      router.push("/login");
      return;
    }
    setState(data);
  }, [router]);
  useEffect(() => {
    let active = true;
    fetchState()
      .then((data) => {
        if (!active) return;
        if (!data) router.push("/login");
        else setState(data);
      })
      .catch((e) => active && setError(e.message))
      .finally(() => active && setLoading(false));
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reload().catch(() => {});
    }, 30000);
    const focus = () => {
      void reload().catch(() => {});
    };
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", focus);
    };
  }, [reload, router]);
  const action: Action = async (type, payload, expectedVersion) => {
    setError("");
    setSuccess("");
    const response = await fetch("/api/v1/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        payload,
        expectedVersion,
        idempotencyKey: crypto.randomUUID(),
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      const message = str(
        obj(data.error).message,
        "הפעולה לא הושלמה. נסו שוב."
      );
      setError(message);
      if (response.status === 409) await reload();
      throw new Error(message);
    }
    if (!type.endsWith(".preview")) {
      await reload();
      setSuccess("השינוי נשמר");
    }
    return obj(data.result ?? data);
  };
  if (loading)
    return (
      <main className="loading-screen" aria-busy="true">
        <div className="brand-mark">ת</div>
        <span className="spinner" />
        <p>טוענים את תמונת היחידה…</p>
      </main>
    );
  if (!state)
    return (
      <main className="loading-screen">
        <Notice tone="danger">{error || "לא ניתן לטעון את המערכת"}</Notice>
        <button
          className="btn primary"
          onClick={() => window.location.reload()}
        >
          לנסות שוב
        </button>
        <Link href="/login">חזרה לכניסה</Link>
      </main>
    );
  const technical = state.actor.role === "technical";
  const manager = state.actor.role === "manager";
  const effectivePath =
    path === "/" ? (technical ? "/technical" : "/calendar") : path;
  const allLinks = [
    ...commonLinks,
    ...managementLinks,
    ...technicalLinks,
    { path: "/settings", title: "העדפות אישיות", icon: Settings },
  ];
  const pageTitle = effectivePath.startsWith("/duties/")
    ? "פרטי תורנות"
    : effectivePath.startsWith("/manage/audit/")
      ? "יומן פעולות"
      : effectivePath.startsWith("/manage/publish/")
        ? "פרסום טיוטות"
        : allLinks.find((l) => l.path === effectivePath)?.title || "המערכת";
  const unread = unreadCount(state.notifications);
  // A manager takes no part in duties and submits no constraints (decision 192).
  const ownLinks = manager
    ? commonLinks.filter(
        (item) =>
          item.path !== "/constraints" &&
          (item.path !== "/my-assignments" ||
            state.assignments.some(
              (assignment) =>
                assignment.soldierId === state.actor.soldierId &&
                state.duties.some(
                  (duty) =>
                    duty.id === assignment.dutyId &&
                    (duty.status === "published" || duty.wasPublished)
                )
            ))
      )
    : commonLinks;
  const restricted =
    (effectivePath === "/constraints" && manager) ||
    (effectivePath.startsWith("/manage") && !manager) ||
    (effectivePath.startsWith("/technical") && !technical) ||
    (technical &&
      !effectivePath.startsWith("/technical") &&
      !["/settings", "/notifications"].includes(effectivePath));
  const navigation = (links: typeof commonLinks) =>
    links.map((item) => (
      <Link
        onClick={() => setMenu(false)}
        key={item.path}
        href={item.path}
        className={`nav-link ${effectivePath === item.path ? "active" : ""}`}
        aria-current={effectivePath === item.path ? "page" : undefined}
      >
        <item.icon size={18} />
        <span>{item.title}</span>
        {item.path === "/notifications" && unread > 0 && (
          <span className="nav-count">{unread}</span>
        )}
      </Link>
    ));
  const content = () => {
    if (restricted)
      return (
        <Empty
          title="המסך הזה אינו זמין לחשבון שלך"
          text="אפשר להמשיך לאחד המסכים בתפריט."
        />
      );
    if (effectivePath === "/calendar")
      return <CalendarView state={state} initialOnlyMine={calendarMine} />;
    if (effectivePath === "/my-assignments") return <MyAssignmentsView />;
    if (effectivePath.startsWith("/duties/"))
      return (
        <DutyDetail
          state={state}
          action={action}
          id={effectivePath.split("/")[2]}
        />
      );
    if (effectivePath === "/fairness") return <FairnessView state={state} />;
    if (effectivePath === "/manage")
      return <Dashboard state={state} action={action} />;
    if (effectivePath === "/manage/soldiers")
      return <SoldiersView state={state} action={action} />;
    if (effectivePath === "/manage/eligibility")
      return <EligibilityView state={state} action={action} />;
    if (effectivePath === "/manage/ranks")
      return <RanksView state={state} action={action} />;
    if (effectivePath === "/manage/catalog")
      return <CatalogView state={state} action={action} />;
    if (effectivePath === "/manage/planning")
      return <PlanningView state={state} action={action} />;
    if (effectivePath === "/manage/publish")
      return <PublishDrafts state={state} action={action} />;
    // The run's drafts come marked: /manage/publish/run/<planning run id>.
    if (effectivePath.startsWith("/manage/publish/run/"))
      return (
        <PublishDrafts
          key={effectivePath}
          state={state}
          action={action}
          runId={effectivePath.split("/")[4]}
        />
      );
    if (["/constraints", "/manage/constraints"].includes(effectivePath))
      return (
        <ConstraintsView
          state={state}
          action={action}
          manage={effectivePath.startsWith("/manage")}
        />
      );
    if (effectivePath === "/requests")
      return <RequestsView state={state} action={action} />;
    if (effectivePath === "/notifications")
      return <NotificationsView state={state} action={action} />;
    if (effectivePath === "/settings")
      return <SettingsView state={state} action={action} />;
    if (effectivePath === "/manage/scores")
      return <ScoresView state={state} action={action} />;
    if (effectivePath === "/manage/imports")
      return <ImportsView state={state} action={action} reload={reload} />;
    if (effectivePath === "/manage/audit") return <AuditView state={state} />;
    if (effectivePath.startsWith("/manage/audit/"))
      return <AuditView state={state} refId={effectivePath.split("/")[3]} />;
    if (effectivePath === "/technical/audit")
      return <AuditView state={state} title="יומן תפעול והרשאות" />;
    if (effectivePath.startsWith("/technical"))
      return (
        <TechnicalView state={state} action={action} path={effectivePath} />
      );
    return (
      <Empty
        title="המסך לא נמצא"
        action={
          <Link className="btn primary" href="/">
            חזרה ללוח
          </Link>
        }
      />
    );
  };
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        דילוג לתוכן
      </a>
      {menu && (
        <button
          className="mobile-overlay"
          aria-label="סגירת תפריט"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <Link href={technical ? "/technical" : "/calendar"} className="brand">
          <span className="brand-mark">ת</span>
          <span>
            <strong>תורנות הוגנת</strong>
            <small>FAIR SHIFTS</small>
          </span>
        </Link>
        <button
          className="icon-btn mobile-close"
          aria-label="סגירת תפריט"
          onClick={() => setMenu(false)}
        >
          <X />
        </button>
        <div className="workspace-label">
          <span className="live-dot" /> מרחב היחידה
        </div>
        <nav aria-label="ניווט ראשי">
          {technical ? navigation(technicalLinks) : navigation(ownLinks)}
          {manager && (
            <>
              <div className="nav-section">ניהול היחידה</div>
              {navigation(managementLinks)}
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          <Link
            href="/settings"
            className={`nav-link ${effectivePath === "/settings" ? "active" : ""}`}
          >
            <Settings size={18} />
            העדפות אישיות
          </Link>
          <div className="profile">
            <span className="avatar">{state.actor.name.slice(0, 1)}</span>
            <span>
              <strong>{state.actor.name}</strong>
              <small>
                {technical
                  ? "מנהל טכני"
                  : manager
                    ? "אחראי תורנויות"
                    : "חיילי היחידה"}
              </small>
            </span>
            <button
              className="icon-btn"
              aria-label="יציאה מהמערכת"
              onClick={async () => {
                const response = await fetch("/api/auth/sign-out", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: "{}",
                });
                if (response.ok) router.push("/login");
                else setError("לא ניתן לצאת כרגע. נסו שוב.");
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-btn mobile-menu"
              aria-label="פתיחת תפריט"
              onClick={() => setMenu(true)}
            >
              <Menu size={22} />
            </button>
            <span>מרחב היחידה</span>
            <ChevronLeft size={14} />
            <strong>{pageTitle}</strong>
          </div>
          <div className="topbar-actions">
            <span className="today">
              {new Intl.DateTimeFormat("he-IL", {
                dateStyle: "full",
                timeZone: "Asia/Jerusalem",
              }).format(new Date())}
            </span>
            <button
              className="icon-btn"
              aria-label="רענון נתונים"
              disabled={refreshing}
              onClick={async () => {
                setRefreshing(true);
                try {
                  await reload();
                  setError("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : "שגיאה בטעינה");
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <RefreshCw size={17} className={refreshing ? "rotating" : ""} />
            </button>
            {!technical && (
              <Link
                className="icon-btn notification-link"
                href="/notifications"
                aria-label={`הודעות${unread ? `, ${unread} לא נקראו` : ""}`}
              >
                <Bell size={19} />
                {unread > 0 && <span className="notification-dot" />}
              </Link>
            )}
          </div>
        </header>
        <main id="main" className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {technical
                  ? "תפעול המערכת"
                  : effectivePath.startsWith("/manage")
                    ? "ניהול ותכנון"
                    : "מרחב היחידה"}
              </div>
              <h1>{pageTitle}</h1>
              <p>
                {descriptions[effectivePath] ||
                  "מידע משותף, החלטות מתועדות ותמיד תמונה מעודכנת."}
              </p>
            </div>
            {manager && effectivePath === "/calendar" && (
              <Link className="btn primary" href="/manage/planning">
                <CalendarDays size={17} /> תכנון תורנות
              </Link>
            )}
          </div>
          {error && (
            <Notice tone="danger">
              {error}
              <button
                className="inline-dismiss"
                onClick={() => setError("")}
                aria-label="סגירת הודעה"
              >
                <X size={16} />
              </button>
            </Notice>
          )}
          {success && (
            <div className="toast" role="status">
              {success}
              <button
                className="icon-btn"
                onClick={() => setSuccess("")}
                aria-label="סגירת הודעה"
              >
                <X size={15} />
              </button>
            </div>
          )}
          {content()}
          <footer className="page-footer">
            <span>תורנות הוגנת · לוח אחד לכל היחידה</span>
            <span>
              <CircleHelp size={14} /> לתיקון מידע או שאלה — פונים לאחראי
              התורנויות
            </span>
          </footer>
        </main>
      </div>
    </div>
  );
}
