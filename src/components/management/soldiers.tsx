"use client";
import { useState } from "react";
import Link from "next/link";
import { Search, ArrowLeft } from "lucide-react";
import {
  type AppState,
  type Action,
  type Row,
  str,
  rows,
  population,
  displayDate,
} from "@/client/types";
import {
  ActionDialog,
  Badge,
  Empty,
  Panel,
  Status,
  Modal,
  populations,
  scrollRegion,
} from "../ui";
import {
  defaultPopulations,
  filterSoldiers,
  noHeldFilter,
  rankTracks,
} from "@/client/soldier-filters";
import { AddPeriod, PersonnelHistory, ProfileEdit } from "../personnel-history";
import { HeldFilters } from "../held-filters";
import { AuditLink } from "../audit";
import { SoldierDeletion } from "../soldier-deletion";
import { SoldierConditions } from "../eligibility-conditions";
import {
  ProfileFacts,
  ServiceDates,
  ServicePath,
  SoldierRankEdit,
  soldierFields,
} from "./soldier-fields";

export function SoldiersView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const [search, setSearch] = useState("");
  const defaults = defaultPopulations(state.actor.responsibility);
  const [shown, setShown] = useState<string[]>(defaults);
  const [rank, setRank] = useState("");
  const [held, setHeld] = useState(noHeldFilter);
  const tracks = rankTracks(rows(state.rankCatalog));
  const [selectedRecord, setSelected] = useState<Row | null>(null);
  // The arrival date each form holds now, so the grace checkbox follows it.
  const [newArrival, setNewArrival] = useState("");
  const [editArrival, setEditArrival] = useState<{
    id: unknown;
    value: string;
  }>();
  const selected = selectedRecord
    ? (state.soldiers.find((person) => person.id === selectedRecord.id) ??
      selectedRecord)
    : null;
  const filtered = filterSoldiers(state.soldiers, {
    search,
    populations: shown,
    rank,
    held,
  });
  const isDefault =
    !rank &&
    !held.capability &&
    !held.exemption &&
    shown.length === defaults.length &&
    defaults.every((value) => shown.includes(value));
  return (
    <>
      <Panel
        title="חיילי היחידה"
        subtitle="נתוני השירות משמשים לבדיקת התאמה במועד התורנות"
        actions={
          <ActionDialog
            title="הוספת חייל"
            fields={soldierFields(state, undefined, newArrival, setNewArrival)}
            onOpen={() => setNewArrival("")}
            action={action}
            type="soldier.create"
            description="לאחר הקליטה החייל יוכל להתחבר באמצעות המייל המאושר."
          />
        }
      >
        <div className="filters">
          <label className="search">
            <Search size={17} />
            <input
              aria-label="חיפוש חייל לפי שם או מספר זיהוי"
              placeholder="שם או מספר זיהוי…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <fieldset className="toggle-group">
            <legend>אוכלוסיות מוצגות</legend>
            {populations.map((p) => (
              <label key={p.value} className="toggle">
                <input
                  type="checkbox"
                  checked={shown.includes(p.value)}
                  onChange={(e) =>
                    setShown(
                      e.target.checked
                        ? [...shown, p.value]
                        : shown.filter((value) => value !== p.value)
                    )
                  }
                />
                {p.label}
              </label>
            ))}
          </fieldset>
          <select
            aria-label="סינון לפי דרגה נוכחית"
            value={rank}
            onChange={(e) => setRank(e.target.value)}
          >
            <option value="">כל הדרגות</option>
            <option value="missing">דרגה חסרה</option>
            {tracks.map((t) => (
              <optgroup key={t.track} label={`מסלול ${t.track}`}>
                <option value={`track:${t.track}`}>
                  כל הדרגות במסלול {t.track}
                </option>
                {t.ranks.map((r) => (
                  <option key={r.id} value={`rank:${r.id}|${t.track}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <HeldFilters state={state} value={held} onChange={setHeld} />
          {!isDefault && (
            <button
              className="btn small secondary"
              onClick={() => {
                setShown(defaults);
                setRank("");
                setHeld(noHeldFilter());
              }}
            >
              חזרה לברירת המחדל
            </button>
          )}
          <span className="muted" role="status">
            {filtered.length} חיילים מוצגים
          </span>
        </div>
        <p className="muted filter-note">
          הסינון משנה את התצוגה בלבד. שני האחראים רשאים לנהל את כל החיילים.
        </p>
        {filtered.length ? (
          <div className="table-scroll" {...scrollRegion("חיילי היחידה")}>
            <table className="soldiers-table">
              <thead>
                <tr>
                  <th>שם</th>
                  <th>מספר זיהוי</th>
                  <th>אוכלוסייה</th>
                  <th>דרגה</th>
                  <th>שחרור</th>
                  <th>מצב</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="person">
                        <span className="avatar small">
                          {str(s.name).slice(0, 1)}
                        </span>
                        <strong>{str(s.name)}</strong>
                        {s.isManager === true && <Badge>אחראי תורנויות</Badge>}
                      </span>
                    </td>
                    <td dir="ltr">{str(s.idNumber)}</td>
                    <td>{population(s.population)}</td>
                    <td>
                      {s.rankId ? (
                        <>
                          {str(s.rankName)}{" "}
                          <small className="muted">
                            · מסלול {str(s.rankTrack)}
                          </small>
                        </>
                      ) : (
                        <Badge tone="warning">דרגה חסרה</Badge>
                      )}
                    </td>
                    <td>{displayDate(s.releaseDate)}</td>
                    <td>
                      <Status value={s.serviceStatus || "active"} />
                    </td>
                    <td>
                      <button
                        className="btn small secondary"
                        onClick={() => setSelected(s)}
                      >
                        פרופיל ועריכה
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="לא נמצאו חיילים"
            text="מוסיפים חייל יחיד או מייבאים את רשימת היחידה מ־Excel."
            action={
              <Link className="text-link" href="/manage/imports">
                לייבוא חיילים <ArrowLeft size={15} />
              </Link>
            }
          />
        )}
      </Panel>
      {selected && (
        <Modal
          title={`פרופיל חייל · ${str(selected.name)}`}
          onClose={() => setSelected(null)}
          wide
        >
          <div className="profile-head">
            <div className="profile-badges">
              <Badge>{population(selected.population)}</Badge>
              <Status value={selected.serviceStatus || "active"} />
              <AuditLink id={selected.id} label="יומן הפעולות של החייל" />
            </div>
            <ProfileFacts person={selected} />
          </div>
          <ServiceDates person={selected} />
          <ProfileEdit
            person={selected}
            fields={soldierFields(
              state,
              selected,
              editArrival?.id === selected.id
                ? editArrival.value
                : str(selected.arrivalDate),
              (value) => setEditArrival({ id: selected.id, value })
            ).filter((f) => !["email", "currentScore"].includes(f.name))}
            action={action}
            onDone={() => setSelected(null)}
          />
          <SoldierRankEdit
            state={state}
            person={selected}
            action={action}
            onDone={() => setSelected(null)}
          />
          <details className="disclosure">
            <summary>מסלול שירות ואוכלוסיית שיבוץ</summary>
            <ServicePath
              key={String(selected.version)}
              person={selected}
              action={action}
              onDone={() => setSelected(null)}
            />
          </details>
          <details className="disclosure">
            <summary>כשירויות ופטורים</summary>
            <div className="stack">
              <PersonnelHistory
                state={state}
                action={action}
                person={selected}
                kinds={["capability", "exemption"]}
                empty="אין כשירויות או פטורים."
              />
              <Link
                className="text-link"
                href={`/manage/eligibility?soldier=${str(selected.id)}`}
              >
                שיוך כשירות או פטור במסך פטורים וכשירויות{" "}
                <ArrowLeft size={15} />
              </Link>
            </div>
          </details>
          <details className="disclosure">
            <summary>אי־פעילות והיסטוריית דרגות</summary>
            <div className="stack">
              <PersonnelHistory
                state={state}
                action={action}
                person={selected}
                kinds={["inactive"]}
                empty="אין תקופות אי־פעילות."
              />
              {["rankHistory"].map((key) =>
                rows(selected[key]).map((entry, i) => (
                  <div className="history-row" key={`${key}-${i}`}>
                    <strong>
                      {str(
                        entry.name ??
                          entry.value ??
                          entry.population ??
                          rows(state.rankCatalog).find(
                            (item) => item.id === entry.rankId
                          )?.name,
                        "תקופת שירות"
                      )}
                    </strong>
                    <span>בתוקף מ־{displayDate(entry.effectiveFrom)}</span>
                  </div>
                ))
              )}
              <h3>הוספת תקופת אי־פעילות</h3>
              <AddPeriod
                state={state}
                action={action}
                fixed={{ soldierId: selected.id, kind: "inactive" }}
                fields={[
                  {
                    name: "startDate",
                    label: "אי־פעילות מתאריך",
                    type: "date",
                    required: true,
                  },
                  {
                    name: "endDate",
                    label: "אי־פעילות עד תאריך (כולל)",
                    type: "date",
                    required: true,
                  },
                  {
                    name: "reason",
                    label: "סיבת אי־הפעילות",
                    type: "textarea",
                    required: true,
                    full: true,
                  },
                ]}
                submitLabel="בדיקת השפעת אי־הפעילות"
              />
            </div>
          </details>
          <details className="disclosure">
            <summary>תנאי התאמה אישיים: מגדר</summary>
            <div className="stack">
              <SoldierConditions
                key={String(selected.version)}
                action={action}
                person={selected}
              />
            </div>
          </details>
          <details className="disclosure">
            <summary>ניהול כתובת מייל וחשבון</summary>
            <p className="account-email">
              כתובת מייל: <bdi dir="ltr">{str(selected.email, "—")}</bdi>
            </p>
            <div className="account-actions">
              <ActionDialog
                title="שינוי כתובת מייל"
                fields={[
                  {
                    name: "email",
                    label: "כתובת המייל החדשה",
                    type: "email",
                    required: true,
                  },
                  { name: "reason", label: "סיבת השינוי", required: true },
                ]}
                action={action}
                type="account.email.request"
                payload={{ soldierId: selected.id }}
                version={selected.version}
                description="נשלח אימות לכתובת החדשה. החיבורים הקיימים יבוטלו לאחר האימות, וקישור Google ייבדק מחדש."
              />
              <ActionDialog
                title="אימות כתובת חדשה"
                fields={[
                  {
                    name: "code",
                    label: "קוד שנשלח לכתובת החדשה",
                    required: true,
                  },
                  {
                    name: "disconnectGoogle",
                    label:
                      "הבנתי שקישור Google הישן יוסר וכל החיבורים הקיימים יבוטלו",
                    type: "checkbox",
                    required: true,
                  },
                ]}
                action={action}
                type="account.email.confirm"
                payload={{ soldierId: selected.id }}
                version={selected.version}
              />
              <div className="danger-zone">
                <small className="muted">
                  מוחקת את פרטי הקשר והמידע הרגיש. השם, מספר הזיהוי וההיסטוריה
                  נשמרים.
                </small>
                <SoldierDeletion
                  person={selected}
                  action={action}
                  self={selected.id === state.actor.soldierId}
                  onDone={() => setSelected(null)}
                />
              </div>
            </div>
          </details>
        </Modal>
      )}
    </>
  );
}
