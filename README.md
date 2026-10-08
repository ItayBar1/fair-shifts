# Fair Shifts

הפרדת שירותים (הכרעה 216, אפיון 1.70, #130): ב־production האתר, העובד והתפעול משתמשים בקובצי env ובמשתמשי מסד נפרדים. `production deploy` עוצר אתר ועובד, מפעיל מיגרציות ובדיקת הרשאות דרך שירות `operations`, ואז מפעיל אותם. שחזור: `sh scripts/production.sh --profile operations run --rm -T --no-deps operations node_modules/.bin/tsx scripts/restore.ts ...`. לתצורה קיימת נדרש מעבר מפורש לפי [מדריך ההפעלה](docs/operations.md#מעבר-לתצורה-ולהרשאות-נפרדות--130); אין להפעיל את הגרסה החדשה עם קובץ env משותף.

מערכת לניהול וחלוקת תורנויות ביחידה של כ־120 חיילים, בעברית וב־RTL.

רוב [תוכנית 20 השלבים המאושרת](plans/fair-shifts-implementation.md) ממומשת. [ביקורת 05.10.2026](docs/audits/2026-10-05/README.md) מפרטת תקלות שנמצאו, יכולת Calendar חסרה ושערי פרטיות, נגישות וקבלה תפעולית שעדיין פתוחים. משתמשים בנתונים סינתטיים בלבד. [מצב ובדיקות בפועל](config/memory/project-state.md).

## מקורות הפרויקט

- [AGENTS.md](AGENTS.md) — הוראות עבודה ומקורות אמת.
- [אפיון 1.70](docs/duty-management-prd.md) ו[עותק HTML](docs/duty-management-prd.html).
- [יומן ההכרעות](docs/open-decisions.md), [מפת כיסוי](docs/requirements-coverage.md) ו[מחקר](docs/research-notes.md).
- [תוכנית המימוש](plans/fair-shifts-implementation.md) ו[מדריך המסירה המקורי](docs/planning-handoff.md).
- [תוכנית תיקון האבטחה המאושרת](plans/2026-10-07-security-remediation.md), [מעקב #122](https://github.com/ItayBar1/fair-shifts/issues/122). שינוי עצמי של אחראי ב־`/manage/account`; חילוץ כתובתו בידי הטכני במסך ההרשאות, עם סיבה וקוד לכתובת החדשה.
- [מפת הדרך וחלוקת העבודה המקורית מ־28.09](docs/team-roadmap.md); מצב השלבים העדכני ב[ביקורת](docs/audits/2026-10-05/implementation.md).
- [כרטיס המעקב ב־GitHub](https://github.com/ItayBar1/fair-shifts/issues/2), [אינדקס 37 ה־Stories המקוריים והתלויות](docs/github-backlog.md) ו[מצב הכרטיסים וההרחבות ב־05.10.2026](docs/audits/2026-10-05/backlog-operations.md).
- [זיכרון בין סשנים](config/memory/README.md) ו[יומן סשנים](config/memory/session-log.md). הזיכרון מתועד ב־Git, אינו נטען אוטומטית ואינו מחליף את האפיון.

## הרצה ובדיקות — Docker בלבד

גבולות קלט (#127): פעולות עד 2MiB, אימות עד 16KiB ועומק JSON עד 32. XLSX עד 5MiB דחוסים, 2,000 רשומות ZIP, 500 שורות ו־50MiB שנפרסו בפועל. הפענוח נעשה בילד Linux עם heap של 128MiB, RSS של 256MiB ו־10 שניות; קובץ אחד במקביל לכל תהליך אתר, ועודף מקבל 429 לניסיון נוסף. נדרשת גישה ל־`/proc` למדידת הזיכרון; כשל מדידה עוצר פענוח. בדיקות crash/זיכרון/זמן נעשות ב־Docker מוגבל בלבד. אין מיגרציה בקבוצה זו; חזרה לתמונה תואמת, ללא ביטול ההגנות שכבר נוספו במסד.

נדרש Docker פעיל. אין צורך ב־Node, pnpm או PostgreSQL על המארח. הסקריפט מזהה גם Docker Desktop ב־macOS שאינו ב־PATH.

```sh
# אתר בכתובת http://localhost:3000, עובד ומסד פיתוח
sh scripts/docker.sh up --build -d app worker

# טיפוסים, lint, כללים, PostgreSQL אמיתי ובניית production
sh scripts/docker.sh --profile test run --build --rm tests

# תהליך דפדפן מול production ובדיקת נייד
sh scripts/docker.sh --profile test run --build --rm e2e

# עצירה, בלי מחיקת נתוני הפיתוח
sh scripts/docker.sh --profile test down
```

הבדיקות משתמשות במסד `fair_shifts_test` נפרד ומסרבות לנקות מסד שאינו מוגדר כמסד בדיקות. אין להריץ אינטגרציה ו־E2E במקביל מול אותו מסד. הפיתוח מתמיד ב־volume; מסד הבדיקות זמני. דוחות הדפדפן ב־`test-results` ו־`playwright-report`, שאינם נשמרים ב־Git.

Compose מיועד לפיתוח סינתטי: סודות מקומיים גלויים ומייל כבוי. Google ומשלוח אמיתי דורשים חשבונות ספקים והגדרות. בדיקות משתמשות במתאם מייל מדומה ובקוד מהמסד המבודד, ללא עוקף־אימות באתר. הקוד והתלויות מותקנים ורצים בתוך התמונות.

## תצורת הפעלה (staging/production)

הצפנה ויומן חתום (#128): קודי מייל ואסימוני Calendar דורשים פורמט v2 עם AAD למטרה ולרשומה. `pnpm security:secrets verify` הוא שער פתיחת האתר; נתונים ישנים מוסבים רק ב־`pnpm security:secrets convert`, בתוך Docker ותחת נוהל הגיבוי והעצירה שב[תפעול](docs/operations.md). יומן גרסה 2 מאומת ב־Ed25519; `worker-secrets.env` מכיל את המפתח הפרטי לעובד בלבד, ו־`app.env` מכיל ציבוריים. את הפרטי מגבים מחוץ לשרת ומאשרים `DELETION_LOG_KEY_RECOVERY_CONFIRMED=true`. יצירת התצורה אינה מוכיחה שהגיבוי החיצוני נעשה. אין קורא לא חתום באתר או בשחזור. גם בסביבת פיתוח נדרשים מפתחות כדי לנקז יומן; אין מפתח פרטי קבוע במאגר.

`compose.production.yaml` מפעיל מסד, אתר, עובד ו־cloudflared, עם סודות מחוץ למאגר ובדיקת תצורה לפני עלייה. ההוראות ב[מדריך ההפעלה](docs/operations.md). בדיקת התצורה ב־Docker עם סודות סינתטיים:

```sh
sh scripts/production-smoke.sh
```

חיילים סינתטיים ל־staging: `pnpm staging:soldiers` בשירות הכלים יוצר קובץ XLSX לייבוא במסך הייבוא (פירוט במדריך ההפעלה).

פריסה אוטומטית של main בשרת: `scripts/auto-deploy.sh` מטיימר systemd (הוראות במדריך ההפעלה). שירות הבדיקות מריץ את `scripts/auto-deploy-test.sh` מול מאגר Git אמיתי, ובו הפריסה עצמה מדומה.

## בדיקה לפני commit וגיבוי ב־Git

Husky מפעיל בדיקה לפני כל commit. אחרי clone מתקינים את ה־hook דרך Docker:

```sh
sh scripts/install-hooks.sh
```

אין צורך ב־Node על המחשב. לפני ה־commit, ‏lint-staged ו־Prettier רצים ב־Docker על הקבצים המיועדים לשמירה. לאחר מכן נבדק עותק מבודד של תוכן ה־index: טיפוסים, lint, כללים, אינטגרציה עם PostgreSQL, בניית production ו־E2E. כל קבוצה חייבת לעבור; Docker לא זמין או בדיקה שנכשלה חוסמים commit. שינוי בקבצים המיועדים ל־commit בזמן הריצה מחייב בדיקה חדשה. ה־hook פועל גם מתוך git worktree: תיקיית ה־Git המשותפת מחוברת לקונטיינר באותו נתיב מוחלט. התיקייה `.husky/_` אינה נשמרת ב־Git, ולכן בכל worktree חדש מריצים את `sh scripts/install-hooks.sh` לפני ה־commit הראשון. בלי זה Git מדלג על הבדיקה בלי הודעה.

מסד הבדיקות והקונטיינרים של ה־commit נפרדים מסביבת הפיתוח ומנוקים בסיום. CI מריץ את אותן בדיקות גם ב־push. לפי הוראת המשתמש, שומרים נקודות התקדמות שעברו בדיקות באמצעות commit ו־push למאגר הקיים.

העבודה בענפים ושילובם ב־main מפורטים בנוהל שלהלן. ההפעלה המתוכננת היא Ubuntu/Docker/Cloudflare Tunnel, עם פריסה אוטומטית של גרסה שנכנסה ל־main לאחר CI. כיום ה־workflow בודק בלבד ואינו פורס. פירוט ב[מפת הדרך לצוות](docs/team-roadmap.md).

## נוהל עבודה בצוות

שני מפתחים: `ItayBar1` (admin) ו־`IshaiZigdon` (write). הנוהל לפי הכרעה 184.

1. **התקנה:** אחרי clone, ובכל worktree חדש, מריצים `sh scripts/install-hooks.sh`. בלי זה Git מדלג על הבדיקה בלי הודעה.
2. **לקיחת Story:** בוחרים כרטיס פתוח בלי בעלים, שכל תלויותיו מוזגו ל־main (התלויות כתובות בגוף הכרטיס). משייכים לעצמך, קוראים שוב את הכרטיס כדי לוודא שאין לקיחה מתחרה, וכותבים בו תגובה עם שם הענף. שיוך אינו נעילה: אם יש טיפול פעיל אחר, מתאמים לפני שמתחילים.
3. **ענף:** מ־main העדכני, בשם `codex/<github-user>/issue-<N>-<תיאור>`. לא עובדים על main.
4. **commit ו־push:** כל commit עובר את מלוא בדיקות Docker דרך Husky, ואין לעקוף את ה־hook. מגבים את הענף ב־push. אין force push, rebase או amend על ענף שכבר הועלה. כדי לעדכן ענף ממזגים לתוכו את main.
5. **קבצים משותפים:** ‏`src/server/actions.ts`, `state.ts`, `validation.ts`, `schema.ts` ומיגרציות. שינוי חוזה בהם מציינים בכרטיס וב־PR. מיגרציה חדשה נוצרת רק אחרי מיזוג main העדכני לענף, עם `pnpm db:generate` דרך Docker. אם main קיבל מיגרציה בינתיים, מוחקים את המיגרציה של הענף ויוצרים אותה מחדש. בדיקת `migrations-order` נכשלת כשהמספור או שרשרת ה־snapshots אינם רציפים.
6. **מספור הכרעות ואפיון:** במיזוג main מספרים מחדש את ההכרעה ואת גרסת האפיון של הענף אחרי מה שכבר נכנס, ומסנכרנים את ה־HTML.
7. **PR:** לפי [התבנית](.github/pull_request_template.md). `Closes #N` רק כשכל תנאי הקבלה הושלמו ונבדקו; אחרת `Related to #N`. בכרטיס מוסיפים תגובה עם קישור ל־PR.
8. **מיזוג:** מוגדר ב־[rulesets](.github/rulesets) של main. נדרשים PR, בדיקת `verify` ירוקה על ענף שמעודכן מול main, ואישור אחד של המפתח השני. admin יכול לעקוף רק את האישור, ורק דרך PR; את ה־CI ואת חסימת ה־force push והמחיקה אי אפשר לעקוף. PR של סוכן נפתח בשם בעל החשבון, ולכן המפתח השני הוא שמאשר אותו.
9. **מסירה:** מעדכנים את [מצב הפרויקט](config/memory/project-state.md), [יומן הסשנים](config/memory/session-log.md) ומפות הכיסוי לפי מה שנבדק בפועל. כרטיס נסגר רק עם ראיות קבלה.

**הפעלת ההגנה (admin, פעם אחת):** ‏Settings ← Rules ← Rulesets ← New ruleset ← Import a ruleset. מייבאים את שני הקבצים שב־`.github/rulesets` ובוחרים Create. אחרי ההפעלה בודקים שדחיפה ישירה ל־main נדחית ושבקשת מיזוג ממתינה ל־`verify`. שינוי מדיניות נעשה בקבצים ובהגדרות גם יחד; בדיקת `repository-rules` מוודאת שהבדיקה הנדרשת קיימת ב־CI.

## הקמה וכלי תחזוקה

להקמה ראשונית מריצים `pnpm bootstrap` בשירות הכלים, עם המשתנים `TECHNICAL_EMAIL`, `TECHNICAL_NAME`, `MANAGER_EMAIL`, `MANAGER_NAME`, `MANAGER_PERSONAL_NUMBER`. הפקודה מסרבת לפעול אם כבר יש חשבונות, ומציגה קודי שחזור פעם אחת. יש לשמור אותם מחוץ למאגר וללוגים משותפים. `pnpm seed:demo` יוצר שני חשבונות סינתטיים בכתובות example.invalid ואינו שולח אליהם מייל.

להדגמה מקומית, לאחר הפעלת השירותים ובניית tools, מריצים `sh scripts/docker.sh run --rm tools pnpm seed:demo`. במסך הכניסה מזינים `manager@example.invalid` ומבקשים קוד. קוראים את הקוד באמצעות `sh scripts/docker.sh run --rm tools pnpm demo:code manager@example.invalid`, ואז מזינים אותו במסך. זהו אותו קוד חד־פעמי ואותו אימות; הכלי מסרב לפעול ב־production, במשלוח מייל פעיל או בכתובת שאינה example.invalid.

שחזור טכני דרך השרת: `pnpm recover` בשירות הכלים, עם `RECOVERY_EMAIL` ו־`RECOVERY_REASON` (חמישה תווים לפחות). הוא מבטל חיבורים, משחרר את החשבון הטכני, מבטל את כל קודי השחזור הקודמים ומנפיק שמונה חדשים, עם אירוע ביומן הפעולות. נדרשת לאחריו התחברות חדשה.

דוגמת הרצת כלי, אחרי `sh scripts/docker.sh build tools`:

```sh
# יצירת migration בקובצי המאגר דרך Docker
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules tools pnpm db:generate

# סנכרון האפיון ל־HTML דרך Docker
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules tools pnpm docs:render

# מפת הקבלה מול הבדיקות, מתוך tests/acceptance/acceptance-map.ts
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules tools pnpm docs:matrix
```

[מפת הקבלה](docs/acceptance-matrix.md) ממפה כל סיפור וכל תרחיש לבדיקות או לחוסר מוצהר. מוסיפים סיפור או תרחיש לאפיון, או משנים שם של בדיקה שהמפה מזכירה? מעדכנים את `tests/acceptance/acceptance-map.ts` ומריצים את הפקודה; בדיקת היחידה נכשלת עד אז.

מיגרציות מוחלות אוטומטית בהפעלת האתר/עובד תחת נעילה משותפת. אין לחשוף את Compose לפיתוח לאינטרנט. את סודות הספקים ותנאי האירוח ב־Linux ו־Cloudflare Tunnel משלימים בשלב ההפעלה; `.env.example` מתעד שמות בלבד. מפתח הצפנת תור המייל הוא 32 בייט בהקסדצימלי. אזור איפוס מכסת הספק טעון אימות בחשבון Brevo לפני שימוש אמיתי.

## מצב הבדיקות וההפעלה

ייבוא חיילים זמין ב־`/manage/imports` לאחראים: מורידים תבנית, ממלאים את גיליון ״חיילים״ ומעלים XLSX עד 5MB ו־500 שורות. התצוגה מפרטת שגיאות, קליטות חדשות ושדות שיידרסו; אישור מפורש מחיל את כל הקובץ. ריקים אינם הוראות מחיקה ושינוי מייל קיים מחייב אימות באתר. שחזור עדכוני רשומות קיימות מציג גרסאות שדות והתנגשויות להכרעה; אינו מוחק שיבוצים, זקיפות או היסטוריה מאוחרת. מדיניות שחזור קליטות חדשות עדיין ממתינה להכרעה. מיגרציה `0001` כוללת פונקציות ו־triggers שנכתבו ידנית למעקב גרסאות שדות; יש לשמרם במיגרציות עתידיות.

פקודות הבדיקות רצות גם ב־CI בתוך Docker. הריצה הראשונה ב־GitHub עברה עבור commit ‏`0e6a3b6`; תוצאות המשך מתועדות במצב הפרויקט. מקרי קבלה באפיון הם יעד, ולא הוכחה שבדיקות עברו. בדיקות הספקים, שחזור גיבוי, מחיקה בזמן ביצוע ויומן מחיקות עצמאי (#34) ויתר שער הפיילוט טרם הושלמו. מחיקת משתמש מסירה מידע רגיש מכל עותק פעיל (הכרעה 192).

אין לשמור במאגר פרטי חיילים אמיתיים, סיסמאות, אסימונים או מפתחות ספקים. ערכי היחידה יוזנו בידי האחראים, ואינם נגזרים מנתוני הבדיקה.
