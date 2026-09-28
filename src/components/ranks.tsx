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
export function RanksView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const catalog = rows(state.rankCatalog);
  const rules = rows(state.rankRules);
  const reminders = rows(state.rankReminders).filter((row) =>
    ["pending", "scheduled", "missing_data"].includes(str(row.status))
  );
  const people = state.soldiers
    .filter((row) => !row.deletedAt)
    .map((row) => ({ value: row.id, label: str(row.name) }));
  const rankOptions = catalog.map((row) => ({
    value: row.id,
    label: `${str(row.name)} · ${str(row.track)}`,
  }));
  const rankName = (id: unknown) =>
    str(catalog.find((row) => row.id === id)?.name, "לא הוגדרה");
  const catalogFields = (row?: Row): Field[] => [
    { name: "name", label: "שם הדרגה", required: true, value: str(row?.name) },
    {
      name: "track",
      label: "מסלול הדרגות",
      required: true,
      value: str(row?.track),
      hint: "מסלולים נפרדים לחוגרים, נגדים, קצינים וקמ״א; ניתן להגדיר מסלולי משנה לפי הכללים המאומתים.",
    },
    {
      name: "order",
      label: "סדר בתוך המסלול",
      type: "number",
      min: 0,
      required: true,
      value: num(row?.order),
    },
    {
      name: "source",
      label: "מקור ההגדרה המאומת",
      required: true,
      value: str(row?.source),
    },
  ];
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
        title="קטלוג דרגות ומסלולים"
        actions={
          <ActionDialog
            title="הוספת דרגה לקטלוג"
            fields={catalogFields()}
            action={action}
            type="rank.catalog.save"
          />
        }
      >
        {catalog.length ? (
          catalog.map((row) => (
            <div className="task-item" key={row.id}>
              <div className="grow">
                <strong>
                  {str(row.name)} · {str(row.track)}
                </strong>
                <p>
                  סדר במסלול: {num(row.order)} · מקור: {str(row.source)}
                </p>
              </div>
              <ActionDialog
                title="עריכת פרטי דרגה"
                fields={catalogFields(row)}
                action={action}
                type="rank.catalog.save"
                payload={{ id: row.id }}
                version={row.version}
              />
            </div>
          ))
        ) : (
          <Empty title="יש להגדיר תחילה את הדרגות והמסלולים" />
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
                  options: rankOptions,
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
                  {rankName(row.fromRankId)} ← {rankName(row.toRankId)} ·{" "}
                  {num(row.months)} חודשים ·{" "}
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
