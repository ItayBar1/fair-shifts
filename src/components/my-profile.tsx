"use client";
import { type Action, type AppState, num, obj, str } from "@/client/types";
import { Empty, Form, Panel } from "./ui";
import { genderLabel } from "./eligibility-conditions";

/**
 * "My details" (decision 222): the soldier sees their own name, issued number
 * and contact details, and changes phone and address. Name and gender are set
 * by a manager; the email changes through its own verified path.
 */
export function MyProfileView({
  state,
  action,
}: {
  state: AppState;
  action: Action;
}) {
  const me = obj(state.myProfile);
  if (!me.id) return <Empty title="הפרטים שלך אינם זמינים" />;
  const versions = obj(me.contactVersions);
  return (
    <>
      <Panel title="פרטים אישיים">
        <dl className="detail-list">
          <div>
            <dt>שם פרטי</dt>
            <dd>{str(me.firstName, str(me.name))}</dd>
          </div>
          <div>
            <dt>שם משפחה</dt>
            <dd>{str(me.lastName, "—")}</dd>
          </div>
          <div>
            <dt>מספר זיהוי</dt>
            <dd>
              <bdi dir="ltr">{str(me.idNumber, "—")}</bdi>
            </dd>
          </div>
          <div>
            <dt>מגדר</dt>
            <dd>{genderLabel(me.gender)}</dd>
          </div>
          <div>
            <dt>מייל</dt>
            <dd>
              <bdi dir="ltr">{str(me.email, "—")}</bdi>
            </dd>
          </div>
        </dl>
        <p className="muted">
          שינוי שם או מגדר נעשה בידי אחראי התורנויות. גם שינוי המייל נעשה דרך
          האחראי, עם קוד אימות לכתובת החדשה.
        </p>
      </Panel>
      <Panel title="טלפון וכתובת">
        <p className="muted">
          השינוי נשמר מיד, ואחראי התורנויות מקבלים הודעה שעדכנת את הפרטים.
          הטלפון והכתובת גלויים לאחראים בלבד.
        </p>
        <Form
          key={`${num(versions.phone)}-${num(versions.address)}`}
          submitLabel="שמירת טלפון וכתובת"
          fields={[
            {
              name: "phone",
              label: "טלפון נייד",
              type: "tel",
              required: true,
              value: str(me.phone),
              hint: "נייד ישראלי שמתחיל ב־05, או מספר בינלאומי שמתחיל ב־+",
            },
            {
              name: "address",
              label: "כתובת (לא חובה)",
              value: str(me.address),
            },
          ]}
          onSubmit={(values) =>
            action("profile.contact.update", {
              ...values,
              versions: {
                phone: num(versions.phone),
                address: num(versions.address),
              },
            })
          }
        />
      </Panel>
    </>
  );
}
