# Fair Shifts

מערכת לניהול וחלוקת תורנויות ביחידה של כ־120 חיילים, בעברית וב־RTL.

המימוש החל לפי [תוכנית 20 השלבים המאושרת](plans/fair-shifts-implementation.md). קיים מסלול ראשוני עובד וקוד ליבה, אך הגרסה המלאה עדיין לא הושלמה. משתמשים בנתונים סינתטיים בלבד. [מצב ובדיקות בפועל](config/memory/project-state.md).

## מקורות הפרויקט

- [AGENTS.md](AGENTS.md) — הוראות עבודה ומקורות אמת.
- [אפיון 1.6](docs/duty-management-prd.md) ו[עותק HTML](docs/duty-management-prd.html).
- [יומן ההכרעות](docs/open-decisions.md), [מפת כיסוי](docs/requirements-coverage.md) ו[מחקר](docs/research-notes.md).
- [תוכנית המימוש](plans/fair-shifts-implementation.md) ו[מדריך המסירה המקורי](docs/planning-handoff.md).
- [מצב השלבים, חלוקת עבודה בצוות ושער השחרור](docs/team-roadmap.md).
- [כרטיס המעקב ב־GitHub](https://github.com/ItayBar1/fair-shifts/issues/2) ו[אינדקס 37 ה־Stories והתלויות](docs/github-backlog.md).
- [זיכרון בין סשנים](config/memory/README.md) ו[יומן סשנים](config/memory/session-log.md). הזיכרון מתועד ב־Git, אינו נטען אוטומטית ואינו מחליף את האפיון.

## הרצה ובדיקות — Docker בלבד

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

## בדיקה לפני commit וגיבוי ב־Git

Husky מפעיל בדיקה לפני כל commit. אחרי clone מתקינים את ה־hook דרך Docker:

```sh
sh scripts/install-hooks.sh
```

אין צורך ב־Node על המחשב. לפני ה־commit, ‏lint-staged ו־Prettier רצים ב־Docker על הקבצים המיועדים לשמירה. לאחר מכן נבדק עותק מבודד של תוכן ה־index: טיפוסים, lint, כללים, אינטגרציה עם PostgreSQL, בניית production ו־E2E. כל קבוצה חייבת לעבור; Docker לא זמין או בדיקה שנכשלה חוסמים commit. שינוי בקבצים המיועדים ל־commit בזמן הריצה מחייב בדיקה חדשה.

מסד הבדיקות והקונטיינרים של ה־commit נפרדים מסביבת הפיתוח ומנוקים בסיום. CI מריץ את אותן בדיקות גם ב־push. לפי הוראת המשתמש, שומרים נקודות התקדמות שעברו בדיקות באמצעות commit ו־push למאגר הקיים.

מעתה עובדים בענף ייעודי לכל משימה, עם קידומת `codex/`, ומשלבים ב־main דרך PR. מגבים את ענף העבודה באופן שוטף. נוצרו 37 Stories עם תלויות ותנאי קבלה; לפני עבודה בוחרים בעלים ומעדכנים את הכרטיס. הגנת main לתיאום ב[כרטיס הצוות #29](https://github.com/ItayBar1/fair-shifts/issues/29); Project טרם הוקם. ההפעלה המתוכננת היא Ubuntu/Docker/Cloudflare Tunnel, עם פריסה אוטומטית של גרסה שנכנסה ל־main לאחר CI. כיום ה־workflow בודק בלבד ואינו פורס. פירוט ב[מפת הדרך לצוות](docs/team-roadmap.md).

## הקמה וכלי תחזוקה

להקמה ראשונית מריצים `pnpm bootstrap` בשירות הכלים, עם המשתנים `TECHNICAL_EMAIL`, `TECHNICAL_NAME`, `MANAGER_EMAIL`, `MANAGER_NAME`, `MANAGER_PERSONAL_NUMBER`. הפקודה מסרבת לפעול אם כבר יש חשבונות, ומציגה קודי שחזור פעם אחת. יש לשמור אותם מחוץ למאגר וללוגים משותפים. `pnpm seed:demo` יוצר שני חשבונות סינתטיים בכתובות example.invalid ואינו שולח אליהם מייל.

להדגמה מקומית, לאחר הפעלת השירותים ובניית tools, מריצים `sh scripts/docker.sh run --rm tools pnpm seed:demo`. במסך הכניסה מזינים `manager@example.invalid` ומבקשים קוד. קוראים את הקוד באמצעות `sh scripts/docker.sh run --rm tools pnpm demo:code manager@example.invalid`, ואז מזינים אותו במסך. זהו אותו קוד חד־פעמי ואותו אימות; הכלי מסרב לפעול ב־production, במשלוח מייל פעיל או בכתובת שאינה example.invalid.

שחזור טכני דרך השרת: `pnpm recover` בשירות הכלים, עם `RECOVERY_EMAIL` ו־`RECOVERY_REASON`. הוא מבטל חיבורים, משחרר את החשבון הטכני ומנפיק קודי שחזור חדשים, עם אירוע ביקורת. נדרשת לאחריו התחברות חדשה.

דוגמת הרצת כלי, אחרי `sh scripts/docker.sh build tools`:

```sh
# יצירת migration בקובצי המאגר דרך Docker
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules tools pnpm db:generate

# סנכרון האפיון ל־HTML דרך Docker
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules tools pnpm docs:render
```

מיגרציות מוחלות אוטומטית בהפעלת האתר/עובד תחת נעילה משותפת. אין לחשוף את Compose לפיתוח לאינטרנט. את סודות הספקים ותנאי האירוח ב־Linux ו־Cloudflare Tunnel משלימים בשלב ההפעלה; `.env.example` מתעד שמות בלבד. מפתח הצפנת תור המייל הוא 32 בייט בהקסדצימלי. אזור איפוס מכסת הספק טעון אימות בחשבון Brevo לפני שימוש אמיתי.

## מצב הבדיקות וההפעלה

ייבוא חיילים זמין ב־`/manage/imports` לאחראים: מורידים תבנית, ממלאים את גיליון ״חיילים״ ומעלים XLSX עד 5MB ו־500 שורות. התצוגה מפרטת שגיאות, קליטות חדשות ושדות שיידרסו; אישור מפורש מחיל את כל הקובץ. ריקים אינם הוראות מחיקה ושינוי מייל קיים מחייב אימות באתר. שחזור עדכוני רשומות קיימות מציג גרסאות שדות והתנגשויות להכרעה; אינו מוחק שיבוצים, זקיפות או היסטוריה מאוחרת. מדיניות שחזור קליטות חדשות עדיין ממתינה להכרעה. מיגרציה `0001` כוללת פונקציות ו־triggers שנכתבו ידנית למעקב גרסאות שדות; יש לשמרם במיגרציות עתידיות.

פקודות הבדיקות רצות גם ב־CI בתוך Docker. הריצה הראשונה ב־GitHub עברה עבור commit ‏`0e6a3b6`; תוצאות המשך מתועדות במצב הפרויקט. מקרי קבלה באפיון הם יעד, ולא הוכחה שבדיקות עברו. בדיקות הספקים, שחזור גיבוי, מחיקה מלאה ויתר שער הפיילוט טרם הושלמו.

אין לשמור במאגר פרטי חיילים אמיתיים, סיסמאות, אסימונים או מפתחות ספקים. ערכי היחידה יוזנו בידי האחראים, ואינם נגזרים מנתוני הבדיקה.
