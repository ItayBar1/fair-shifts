# מפת קבלה מול בדיקות

המסמך נוצר אוטומטית מ־`tests/acceptance/acceptance-map.ts` בפקודה `pnpm docs:matrix`, ואין לערוך אותו ביד. הבדיקה `tests/unit/acceptance-matrix.test.ts` מוודאת שכל קובץ ושם בדיקה שמופיעים בו קיימים, שהמספרים זהים לאלה שבאפיון (סעיפים 4 ו־9), ושהמסמך שבמאגר שווה למה שהמפה מייצרת. כרטיס [#38](https://github.com/ItayBar1/fair-shifts/issues/38).

**איך קוראים.** ״מכוסה״: לכל סעיף בסיפור או בתרחיש יש בדיקה אוטומטית. ״חלקי״ ו״פתוח״: השורה ״חוסר״ אומרת מה אין לו בדיקה, ובפתוח גם איזה כרטיס יסגור זאת. בדיקה נקראת לפי הקובץ וחלק משמה, כך שבדיקה שנמחקה או ששמה שונה שוברת את הבדיקה של המפה. תוצאות מול ספק, שרת ופיילוט מופיעות בנפרד בשורה ״ספקים, שרת ופיילוט״: ״נבדק״ מתועד ב[מצב הפרויקט](../config/memory/project-state.md), ״טרם נבדק״ עדיין לא נעשה. מעבר בדיקה אוטומטית אינו הוכחה שקיימת הפעלה בשרת או בפיילוט.

סיפורים: 65 במפה: 65 מכוסים, 0 חלקיים, 0 פתוחים. תרחישי קבלה: 64 במפה: 64 מכוסים, 0 חלקיים, 0 פתוחים.

## מה עדיין פתוח

- אין חוסר פתוח במפה.

## סיפורי משתמש

### 1. כאחראי, אני רוצה להוסיף חייל בטופס בודד כדי לקלוט משתמש גם בלי להכין קובץ. — מכוסה

- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `manager invites, assigns and publishes; soldier sees only published duties`
- [soldier-intake.test.ts](../tests/integration/soldier-intake.test.ts): `creates the record, the contact, a zero balance, an invited account and its invitation`; `refuses a personal number that is taken, and an address that is taken, without a trace`; `creates one soldier when two managers send the same form at once`; `refuses a form %s and writes nothing`

### 2. כאחראי, אני רוצה להוסיף ולעדכן חיילים מ־Excel לפי מספר אישי, עם תצוגה מקדימה, כדי לשלוט בשינויים לפני החלתם. — מכוסה

- [import-invitations.test.ts](../tests/integration/import-invitations.test.ts): `stores soldiers and permits sign-in before any invitation is published`; `requires confirmation and publishes only new accounts once across two tabs and retries`
- [import-invitations.spec.ts](../tests/e2e/import-invitations.spec.ts): `imports without mail and explicitly publishes invitations after reopening the batch`
- [import-workbook.test.ts](../tests/unit/import-workbook.test.ts): `preserves identifiers and zeros, Israeli calendar dates, explicit false and integer scores`; `rejects the entire file and returns row, field and value for duplicates and malformed cells`; `rejects invalid archives, empty templates and excess rows`
- [auth.test.ts](../tests/integration/auth.test.ts): `imports a whole reviewed batch, preserving reservations and blank fields with documented balances`; `rejects all rows on duplicate, conflicting identities, incomplete ranks or deleted people`; `serializes competing import approvals and returns idempotent results without duplicate ledger entries`; `restricts import previews and history to managers`
- [staging-soldiers.test.ts](../tests/integration/staging-soldiers.test.ts): `writes a workbook that the import accepts whole, with the three populations`

### 3. כאחראי, אני רוצה לייבא יתרת פתיחה קיימת כדי להתחיל לעבוד בלי לשחזר את כל תורנויות העבר. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `imports a whole reviewed batch, preserving reservations and blank fields with documented balances`
- [soldier-intake.test.ts](../tests/integration/soldier-intake.test.ts): `takes an opening balance as the only history`

### 4. כאחראי, אני רוצה להזמין חייל דרך כתובת מייל מאושרת כדי לקשר כניסה לרשומה הנכונה. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `does not create an account or send mail for an unknown address`
- [google-sign-in.test.ts](../tests/integration/google-sign-in.test.ts): `refuses an uninvited address and an address Google has not verified, creating nothing`
- [soldier-intake.test.ts](../tests/integration/soldier-intake.test.ts): `creates the record, the contact, a zero balance, an invited account and its invitation`
- ספקים, שרת ופיילוט:
  - נבדק: Brevo אמיתי ב־staging: קוד, פרסום, כשל וחזרה (#25)

### 5. כחייל, אני רוצה להתחבר באמצעות Google או קוד למייל המאושר כדי לגשת לחשבון שלי. — מכוסה

- [google-sign-in.test.ts](../tests/integration/google-sign-in.test.ts): `lets an invited person start with Google and then use either Google or an email code`
- [google-sign-in.spec.ts](../tests/e2e/google-sign-in.spec.ts): `the Google button gets a Google link from the server, with the server's own permissions`
- [auth.test.ts](../tests/integration/auth.test.ts): `consumes a code only once`; `expires a code at ten minutes`
- [access-lifecycle.spec.ts](../tests/e2e/access-lifecycle.spec.ts): `a refused Google sign-in returns to the login page with guidance, also on a phone`
- ספקים, שרת ופיילוט:
  - נבדק: כניסה אמיתית ב־Google ב־staging (#25)

### 6. כאחראי, אני רוצה לנהל את כל החיילים ולראות כברירת מחדל את אוכלוסייתי ואת הקבוצה המשותפת כדי להתמקד בתחום הטיפול שלי. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps responsibility a versioned screen default set by the technical account or the manager, never a permission`
- [soldier-filters.test.ts](../tests/unit/soldier-filters.test.ts): `defaults a manager to their responsibility and the shared KAMA group`; `hides KAMA independently and can add the other population`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `responsibility filters default per manager, hide KAMA and filter rank without granting or limiting access`

### 7. כאחראי, אני רוצה להזין מועדי שירות וקצונה כדי שהזכאות העתידית תחושב לפי מועד התורנות. — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `moves the population for an earlier officer date or a KAMA transition`; `treats an officer date after the career date as no move`; `merges dates that do not change the effective population`
- [auth.test.ts](../tests/integration/auth.test.ts): `previews a population transition over a night duty that crosses it, keeps earlier transitions and saves one of two competing confirmations`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `population moves preview their impact before saving in the transition, the profile and the import`

### 8. כאחראי, אני רוצה לאשר חודש חסד רק לזכאים כדי שקליטת רשומה קיימת לא תעניק חסד בטעות. — מכוסה

- [service-lifecycle.test.ts](../tests/integration/service-lifecycle.test.ts): `grants grace only when marked eligible and leaves the balance when it ends`
- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `applies only to an explicitly eligible soldier`; `ends on the last day of a shorter month, which is itself available`

### 9. כאחראי, אני רוצה להגדיר אי־פעילות לתקופה כדי למנוע שיבוץ בזמן קורס או היעדרות ממושכת. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `retains an assignment and flags it when a new inactivity period conflicts`; `previews a new inactivity period that touches only the last day of a duty, saves nothing until confirmation and then flags it in the same save`
- [service-lifecycle.test.ts](../tests/integration/service-lifecycle.test.ts): `keeps access during an inactive period`
- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `limits assignment but is not an access state`

### 10. כאחראי, אני רוצה שגישת חייל תיחסם לאחר שחרור ושאקבל הודעת עזיבה כדי לטפל במחיקתו בנפרד. — מכוסה

- [service-lifecycle.test.ts](../tests/integration/service-lifecycle.test.ts): `refuses every request from the local midnight after the release day, before any worker run`; `announces a departure once to each manager across repeated runs, races and downtime, without deleting`
- [service-lifecycle.spec.ts](../tests/e2e/service-lifecycle.spec.ts): `release blocks the open session at the boundary, the managers get one departure notice and the service dates are shown`

### 11. כאחראי, אני רוצה למחוק משתמש, להסיר פרטי התקשרות ומידע רגיש ולפנות שיבוצים עתידיים כדי להפסיק את פעילותו תוך שימור ההיס… — מכוסה

- [soldier-deletion.test.ts](../tests/integration/soldier-deletion.test.ts): `removes contact details and conditions, and keeps name, number and history`; `vacates future seats, keeps seats of a duty that started, and warns the managers`; `ends access and mail at once`
- [soldier-deletion.spec.ts](../tests/e2e/soldier-deletion.spec.ts): `the manager sees what a deletion does, deletes the user, and the seat becomes vacant with a warning`

### 12. כאחראי, אני רוצה ליצור סוגי פטורים לשימוש חוזר ולשייכם לחיילים ולסוגי תורנויות כדי לנהל מגבלות בלי לשנות תוכנה. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `removes an exemption without discarding approved constraints and restricts both preview and catalog edits to managers`; `requires exemption approval for a partial overlap, rejects an obsolete preview and saves one of two competing confirmations`
- [soldier-picker.test.ts](../tests/unit/soldier-picker.test.ts): `hides the soldier through the last day of the exemption, inclusive`

### 13. כאחראי, אני רוצה להזין כשירות ותוקף כדי למנוע שיבוץ שאינו מתאים לכל משך התורנות. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `previews a shortened qualification for the whole performance, retains the assignment and flags it after explicit confirmation`; `counts combined qualification periods over the whole duty and clears the attention flag only when they cover it`
- [domain.test.ts](../tests/unit/domain.test.ts): `checks qualification throughout the execution`
- [soldier-picker.test.ts](../tests/unit/soldier-picker.test.ts): `hides a soldier whose qualification expires, or starts, inside the range`

### 14. כאחראי, אני רוצה להגדיר מנוחה לפני ואחרי סוג תורנות כדי למנוע שיבוצים שאינם מאפשרים אותה. — מכוסה

- [rest-windows.test.ts](../tests/unit/rest-windows.test.ts): `also holds when the soldier already has the later duty`; `allows a duty that starts the minute the other ends, and blocks one minute of overlap`; `does not count the seat that is being given away`
- [domain.test.ts](../tests/unit/domain.test.ts): `does not treat overlapping rest buffers alone as conflicting`

### 15. כאחראי, אני רוצה לבצע עקיפת פטור נקודתית רק לאחר אישור חריג מפורש כדי לתעד את ההחלטה בלי לשנות את הפטור. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `persists a justified rank exception through another seat assignment and publication`; `rejects an obsolete exception preview and never permits it to bypass a missing qualification`; `checks personal hours over a night in Israeli time, keeps them out of the lottery and allows only a justified manual exception`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `manager invites, assigns and publishes; soldier sees only published duties`

### 16. כאחראי, אני רוצה לפתוח ולסגור סבב אילוצים משותף ולהגדיר בנפרד את תקופת היעד כדי לשלוט במועדי ההגשה. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `allows a manager to reopen a closed round without changing its target period`
- [round-notices.test.ts](../tests/integration/round-notices.test.ts): `cancels on closing and starts a new generation on reopening or extension`
- [constraint-rounds.spec.ts](../tests/e2e/constraint-rounds.spec.ts): `constraint round: direct declaration, shared decision, stale approval, close and reopen`

### 17. כחייל, אני רוצה להגיש יום או טווח ימים עם סיבה כדי שהאחראי יוכל לבחון את האילוץ. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `rejects submissions outside the window or target period and applies whole Israel days across a clock change`
- [constraint-rounds.spec.ts](../tests/e2e/constraint-rounds.spec.ts): `constraint round: direct declaration, shared decision, stale approval, close and reopen`

### 18. כחייל, אני רוצה לסמן ״אין לי אילוצים״ כדי להשלים הגשה גם כשהכול פנוי. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `records a no-constraints declaration directly as a completed submission and lets a later item replace it`
- [round-notices.test.ts](../tests/integration/round-notices.test.ts): `reminds only soldiers who have not submitted, and rechecks at delivery`

### 19. כחייל, אני רוצה לערוך אילוץ בחלון פתוח תוך שמירת הגרסה המאושרת עד החלטה כדי שלא לאבד אישור קיים. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps the approved constraint while an edit awaits review and after its rejection`; `accepts multiple independently reviewed items atomically and archives changed versions`

### 20. כאחראי, אני רוצה לאשר הגשות ולדחות סעיפים מסוימים כדי לסיים סקירה מרוכזת. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `accepts multiple independently reviewed items atomically and archives changed versions`; `lets one of two managers decide a shared constraint, shows who decided and rejects stale edits`

### 21. כאחראי, אני רוצה לקבל תזכורת לפני שיבוץ מול אילוצים שטרם נבדקו ולאשר כל התנגשות בנפרד כדי להכריע במודע. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps the global pending-review confirmation separate from each collision approval`; `requires a new collision approval for every pending version and never carries it into the approved version`
- [planning.test.ts](../tests/integration/planning.test.ts): `stops a confirmed run at a newly pending constraint until a manager confirms again`
- [domain.test.ts](../tests/unit/domain.test.ts): `global pending review approval does not waive the individual collision`

### 22. כאחראי, אני רוצה לראות שיבוצים שנפגעו מאילוץ או פטור חדש כדי למצוא פתרון בלי שהשיבוץ יימחק אוטומטית. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `retains an assignment and flags it when a new inactivity period conflicts`; `requires current impact confirmation and keeps a conflicting assignment for treatment`

### 23. כאחראי, אני רוצה לנהל קטלוג תורנויות, תנאים, ניקוד ותוספות כדי להשתמש בהגדרות חוזרות. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `applies updated catalog prices and composition only through an explicit proposal`
- [instance-composition.test.ts](../tests/integration/instance-composition.test.ts): `edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone`

### 24. כאחראי, אני רוצה ליצור תורנות מסוימת עם מועדים, מיקום והנחיות משתנים כדי לשמור את פרטי הביצוע הנכונים. — מכוסה

- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `multi-day duties appear on every Israeli day and month, independent of the browser zone`
- [calendar.test.ts](../tests/unit/calendar.test.ts): `shows a duty crossing a month in both months, with start and end`
- [instance-composition.test.ts](../tests/integration/instance-composition.test.ts): `edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone`

### 25. כאחראי, אני רוצה להגדיר משך ומספר חיילים שונים, ובמידת הצורך מכסות לפי תפקיד, כדי לייצג גם תורנות קצרה וגם שבוע אבט״ש. — מכוסה

- [instance-composition.test.ts](../tests/integration/instance-composition.test.ts): `releases an occupied seat of a published instance only when it is chosen explicitly, and only on update and publish`; `keeps occupied seats before vacant ones when a catalog quota is applied`
- [composition.test.ts](../tests/unit/composition.test.ts): `keeps slot ids and occupants, drops vacant slots first and applies role conditions`
- [instance-composition.spec.ts](../tests/e2e/instance-composition.spec.ts): `manager reduces an instance's quota, releases a seat explicitly and changes its pricing before update and publish`

### 26. כאחראי, אני רוצה לתכנן חודש וגם לשבץ תורנות בודדת בהתראה קצרה כדי לטפל בשני דפוסי העבודה. — מכוסה

- [planning.test.ts](../tests/integration/planning.test.ts): `recomputes candidates and the minimum after every seat of one instance`
- [auth.test.ts](../tests/integration/auth.test.ts): `plans one seat per transaction, resumes, and leaves missing seats without moving assignments`
- [planning-shortfall.spec.ts](../tests/e2e/planning-shortfall.spec.ts): `a period plan explains each shortfall, and a changed draw drops its approval form`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `manager invites, assigns and publishes; soldier sees only published duties`

### 27. כאחראי, אני רוצה שהמערכת תסנן לפי כשירות וזמינות לפני חישוב רצועת הניקוד כדי שההגרלה תיעשה בין חיילים מתאימים. — מכוסה

- [planning.test.ts](../tests/integration/planning.test.ts): `filters blocked candidates before the minimum and keeps the exact strict band`
- [domain.test.ts](../tests/unit/domain.test.ts): `filters before minimum and uses a strict upper bound`

### 28. כאחראי, אני רוצה הגרלה לפי רצועה התלויה במשקל התורנות כדי שגם מועמדים קרובים למינימום יוכלו להשתתף. — מכוסה

- [lottery-draw.test.ts](../tests/unit/lottery-draw.test.ts): `gives every member of the band an equal share of the random range`; `never reaches a member above the band, even with the highest value`
- [domain.test.ts](../tests/unit/domain.test.ts): `filters before minimum and uses a strict upper bound`
- [planning.test.ts](../tests/integration/planning.test.ts): `filters blocked candidates before the minimum and keeps the exact strict band`

### 29. כאחראי, אני רוצה ששיבוצים שמורים אצל שני האחראים ישפיעו מיד על הזמינות והניקוד לשיבוץ כדי למנוע חלוקה כפולה. — מכוסה

- [planning.test.ts](../tests/integration/planning.test.ts): `counts draft and in-execution reservations of both managers in the scheduling score`; `lets two managers plan overlapping duties at once without booking one soldier twice`
- [auth.test.ts](../tests/integration/auth.test.ts): `lets only one of two managers occupy the last place`
- [domain.test.ts](../tests/unit/domain.test.ts): `counts draft reservations and forbids an automatic zero value selection`

### 30. כאחראי, אני רוצה להתחיל בתורנויות שקשה לאייש ולעדכן את המצב לאחר כל בחירה כדי לנצל את האפשרויות הקיימות. — מכוסה

- [planning.test.ts](../tests/integration/planning.test.ts): `orders equally scarce duties by nearer start and then a fixed id`
- [auth.test.ts](../tests/integration/auth.test.ts): `plans scarce duties before earlier common duties and the rare role first within a duty`

### 31. כאחראי, אני רוצה לאשר או לדחות מועמד שנבחר בחודש שלפני שחרורו כדי להפעיל שיקול דעת בלי לשנות את כלל ההגרלה. — מכוסה

- [planning.test.ts](../tests/integration/planning.test.ts): `excludes a rejected near-release candidate only from that duty`
- [auth.test.ts](../tests/integration/auth.test.ts): `requires explicit proposal approvals and completes a competing decision only once`; `does not inherit an earlier near-release approval into a new published version`
- [domain.test.ts](../tests/unit/domain.test.ts): `allows a volunteer near release without that approval alone`

### 32. כאחראי, אני רוצה לראות חוסרים וסיבות פסילה כדי לטפל בתורנות שלא ניתן להשלים. — מכוסה

- [planning-shortfall.spec.ts](../tests/e2e/planning-shortfall.spec.ts): `a period plan explains each shortfall, and a changed draw drops its approval form`
- [auth.test.ts](../tests/integration/auth.test.ts): `plans one seat per transaction, resumes, and leaves missing seats without moving assignments`
- [planning.test.ts](../tests/integration/planning.test.ts): `draws nobody for a zero value seat and reports it as missing in a period plan`

### 33. כאחראי, אני רוצה לשמור טיוטה ולפרסם במפורש כדי לבדוק את התכנון לפני חשיפתו לחיילים. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps drafts private, publishes explicitly and settles exactly once`; `cancels an expired draft explicitly and releases reservations without earning points or revealing it`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `manager invites, assigns and publishes; soldier sees only published duties`

### 34. כאחראי, אני רוצה להשתמש ב״עדכן ופרסם״ לשינוי תורנות שפורסמה כדי שכל המושפעים יקבלו את השינוי המחייב. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps a published duty binding until an atomic versioned update replaces its reservations`; `applies updated catalog prices and composition only through an explicit proposal`
- [instance-composition.spec.ts](../tests/e2e/instance-composition.spec.ts): `manager reduces an instance's quota, releases a seat explicitly and changes its pricing before update and publish`

### 35. כחייל, אני רוצה לראות את הלוח היחידתי ולסנן לתורנויותיי כדי להבין את התכנון ואת האחריות האישית שלי. — מכוסה

- [calendar.test.ts](../tests/unit/calendar.test.ts): `builds a Sunday-first month grid and moves across years`; `assigns instants near midnight to the Israeli day and month`
- [calendar-filters.test.ts](../tests/unit/calendar-filters.test.ts): `upcoming honors personal scope and excludes a duty at its exact end`
- [calendar-cards.spec.ts](../tests/e2e/calendar-cards.spec.ts): `soldier summary cards filter, restore and focus the score at width`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `multi-day duties appear on every Israeli day and month, independent of the browser zone`

### 36. כחייל, אני רוצה לראות את דירוגי ואת הניקוד הנוכחי בטבלה המשותפת כדי להבין את מצב החלוקה. — מכוסה

- [fairness-table.test.ts](../tests/unit/fairness-table.test.ts): `ranks soldiers by balance, with equal balances sharing a rank`
- [domain.test.ts](../tests/unit/domain.test.ts): `shares rank at equal scores and only credits published duties`
- [calendar-cards.spec.ts](../tests/e2e/calendar-cards.spec.ts): `soldier summary cards filter, restore and focus the score at width`

### 37. כאחראי, אני רוצה לחשב מחיר קבוע או מחיר ל־24 שעות עם תוספות בחיבור כדי לייצג משקלים שונים. — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `prices 36 actual hours at six points`; `rounds only after all components have been added`; `counts an overnight window once and applies its minimum`
- [execution.test.ts](../tests/unit/execution.test.ts): `measures real hours across the end of summer time in Israel`
- [instance-composition.test.ts](../tests/integration/instance-composition.test.ts): `edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone`

### 38. כאחראי, אני רוצה להעניק תוספת הזנקה למשתתף הרלוונטי בלבד כדי לא להגדיל את הניקוד של שאר התורנים. — מכוסה

- [instance-composition.test.ts](../tests/integration/instance-composition.test.ts): `saves a suggested call-up amount on the type and instance without ever applying it by itself`
- [execution-periods.test.ts](../tests/integration/execution-periods.test.ts): `requires an explicit fixed-price and bonus split, then credits each performer once`
- [auth.test.ts](../tests/integration/auth.test.ts): `keeps the original until consent, moves the full value without a score check and completes once when candidates race`

### 39. כאחראי, אני רוצה ששינוי מחירון יחול על תורנויות חדשות כדי לשמור על התמחור שנקבע לקיימות. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `applies updated catalog prices and composition only through an explicit proposal`
- [instance-composition.test.ts](../tests/integration/instance-composition.test.ts): `edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone`

### 40. כאחראי, אני רוצה לזקוף ניקוד אוטומטית בתום תורנות שלא בוטלה כדי שלא אצטרך לאשר כל ביצוע רגיל. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps drafts private, publishes explicitly and settles exactly once`
- [execution-periods.test.ts](../tests/integration/execution-periods.test.ts): `splits the daily base by actual time, credits the ended part once and keeps the rest stored`
- [deletion-in-execution.test.ts](../tests/integration/deletion-in-execution.test.ts): `never credits twice when the worker and the manager's decision race`

### 41. כאחראי, אני רוצה לערוך יתרה בודדת או לבצע שינוי מרוכז עם רצפת אפס כדי לבצע תיקונים ונרמול. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `rejects a normalization preview after a concurrent balance change without partially applying it`; `settles overdue work before normalization and serializes a competing worker without double credit`
- [domain.test.ts](../tests/unit/domain.test.ts): `rounds a 20% reduction of 51 to 41 and clamps at zero`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `manager resolves a pending balance decision from the handling center after a correction crosses a normalization`

### 42. כאחראי, אני רוצה שנרמול ישמור שיבוצים ושנקודות מתורנות שמסתיימת אחריו ייזקפו אחריו כדי לשמור על כלל מועד הביצוע. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `settles overdue work before normalization and serializes a competing worker without double credit`; `records the history but leaves the balance for a manager decision after a normalization, even when the corrected end moves past it`

### 43. כאחראי, אני רוצה לתקן היסטוריה שלפני נרמול ולהחליט בנפרד על השפעתה כיום כדי למנוע חישוב שגוי של ההפרש. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `records the history but leaves the balance for a manager decision after a normalization, even when the corrected end moves past it`; `shows the decision in the handling center, keeps the balance once and lets a later correction weigh only the new difference`; `adjusts with a zero floor or sets the balance once when two managers compete, and rejects obsolete or empty choices`

### 44. כאחראי, אני רוצה לתעד תקופות ביצוע כשמחליפים חייל במהלך תורנות כדי לתת ניקוד למבצעים בפועל. — מכוסה

- [execution-periods.test.ts](../tests/integration/execution-periods.test.ts): `requires every moment to belong to one performer or to be marked as not performed`; `checks a replacement against their own period, and frees the leaving soldier after they left`
- [execution-periods.spec.ts](../tests/e2e/execution-periods.spec.ts): `a manager records who covered a started seat, approves a handover, and soldiers see each period`

### 45. כחייל, אני רוצה להציע לחייל אחר לקבל תורנות ולאפשר לו לאשר כדי לבצע העברה בהסכמה. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps the original until consent, moves the full value without a score check and completes once when candidates race`; `rejects an unsuitable candidate without revealing why and rechecks at acceptance`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `a soldier offers a published duty to several replacements and the first consent transfers it`

### 46. כחייל, אני רוצה להציע החלפה של שתי תורנויות כדי ששתי ההעברות יושלמו יחד או לא יושלמו כלל. — מכוסה

- [google-sign-in.test.ts](../tests/integration/google-sign-in.test.ts): `rejects a link inserted after the hook approved it`; `rejects a session inserted after its hook approved an epoch`; `requires a proven epoch even when no Google proof exists`; `requires a verified current email once for a legacy Google link`; `refuses direct idToken sign-in`
- [otp-protection.test.ts](../tests/integration/otp-protection.test.ts): `burns exactly once in a race`; `anchors the wait to burning`; `doubles each burn delay to 24 hours`; `gives the same code-request response`; `returns an identical recovery error`; `does not trust client-provided proxy headers`; `enforces 60 requests, 300 verifications and 10 recoveries`; `applies the rate limit at the public authentication route`
- [swaps.test.ts](../tests/integration/swaps.test.ts): `swaps both seats together with their full value, without a score check, and completes once when two acceptances race`; `rechecks both sides at acceptance and keeps both seats when one side no longer fits, without revealing the offerer's reason`
- [swaps.spec.ts](../tests/e2e/swaps.spec.ts): `two soldiers swap seats by consent, and a manager approves a swap that needs an exception`

### 47. כחייל, אני רוצה שהחלפה תקינה לפני תחילת התורנות תתבצע אוטומטית בלי מגבלת ניקוד כדי לאפשר התנדבות של כל מחליף מתאים. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `lets a volunteer near release take over automatically but never past the release boundary`
- [swaps.test.ts](../tests/integration/swaps.test.ts): `checks the state after the swap, so overlapping source duties and seats in one duty are not a self-conflict`
- [domain.test.ts](../tests/unit/domain.test.ts): `lets a consenting volunteer bypass pending constraints but not approved ones or release`

### 48. כחייל, אני רוצה לבקש החלפה במהלך ביצוע ולהעבירה לאחראי כדי לאפשר טיפול במצב משתנה. — מכוסה

- [execution-periods.test.ts](../tests/integration/execution-periods.test.ts): `goes to a manager, who sets the handover, and the original seat binds until then`
- [swaps.test.ts](../tests/integration/swaps.test.ts): `sends a swap whose duty started to a manager, who needs a handover time to approve it and may reject it with a visible reason`
- [auth.test.ts](../tests/integration/auth.test.ts): `hands an acceptance after the start to a manager without moving the seat`

### 49. כחייל, אני רוצה לבקש ביטול או דחייה עקב פטור שלדעתי חל עליי כדי שהאחראי יבחן זאת בלי ביטול אוטומטי. — מכוסה

- [cancellation-requests.test.ts](../tests/integration/cancellation-requests.test.ts): `submitting changes neither the seat, the calendar nor reserved points, and is visible only to its owner and managers`; `completes a removal only through update and publish, frees the seat and its reserved points`
- [cancellation-requests.spec.ts](../tests/e2e/cancellation-requests.spec.ts): `a soldier's request changes nothing until the manager removes the seat in update and publish, or rejects it`

### 50. כחייל, אני רוצה לקבל תזכורות במייל ובאתר כדי לא להסתמך על פתיחת הדפדפן. — מכוסה

- [duty-reminders.test.ts](../tests/integration/duty-reminders.test.ts): `sends the default 24 and 2 hour reminders once on both channels and nothing after the start`
- [mail-delivery.test.ts](../tests/integration/mail-delivery.test.ts): `retries with growing delays, then fails visibly while the site notice stays`
- [duty-reminders.spec.ts](../tests/e2e/duty-reminders.spec.ts): `duty reminder: one site notice per time, linked to the duty, on mobile too`
- ספקים, שרת ופיילוט:
  - נבדק: Brevo אמיתי ב־staging: קוד, פרסום, כשל וחזרה (#25)

### 51. כמשתמש, אני רוצה להתאים את סוגי המיילים, תדירותם ומועדיהם כדי לקבל תזכורות שמתאימות לי. — מכוסה

- [notifications.test.ts](../tests/integration/notifications.test.ts): `applies changed unit defaults to inheriting accounts without overriding a saved personal form`; `rechecks type and timing preferences after scheduling and before delivery`
- [notification-preferences.test.ts](../tests/unit/notification-preferences.test.ts): `validates type, timing, channels and frequency on the server`
- [notification-preferences.spec.ts](../tests/e2e/notification-preferences.spec.ts): `unit defaults reach soldiers without personal preferences; a saved personal form and inbox states stay personal`

### 52. כמשתמש, אני רוצה לראות הודעות שלא נקראו ולהסתיר הודעות מההיסטוריה האישית כדי לנהל את התיבה שלי. — מכוסה

- [notifications.test.ts](../tests/integration/notifications.test.ts): `keeps the site notification when email is off and never treats delivery as reading`; `hides and reads only the recipient's copy without changing the duty, assignment or log`; `shows a notification addressed to a manager only to that manager, even when it concerns a soldier`

### 53. כאחראי, אני רוצה לראות תיעוד החלטות ושינויים כדי להבין מי ביצע פעולה ומה השתנה. — מכוסה

- [audit-log.test.ts](../tests/integration/audit-log.test.ts): `shows when, who, why and what changed, with the effective date only when it differs`; `identifies a decision of another manager and reaches it from the score ledger`; `gives soldiers no log and the technical account only operations within its authority`
- [audit-log.spec.ts](../tests/e2e/audit-log.spec.ts): `a manager reads who did what and why, and reaches it from the soldier and the score ledger`; `a soldier has no audit log`

### 54. כמפעיל, אני רוצה גיבוי שניתן לשחזר כדי לצמצם אובדן נתונים גם כשהמערכת מושבתת. — מכוסה

- [backup.test.ts](../tests/integration/backup.test.ts): `produces a verified copy that is only ciphertext, decrypts and restores the data`
- [restore.test.ts](../tests/integration/restore.test.ts): `restores the newest backup into a scratch database, passes every check and leaves the live system as it was`
- [backups.spec.ts](../tests/e2e/backups.spec.ts): `technical account sees backup status, failures and alerts, and requests a backup once`
- ספקים, שרת ופיילוט:
  - נבדק: Drive אמיתי: גיבוי יומי וידני, הרשאה שבוטלה, כשל רשת, שמירת 30 (#37)
  - טרם נבדק: Drive אמיתי: שחזור מגיבוי שהורד ומחיקות אחרי שחזור, ותרגיל בשרת (#37)

### 55. כאחראי, אני רוצה לשמור ולעדכן את דרגת החייל כדי שהשיבוץ יתבסס על הדרגה הרלוונטית. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `creates one tenure reminder without promoting and requires an explicit versioned decision`; `recalculates open reminders on a rule change and never overwrites a manually approved future rank`
- [soldier-filters.test.ts](../tests/unit/soldier-filters.test.ts): `filters an exact rank without treating another track as equivalent`
- [rank-conditions.test.ts](../tests/unit/rank-conditions.test.ts): `accepts an exact rank and no other`

### 56. כאחראי, אני רוצה להגדיר תורנות המיועדת לדרגה מסוימת, למשל רס״ל או רס״ן, כדי לשבץ רק חיילים שעומדים בדרישה. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `snapshots duty and role rank requirements and checks the confirmed rank at the start`
- [rank-conditions.test.ts](../tests/unit/rank-conditions.test.ts): `blocks another rank in an automatic draw, whatever the score`; `asks the role's condition as well as the duty's`
- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `checks rank at the start only`

### 57. כאחראי, אני רוצה התראה כשמגיע מועד הפז״ם לדרגה, ולאשר את עדכון הדרגה או לעדכן ידנית, כדי לתכנן לפי דרגה שאומתה. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `creates one tenure reminder without promoting and requires an explicit versioned decision`; `recalculates open reminders on a rule change and never overwrites a manually approved future rank`; `shows missing enlistment data and permits a sourced personal deadline without guessing equivalence`

### 58. כאחראי, אני רוצה תנאי דרגה מדויקת, רשימה, מינימום, מקסימום או טווח, כדי לייצג את דרישות התורנות. — מכוסה

- [rank-conditions.test.ts](../tests/unit/rank-conditions.test.ts): `accepts an exact rank and no other`; `accepts any rank in a list`; `accepts a minimum, the rank itself included`; `accepts a maximum, the rank itself included`; `accepts a range with both ends included`; `takes several clauses as alternatives`
- [soldier-picker.test.ts](../tests/unit/soldier-picker.test.ts): `expands rank clauses to the catalog ranks they accept`

### 59. כאחראי, אני רוצה לאשר חריג דרגה נקודתי בחלון מפורש, כדי לתעד שיבוץ חריג בלי לשנות את פרטי החייל. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `persists a justified rank exception through another seat assignment and publication`; `rejects an obsolete exception preview and never permits it to bypass a missing qualification`
- [domain.test.ts](../tests/unit/domain.test.ts): `routes a volunteer's exemption or rank exception to a manager instead of blocking`
- [rank-conditions.test.ts](../tests/unit/rank-conditions.test.ts): `leaves a manual selection to an explicit exception instead of blocking`

### 60. כמנהל טכני, אני רוצה להוסיף משתמש בודד ולהעניק ולהסיר הרשאת אחראי, כדי שתמיד אוכל למנות אחראי חדש ולשלוט בגישת הניהול מ… — מכוסה

- [technical-user-create.test.ts](../tests/integration/technical-user-create.test.ts): `creates an invited identity with zero balance without any manager`; `grants the existing manager role, revokes old access`; `refuses soldier and manager actors before validating payload`; `rejects duplicate identity and normalized email`; `replays one idempotent result`; `serializes competing creations`; `rolls back person, contact, balance and account`
- [technical-user-create.spec.ts](../tests/e2e/technical-user-create.spec.ts): `technical intake without managers, validation, keyboard and promotion`
- [access.test.ts](../tests/integration/access.test.ts): `rejects managers and soldiers on the server, applies a grant and a removal to an existing connection and records both`; `keeps the technical account out of soldier records, rankings and role changes`
- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `makes the technical account read the account again before changing a role`
- [access-lifecycle.spec.ts](../tests/e2e/access-lifecycle.spec.ts): `the technical account grants and removes manager permission, ending the open connection each time`
- ספקים, שרת ופיילוט:
  - טרם נבדק: קליטת משתמש ומינוי אחראי חדש בממשק הטכני ב־staging סינתטי (#114)

### 61. כאחראי, אני רוצה לשחרר חשבון חייל שננעל; כמנהל טכני, אני רוצה לשחרר חשבון אחראי, כדי לאפשר חזרה מבוקרת למערכת. — מכוסה

- [access.test.ts](../tests/integration/access.test.ts): `blocks an existing connection, a provider sign-in and new codes until a manager releases the soldier`; `sends a locked manager to the technical account, which alone releases it`
- [access-lifecycle.spec.ts](../tests/e2e/access-lifecycle.spec.ts): `a soldier is warned, its code burns without revoking access, and a legacy lock is released by a manager`; `a locked manager is sent to the technical account, which releases it; a recovery code works once`

### 62. כמנהל טכני, אני רוצה קודי שחזור חד־פעמיים ושחזור מתועד דרך השרת, כדי לא לאבד גישה במקרה שחשבוני ננעל. — מכוסה

- [access.test.ts](../tests/integration/access.test.ts): `points a locked technical account to its recovery codes and lets each code work once`; `recovers through the server with a recorded reason, ends connections and replaces every earlier code`

### 63. כאחראי, אני רוצה לאשר דריסת נתונים בייבוא ולשחזר שדות שלא השתנו מאז, כדי לתקן טעות בלי למחוק עבודה חדשה. — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `restores unchanged imported fields while preserving later edits and reservations`; `requires a decision after a field changes and returns to the imported value`; `requires explicit balance resolution after performance, preserves its ledger and applies once in a race`
- [import-restore-population.spec.ts](../tests/e2e/import-restore-population.spec.ts): `a restore that moves the population shows its assignments per the chosen decision and flags them after confirmation`

### 64. כמנהל טכני, אני רוצה גיבוי מוצפן לחשבון Google ייעודי, חיווי כשלים ובדיקת שחזור, כדי לשמר את הנתונים במסגרת אחסון חינמי. — מכוסה

- [backup.test.ts](../tests/integration/backup.test.ts): `fails at once with one alert when the encryption key is missing`; `alerts at once when the Drive grant expired, without retrying`; `retries an upload failure after 15 minutes and an hour, then alerts once`
- [restore.test.ts](../tests/integration/restore.test.ts): `restores the newest backup into a scratch database, passes every check and leaves the live system as it was`; `is off without backups, waiting while young, ok after a pass and overdue after 100 days`
- ספקים, שרת ופיילוט:
  - נבדק: Drive אמיתי: גיבוי יומי וידני, הרשאה שבוטלה, כשל רשת, שמירת 30 (#37)
  - טרם נבדק: Drive אמיתי: שחזור מגיבוי שהורד ומחיקות אחרי שחזור, ותרגיל בשרת (#37)

### 65. כמנהל טכני, אני רוצה להחליף את כתובת המייל של החשבון שלי באימות משתי התיבות, וכשאין גישה לכתובת הנוכחית להחליף אותה דרך… — מכוסה

- [technical-email.test.ts](../tests/integration/technical-email.test.ts): `needs both: one right code and one wrong code changes nothing and says nothing about which was wrong`; `moves the account: new address verified, connections and the Google link gone, recovery codes kept, and recorded with the reason`; `moves the account with the code from the new address, ends access and replaces the recovery codes`
- [technical-email-change.spec.ts](../tests/e2e/technical-email-change.spec.ts): `the technical account moves itself to a new address with a code from each mailbox`
- ספקים, שרת ופיילוט:
  - טרם נבדק: החלפת כתובת החשבון הטכני ב־staging לחשבון הייעודי, ומשלוח קוד אמיתי לשתי הכתובות (#90)

## תרחישי קבלה

### 1. כניסה לחשבון קיים — חיילים וחשבונות — מכוסה

- [import-invitations.test.ts](../tests/integration/import-invitations.test.ts): `stores soldiers and permits sign-in before any invitation is published`
- [google-sign-in.test.ts](../tests/integration/google-sign-in.test.ts): `rejects a link inserted after the hook approved it`; `rejects a session inserted after its hook approved an epoch`; `requires a proven epoch even when no Google proof exists`; `requires a verified current email once for a legacy Google link`; `refuses direct idToken sign-in`; `lets an invited person start with Google and then use either Google or an email code`; `refuses an uninvited address and an address Google has not verified, creating nothing`
- [auth.test.ts](../tests/integration/auth.test.ts): `does not create an account or send mail for an unknown address`; `expires a code at ten minutes`; `consumes a code only once`
- ספקים, שרת ופיילוט:
  - נבדק: כניסה אמיתית ב־Google ב־staging (#25)

### 2. פרטיות והרשאות — חיילים וחשבונות — מכוסה

- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `refuses a role that the command is not for with 403, before reading the payload`; `keeps contact details out of every state but a manager's`; `keeps another soldier's exemptions and hours out of a soldier's state`; `refuses a request from another origin, with or without a session`
- [auth.test.ts](../tests/integration/auth.test.ts): `rejects forged privileges and makes retries idempotent`
- [audit-log.test.ts](../tests/integration/audit-log.test.ts): `gives soldiers no log and the technical account only operations within its authority`
- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `and sees nothing of it`
- [browser-security.spec.ts](../tests/e2e/browser-security.spec.ts): `each HTML response gets a fresh server nonce`; `the production browser boots normally and blocks injected inline script and eval`; `public health exposes readiness only`

### 3. שני אחראים ומאגר משותף — חיילים וחשבונות; סבבי אילוצים — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps responsibility a versioned screen default set by the technical account or the manager, never a permission`; `lets one of two managers decide a shared constraint, shows who decided and rejects stale edits`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `responsibility filters default per manager, hide KAMA and filter rank without granting or limiting access`
- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `shows both managers the same unit, with a draft that only managers see`

### 4. קליטה ידנית ובאקסל — חיילים וחשבונות — מכוסה

- [import-invitations.test.ts](../tests/integration/import-invitations.test.ts): `stores soldiers and permits sign-in before any invitation is published`; `requires confirmation and publishes only new accounts once across two tabs and retries`; `keeps manual intake invitations automatic and needs none for an update-only batch`
- [import-invitations.spec.ts](../tests/e2e/import-invitations.spec.ts): `imports without mail and explicitly publishes invitations after reopening the batch`
- [import-workbook.test.ts](../tests/unit/import-workbook.test.ts): `preserves identifiers and zeros, Israeli calendar dates, explicit false and integer scores`; `rejects the entire file and returns row, field and value for duplicates and malformed cells`
- [auth.test.ts](../tests/integration/auth.test.ts): `imports a whole reviewed batch, preserving reservations and blank fields with documented balances`
- [soldier-intake.test.ts](../tests/integration/soldier-intake.test.ts): `takes an opening balance as the only history`; `starts without history, rank, grace or duties`

### 5. חסד לפי זכאות — כשירות וזמינות — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `uses a calendar month for grace at month end`; `rejects a nonexistent daylight-saving time and requires disambiguation for a repeated time`
- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `ends on the last day of a shorter month, which is itself available`
- [service-lifecycle.test.ts](../tests/integration/service-lifecycle.test.ts): `grants grace only when marked eligible and leaves the balance when it ends`

### 6. אי-פעילות זמנית — כשירות וזמינות; ניקוד — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `retains an assignment and flags it when a new inactivity period conflicts`
- [inactivity-normalization.test.ts](../tests/integration/inactivity-normalization.test.ts): `cannot be given a duty that overlaps it, and can still sign in`; `is reached by a normalization like everyone else`; `keeps the normalized balance when the period ends, and is available again`
- [service-lifecycle.test.ts](../tests/integration/service-lifecycle.test.ts): `keeps access during an inactive period`
- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `limits assignment but is not an access state`

### 7. מעבר לקבע וקצונה — כשירות וזמינות — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `moves the population for an earlier officer date or a KAMA transition`; `checks populations for the entire duty`
- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `requires the duty to fit the population on both sides of a switch`
- [auth.test.ts](../tests/integration/auth.test.ts): `previews a population transition over a night duty that crosses it, keeps earlier transitions and saves one of two competing confirmations`

### 8. פטורים ותוקף כשירות — כשירות וזמינות — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `checks qualification throughout the execution`
- [auth.test.ts](../tests/integration/auth.test.ts): `requires exemption approval for a partial overlap, rejects an obsolete preview and saves one of two competing confirmations`; `rejects an obsolete exception preview and never permits it to bypass a missing qualification`; `removes an exemption without discarding approved constraints and restricts both preview and catalog edits to managers`
- [soldier-picker.test.ts](../tests/unit/soldier-picker.test.ts): `hides the soldier through the last day of the exemption, inclusive`

### 9. חפיפה ומנוחה — כשירות וזמינות; החלפות — מכוסה

- [rest-windows.test.ts](../tests/unit/rest-windows.test.ts): `allows a duty that starts the minute the other ends, and blocks one minute of overlap`; `blocks in %s mode, as it does for a consenting replacement`; `still rests at 03:30 summer time`; `is free from 04:00 summer time`
- [domain.test.ts](../tests/unit/domain.test.ts): `does not treat overlapping rest buffers alone as conflicting`

### 10. חודש לפני שחרור — שיבוץ והגרלה — מכוסה

- [planning.test.ts](../tests/integration/planning.test.ts): `excludes a rejected near-release candidate only from that duty`
- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `allows a duty that ends exactly at the boundary and blocks one that runs past it`; `starts the month before release on the same calendar day, or the last day of a shorter month`
- [domain.test.ts](../tests/unit/domain.test.ts): `allows a volunteer near release without that approval alone`

### 11. טיוטות משותפות — תורנויות ולוח; ניקוד — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `counts draft reservations and forbids an automatic zero value selection`
- [auth.test.ts](../tests/integration/auth.test.ts): `keeps drafts private, publishes explicitly and settles exactly once`; `cancels an expired draft explicitly and releases reservations without earning points or revealing it`
- [planning.test.ts](../tests/integration/planning.test.ts): `counts draft and in-execution reservations of both managers in the scheduling score`

### 12. רצועת ההגרלה המדויקת — שיבוץ והגרלה — מכוסה

- [planning.test.ts](../tests/integration/planning.test.ts): `filters blocked candidates before the minimum and keeps the exact strict band`; `draws nobody for a zero value seat and reports it as missing in a period plan`
- [domain.test.ts](../tests/unit/domain.test.ts): `filters before minimum and uses a strict upper bound`; `counts draft reservations and forbids an automatic zero value selection`
- [lottery-draw.test.ts](../tests/unit/lottery-draw.test.ts): `gives every member of the band an equal share of the random range`; `never reaches a member above the band, even with the highest value`

### 13. תכנון אצווה ומכסות — שיבוץ והגרלה — מכוסה

- [planning.test.ts](../tests/integration/planning.test.ts): `recomputes candidates and the minimum after every seat of one instance`
- [auth.test.ts](../tests/integration/auth.test.ts): `plans scarce duties before earlier common duties and the rare role first within a duty`; `plans one seat per transaction, resumes, and leaves missing seats without moving assignments`
- [planning-shortfall.spec.ts](../tests/e2e/planning-shortfall.spec.ts): `a period plan explains each shortfall, and a changed draw drops its approval form`

### 14. פרסום ועדכון — תורנויות ולוח — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps drafts private, publishes explicitly and settles exactly once`; `keeps a published duty binding until an atomic versioned update replaces its reservations`
- [mail-delivery.test.ts](../tests/integration/mail-delivery.test.ts): `sends only the newest published version of a duty`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `manager invites, assigns and publishes; soldier sees only published duties`

### 15. טופס אילוצים — סבבי אילוצים — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `rejects submissions outside the window or target period and applies whole Israel days across a clock change`; `records a no-constraints declaration directly as a completed submission and lets a later item replace it`
- [constraint-rounds.spec.ts](../tests/e2e/constraint-rounds.spec.ts): `constraint round: direct declaration, shared decision, stale approval, close and reopen`

### 16. שני אישורים לאילוצים ממתינים — סבבי אילוצים; שיבוץ — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps the global pending-review confirmation separate from each collision approval`; `requires a new collision approval for every pending version and never carries it into the approved version`
- [domain.test.ts](../tests/unit/domain.test.ts): `global pending review approval does not waive the individual collision`
- [planning.test.ts](../tests/integration/planning.test.ts): `keeps the review confirmation separate from each collision in a period plan`

### 17. גרסאות אילוץ והגשה ריקה — סבבי אילוצים — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps the approved constraint while an edit awaits review and after its rejection`; `records a no-constraints declaration directly as a completed submission and lets a later item replace it`
- [round-notices.test.ts](../tests/integration/round-notices.test.ts): `reminds only soldiers who have not submitted, and rechecks at delivery`

### 18. התנגשות חדשה בשיבוץ קיים — כשירות וזמינות; סבבי אילוצים — מכוסה

- [performer-rest.test.ts](../tests/integration/performer-rest.test.ts): `releases the original assignee`; `blocks the actual performer during rest`; `moves overlap to the actual performer`; `uses corrected times when the performer stays the same`; `reassesses reservations and impact`; `allows the original assignee manually`; `checks corrected rest in a real`
- [auth.test.ts](../tests/integration/auth.test.ts): `retains an assignment and flags it when a new inactivity period conflicts`; `requires current impact confirmation and keeps a conflicting assignment for treatment`
- [cancellation-requests.test.ts](../tests/integration/cancellation-requests.test.ts): `submitting changes neither the seat, the calendar nor reserved points, and is visible only to its owner and managers`

### 19. קטלוג ומופע — תורנויות ולוח; ניקוד — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `applies updated catalog prices and composition only through an explicit proposal`; `edits a draft and explicitly applies catalog changes without publishing or double reserving points`
- [instance-composition.test.ts](../tests/integration/instance-composition.test.ts): `edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone`

### 20. משך, משתתפים ותוספות — ניקוד — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `prices 36 actual hours at six points`; `counts an overnight window once and applies its minimum`; `splits actual daily time and never duplicates a fixed extra`; `rounds only after all components have been added`
- [execution.test.ts](../tests/unit/execution.test.ts): `gives each performer the daily base in proportion to actual time, rounded once at the end`

### 21. תוספת הזנקה אישית — ניקוד — מכוסה

- [instance-composition.test.ts](../tests/integration/instance-composition.test.ts): `saves a suggested call-up amount on the type and instance without ever applying it by itself`
- [execution-periods.test.ts](../tests/integration/execution-periods.test.ts): `requires an explicit fixed-price and bonus split, then credits each performer once`
- [auth.test.ts](../tests/integration/auth.test.ts): `keeps the original until consent, moves the full value without a score check and completes once when candidates race`
- [swaps.test.ts](../tests/integration/swaps.test.ts): `swaps both seats together with their full value, without a score check, and completes once when two acceptances race`

### 22. סיום וביצוע פעם אחת — ניקוד — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `keeps drafts private, publishes explicitly and settles exactly once`; `cancels an expired draft explicitly and releases reservations without earning points or revealing it`; `cancels a future published duty atomically, closes proposals and sends one cancellation per affected soldier`

### 23. נרמול ורצפת אפס — ניקוד — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `rounds a 20% reduction of 51 to 41 and clamps at zero`
- [auth.test.ts](../tests/integration/auth.test.ts): `settles overdue work before normalization and serializes a competing worker without double credit`; `rejects a normalization preview after a concurrent balance change without partially applying it`

### 24. תיקון עבר לפני נרמול — ניקוד — מכוסה

- [performer-rest.test.ts](../tests/integration/performer-rest.test.ts): `releases the original assignee`; `blocks the actual performer during rest`; `moves overlap to the actual performer`; `uses corrected times when the performer stays the same`; `reassesses reservations and impact`; `allows the original assignee manually`; `checks corrected rest in a real`
- [auth.test.ts](../tests/integration/auth.test.ts): `records the history but leaves the balance for a manager decision after a normalization, even when the corrected end moves past it`; `previews and applies a value correction once, keeping the draw value and hiding reasons from soldiers`; `shows the decision in the handling center, keeps the balance once and lets a later correction weigh only the new difference`
- [domain.test.ts](../tests/unit/domain.test.ts): `waits for a manager after a barrier or while a decision is open`

### 25. החלפה בהסכמה לפני התחלה — החלפות ובקשות שינוי — מכוסה

- [expired-transfer.test.ts](../tests/integration/expired-transfer.test.ts): `expires acceptance at or after the execution end`; `routes consent one millisecond before the end`; `expires a manager`; `rejects a new offer exactly at its execution end`; `expires at the performer's own end`; `when the target's period ends first`; `closes only an expired target`
- [auth.test.ts](../tests/integration/auth.test.ts): `keeps the original until consent, moves the full value without a score check and completes once when candidates race`
- [security-mail.test.ts](../tests/integration/security-mail.test.ts): `cancels old offers when completed but retains valid completion messages for both parties`
- [swaps.test.ts](../tests/integration/swaps.test.ts): `swaps both seats together with their full value, without a score check, and completes once when two acceptances race`
- [first-duty.spec.ts](../tests/e2e/first-duty.spec.ts): `a soldier offers a published duty to several replacements and the first consent transfers it`

### 26. החלפה אטומית ובדיקה חוזרת — החלפות ובקשות שינוי — מכוסה

- [expired-transfer.test.ts](../tests/integration/expired-transfer.test.ts): `expires acceptance at or after the execution end`; `routes consent one millisecond before the end`; `expires a manager`; `rejects a new offer exactly at its execution end`; `expires at the performer's own end`; `when the target's period ends first`; `closes only an expired target`
- [auth.test.ts](../tests/integration/auth.test.ts): `rejects an unsuitable candidate without revealing why and rechecks at acceptance`
- [security-mail.test.ts](../tests/integration/security-mail.test.ts): `retains a swap offer while another seat for that recipient is pending, then cancels it`
- [swaps.test.ts](../tests/integration/swaps.test.ts): `rechecks both sides at acceptance and keeps both seats when one side no longer fits, without revealing the offerer's reason`; `closes the entries of seats that moved or of a duty that changed, and competing moves of a seat end in one outcome`

### 27. החלפה במהלך ביצוע — החלפות; ניקוד — מכוסה

- [execution-periods.test.ts](../tests/integration/execution-periods.test.ts): `splits the daily base by actual time, credits the ended part once and keeps the rest stored`; `requires an explicit fixed-price and bonus split, then credits each performer once`; `goes to a manager, who sets the handover, and the original seat binds until then`
- [execution-periods.spec.ts](../tests/e2e/execution-periods.spec.ts): `a manager records who covered a started seat, approves a handover, and soldiers see each period`

### 28. ביטול ללא מחליף — החלפות ובקשות שינוי — מכוסה

- [cancellation-requests.test.ts](../tests/integration/cancellation-requests.test.ts): `submitting changes neither the seat, the calendar nor reserved points, and is visible only to its owner and managers`; `is decided once when two managers race, keeps the seat on rejection and hides the decider from the soldier`; `completes a removal only through update and publish, frees the seat and its reserved points`
- [notifications.test.ts](../tests/integration/notifications.test.ts): `hides and reads only the recipient's copy without changing the duty, assignment or log`

### 29. שחרור ומחיקה — חיילים וחשבונות; תורנויות — מכוסה

- [service-lifecycle.test.ts](../tests/integration/service-lifecycle.test.ts): `announces a departure once to each manager across repeated runs, races and downtime, without deleting`; `refuses every request from the local midnight after the release day, before any worker run`
- [security-erasure.test.ts](../tests/integration/security-erasure.test.ts): `erases an opaque result by its explicit subject and keeps its replay key and fingerprint`
- [soldier-deletion.test.ts](../tests/integration/soldier-deletion.test.ts): `vacates future seats, keeps seats of a duty that started, and warns the managers`; `removes contact details and conditions, and keeps name, number and history`

### 30. תצוגת חייל — תורנויות ולוח; ניקוד — מכוסה

- [calendar-filters.test.ts](../tests/unit/calendar-filters.test.ts): `counts exactly the selected month and keeps cancellations only in the regular view`
- [calendar-cards.spec.ts](../tests/e2e/calendar-cards.spec.ts): `soldier summary cards filter, restore and focus the score at width`
- [fairness-table.test.ts](../tests/unit/fairness-table.test.ts): `ranks soldiers by balance, with equal balances sharing a rank`

### 31. תזמון התראות והעדפות — הודעות ותיעוד — מכוסה

- [duty-reminders.test.ts](../tests/integration/duty-reminders.test.ts): `sends the default 24 and 2 hour reminders once on both channels and nothing after the start`; `cancels queued reminders of an old start or a cancelled duty before delivery`
- [round-notices.test.ts](../tests/integration/round-notices.test.ts): `opens once for soldiers serving in the target period, by their preferences`; `reminds only soldiers who have not submitted, and rechecks at delivery`
- [notifications.test.ts](../tests/integration/notifications.test.ts): `rechecks type and timing preferences after scheduling and before delivery`
- [mail-delivery.test.ts](../tests/integration/mail-delivery.test.ts): `sends only the newest published version of a duty`
- ספקים, שרת ופיילוט:
  - נבדק: Brevo אמיתי ב־staging: קוד, פרסום, כשל וחזרה (#25)

### 32. קריאה והסתרת הודעה — הודעות ותיעוד — מכוסה

- [notifications.test.ts](../tests/integration/notifications.test.ts): `keeps the site notification when email is off and never treats delivery as reading`; `hides and reads only the recipient's copy without changing the duty, assignment or log`
- [notification-preferences.test.ts](../tests/unit/notification-preferences.test.ts): `counts only unread copies that were not hidden`

### 33. שמירה מקבילה — כל המודולים המשנים נתונים — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `lets only one of two managers occupy the last place`; `settles overdue work before normalization and serializes a competing worker without double credit`; `tracks per-field ABA changes and rejects a stale import without changing any row`
- [planning.test.ts](../tests/integration/planning.test.ts): `lets two managers plan overlapping duties at once without booking one soldier twice`; `accepts only one of two managers stepping the same run from the same version`
- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `makes the second of two managers read again before saving a soldier`; `makes a manager read the duty again after another manager changed it`
- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `in a second tab that the form changed, and shows what was saved`

### 34. התאוששות משליחה ומגיבוי — הודעות ותיעוד; תפעול — מכוסה

- [deployment-preflight.test.ts](../tests/unit/deployment-preflight.test.ts): `rejects an existing legacy database before building`; `continues a fresh deployment`; `rejects missing runtime or operations env files`; `rejects invalid configuration for each service`; `checks all three service configurations`
- [supply-chain.test.ts](../tests/unit/supply-chain.test.ts): `blocks high and critical findings`; `requires actual approval`; `fails closed for empty`
- [repository-rules.test.ts](../tests/unit/repository-rules.test.ts): `verifies effective GitHub rules`; `pins external Docker images`
- [braces-depth.test.ts](../tests/unit/braces-depth.test.ts): `rejects the published stack-exhaustion input`
- [database-permissions.test.ts](../tests/integration/database-permissions.test.ts): `verifies real non-superuser logins`; `lets pg-boss initialize and work only`
- [auth.test.ts](../tests/integration/auth.test.ts): `shows worker backup presence to the site`
- [mail-delivery.test.ts](../tests/integration/mail-delivery.test.ts): `retries with growing delays, then fails visibly while the site notice stays`
- [backup.test.ts](../tests/integration/backup.test.ts): `produces a verified copy that is only ciphertext, decrypts and restores the data`
- [restore.test.ts](../tests/integration/restore.test.ts): `restores the newest backup into a scratch database, passes every check and leaves the live system as it was`
- ספקים, שרת ופיילוט:
  - נבדק: Brevo אמיתי ב־staging: קוד, פרסום, כשל וחזרה (#25)
  - טרם נבדק: Drive אמיתי: שחזור מגיבוי שהורד ומחיקות אחרי שחזור, ותרגיל בשרת (#37)

### 35. עברית ושימוש מעשי — כלל המסכים — מכוסה

- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `is Hebrew, named and fits a phone`; `without a mouse`; `when the state cannot load, and recovers on retry`
- [soldier-picker.spec.ts](../tests/e2e/soldier-picker.spec.ts): `the picker works with the keyboard and on a phone without sideways scrolling`
- [domain.test.ts](../tests/unit/domain.test.ts): `prices a daytime duty on a clock-change date outside the changed hour`; `starts a surcharge window at the moment summer time skips its start time`
- [execution.test.ts](../tests/unit/execution.test.ts): `measures real hours across the end of summer time in Israel`
- [calendar.test.ts](../tests/unit/calendar.test.ts): `uses local days across DST changes while the duration stays actual time`

### 36. דרגה והתאמה — חיילים וחשבונות; כשירות ושיבוץ — מכוסה

- [rank-conditions.test.ts](../tests/unit/rank-conditions.test.ts): `blocks another rank in an automatic draw, whatever the score`; `blocks a missing rank as missing information`; `does not block a soldier with no rank when the duty asks for none`
- [auth.test.ts](../tests/integration/auth.test.ts): `snapshots duty and role rank requirements and checks the confirmed rank at the start`
- [soldier-filters.test.ts](../tests/unit/soldier-filters.test.ts): `filters an exact rank without treating another track as equivalent`

### 37. דרגה בתחילת התורנות וחריגה — כשירות — מכוסה

- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `checks rank at the start only`
- [auth.test.ts](../tests/integration/auth.test.ts): `snapshots duty and role rank requirements and checks the confirmed rank at the start`; `persists a justified rank exception through another seat assignment and publication`
- [soldier-picker.test.ts](../tests/unit/soldier-picker.test.ts): `uses the rank in force on the Israel date the range starts`; `ignores a later promotion inside the range`

### 38. פז״ם ואישור דרגה — חיילים וחשבונות — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `creates one tenure reminder without promoting and requires an explicit versioned decision`; `recalculates open reminders on a rule change and never overwrites a manually approved future rank`; `shows missing enlistment data and permits a sourced personal deadline without guessing equivalence`

### 39. גבולות שירות וזמן — כשירות וחשבונות — מכוסה

- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `allows access through the last day and refuses it from local midnight`; `uses the winter offset for a release in winter`; `allows a duty that ends exactly at the boundary and blocks one that runs past it`
- [service-lifecycle.test.ts](../tests/integration/service-lifecycle.test.ts): `applies the boundary at 00:00 Israel time with an explicit clock`; `refuses every request from the local midnight after the release day, before any worker run`
- [domain.test.ts](../tests/unit/domain.test.ts): `expires access after the local release day, independently of a worker`; `rejects a nonexistent daylight-saving time and requires disambiguation for a repeated time`
- [calendar.test.ts](../tests/unit/calendar.test.ts): `uses local days across DST changes while the duration stays actual time`

### 40. סדר בחירה וריצה חוזרת — שיבוץ — מכוסה

- [lottery-draw.test.ts](../tests/unit/lottery-draw.test.ts): `gives every member of the band an equal share of the random range`; `keeps the band in id order whatever the order or the scores of the input`
- [planning.test.ts](../tests/integration/planning.test.ts): `orders equally scarce duties by nearer start and then a fixed id`
- [auth.test.ts](../tests/integration/auth.test.ts): `plans scarce duties before earlier common duties and the rare role first within a duty`; `plans one seat per transaction, resumes, and leaves missing seats without moving assignments`

### 41. שינוי כללים ואילוץ מאושר — לוח ואילוצים — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `applies updated catalog prices and composition only through an explicit proposal`; `requires a new collision approval for every pending version and never carries it into the approved version`; `requires current impact confirmation and keeps a conflicting assignment for treatment`

### 42. שלמים ואחוזים — ניקוד — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `rounds only after all components have been added`; `rounds a 20% reduction of 51 to 41 and clamps at zero`; `shares rank at equal scores and only credits published duties`
- [planning.test.ts](../tests/integration/planning.test.ts): `draws nobody for a zero value seat and reports it as missing in a period plan`

### 43. ניקוד שמור ומסלולי תיקון — ניקוד — מכוסה

- [auth.test.ts](../tests/integration/auth.test.ts): `records the history but leaves the balance for a manager decision after a normalization, even when the corrected end moves past it`; `applies a correction to zero with a floor, then treats that clamp as a barrier`; `settles overdue work before normalization and serializes a competing worker without double credit`
- [domain.test.ts](../tests/unit/domain.test.ts): `orders barriers by effective time, not by recording time`; `names every operation that changes the meaning of a correction`

### 44. העברת תוספת ורגע קבלה — החלפות — מכוסה

- [expired-transfer.test.ts](../tests/integration/expired-transfer.test.ts): `expires acceptance at or after the execution end`; `routes consent one millisecond before the end`; `expires a manager`; `rejects a new offer exactly at its execution end`; `expires at the performer's own end`; `when the target's period ends first`; `closes only an expired target`
- [auth.test.ts](../tests/integration/auth.test.ts): `keeps the original until consent, moves the full value without a score check and completes once when candidates race`; `hands an acceptance after the start to a manager without moving the seat`
- [swaps.test.ts](../tests/integration/swaps.test.ts): `sends a swap whose duty started to a manager, who needs a handover time to approve it and may reject it with a visible reason`
- [execution-periods.test.ts](../tests/integration/execution-periods.test.ts): `swaps a started seat at a handover for a whole seat that has not started`; `goes to a manager, who sets the handover, and the original seat binds until then`

### 45. מנהל טכני, קליטת משתמש והרשאות — הרשאות; מקביליות; עברית ונייד — מכוסה

- [technical-user-create.test.ts](../tests/integration/technical-user-create.test.ts): `creates an invited identity with zero balance without any manager`; `grants the existing manager role, revokes old access`; `refuses soldier and manager actors before validating payload`; `rejects invalid or out-of-scope identity fields`; `rejects duplicate identity and normalized email`; `replays one idempotent result`; `serializes competing creations`; `rolls back person, contact, balance and account`
- [technical-user-create.spec.ts](../tests/e2e/technical-user-create.spec.ts): `technical intake without managers, validation, keyboard and promotion`
- [access.test.ts](../tests/integration/access.test.ts): `rejects managers and soldiers on the server, applies a grant and a removal to an existing connection and records both`; `keeps the technical account out of soldier records, rankings and role changes`
- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `makes the technical account read the account again before changing a role`; `gives the technical account accounts and operations but no soldiers or scores`
- [manager-exclusion.test.ts](../tests/integration/manager-exclusion.test.ts): `changes the role only for the technical account, and only from a current version`
- [access-lifecycle.spec.ts](../tests/e2e/access-lifecycle.spec.ts): `the technical account grants and removes manager permission, ending the open connection each time`
- ספקים, שרת ופיילוט:
  - טרם נבדק: קליטת משתמש ומינוי אחראי חדש בממשק הטכני ב־staging סינתטי (#114)

### 46. קודים, נעילה ושחזור — חשבונות — מכוסה

- [access.test.ts](../tests/integration/access.test.ts): `warns after the third and fourth failure, keeps counting across a resend and burns on the fifth failure without locking`; `blocks an existing connection, a provider sign-in and new codes until a manager releases the soldier`; `sends a locked manager to the technical account, which alone releases it`; `keeps a soldier seven days and managers and the technical account 24 hours, without extending on use`
- [auth.test.ts](../tests/integration/auth.test.ts): `expires a code at ten minutes`
- [access-lifecycle.spec.ts](../tests/e2e/access-lifecycle.spec.ts): `a soldier is warned, its code burns without revoking access, and a legacy lock is released by a manager`

### 47. דחיית קובץ, דריסה ושחזור — ייבוא — מכוסה

- [import-invitations.test.ts](../tests/integration/import-invitations.test.ts): `does not revive invitations for a fully restored intake`; `publishes only surviving rows after a partial restore`; `removes pending published invitations when the intake is restored`
- [auth.test.ts](../tests/integration/auth.test.ts): `rejects all rows on duplicate, conflicting identities, incomplete ranks or deleted people`; `restores unchanged imported fields while preserving later edits and reservations`; `cancels a new soldier without activity: removes every trace, frees the number and keeps the row`; `shows each kind of activity as a conflict, including an edit that was reverted, and closes the batch only when every row is handled`
- [bounded-body.test.ts](../tests/unit/bounded-body.test.ts): `counts streamed action bodies despite a missing or false length`
- [workbook-archive.test.ts](../tests/unit/workbook-archive.test.ts): `counts actual bytes even when the directory advertises one byte`
- [workbook-process.test.ts](../tests/unit/workbook-process.test.ts): `contains a parser process crash`; `kills a parser that exceeds the actual resident-memory limit`; `kills a stalled parser at the deadline`
- [security-erasure.test.ts](../tests/integration/security-erasure.test.ts): `completes the subject links of an import preview after the new soldier is created, then erases its replay content`
- [import-restore-creations.spec.ts](../tests/e2e/import-restore-creations.spec.ts): `cancels a new soldier without activity and waits for a decision on one who signed in`

### 48. מידע רגיש ומחיקה בזמן ביצוע — פרטיות — מכוסה

- [soldier-deletion.test.ts](../tests/integration/soldier-deletion.test.ts): `removes contact details and conditions, and keeps name, number and history`; `is removed, while the event and the history stay`
- [security-erasure.test.ts](../tests/integration/security-erasure.test.ts): `scrubs historical contact-only results before erasing contact revisions and conservatively scrubs unlinked legacy results`; `refuses a claimed copy when deletion commits before dispatch begins`; `serializes erasure with an already-started dispatch and removes the local copy after delivery`; `detects deleted subjects and counterpart mail in a restored copy, and applies the same erasure rules`
- [deletion-in-execution.test.ts](../tests/integration/deletion-in-execution.test.ts): `stays on the deleted soldier, is not credited by itself, and is urgent for the managers by site and email`; `is decided by recording the part performed, which is credited once, and a replacement for the rest`; `never credits twice when the worker and the manager's decision race`
- [restore.test.ts](../tests/integration/restore.test.ts): `are applied again from the log before anything of the restored copy is open, and no deleted data returns`
- [deletion-in-execution.spec.ts](../tests/e2e/deletion-in-execution.spec.ts): `the manager finds the urgent item, is offered the part up to the deletion, records a replacement, and the item goes`

### 49. מכסת מייל, העדפות והתאוששות — הודעות — מכוסה

- [security-mail.test.ts](../tests/integration/security-mail.test.ts): `saves proposals and site notices beyond 30 recipients, never refunds withdrawal, and shares the budget with swaps`; `reserves the final recipient only once while both competing proposals remain saved`; `keeps old manager notices but creates none after demotion or release`; `rechecks a historical pending offer even when it was closed without the command helper`
- [otp-protection.test.ts](../tests/integration/otp-protection.test.ts): `limits the whole unit to 200 issued login codes`; `resets failures on success while retaining the ten-code issuance budget`; `allocates a pair atomically at both account and unit boundaries`; `uses the configured quota-day boundary`; `lets only one competing pair take the final two unit slots`; `charges actual retry attempts atomically`; `retains issuance budgets when a new service connection replaces the old one`
- [mail-delivery.test.ts](../tests/integration/mail-delivery.test.ts): `sends 290 of three waves of 120, keeps the rest for the next day and never counts 360`; `holds business mail at 290 and still sends a sign-in code from the reserve`; `never sends an expired code, and reports one that expired waiting for quota`; `retries with growing delays, then fails visibly while the site notice stays`; `stops retrying when the message is no longer relevant`
- [notifications.test.ts](../tests/integration/notifications.test.ts): `applies changed unit defaults to inheriting accounts without overriding a saved personal form`
- [mail-delivery.test.ts](../tests/unit/mail-delivery.test.ts): `retries five times in total with growing delays inside 24 hours`
- [auth.test.ts](../tests/integration/auth.test.ts): `encrypts codes and prioritizes them over reminders`
- [secrets.test.ts](../tests/unit/secrets.test.ts): `authenticates purpose and record`; `rejects short tags, noncanonical encoding`; `rejects changed authenticated ciphertext`
- [security-conversion.test.ts](../tests/integration/security-conversion.test.ts): `converts existing mail and Calendar atomically`; `rolls back every conversion if one old secret is corrupt`
- [mail-operations.spec.ts](../tests/e2e/mail-operations.spec.ts): `technical admin sees mail failures, the pause and the quota without personal data`
- ספקים, שרת ופיילוט:
  - נבדק: Brevo אמיתי ב־staging: קוד, פרסום, כשל וחזרה (#25)

### 50. גיבוי Google Drive — תפעול — מכוסה

- [backup.test.ts](../tests/integration/backup.test.ts): `keeps the newest 30 and never touches files the application did not create`; `frees the oldest copies for a new one but keeps the newest verified copy`; `fails without deleting anything when even the older copies would not make room`; `alerts at once when the Drive grant expired, without retrying`; `fails at once with one alert when the encryption key is missing`; `retries an upload failure after 15 minutes and an hour, then alerts once`
- [restore.test.ts](../tests/integration/restore.test.ts): `restores the newest backup into a scratch database, passes every check and leaves the live system as it was`
- ספקים, שרת ופיילוט:
  - נבדק: Drive אמיתי: גיבוי יומי וידני, הרשאה שבוטלה, כשל רשת, שמירת 30 (#37)
  - טרם נבדק: Drive אמיתי: שחזור מגיבוי שהורד ומחיקות אחרי שחזור, ותרגיל בשרת (#37)

### 51. דוגמאות היחידה ותוספות זמן — תורנויות וכשירות — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `counts an overnight window once and applies its minimum`; `splits actual daily time and never duplicates a fixed extra`
- [instance-composition.test.ts](../tests/integration/instance-composition.test.ts): `edits a draft's roles and daily pricing, prices each seat once and leaves the catalog and other instances alone`
- [eligibility-conditions.test.ts](../tests/unit/eligibility-conditions.test.ts): `checks the whole execution, not only its start`
- [rest-windows.test.ts](../tests/unit/rest-windows.test.ts): `counts it from the end of the soldier's period, not of the whole duty`

### 52. כמה מקומות באותו מופע — שיבוץ — מכוסה

- [planning.test.ts](../tests/integration/planning.test.ts): `recomputes candidates and the minimum after every seat of one instance`
- [auth.test.ts](../tests/integration/auth.test.ts): `plans one seat per transaction, resumes, and leaves missing seats without moving assignments`

### 53. חלונות תוספות יומיים — ניקוד — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `counts an overnight window once and applies its minimum`; `starts a surcharge window at the moment summer time skips its start time`; `gives a surcharge window its widest meaning when winter time repeats its start time`
- [weekend-surcharge.test.ts](../tests/unit/weekend-surcharge.test.ts): `counts Friday and Saturday as two windows, and adds their parts before one rounding`; `judges each day by its own hours against the minimum`
- [execution.test.ts](../tests/unit/execution.test.ts): `tests each time extra against the performer's own overlap with its daily window`

### 54. ביצוע חלקי ותוספות — ניקוד — מכוסה

- [execution-periods.test.ts](../tests/integration/execution-periods.test.ts): `splits the daily base by actual time, credits the ended part once and keeps the rest stored`; `requires an explicit fixed-price and bonus split, then credits each performer once`; `adds a fixed bonus to daily time without intermediate rounding and rejects a stale split`; `corrects credited fixed shares by the difference and keeps the seat's original total`
- [execution.test.ts](../tests/unit/execution.test.ts): `tests each time extra against the performer's own overlap with its daily window`

### 55. התנדבות סמוך לשחרור — החלפות — מכוסה

- [domain.test.ts](../tests/unit/domain.test.ts): `allows a volunteer near release without that approval alone`; `lets a consenting volunteer bypass pending constraints but not approved ones or release`
- [auth.test.ts](../tests/integration/auth.test.ts): `lets a volunteer near release take over automatically but never past the release boundary`; `hands an acceptance after the start to a manager without moving the seat`

### 56. איפוס טעויות — חשבונות — מכוסה

- [access.test.ts](../tests/integration/access.test.ts): `keeps failures on resend and refuses an unproven provider session instead of resetting them`
- [google-sign-in.test.ts](../tests/integration/google-sign-in.test.ts): `resets earlier code failures on a Google success, and a lock blocks Google and its sessions`
- [auth.test.ts](../tests/integration/auth.test.ts): `retains failures on resend, resets on success, and consumes a code only once`

### 57. אחראי תורנויות אינו משובץ — הרשאות; שיבוץ; אילוצים; החלפות — מכוסה

- [manager-exclusion.test.ts](../tests/integration/manager-exclusion.test.ts): `refuses a manual assignment with the reason, directly through the API`; `never draws a manager, and leaves one out of the draw's picture`; `takes no constraints from a manager and sends no round notice to one`; `marks the soldier's reservations, keeps them in force and tells the managers`; `clears the marks when the role is removed and opens one decision about the balance`; `never leaves an unmarked reservation of a manager, whichever comes first`
- [manager-exclusion.test.ts](../tests/unit/manager-exclusion.test.ts): `is not lifted by a specific approval`
- [manager-exclusion.spec.ts](../tests/e2e/manager-exclusion.spec.ts): `managers are outside the ranking, the pickers and a soldier's lists, and the calendar shows what fits each`

### 58. בחירת חייל לשיבוץ — שיבוץ; כשירות; עברית ושימוש מעשי — מכוסה

- [soldier-picker.test.ts](../tests/unit/soldier-picker.test.ts): `matches a name part and a personal number part as typed`; `hides a soldier whose exemption covers only part of the range`; `hides a soldier whose qualification expires, or starts, inside the range`; `uses Israel days on the night the clocks go back`; `shows a value added to a catalog with no change in code`
- [soldier-picker.spec.ts](../tests/e2e/soldier-picker.spec.ts): `the picker opens filtered by the duty and the role, and finds by name and personal number`; `the server still checks a soldier the filters had hidden`; `the picker works with the keyboard and on a phone without sideways scrolling`

### 59. תורנויות ביומן Google — הודעות והעדפות; חשבונות — מכוסה

- [calendar-lifecycle.test.ts](../tests/integration/calendar-lifecycle.test.ts): `email replacement erases the old grant and pending events`; `adopts the verified app-created calendar`; `requires the explicit operator acknowledgement`; `does not apply an old recovery after a new grant`
- [calendar-sync.test.ts](../tests/integration/calendar-sync.test.ts): `creates the calendar once, and one event per published seat`; `has nothing for a soldier who never granted the permission, a duty manager, or a draft`; `updates the event when the duty is updated and published, and removes it when the duty is cancelled`; `moves the event with the seat when the duty is transferred by consent`; `swaps the events of two soldiers when their duties are swapped by consent`; `gives each performer of a seat split into execution periods the event of their own period`; `follows the calendar slots of the reminders`; `removes the events of a soldier who was made a duty manager`; `stops adding and updating as soon as the switch is off`; `removes only the future events on request`; `refuses the switch and the button for anyone without a usable permission`; `shows the four states of the switch`; `never brings back an event the soldier deleted, but creates one for a new seat`; `starts over in a new calendar when the calendar itself was deleted`; `stops without an error`; `treats an access error of the Calendar API like a lost permission`; `keeps only the permission and a sealed token, never a plain one`; `waits after a temporary failure with growing delays`; `never asks Google sooner than it said`; `recovers an event that Google created before the run could record it`; `creates each event once when two runs overlap`; `does not run while a restore keeps the system closed`; `removes the permission, the token and the event records at once`; `deletes a soldier even when Google cannot be reached`; `does not make a link for an account that is already deleted`; `pauses an uncertain calendar creation`; `tracks uncertain event creation`; `does not update after the switch was turned off`; `uses the provider etag`; `does not revoke a fresh grant`; `retains a user-deletion tombstone`
- [calendar-grant.test.ts](../tests/integration/calendar-grant.test.ts): `asks only for the one calendar permission and for offline access`; `records the permission of a first sign-in with a sealed token`; `lets a person who declines the permission sign in`; `keeps the held token when a later sign-in`; `turns the link to`; `makes no link for a duty manager who signs in with Google`; `lets the button of the settings screen ask Google to show the consent again`
- [notifications.test.ts](../tests/integration/notifications.test.ts): `sends a duty reminder email only when the email slot of that reminder is marked`; `reads a form saved with plain hours and one reminder switch`
- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `classifies every command the server knows, and no other`
- [calendar-sync.test.ts](../tests/unit/calendar-sync.test.ts): `keeps the real instants in Israel time across midnight, several days and a clock change`; `is blocked without a Google link`; `holds the name, location, instructions`; `adds a popup for every reminder marked for the calendar`; `derives one stable id`; `makes one event per duty, whichever rows the seat has`; `never brings back an event the soldier deleted, and only a new seat gets a new one`; `waits a minute after the first failure`
- [notification-preferences.test.ts](../tests/unit/notification-preferences.test.ts): `validates type, timing, channels and frequency on the server`; `converts a form saved with plain hours and one reminder email switch`; `never withholds security email and checks each business type and reminder time`
- [calendar-settings.spec.ts](../tests/e2e/calendar-settings.spec.ts): `a person who signed in with a code only sees the switch blocked, with the reason`; `a person who did not grant the permission sees a button that goes to Google`; `a person with the permission turns the sync off and on`; `the calendar switch and the reminder slots fit a phone`
- [notification-preferences.spec.ts](../tests/e2e/notification-preferences.spec.ts): `unit defaults reach soldiers without personal preferences`

### 60. יומן מחיקות עצמאי ושחזור — גיבוי ושחזור; פרטיות; מקביליות — מכוסה

- [security-erasure.test.ts](../tests/integration/security-erasure.test.ts): `expires content at 30 days and never reexecutes an old key, including conflict checks`; `prunes content at the exact 30-day boundary while retaining newer results`
- [deletion-log.test.ts](../tests/integration/deletion-log.test.ts): `never lowers the database witness when both signed copies are rolled back`; `does not repair a torn signed entry that the database already witnessed`; `queues a deletion in its own commit and appends it once, with ids and a time only`; `leaves nothing in the log for a deletion that rolled back`; `appends each deletion once and in order when workers drain at the same time`; `is not appended to when a line was changed`; `is released only by a person with a reason and the exact words, and the managers are told`
- [deletion-log.test.ts](../tests/unit/deletion-log.test.ts): `keeps only what is personal-data free: ids, a time and hashes`

### 61. מייל מרוכז לכמה שיבוצים — הודעות והעדפות; תורנויות ולוח; מקביליות — מכוסה

- [publish-drafts.test.ts](../tests/integration/publish-drafts.test.ts): `publishes the ready drafts together and leaves a blocked draft a draft`; `rejects the whole action when a selected draft changed since the preview, by either manager`; `does not publish or send twice when the same request is sent again`; `lets only one of two managers publish the same drafts, and tells nobody twice`
- [publish-drafts.spec.ts](../tests/e2e/publish-drafts.spec.ts): `a manager picks a range, previews it, and publishes the ready drafts while a blocked one stays a draft`
- [assignment-digest.test.ts](../tests/integration/assignment-digest.test.ts): `gathers publications of a window into one notice and one mail, sent when the window closes`; `does not extend the window: an event after ten minutes opens a new window and a second mail`; `sends a duty starting within two hours at once and apart, and keeps the rest in the window`; `leaves out a duty published and cancelled in the same window, and sends nothing when none is left`; `shows a read or hidden notice again, unread, when an event joins its window`; `does not mail a switched-off type, and still writes the notice`; `does not send a window twice when two workers claim at once`
- [assignment-digest.test.ts](../tests/unit/assignment-digest.test.ts): `sends a duty starting within two hours at once, the boundary included`; `follows the clock change: a night that loses an hour still reads 22:00 to 06:00`
- [assignment-digest.spec.ts](../tests/e2e/assignment-digest.spec.ts): `several publications reach the soldier as one notice that counts them and leads to all assignments`
- [my-assignments.test.ts](../tests/integration/my-assignments.test.ts): `records batch publication and highlights every duty in the recipient's mail`; `reads without waiting for a unit-wide writer`; `serializes two tabs on their account`; `does not hold another account behind a locked account`; `records publication, advances the cursor once, and keeps later events for another window`; `records changed duty details and removal, then clears the cancelled section on revisit`; `highlights mail items only for their recipient and blocks technical and manager without history`
- [my-assignments.test.ts](../tests/unit/my-assignments.test.ts): `uses Israel dates across midnight and distinguishes the repeated autumn hour`
- [my-assignments.spec.ts](../tests/e2e/my-assignments.spec.ts): `personal assignments on desktop and mobile, private mail highlight and visit markers`

### 62. תנאי עם כל המגדרים — כשירות; שיבוץ — מכוסה

- [all-genders.test.ts](../tests/integration/all-genders.test.ts): `stores every gender as an empty list in the type, its roles and the duty made from it`; `is assignable by hand, and a draw offers them, when every gender is allowed`; `is still blocked as missing information when two of three genders are allowed`; `is not blocked by a full list that was saved before the fix`; `clears the gender mark only where no gender condition is left, and logs it as a system action`
- [eligibility-conditions.test.ts](../tests/unit/eligibility-conditions.test.ts): `reads an empty, missing or full list as no condition`; `does not block a soldier without a gender, in every mode`

### 63. שחזור מבודד ותרגיל רבעוני — גיבוי ושחזור; פרטיות; הרשאות; מקביליות — מכוסה

- [security-conversion.test.ts](../tests/integration/security-conversion.test.ts): `requires stopped-service acknowledgement and a recent verified backup whose stored hash still matches`; `blocks restore when both copies contain a deletion with recomputed hashes but no valid signature`; `refuses unsigned logs during restore`; `refuses unequal old copies`; `refuses a database head mismatch`
- [secrets.test.ts](../tests/unit/secrets.test.ts): `verifies with public keys only`; `rejects an attacker who changes a deletion and recomputes every hash`; `rejects unsigned old lines`
- [security-erasure.test.ts](../tests/integration/security-erasure.test.ts): `detects expired unpruned results and false tombstones in restore checks even without a deleted soldier`
- [restore.test.ts](../tests/integration/restore.test.ts): `restores the newest backup into a scratch database, passes every check and leaves the live system as it was`; `refuses a backup written by a newer version, and runs no other check on it`; `stays closed when a check fails, and cannot be promoted`; `refuses while anyone is connected to either database, and changes nothing`; `reminds the technical account once when overdue, and again after 30 days`
- [restore.test.ts](../tests/unit/restore.test.ts): `passes only when every check passed and the deletion log was applied`
- [backups.spec.ts](../tests/e2e/backups.spec.ts): `the restore drill row shows how long ago a backup was restored and checked end to end`
- ספקים, שרת ופיילוט:
  - טרם נבדק: Drive אמיתי: שחזור מגיבוי שהורד ומחיקות אחרי שחזור, ותרגיל בשרת (#37)

### 64. החלפת כתובת המנהל הטכני — כניסה; הרשאות; מקביליות; עברית ונייד — מכוסה

- [technical-email.test.ts](../tests/integration/technical-email.test.ts): `sends one code to each mailbox, stores only digests and changes nothing yet`; `refuses the current address and an address of another account`; `allows one request a minute and lets a new one cancel the earlier one and its mail`; `serializes two requests made together: one succeeds, the other waits a minute`; `needs both: one right code and one wrong code changes nothing and says nothing about which was wrong`; `cancels the request after five mistakes, even for the right codes, and the unsent codes with it`; `does not accept an expired request`; `does not accept a request opened before the account's access changed`; `moves the account: new address verified, connections and the Google link gone, recovery codes kept, and recorded with the reason`; `signs in with a code at the new address only`; `lets only one of two confirmations made together succeed`; `stops when the address was given to someone else after the request`; `is refused to a manager and a soldier, also when called directly`; `sends a code to the new address only and needs a reason`; `works only on the technical account, and its errors are in English`; `moves the account with the code from the new address, ends access and replaces the recovery codes`; `counts wrong codes and cancels after five`; `keeps the two routes apart: a request of one is not confirmed by the other`; `blocks the original peer takeover, including self through the soldier route`; `rechecks the role under lock after a soldier is promoted between request and confirmation`; `requires both mailboxes for a manager and revokes prior access on success`; `rejects unauthorized roles before parsing and never lets a self request choose another target`; `allows technical recovery with a reason and only the new mailbox code, and records erasable reasons`; `rejects recovery confirmation after demotion`; `serializes competing confirmations so only one applies`
- [google-sign-in.test.ts](../tests/integration/google-sign-in.test.ts): `drops the Google link, refuses the old Google account and links the new address afresh`
- [technical-email-change.spec.ts](../tests/e2e/technical-email-change.spec.ts): `the technical account moves itself to a new address with a code from each mailbox`; `a manager uses its own screen and the server refuses the technical route`; `a manager changes its own email using two codes on desktop and mobile`; `the technical account recovers a manager email using a reason and the new code`
- ספקים, שרת ופיילוט:
  - טרם נבדק: החלפת כתובת החשבון הטכני ב־staging לחשבון הייעודי, ומשלוח קוד אמיתי לשתי הכתובות (#90)

## תפקידים ומצבים

חייל, שני האחראים והמנהל הטכני, בכל אחד מהמצבים: מותר, אסור, מצב ריק, טעינה, שגיאה וגרסה שהשתנתה. הבדיקות ב־`tests/integration/role-matrix.test.ts` (שרת) וב־`tests/e2e/screens-sweep.spec.ts` (דפדפן) רצות לכל תפקיד בנפרד.

### מותר: כל ארבעת התפקידים

- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `lets each role reach the commands it is for, and never fails with a server error`
- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `is Hebrew, named and fits a phone`

### אסור: כל ארבעת התפקידים

- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `refuses a role that the command is not for with 403, before reading the payload`
- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `and sees nothing of it`

### מצב ריק: כל ארבעת התפקידים

- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `shows an empty unit to everyone without an error`
- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `is Hebrew, named and fits a phone`

### טעינה: כל ארבעת התפקידים

- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `a loading screen, then the content`

### שגיאה: כל ארבעת התפקידים

- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `when the state cannot load, and recovers on retry`; `to the sign-in page when the session ended`
- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `sends a malformed envelope back as a validation error, not a failure`; `asks for a fresh sign-in on every command when the account changed, before any role check`

### גרסה שהשתנתה: חייל

- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `makes a soldier read the form again after the preferences changed`
- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `in a second tab that the form changed, and shows what was saved`

### גרסה שהשתנתה: אחראי ראשון

- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `makes the second of two managers read again before saving a soldier`; `makes a manager read the duty again after another manager changed it`
- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `in a second tab that the form changed, and shows what was saved`

### גרסה שהשתנתה: אחראי שני

- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `makes the second of two managers read again before saving a soldier`; `makes a manager read the duty again after another manager changed it`
- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `in a second tab that the form changed, and shows what was saved`

### גרסה שהשתנתה: מנהל טכני

- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `makes the technical account read the account again before changing a role`
- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `in a second tab that the form changed, and shows what was saved`

## תרחישים רוחביים 2, 33 ו־35

### פרטיות

- [role-matrix.test.ts](../tests/integration/role-matrix.test.ts): `keeps contact details out of every state but a manager's`; `keeps another soldier's exemptions and hours out of a soldier's state`
- [audit-log.test.ts](../tests/integration/audit-log.test.ts): `keeps personal text out of the envelope, and keeps the envelope when that text is erased`
- [cancellation-requests.test.ts](../tests/integration/cancellation-requests.test.ts): `submitting changes neither the seat, the calendar nor reserved points, and is visible only to its owner and managers`
- [soldier-deletion.test.ts](../tests/integration/soldier-deletion.test.ts): `is removed, while the event and the history stay`

### מקביליות

- [auth.test.ts](../tests/integration/auth.test.ts): `lets only one of two managers occupy the last place`
- [planning.test.ts](../tests/integration/planning.test.ts): `lets two managers plan overlapping duties at once without booking one soldier twice`
- [swaps.test.ts](../tests/integration/swaps.test.ts): `swaps both seats together with their full value, without a score check, and completes once when two acceptances race`
- [soldier-deletion.test.ts](../tests/integration/soldier-deletion.test.ts): `lets only one of two simultaneous deletions win`
- [deletion-in-execution.test.ts](../tests/integration/deletion-in-execution.test.ts): `never credits twice when the worker and the manager's decision race`
- [manager-exclusion.test.ts](../tests/integration/manager-exclusion.test.ts): `holds with two managers assigning one soldier to different duties meanwhile`
- [backup.test.ts](../tests/integration/backup.test.ts): `accepts one waiting request at a time and two workers back up once`

### עברית מימין לשמאל

- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `is Hebrew, named and fits a phone`
- [soldier-picker.spec.ts](../tests/e2e/soldier-picker.spec.ts): `the picker works with the keyboard and on a phone without sideways scrolling`

### נייד

- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `is Hebrew, named and fits a phone`
- [soldier-picker.spec.ts](../tests/e2e/soldier-picker.spec.ts): `the picker works with the keyboard and on a phone without sideways scrolling`
- [calendar-cards.spec.ts](../tests/e2e/calendar-cards.spec.ts): `soldier summary cards filter, restore and focus the score at width`
- [soldier-deletion.spec.ts](../tests/e2e/soldier-deletion.spec.ts): `the deletion screen fits a phone and a manager cannot delete their own record`

### מקלדת

- [screens-sweep.spec.ts](../tests/e2e/screens-sweep.spec.ts): `without a mouse`
- [soldier-picker.spec.ts](../tests/e2e/soldier-picker.spec.ts): `the picker works with the keyboard and on a phone without sideways scrolling`
- [calendar-cards.spec.ts](../tests/e2e/calendar-cards.spec.ts): `soldier summary cards filter, restore and focus the score at width`

### סוף חודש

- [calendar.test.ts](../tests/unit/calendar.test.ts): `builds a Sunday-first month grid and moves across years`; `keeps a duty ending exactly at midnight within its own day and month`
- [calendar-filters.test.ts](../tests/unit/calendar-filters.test.ts): `uses Israeli month boundaries for cards as well as the calendar`
- [service-lifecycle.test.ts](../tests/unit/service-lifecycle.test.ts): `ends on the last day of a shorter month, which is itself available`; `starts the month before release on the same calendar day, or the last day of a shorter month`
- [domain.test.ts](../tests/unit/domain.test.ts): `uses a calendar month for grace at month end`

### שעון קיץ וחורף

- [domain.test.ts](../tests/unit/domain.test.ts): `starts a surcharge window at the moment summer time skips its start time`; `prices a daytime duty on a clock-change date outside the changed hour`
- [execution.test.ts](../tests/unit/execution.test.ts): `measures real hours across the end of summer time in Israel`
- [rest-windows.test.ts](../tests/unit/rest-windows.test.ts): `still rests at 03:30 summer time`
- [calendar.test.ts](../tests/unit/calendar.test.ts): `uses local days across DST changes while the duration stays actual time`
- [round-notices.test.ts](../tests/integration/round-notices.test.ts): `schedules by the Israeli calendar when winter time starts`
- [auth.test.ts](../tests/integration/auth.test.ts): `rejects submissions outside the window or target period and applies whole Israel days across a clock change`
- [backup.test.ts](../tests/unit/backup.test.ts): `keeps one key on the nights the clock changes`

## השבתה, ניסיונות חוזרים, שחזור ושליטה באקראיות ובשעון

### השבתת עובד

- [duty-reminders.test.ts](../tests/integration/duty-reminders.test.ts): `merges times missed while the worker was down into one reminder and skips a duty that started`
- [round-notices.test.ts](../tests/integration/round-notices.test.ts): `skips stale notices after downtime and merges an overdue opening`
- [service-lifecycle.test.ts](../tests/integration/service-lifecycle.test.ts): `announces a departure once to each manager across repeated runs, races and downtime, without deleting`
- [auth.test.ts](../tests/integration/auth.test.ts): `reports a missing worker without failing the site`; `tracks beats, keeps the last success while paused and marks delays`

### ניסיונות חוזרים

- [mail-delivery.test.ts](../tests/integration/mail-delivery.test.ts): `retries with growing delays, then fails visibly while the site notice stays`; `stops retrying when the message is no longer relevant`
- [backup.test.ts](../tests/integration/backup.test.ts): `retries an upload failure after 15 minutes and an hour, then alerts once`
- [mail-delivery.test.ts](../tests/unit/mail-delivery.test.ts): `retries five times in total with growing delays inside 24 hours`
- [mail-signal.test.ts](../tests/integration/mail-signal.test.ts): `reconnects after losing its connection and sends a code committed meanwhile`

### שחזור ייבוא

- [auth.test.ts](../tests/integration/auth.test.ts): `restores unchanged imported fields while preserving later edits and reservations`; `cancels a new soldier without activity: removes every trace, frees the number and keeps the row`
- [import-restore-population.spec.ts](../tests/e2e/import-restore-population.spec.ts): `a restore that moves the population shows its assignments per the chosen decision and flags them after confirmation`
- [import-restore-creations.spec.ts](../tests/e2e/import-restore-creations.spec.ts): `cancels a new soldier without activity and waits for a decision on one who signed in`

### שחזור גיבוי

- [restore.test.ts](../tests/integration/restore.test.ts): `restores the newest backup into a scratch database, passes every check and leaves the live system as it was`; `are applied again from the log before anything of the restored copy is open, and no deleted data returns`
- [backup.test.ts](../tests/integration/backup.test.ts): `produces a verified copy that is only ciphertext, decrypts and restores the data`

### אקראיות נשלטת

- [lottery-draw.test.ts](../tests/unit/lottery-draw.test.ts): `gives every member of the band an equal share of the random range`; `rejects a source that leaves the range from 0 up to, not including, 1`
- [domain.test.ts](../tests/unit/domain.test.ts): `filters before minimum and uses a strict upper bound`

### שעון נשלט

- [service-lifecycle.test.ts](../tests/integration/service-lifecycle.test.ts): `applies the boundary at 00:00 Israel time with an explicit clock`
- [backup.test.ts](../tests/integration/backup.test.ts): `runs once per Israel date from 03:30 and not while restore mode is on`
- [rest-windows.test.ts](../tests/unit/rest-windows.test.ts): `is free from 04:00 summer time`
- [restore.test.ts](../tests/unit/restore.test.ts): `is ok after a passed drill and overdue after more than 100 days`

## ספקים, שרת ופיילוט

- נבדק: כניסה אמיתית ב־Google ב־staging (#25)
- נבדק: Brevo אמיתי ב־staging: קוד, פרסום, כשל וחזרה (#25)
- נבדק: Drive אמיתי: גיבוי יומי וידני, הרשאה שבוטלה, כשל רשת, שמירת 30 (#37)
- נבדק: תקלה וחזרה של פריסה אוטומטית בשרת (#36)
- טרם נבדק: Drive אמיתי: שחזור מגיבוי שהורד ומחיקות אחרי שחזור, ותרגיל בשרת (#37)
- טרם נבדק: גיבוי לפני מיגרציה כשמיגרציה משנה את המסד, בשרת (#36)
- טרם נבדק: תורנויות ביומן Google של חייל אמיתי (#92)
- טרם נבדק: פיילוט עם שני האחראים ונתוני אמת (#39)
- טרם נבדק: קורא מסך אמיתי (הבדיקות האוטומטיות אינן אישור נגישות)
