"use client";
import {
  type AppState,
  type Action,
  type Row,
  str,
  num,
  rows,
  displayDate,
  personName,
} from "@/client/types";
import { ActionDialog, Empty, Panel, Form, Notice, type Field } from "./ui";
import { rankMemberships } from "@/domain/rank-tracks";
import { rankChoices } from "@/client/soldier-filters";
export function RanksView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const catalog = rows(state.rankCatalog);
  const tracks = rows(state.rankTracks).sort((a, b) =>
    str(a.name).localeCompare(str(b.name), "he")
  );
  const placesText = (row: Row) =>
    rankMemberships(row)
      .map((m) => `${m.track} (מקום ${m.order})`)
      .join(" · ");
  const rules = rows(state.rankRules);
  const reminders = rows(state.rankReminders).filter((row) =>
    ["pending", "scheduled", "missing_data"].includes(str(row.status))
  );
  const people = state.soldiers
    .filter((row) => !row.deletedAt)
    .map((row) => ({ value: row.id, label: str(row.name) }));
  const rankOptions = catalog.map((row) => ({
    value: row.id,
    label: `${str(row.name)} · ${rankMemberships(row)
      .map((m) => m.track)
      .join(" / ")}`,
  }));
  const trackFields = (row?: Row): Field[] => [
    { name: "name", label: "שם המסלול", required: true, value: str(row?.name) },
    {
      name: "source",
      label: "מקור ההגדרה",
      required: true,
      value: str(row?.source),
    },
  ];
  const rankName = (id: unknown) =>
    str(catalog.find((row) => row.id === id)?.name, "לא הוגדרה");
  const catalogFields = (row?: Row): Field[] => [
    { name: "name", label: "שם הדרגה", required: true, value: str(row?.name) },
    ...tracks.map((track, index): Field => ({
      name: `place:${track.id}`,
      label: `מקום במסלול ${str(track.name)}`,
      type: "number",
      min: 0,
      value: row
        ? (rankMemberships(row)
            .find((m) => m.track === track.name)
            ?.order.toString() ?? "")
        : "",
      hint:
        index === 0
          ? "ריק — הדרגה אינה במסלול. דרגה יכולה להיות בכמה מסלולים, למשל סמ״ר אחרון בחוגרים וראשון בנגדים. מספר נמוך יותר הוא דרגה נמוכה יותר."
          : undefined,
      group: "places",
    })),
    {
      name: "source",
      label: "מקור ההגדרה המאומת",
      required: true,
      value: str(row?.source),
    },
    ...(row
      ? [
          {
            name: "usageConfirmed",
            label:
              "לשמור גם אם ההסרה או שינוי המקום משפיעים על חיילים, כללים או תנאים",
            type: "checkbox",
            full: true,
            hint: "אם יש שימוש קיים, השמירה תיעצר עם פירוט עד שמסמנים כאן",
          } satisfies Field,
        ]
      : []),
  ];
  const catalogPayload = (values: Record<string, unknown>) => ({
    name: values.name,
    source: values.source,
    usageConfirmed: values.usageConfirmed === true,
    tracks: tracks.flatMap((track) => {
      const place = values[`place:${track.id}`];
      return place === "" || place === undefined
        ? []
        : [{ track: str(track.name), order: Number(place) }];
    }),
  });
  const ruleFields = (row?: Row): Field[] => [
    {
      name: "name",
      label: "שם כלל הפז״ם",
      required: true,
      value: str(row?.name),
    },
    {
      name: "fromRankId",
      label: "דרגת מוצא",
      type: "select",
      required: true,
      options: rankOptions,
      value: str(row?.fromRankId),
    },
    {
      name: "toRankId",
      label: "דרגת יעד",
      type: "select",
      required: true,
      options: rankOptions,
      value: str(row?.toRankId),
    },
    {
      name: "track",
      label: "מסלול הכלל",
      type: "select",
      options: tracks.map((track) => ({
        value: str(track.name),
        label: str(track.name),
      })),
      value: str(row?.track),
      hint: "נדרש כששתי הדרגות נמצאות יחד בכמה מסלולים; אחרת נקבע לפי הדרגות.",
    },
    {
      name: "months",
      label: "מספר חודשים",
      type: "number",
      required: true,
      min: 1,
      max: 600,
      value: num(row?.months, 1),
    },
    {
      name: "base",
      label: "תאריך הבסיס",
      type: "select",
      required: true,
      options: [
        { value: "enlistment", label: "תאריך גיוס" },
        { value: "rank", label: "תאריך קבלת הדרגה הנוכחית" },
      ],
      value: str(row?.base, "rank"),
    },
    {
      name: "source",
      label: "מקור הכלל המאומת",
      required: true,
      value: str(row?.source),
    },
  ];
  return (
    <>
      <Notice>
        פז״ם יוצר תזכורת לבדיקה. רק אישור אחראי או עדכון ידני משנים דרגה. יש
        להזין כללים מאומתים המתאימים למסלולים ביחידה; אין ערכי ברירת מחדל.
      </Notice>
      <Panel
        title="מסלולי דרגות"
        subtitle="מסלול הוא סדר של דרגות. השוואת דרגות וכללי פז״ם נעשות בתוך מסלול"
        actions={
          <ActionDialog
            title="הוספת מסלול"
            fields={trackFields()}
            action={action}
            type="rank.track.save"
          />
        }
      >
        {tracks.length ? (
          tracks.map((track) => {
            const members = catalog
              .flatMap((row) => {
                const m = rankMemberships(row).find(
                  (item) => item.track === track.name
                );
                return m ? [{ name: str(row.name), order: m.order }] : [];
              })
              .sort((a, b) => a.order - b.order);
            return (
              <div className="task-item" key={track.id}>
                <div className="grow">
                  <strong>{str(track.name)}</strong>
                  <p>
                    {members.length
                      ? members.map((m) => m.name).join(" ← ")
                      : "אין עדיין דרגות במסלול"}
                  </p>
                  <small>מקור: {str(track.source)}</small>
                </div>
                <ActionDialog
                  title="עריכת מסלול"
                  buttonLabel="עריכה"
                  fields={trackFields(track)}
                  action={action}
                  type="rank.track.save"
                  payload={{ id: track.id }}
                  version={track.version}
                  description="אפשר לשנות שם רק למסלול שאין בו חיילים, כללי פז״ם או תנאי תורנות."
                />
                {!members.length && (
                  <ActionDialog
                    title="מחיקת מסלול"
                    buttonLabel="מחיקה"
                    danger
                    fields={[]}
                    action={action}
                    type="rank.track.delete"
                    payload={{ id: track.id }}
                    version={track.version}
                    description={`המסלול ${str(track.name)} יימחק. אפשר למחוק רק מסלול ריק שאינו בשימוש.`}
                    submitLabel="מחיקת המסלול"
                  />
                )}
              </div>
            );
          })
        ) : (
          <Empty
            title="יש להגדיר תחילה את מסלולי הדרגות"
            text="למשל חוגרים, נגדים, קצינים וקמ״א, לפי הכללים המאומתים ביחידה."
          />
        )}
      </Panel>
      <Panel
        title="קטלוג דרגות"
        actions={
          tracks.length > 0 && (
            <ActionDialog
              title="הוספת דרגה לקטלוג"
              fields={catalogFields()}
              action={action}
              type="rank.catalog.save"
              transform={catalogPayload}
            />
          )
        }
      >
        {catalog.length ? (
          catalog.map((row) => (
            <div className="task-item" key={row.id}>
              <div className="grow">
                <strong>{str(row.name)}</strong>
                <p>
                  {placesText(row) || "לא משויכת למסלול"} · מקור:{" "}
                  {str(row.source)}
                </p>
              </div>
              <ActionDialog
                title="עריכת פרטי דרגה"
                fields={catalogFields(row)}
                action={action}
                type="rank.catalog.save"
                payload={{ id: row.id }}
                version={row.version}
                transform={catalogPayload}
              />
            </div>
          ))
        ) : (
          <Empty title="עדיין לא הוגדרו דרגות" />
        )}
      </Panel>
      {catalog.length > 0 && (
        <div className="two-columns">
          <Panel title="עדכון דרגה מאושר">
            <Form
              fields={[
                {
                  name: "soldierId",
                  label: "חייל לעדכון דרגה",
                  type: "select",
                  required: true,
                  options: people,
                },
                {
                  name: "rankId",
                  label: "דרגה מאושרת",
                  type: "select",
                  required: true,
                  options: rankChoices(catalog),
                },
                {
                  name: "effectiveDate",
                  label: "תאריך תחולת הדרגה",
                  type: "date",
                  required: true,
                },
                { name: "reason", label: "מקור ואישור העדכון", required: true },
              ]}
              onSubmit={(values) =>
                action(
                  "rank.set",
                  values,
                  state.soldiers.find((row) => row.id === values.soldierId)
                    ?.version
                )
              }
              submitLabel="שמירת הדרגה המאושרת"
            />
          </Panel>
          <Panel title="מועד בדיקה אישי">
            <p>
              למקרה שבו אין כלל מתאים או שקיים מועד מאומת שונה. המועד חל על
              המעבר מהדרגה הנוכחית בלבד.
            </p>
            <Form
              fields={[
                {
                  name: "soldierId",
                  label: "חייל למועד אישי",
                  type: "select",
                  required: true,
                  options: people,
                },
                {
                  name: "toRankId",
                  label: "דרגת יעד למועד אישי",
                  type: "select",
                  required: true,
                  options: rankOptions,
                },
                {
                  name: "dueDate",
                  label: "מועד בדיקה מאומת",
                  type: "date",
                  required: true,
                },
                { name: "source", label: "מקור המועד האישי", required: true },
              ]}
              onSubmit={(values) =>
                action(
                  "rank.deadline",
                  values,
                  state.soldiers.find((row) => row.id === values.soldierId)
                    ?.version
                )
              }
            />
          </Panel>
        </div>
      )}
      <Panel title="תזכורות פז״ם ומועדים עתידיים">
        {reminders.length ? (
          reminders.map((row) => (
            <div className="task-item" key={row.id}>
              <div className="grow">
                <strong>
                  {personName(state, row.soldierId)} · {str(row.toRank)}
                </strong>
                <p>
                  {row.status === "missing_data"
                    ? "מידע חסר: יש להשלים תאריך גיוס בפרופיל"
                    : `${row.status === "scheduled" ? "מועד עתידי" : "ממתין לבדיקה"}: ${displayDate(row.dueDate)}`}
                </p>
                <small>מקור: {str(row.source)}</small>
              </div>
              {row.status !== "missing_data" && (
                <ActionDialog
                  title="אישור דרגה"
                  buttonLabel="בדיקה ואישור"
                  fields={[
                    {
                      name: "effectiveDate",
                      label: "תאריך תחולה מאושר",
                      type: "date",
                      required: true,
                    },
                    { name: "reason", label: "מקור האישור", required: true },
                  ]}
                  action={action}
                  type="rank.approve"
                  payload={{ id: row.id }}
                  version={row.version}
                />
              )}
            </div>
          ))
        ) : (
          <Empty
            title="אין תזכורות פתוחות"
            text="החישוב דורש דרגה קיימת וכלל פז״ם או מועד אישי מאומת."
          />
        )}
      </Panel>
      <Panel
        title="כללי פז״ם של היחידה"
        actions={
          catalog.length > 0 && (
            <ActionDialog
              title="הוספת כלל פז״ם"
              fields={ruleFields()}
              action={action}
              type="rank.rule.save"
            />
          )
        }
      >
        {rules.length ? (
          rules.map((row) => (
            <div className="task-item" key={row.id}>
              <div className="grow">
                <strong>{str(row.name)}</strong>
                <p>
                  {rankName(row.fromRankId)} ← {rankName(row.toRankId)} · מסלול{" "}
                  {str(row.track)} · {num(row.months)} חודשים ·{" "}
                  {row.base === "enlistment" ? "מתאריך גיוס" : "מתאריך הדרגה"}
                </p>
                <small>
                  {str(row.source)} · גרסה {row.version}
                </small>
              </div>
              <ActionDialog
                title="עריכת כלל פז״ם"
                fields={ruleFields(row)}
                action={action}
                type="rank.rule.save"
                payload={{ id: row.id }}
                version={row.version}
              />
            </div>
          ))
        ) : (
          <Empty title="לא הוגדרו כללי פז״ם" />
        )}
      </Panel>
    </>
  );
}
