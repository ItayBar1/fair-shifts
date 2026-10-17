# תורנות הוגנת · Fair Shifts

מערכת לניהול וחלוקה הוגנת של תורנויות ביחידה של כ־120 חיילים. לוח משותף, שיבוץ לפי ניקוד שקוף לכולם, אילוצים, החלפות והודעות, במקום אחד. האתר בעברית ומימין לשמאל, ועובד במחשב ובנייד.

**מצב:** פעיל ב־production ב־[fairshifts.app](https://fairshifts.app) מ־16.10.2026. הכניסה בהזמנה בלבד.

## מה המערכת עושה

**לחייל:** לוח התורנויות שפורסמו, ״השיבוצים שלי״, טבלת הצדק עם הניקוד של כולם, הגשת אילוצים בסבב, בקשות העברה, החלפה וביטול, הודעות באתר ובמייל, וסנכרון אופציונלי ליומן Google.

**לאחראי התורנויות:** קטלוג סוגי תורנות, הרכבים ומחירים; טיוטות, תכנון תקופה והגרלה מוסברת; פרסום ושינוי מפורסם; אישור אילוצים ובקשות; ביצוע, תיקוני עבר ונרמול ניקוד; ייבוא חיילים מ־XLSX; דרגות, כשירויות ופטורים; מרכז טיפול ויומן פעולות.

**למנהל הטכני:** חשבונות והרשאות אחראים, מצב המערכת, משלוחי מייל, גיבוי ושחזור.

### איך השיבוץ נשאר הוגן

לכל חייל ניקוד שנצבר מתורנויות שביצע. לכל מקום פנוי המערכת מסננת קודם את מי שמתאים (אוכלוסייה, דרגה, כשירות, פטורים, אילוצים מאושרים ומנוחה), ואז בוחרת בהגרלה אחידה מבין המתאימים שהניקוד שלהם נמוך מהמינימום ועוד רצועה קבועה. הניקוד לשיבוץ כולל גם שיבוצים שטרם זוכו, והחישוב מתעדכן אחרי כל בחירה. כל הגרלה נשמרת עם תמונת המועמדים, כך שאפשר להסביר כל החלטה. הכללים המלאים בסעיף 6 של [האפיון](docs/duty-management-prd.md).

## טכנולוגיות

| שכבה       | בחירה                                                               |
| ---------- | ------------------------------------------------------------------- |
| אתר ו־API  | Next.js 16, React 19, TypeScript, Tailwind                          |
| מסד        | PostgreSQL 18, Drizzle ORM                                          |
| עבודה ברקע | עובד Node.js עם pg-boss                                             |
| אימות      | Better Auth: קוד חד־פעמי במייל או Google                            |
| ספקים      | Brevo (מייל), Google (כניסה, יומן, Drive לגיבוי), Cloudflare Tunnel |
| הרצה       | Docker בלבד, בפיתוח, בבדיקות וב־production                          |

סקירת המבנה, זרימת הבקשות ומודל הנתונים ב[מסמך הארכיטקטורה](docs/architecture.md).

## הרצה מקומית

נדרש רק Docker פעיל. אין צורך ב־Node, pnpm או PostgreSQL על המחשב; הסקריפט מוצא גם Docker Desktop ב־macOS שאינו ב־PATH.

```sh
sh scripts/docker.sh up --build -d app worker
```

האתר עולה ב־`http://localhost:3000` עם מסד פיתוח קבוע ב־volume ומייל כבוי. ליצירת שני חשבונות הדגמה (אחראי וטכני, בכתובות `example.invalid`):

```sh
sh scripts/docker.sh run --rm tools pnpm seed:demo
```

במסך הכניסה מזינים `manager@example.invalid` ומבקשים קוד. את הקוד קוראים מהמסד המקומי:

```sh
sh scripts/docker.sh run --rm tools pnpm demo:code manager@example.invalid
```

הכלי מסרב לפעול ב־production, כשמשלוח מייל פעיל או לכתובת שאינה `example.invalid`. עצירה, בלי מחיקת נתוני הפיתוח:

```sh
sh scripts/docker.sh --profile test down
```

`compose.yaml` מיועד לפיתוח בלבד: הסודות בו גלויים, ואסור לחשוף אותו לאינטרנט.

## בדיקות

```sh
# טיפוסים, lint, כללי המאגר, בדיקות יחידה, PostgreSQL אמיתי ובניית production
sh scripts/docker.sh --profile test run --build --rm tests

# Playwright מול build של production, כולל רוחב נייד
sh scripts/docker.sh --profile test run --build --rm e2e

# תצורת production עם סודות סינתטיים: בריאות, restart, הרשאות תמונה, גיבוי ושחזור
sh scripts/production-smoke.sh

# שער שרשרת האספקה: pnpm audit ו־Trivy על התלויות ועל כל התמונות
sh scripts/security-scan.sh
```

הבדיקות משתמשות במסד `fair_shifts_test` נפרד ומסרבות לנקות מסד אחר. אין להריץ אינטגרציה ו־E2E במקביל מול אותו מסד. הן משתמשות במתאם מייל מדומה ובספק Google מדומה, בלי עוקף אימות באתר. [מפת הקבלה](docs/acceptance-matrix.md) מקשרת כל סיפור משתמש ותרחיש קבלה באפיון לבדיקות שמכסות אותו.

## כלי פיתוח

אחרי `sh scripts/docker.sh build tools`:

```sh
# מיגרציה חדשה מהסכמה (src/server/schema.ts)
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules tools pnpm db:generate

# סנכרון האפיון ל־HTML
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules tools pnpm docs:render

# מפת הקבלה, מתוך tests/acceptance/acceptance-map.ts
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules tools pnpm docs:matrix
```

מיגרציה `0001` ואחרות כוללות פונקציות וטריגרים שנכתבו ידנית; שומרים אותם במיגרציות עתידיות.

## פריסה ותפעול

production רץ על שרת Ubuntu עם Docker Compose (`compose.production.yaml`): מסד, אתר, עובד ו־cloudflared, בלי פורטים פתוחים. טיימר systemd בשרת פורס כל commit ב־main אחרי שריצת ה־CI שלו עברה, עם גיבוי מאומת לפני שינוי מסד וחזרה אוטומטית כשאין שינוי מסד. גיבוי יומי מוצפן נשמר ב־Google Drive, ותרגיל שחזור מבודד רץ כל רבעון.

כל ההוראות, כולל הקמה ראשונה, סודות, שחזור, יומן המחיקות וטיפול בתקלות, ב[מדריך ההפעלה](docs/operations.md). כל פלט שנקרא בשרת כתוב באנגלית.

## נוהל עבודה בצוות

שני מפתחים: `ItayBar1` (admin) ו־`IshaiZigdon` (write). המשימות מנוהלות ב־[GitHub Issues](https://github.com/ItayBar1/fair-shifts/issues). הנוהל לפי הכרעה 217:

1. **התקנה:** אחרי clone, ובכל worktree חדש, מריצים `sh scripts/install-hooks.sh`. בלי זה Git מדלג על הבדיקה בלי הודעה.
2. **לקיחת משימה:** כרטיס פתוח בלי בעלים, שכל תלויותיו מוזגו. משייכים לעצמך, קוראים שוב את הכרטיס כדי לוודא שאין לקיחה מתחרה, וכותבים בו את שם הענף.
3. **ענף:** מ־main העדכני, עם שם שמתאר את המשימה (למשל `issue-<N>-<topic>`). לא עובדים על main.
4. **commit:** Husky מריץ על כל commit את מלוא הבדיקות ב־Docker (כ־10 דקות): Prettier על הקבצים המיועדים, ואז טיפוסים, lint, אינטגרציה, בנייה ו־E2E על עותק מבודד של ה־index. כשל חוסם. אין לעקוף את ה־hook, ואין force push, rebase או amend על ענף שהועלה. מעדכנים ענף במיזוג main.
5. **קבצים משותפים:** `src/server/actions.ts`, `state.ts`, `validation.ts`, `schema.ts` והמיגרציות. שינוי חוזה בהם מציינים ב־PR. מיגרציה נוצרת רק אחרי מיזוג main העדכני; אם main קיבל מיגרציה בינתיים, יוצרים את שלך מחדש. בדיקת `migrations-order` אוכפת רצף.
6. **הכרעות ואפיון:** שינוי בכלל מוצר נרשם כהכרעה חדשה ב[יומן ההכרעות](docs/open-decisions.md) וכעדכון באפיון, עם סנכרון ה־HTML. במיזוג main מספרים מחדש לפי מה שכבר נכנס.
7. **PR:** לפי [התבנית](.github/pull_request_template.md). `Closes #N` רק כשכל תנאי הקבלה נבדקו; אחרת `Related to #N`.
8. **מיזוג:** לפי ה־[rulesets](.github/rulesets) של main: PR, בדיקת `verify` ירוקה על ענף מעודכן, ואישור של המפתח השני לדחיפה האחרונה. אין bypass, גם ל־admin. PR של סוכן נפתח בשם בעל החשבון, ולכן המפתח השני מאשר אותו. כל מיזוג נפרס ל־production.

הכללים ב־GitHub נבדקים מול הקבצים ב־`pnpm repository:rules` (ב־Docker, עם `GITHUB_TOKEN` שיכול לקרוא אותם). להקמה מחדש: Settings ← Rules ← Rulesets ← Import a ruleset, עם שני הקבצים שב־`.github/rulesets`.

## תיעוד

| מסמך                                               | תוכן                                                                                     |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [אפיון המוצר](docs/duty-management-prd.md)         | מקור הדרישות: תפקידים, כללים, מסכים ותרחישי קבלה ([HTML](docs/duty-management-prd.html)) |
| [יומן ההכרעות](docs/open-decisions.md)             | כל החלטת מוצר ומשמעותה, כולל מה שהוחלף                                                   |
| [מפת כיסוי הדרישות](docs/requirements-coverage.md) | איפה כל דרישה מופיעה באפיון ובאיזה תרחיש היא נבדקת                                       |
| [מפת הקבלה](docs/acceptance-matrix.md)             | נוצרת מהקוד: כל סיפור ותרחיש מול הבדיקות                                                 |
| [ארכיטקטורה](docs/architecture.md)                 | רכיבים, מבנה הקוד, זרימת בקשה ומודל הנתונים                                              |
| [אבטחה](docs/security.md)                          | גבולות אמון, הגנות, רגרסיות וסיכונים שהתקבלו                                             |
| [מדריך ההפעלה](docs/operations.md)                 | תפעול production                                                                         |
| [העלאה לפרודקשן](docs/production-launch.md)        | הגדרות הספקים והשלבים שנותרו לקליטת היחידה                                               |
| [מחקר](docs/research-notes.md)                     | מקורות חיצוניים: דרגות, ספק המייל, גיבוי                                                 |
| [מצב הפרויקט](config/memory/project-state.md)      | מה פעיל, מה פתוח ומה הבא                                                                 |
| [AGENTS.md](AGENTS.md)                             | הוראות עבודה לסוכני קוד                                                                  |

## פרטיות

אין לשמור במאגר פרטי חיילים אמיתיים, סיסמאות, אסימונים או מפתחות ספקים. הסודות נשמרים מחוץ למאגר, ו־`.env.example` מתעד שמות בלבד. מדיניות הפרטיות למשתמשים פתוחה ב־[/privacy](https://fairshifts.app/privacy).
