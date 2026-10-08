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
  CircleHelp,
  Send,
  UserRound,
  Ellipsis,
  type LucideIcon,
} from "lucide-react";
import { type AppState, type Action, str, obj } from "@/client/types";
import { unreadCount } from "@/client/notifications";
import { Notice, Empty, Modal } from "./ui";
import { CalendarView, DutyDetail, FairnessView, Dashboard } from "./views";
import { MyAssignmentsView } from "./my-assignments";
import { PublishDrafts } from "./publish-drafts";
import { TechnicalAccount } from "./technical-account";
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
  { path: "/manage/account", title: "החשבון שלי", icon: UserRound },
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
  { path: "/technical/account", title: "החשבון שלי", icon: UserRound },
  { path: "/technical/locked", title: "חשבונות נעולים", icon: ShieldCheck },
  { path: "/technical/recovery", title: "שחזור גישה", icon: History },
  { path: "/technical/mail", title: "משלוחי מייל", icon: Bell },
  { path: "/technical/backups", title: "גיבוי ושחזור", icon: Upload },
  { path: "/technical/audit", title: "יומן תפעול", icon: ClipboardList },
  { path: "/notifications", title: "הודעות", icon: Bell },
];
// A line under the title only where it tells something the title does not.
const descriptions: Record<string, string> = {
  "/my-assignments": "התורנויות שפורסמו עבורך, ועדכונים מאז הביקור הקודם.",
  "/manage/publish": "מפרסמים כמה טיוטות יחד. החסומות נשארות טיוטה.",
};
type NavItem = { path: string; title: string; icon: LucideIcon };
const settingsLink: NavItem = {
  path: "/settings",
  title: "העדפות אישיות",
  icon: Settings,
};
const linkByPath = new Map<string, NavItem>(
  [...commonLinks, ...managementLinks, ...technicalLinks, settingsLink].map(
    (item) => [item.path, item]
  )
);
type NavGroup = { title?: string; paths: string[] };
// Work comes first, in groups; the person's own account sits at the bottom.
const managerGroups = (ownDuties: boolean): NavGroup[] => [
  {
    paths: ["/manage", "/calendar", ...(ownDuties ? ["/my-assignments"] : [])],
  },
  {
    title: "עבודה שוטפת",
    paths: [
      "/manage/planning",
      "/manage/publish",
      "/manage/constraints",
      "/requests",
    ],
  },
  {
    title: "אנשים",
    paths: [
      "/manage/soldiers",
      "/manage/eligibility",
      "/manage/ranks",
      "/manage/imports",
    ],
  },
  {
    title: "הגדרות ונתונים",
    paths: ["/manage/catalog", "/manage/scores", "/fairness", "/manage/audit"],
  },
];
const technicalGroups: NavGroup[] = [
  { paths: ["/technical"] },
  {
    title: "חשבונות",
    paths: [
      "/technical/permissions",
      "/technical/locked",
      "/technical/recovery",
    ],
  },
  {
    title: "תפעול",
    paths: ["/technical/mail", "/technical/backups", "/technical/audit"],
  },
];
const soldierGroups: NavGroup[] = [
  {
    paths: [
      "/calendar",
      "/my-assignments",
      "/fairness",
      "/constraints",
      "/requests",
      "/notifications",
    ],
  },
];
// A soldier's phone: the four most used screens, the rest under "more".
const soldierTabs: NavItem[] = [
  { path: "/calendar", title: "לוח", icon: CalendarDays },
  { path: "/my-assignments", title: "השיבוצים", icon: CalendarCheck2 },
  { path: "/constraints", title: "אילוצים", icon: CalendarOff },
  { path: "/requests", title: "בקשות", icon: ArrowLeftRight },
];
const soldierMore = ["/fairness", "/notifications"];
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
  const [more, setMore] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [titleAbove, setTitleAbove] = useState(false);
  // The bar gets its edge once content scrolls under it, and the title moves
  // into the bar once the page's own title has scrolled away.
  useEffect(() => {
    const track = () => {
      setScrolled(window.scrollY > 2);
      const heading = document.querySelector("main h1");
      setTitleAbove(!!heading && heading.getBoundingClientRect().bottom < 56);
    };
    track();
    window.addEventListener("scroll", track, { passive: true });
    return () => window.removeEventListener("scroll", track);
  }, [loading]);
  const [toastHeld, setToastHeld] = useState(false);
  // A confirmation leaves on its own unless the pointer or focus is on it.
  useEffect(() => {
    if (!success || toastHeld) return;
    const timer = window.setTimeout(() => setSuccess(""), 5000);
    return () => window.clearTimeout(timer);
  }, [success, toastHeld]);
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
  const soldier = !technical && !manager;
  // Each role starts where its work is; a manager at the care centre (decision 218).
  const home = technical ? "/technical" : manager ? "/manage" : "/calendar";
  const effectivePath = path === "/" ? home : path;
  const allLinks = [...linkByPath.values()];
  const pageTitle = effectivePath.startsWith("/duties/")
    ? "פרטי תורנות"
    : effectivePath.startsWith("/manage/audit/")
      ? "יומן פעולות"
      : effectivePath.startsWith("/manage/publish/")
        ? "פרסום טיוטות"
        : allLinks.find((l) => l.path === effectivePath)?.title || "המערכת";
  const unread = unreadCount(state.notifications);
  // A manager takes no part in duties and submits no constraints (decision 192);
  // "my assignments" shows only when the manager still holds a published one.
  const ownDuties =
    manager &&
    state.assignments.some(
      (assignment) =>
        assignment.soldierId === state.actor.soldierId &&
        state.duties.some(
          (duty) =>
            duty.id === assignment.dutyId &&
            (duty.status === "published" || duty.wasPublished)
        )
    );
  const groups = technical
    ? technicalGroups
    : manager
      ? managerGroups(ownDuties)
      : soldierGroups;
  // The account page of a manager or the technical account; a soldier has none.
  const accountPath = technical
    ? "/technical/account"
    : manager
      ? "/manage/account"
      : null;
  const signOut = async () => {
    const response = await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.ok) router.push("/login");
    else setError("לא ניתן לצאת כרגע. נסו שוב.");
  };
  const restricted =
    (effectivePath === "/constraints" && manager) ||
    (effectivePath.startsWith("/manage") && !manager) ||
    (effectivePath.startsWith("/technical") && !technical) ||
    (technical &&
      !effectivePath.startsWith("/technical") &&
      !["/settings", "/notifications"].includes(effectivePath));
  const navLink = (path: string) => {
    const item = linkByPath.get(path)!;
    return (
      <Link
        onClick={() => {
          setMenu(false);
          setMore(false);
        }}
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
    );
  };
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
    if (
      effectivePath === "/technical/account" ||
      effectivePath === "/manage/account"
    )
      return <TechnicalAccount state={state} action={action} />;
    if (effectivePath.startsWith("/technical"))
      return (
        <TechnicalView state={state} action={action} path={effectivePath} />
      );
    return (
      <Empty
        title="המסך לא נמצא"
        action={
          <Link className="btn primary" href="/">
            חזרה לדף הבית
          </Link>
        }
      />
    );
  };
  const profileRole = technical
    ? "מנהל טכני"
    : manager
      ? "אחראי תורנויות"
      : "חיילי היחידה";
  // Who is signed in, their own pages and the way out, in one row.
  const profile = (
    <div className="profile">
      <span className="avatar" aria-hidden="true">
        {state.actor.name.slice(0, 1)}
      </span>
      <span className="profile-text">
        <strong>{state.actor.name}</strong>
        {accountPath ? (
          <Link
            href={accountPath}
            onClick={() => setMenu(false)}
            className={`profile-account ${effectivePath === accountPath ? "active" : ""}`}
            aria-current={effectivePath === accountPath ? "page" : undefined}
          >
            החשבון שלי
          </Link>
        ) : (
          <small>{profileRole}</small>
        )}
      </span>
      <Link
        href="/settings"
        className={`icon-btn ${effectivePath === "/settings" ? "active" : ""}`}
        aria-label="העדפות אישיות"
        title="העדפות אישיות"
        aria-current={effectivePath === "/settings" ? "page" : undefined}
        onClick={() => {
          setMenu(false);
          setMore(false);
        }}
      >
        <Settings size={18} />
      </Link>
      <button
        className="icon-btn"
        aria-label="יציאה מהמערכת"
        title="יציאה מהמערכת"
        onClick={signOut}
      >
        <LogOut size={17} />
      </button>
    </div>
  );
  return (
    <div className={`app-shell ${soldier ? "has-tab-bar" : ""}`}>
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
        <Link href={home} className="brand">
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
        <nav aria-label="ניווט ראשי" className="nav-groups">
          {groups.map((group) => (
            <div className="nav-group" key={group.paths[0]}>
              {group.title && <div className="nav-section">{group.title}</div>}
              {group.paths.map(navLink)}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          {soldier && (
            <p className="sidebar-help">
              <CircleHelp size={14} aria-hidden="true" /> לתיקון מידע או שאלה —
              פונים לאחראי התורנויות
            </p>
          )}
          {profile}
        </div>
      </aside>
      <div className="main-shell">
        <header className={`topbar ${scrolled ? "scrolled" : ""}`}>
          <div className="topbar-start">
            {!soldier && (
              <button
                className="icon-btn mobile-menu"
                aria-label="פתיחת תפריט"
                onClick={() => setMenu(true)}
              >
                <Menu size={22} />
              </button>
            )}
            {/* The page's own h1 names the screen; this copy only follows it. */}
            <span
              className={`topbar-title ${titleAbove ? "shown" : ""}`}
              aria-hidden="true"
            >
              {pageTitle}
            </span>
          </div>
          <div className="topbar-actions">
            <span className="today">
              {new Intl.DateTimeFormat("he-IL", {
                dateStyle: "full",
                timeZone: "Asia/Jerusalem",
              }).format(new Date())}
            </span>
            <Link
              className={`icon-btn notification-link ${effectivePath === "/notifications" ? "active" : ""}`}
              href="/notifications"
              aria-label={`הודעות${unread ? `, ${unread} לא נקראו` : ""}`}
              aria-current={
                effectivePath === "/notifications" ? "page" : undefined
              }
            >
              <Bell size={19} />
              {unread > 0 && <span className="notification-dot" />}
            </Link>
          </div>
        </header>
        <main id="main" className="main-content">
          <div className="page-heading">
            <div>
              <h1>{pageTitle}</h1>
              {descriptions[effectivePath] && (
                <p>{descriptions[effectivePath]}</p>
              )}
            </div>
            {manager && effectivePath === "/calendar" && (
              <Link className="btn primary" href="/manage/planning">
                <CalendarDays size={17} /> תכנון תורנות
              </Link>
            )}
          </div>
          {content()}
          {/* Shown above the bottom edge, wherever the page is scrolled. */}
          <div className="toast-stack">
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
              <div
                className="toast"
                role="status"
                onPointerEnter={() => setToastHeld(true)}
                onPointerLeave={() => setToastHeld(false)}
                onFocus={() => setToastHeld(true)}
                onBlur={() => setToastHeld(false)}
              >
                {success}
                <button
                  className="icon-btn"
                  onClick={() => {
                    setSuccess("");
                    setToastHeld(false);
                  }}
                  aria-label="סגירת הודעה"
                >
                  <X size={15} />
                </button>
              </div>
            )}
          </div>
        </main>
      </div>
      {soldier && (
        <nav className="tab-bar" aria-label="ניווט בטלפון">
          {soldierTabs.map((tab) => (
            <Link
              key={tab.path}
              href={tab.path}
              className={`tab ${effectivePath === tab.path ? "active" : ""}`}
              aria-current={effectivePath === tab.path ? "page" : undefined}
            >
              <tab.icon size={22} aria-hidden="true" />
              <span>{tab.title}</span>
            </Link>
          ))}
          <button
            type="button"
            className={`tab ${[...soldierMore, "/settings"].includes(effectivePath) ? "active" : ""}`}
            aria-haspopup="dialog"
            onClick={() => setMore(true)}
          >
            <span className="tab-icon">
              <Ellipsis size={22} aria-hidden="true" />
              {unread > 0 && <span className="notification-dot" />}
            </span>
            <span>עוד</span>
          </button>
        </nav>
      )}
      {more && (
        <Modal title="עוד" onClose={() => setMore(false)}>
          <nav aria-label="עוד" className="more-list">
            {soldierMore.map(navLink)}
          </nav>
          <p className="sidebar-help">
            <CircleHelp size={14} aria-hidden="true" /> לתיקון מידע או שאלה —
            פונים לאחראי התורנויות
          </p>
          {profile}
        </Modal>
      )}
    </div>
  );
}
