# הפעלה ב־Ubuntu עם Docker ו־Cloudflare Tunnel

29.09.2026 · כרטיס [#24](https://github.com/ItayBar1/fair-shifts/issues/24) (FS-25) · הכרעה 167 ב[יומן ההכרעות](open-decisions.md).

המסמך מתאר את תצורת ההפעלה שבמאגר ואת אופן השימוש בה. מ־30.09.2026 רצה סביבת staging סינתטית על שרת המשתמש, דרך Cloudflare Tunnel (כרטיס [#25](https://github.com/ItayBar1/fair-shifts/issues/25), בתהליך). אין סביבת production. הפריסה האוטומטית (כרטיס [#36](https://github.com/ItayBar1/fair-shifts/issues/36), הכרעה 186) מתוארת בהמשך.

כל פלט שנקרא בשרת כתוב באנגלית: סקריפטים, יומני קונטיינרים ו־systemd, הודעות בדיקת התצורה, הערות ב־`app.env` וההערות בבלוקי הפקודות כאן. מסוף Linux מציג עברית משמאל לימין (הכרעה 187). ממשק האתר נשאר בעברית. הגיבוי (כרטיס [#27](https://github.com/ItayBar1/fair-shifts/issues/27)) מתואר בהמשך, ועדיין לא נבדק מול Drive אמיתי. שימוש בנתוני אמת מותר רק אחרי שער הפיילוט שבאפיון.

## מה יש במאגר

| קובץ                                | תפקיד                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `compose.production.yaml`           | ההפעלה: מסד, אתר, עובד ו־cloudflared. נפרד מ־`compose.yaml` של הפיתוח, שכולל סודות סינתטיים ואסור לחשוף אותו לאינטרנט. |
| `scripts/production.sh`             | עטיפה ל־Compose: `init`, `deploy`, `health` וכל פקודת Compose אחרת (`ps`, `logs`, `stop`, `down`).                     |
| `scripts/init-production-config.ts` | יוצר את קובצי התצורה עם סודות אקראיים. רץ בתוך תמונת היישום, ואינו דורס קבצים קיימים.                                  |
| `scripts/check-config.ts`           | בודק את המשתנים לפני מיגרציה ולפני עליית האתר או העובד. שגיאה עוצרת את הקונטיינר; ההודעות מציינות שם משתנה בלי ערך.    |
| `scripts/production-smoke.sh`       | בדיקת התצורה ב־Docker עם נתונים וסודות סינתטיים (פירוט בהמשך). רצה גם ב־CI.                                            |
| `scripts/auto-deploy.sh`            | פריסה אוטומטית של main אחרי שהבדיקות עברו, מטיימר systemd (`scripts/systemd`). פירוט בהמשך.                            |
| `/api/health`                       | בריאות האתר, המסד ופעימת העובד, בלי מידע אישי. הפירוט מוצג גם למנהל הטכני ב״תמונת מצב״.                                |

## מבנה ההפעלה

- **db** — PostgreSQL 18 עם נפח קבוע `postgres-data`. הוא מחובר רק לרשת `internal`, שאין לה יציאה אל מחוץ לשרת, ואין לו פורט פתוח.
- **app** — Next.js במצב production. בכל עלייה נבדקת התצורה, ואחר כך מוחלות המיגרציות תחת נעילה. גם לו אין פורט פתוח; הגישה אליו עוברת רק דרך cloudflared ברשת הפנימית של Compose.
- **worker** — אותה תמונה ואותה גרסה של האתר. הוא עולה רק אחרי שהאתר תקין, כלומר אחרי המיגרציות. כל דקה הוא רושם פעימה במסד ובקובץ שבודקת בדיקת הבריאות של הקונטיינר.
- **cloudflared** — `cloudflare/cloudflared:2026.9.3`, בחיבור יוצא בלבד. אין צורך לפתוח פורטים נכנסים בחומת האש.

לכל השירותים `restart: unless-stopped`, ‏`init` שמעביר אותות וזמן חסד לעצירה: 30 שניות לאתר ולעובד ו־60 למסד. היומנים מוגבלים ל־5 קבצים של 10MB לכל שירות. האתר והעובד רצים כמשתמש שאינו root.

## הכנת השרת

1. Ubuntu LTS מעודכן. מתקינים Docker Engine ותוסף Compose ממאגר Docker הרשמי ([הוראות Docker ל־Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), ומתקינים גם git.
2. יוצרים משתמש הפעלה ומוסיפים אותו לקבוצה `docker`. מושכים את המאגר לתיקייה קבועה, למשל `/opt/fair-shifts/app`.
3. אין לפתוח את פורט 3000 או 5432. גישת SSH לניהול מוגדרת לפי מדיניות השרת.

## סודות ותצורה

הסודות נשמרים מחוץ למאגר, בתיקייה `FAIR_SHIFTS_CONFIG_DIR` (ברירת מחדל: `/opt/fair-shifts/config`). הבעלים הוא משתמש ההפעלה, והרשאות התיקייה 700. יצירה ראשונה:

```sh
sh scripts/production.sh init --environment=staging --url=https://staging.example.org
```

נוצרים שלושה קבצים בהרשאה 600:

- `db.env` — משתמש, מסד וסיסמה אקראית ל־PostgreSQL. הסיסמה נקבעת רק באתחול הראשון של הנפח. החלפתה בהמשך מחייבת נוהל ייעודי ואינה מתבצעת בעריכת הקובץ.
- `app.env` — `DEPLOYMENT_ENVIRONMENT` ‏(`staging` או `production`), כתובת המסד, כתובת האתר ב־https, סודות Better Auth וקודי כניסה, ומפתח הצפנת תור המייל. `MAIL_TRANSPORT=disabled`: משלוח אמיתי כבוי עד לאימות Brevo בכרטיס [#28](https://github.com/ItayBar1/fair-shifts/issues/28). שדות Google נשארים ריקים עד כרטיס [#26](https://github.com/ItayBar1/fair-shifts/issues/26).
- `tunnel.env` — `TUNNEL_TOKEN`, שממלאים ידנית (בהמשך).

בדיקת התצורה דוחה ערכים חסרים, סודות קצרים, אותו סוד לשני תפקידים, ערכי פיתוח מ־`compose.yaml` ו־`.env.example`, כתובת שאינה https, `MAIL_TRANSPORT=brevo` בלי מפתח ושולח, וזוג Google חלקי. מגבים את תיקיית התצורה בנפרד מהמאגר. בלי `MAIL_ENCRYPTION_KEY` לא אפשר לפתוח הודעות שממתינות בתור. סביבות staging ו־production מקבלות תיקיות וסודות נפרדים.

## Cloudflare Tunnel ו־DNS

הדומיין צריך להיות מנוהל ב־DNS של Cloudflare ([דרישות Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/)). לפני ההקמה בודקים בחשבון שאין צורך בתוכנית בתשלום. אין לבחור שירות בתשלום בלי הכרעה.

1. בלוח הבקרה: **Networking → Tunnels → Create a tunnel**, מסוג cloudflared, בשם הסביבה.
2. בשלב ההתקנה בוחרים Docker. מעתיקים רק את האסימון שמופיע אחרי `--token`, ושומרים אותו כ־`TUNNEL_TOKEN=...` ב־`tunnel.env`. אין להריץ את הפקודה המוצעת; השירות מוגדר ב־Compose.
3. בלשונית **Routes** בוחרים **Add route → Published application**: תת־דומיין ודומיין לפי `BETTER_AUTH_URL`, ושירות `http://app:3000`. רשומת ה־DNS נוצרת אוטומטית.
4. לכל סביבה Tunnel ושם מתחם משלה.

cloudflared רץ עם `--no-autoupdate`, והגרסה נעולה בקובץ. עדכון הגרסה נעשה בשינוי במאגר, דרך PR.

## הפעלה, עדכון ועצירה

```sh
export FAIR_SHIFTS_CONFIG_DIR=/opt/fair-shifts/config
sh scripts/production.sh deploy    # build the current commit and start every service
sh scripts/production.sh health    # site, database and worker status
sh scripts/production.sh ps
sh scripts/production.sh logs -f worker
sh scripts/production.sh stop      # graceful stop; start brings it back
sh scripts/production.sh down      # remove containers; the volume and data stay
```

- `deploy` בלי שמות שירותים מסרב לעלות כשאין `TUNNEL_TOKEN`. אפשר להעלות שירותים מסוימים, למשל `deploy db app worker`.
- התמונה מתויגת לפי ה־commit (`APP_VERSION`). כשיש שינויים שלא נשמרו ב־commit, מתווספת לתג הסיומת `-local`. לכן האתר והעובד תמיד מאותה בנייה, והבדיקה מציגה אם הגרסאות שונות.
- כדי לעדכן, מושכים את ה־commit המאושר מ־main ומריצים `deploy`. המיגרציות מוחלות בעליית האתר. לפני מיגרציה בנתוני אמת נדרש גיבוי מאומת (כרטיסים #27 ו־#35). חזרה לתמונה קודמת אפשרית רק כשהמסד תואם לה. בשרת עם טיימר הפריסה האוטומטית, העדכון נעשה מעצמו (בסעיף הבא).
- **אסור** להריץ `down --volumes` בסביבה עם נתונים: הפקודה מוחקת את המסד.

## פריסה אוטומטית של main

כרטיס [#36](https://github.com/ItayBar1/fair-shifts/issues/36), הכרעה 186. השרת מושך את הגרסה בעצמו. אין runner של GitHub בשרת, אין סודות פריסה ב־GitHub ואין פורט פתוח: המאגר ציבורי, ו־runner עצמי במאגר ציבורי חשוף לקוד מ־PR של fork.

**מה קורה בכל דקה** (טיימר systemd, דקה אחרי סיום הריצה הקודמת):

1. אם יש commit חדש ב־main, נבדקת ב־GitHub ריצת ה־CI (`ci.yml`) של ה־push ל־main לאותו commit בדיוק. ריצת PR אינה נחשבת. עד שהיא מסתיימת לא קורה דבר.
2. בדיקות שנכשלו: הגרסה לא נפרסת, והיא לא נבדקת שוב. push חדש מחליף אותה.
3. בדיקות שעברו: `git merge --ff-only` ל־main בשרת, `production.sh deploy`, ואחר כך בדיקת בריאות: `status` ‏`ok` לאותה גרסה, עובד מאותה גרסה, ודף הכניסה עונה.
4. נכשל בלי שינוי מסד (אין שינוי בתיקייה `drizzle` מאז הגרסה הפעילה): חוזרים לתמונה הקודמת (`up --no-build` עם הגרסה הקודמת) ובודקים את בריאותה. עם שינוי מסד אין חזרה אוטומטית, כי התמונה הקודמת עלולה לא להתאים למסד.

ריצה אחת בכל פעם (`flock`). push חדש לא עוצר פריסה או מיגרציה באמצע, והוא נפרס בסבב הבא. אין פריסה כשהתיקייה אינה על main או כשיש בה שינויים שלא נשמרו.

**גיבוי לפני מיגרציה:** ב־staging בלי גיבוי (`BACKUP_STORAGE` ריק) גרסה עם שינוי מסד נפרסת, ובלוג נכתב שלא נעשה גיבוי. זו החלטת המשתמש, כי הנתונים סינתטיים. ב־production, או כש־`BACKUP_STORAGE` מוגדר, גרסה כזו **אינה** נפרסת אוטומטית: מריצים ״גיבוי עכשיו״ במסך ״גיבוי ושחזור״, מחכים ל״אומת״, ואז פורסים ידנית. גיבוי אוטומטי לפני מיגרציה עדיין לא מומש (#36 נשאר פתוח עד #37 ו־#35).

### התקנה בשרת

```sh
cd /opt/fair-shifts/app
mkdir -p /opt/fair-shifts/deploy-state
git rev-parse HEAD > /opt/fair-shifts/deploy-state/deployed   # the commit that runs now, before pulling
git pull -q --ff-only
sudo cp scripts/systemd/fair-shifts-deploy@.service scripts/systemd/fair-shifts-deploy@.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now "fair-shifts-deploy@$USER.timer"
```

רושמים את הגרסה שרצה לפני `git pull`: בלי הרישום הטיימר מניח שהגרסה הפעילה היא ה־commit שבתיקייה, ולא יפרוס את מה שנמשך. שם המופע הוא משתמש ההפעלה, שחבר בקבוצה `docker`. הנתיבים הקבועים ביחידה: הקוד ב־`/opt/fair-shifts/app`, התצורה ב־`/opt/fair-shifts/config`, ומצב הפריסה ב־`/opt/fair-shifts/deploy-state`: הגרסה הפעילה (`deployed`), גרסה שנעצרה (`stopped`) והנעילה.

### מעקב ותחזוקה

```sh
systemctl list-timers 'fair-shifts-deploy@*'
journalctl -u "fair-shifts-deploy@$USER" -n 50      # auto-deploy lines
touch /opt/fair-shifts/deploy-state/paused          # pause for maintenance or a manual deployment
rm /opt/fair-shifts/deploy-state/paused             # resume
rm /opt/fair-shifts/deploy-state/stopped            # retry a stopped commit, e.g. after a CI re-run passed
```

יחידה שנכשלה מופיעה ב־`systemctl --failed`. כדי לפרוס ידנית בזמן שהטיימר פעיל, משהים קודם ומחדשים אחרי הפריסה. אחרי פריסה ידנית של commit אחר מ־main, רושמים אותו: `git rev-parse HEAD > /opt/fair-shifts/deploy-state/deployed`.

## סביבת ה־staging

כרטיס [#25](https://github.com/ItayBar1/fair-shifts/issues/25), הכרעה 189. סביבה סינתטית לתרגול ההפעלה ולבדיקות מול ספקים אמיתיים. אין בה נתוני חיילים אמיתיים.

| פריט    | ערך                                                                                                                                                                                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| כתובת   | `https://classly-studio-management.uk`. זה דומיין של אתר קודם שהוסר מהשרת, והוא משמש זמנית לבדיקות. החלפה: `BETTER_AUTH_URL`, ה־Route ב־Tunnel, ה־redirect ב־Google והשולח ב־Brevo. |
| שרת     | Ubuntu של המשתמש. הקוד ב־`/opt/fair-shifts/app`, התצורה ב־`/opt/fair-shifts/config`, מצב הפריסה ב־`/opt/fair-shifts/deploy-state`.                                                  |
| תצורה   | `DEPLOYMENT_ENVIRONMENT=staging`, גיבוי כבוי, `MAIL_TRANSPORT=brevo` עם דומיין ושולח מאומתים, ולקוח Google במצב Testing עם משתמשי בדיקה בלבד.                                       |
| עדכון   | הטיימר של הפריסה האוטומטית (בסעיף הקודם). שירותים אחרים שרצים באותו שרת לא שייכים לפרויקט, ואין לגעת בהם.                                                                           |
| חשבונות | מנהל טכני ואחראי מ־`bootstrap`, עם כתובות הבדיקה של המשתמש. הכתובות לא נשמרות במאגר. קודי השחזור של הטכני נשמרים אצל המשתמש.                                                        |

### גישה ותחזוקה

- **גישה לשרת:** SSH של המשתמש. אין פורט פתוח לאתר או למסד. הגישה לאתר היא רק דרך ה־Tunnel.
- **הקמה ראשונה של חשבונות** (פעם אחת, על מסד ריק; הפלט באנגלית):

```sh
cd /opt/fair-shifts/app
sh scripts/production.sh exec -T -e TECHNICAL_EMAIL=<address> -e TECHNICAL_NAME="Technical admin" \
  -e MANAGER_EMAIL=<address> -e MANAGER_NAME="Test manager" -e MANAGER_PERSONAL_NUMBER=0000001 \
  app node_modules/.bin/tsx scripts/bootstrap.ts
```

- **קודי שחזור חדשים לטכני:** `production.sh exec -T -e RECOVERY_EMAIL=<address> -e RECOVERY_REASON="<reason>" app node_modules/.bin/tsx scripts/recover.ts`.
- **שינוי ערך ב־`app.env`:** משהים את הטיימר (`touch /opt/fair-shifts/deploy-state/paused`), עורכים, מריצים `production.sh deploy`, ומחדשים את הטיימר.
- **ספירה במסד בלי לחשוף תוכן:** `production.sh exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select role, count(*) from auth_user group by role"'`.

### נתונים סינתטיים

`seed:demo` חסום כש־`NODE_ENV=production`, וזה המצב גם ב־staging. במקום זה מייבאים חיילים סינתטיים דרך מסך הייבוא של האחראי. זה אותו מסלול שישמש בהמשך לנתוני אמת. הקובץ נוצר במחשב של המפתח, ב־Docker:

```sh
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules tools \
  pnpm staging:soldiers --out .local/staging-soldiers.xlsx --extra "<tester address>|<name>"
```

בקובץ 20 חיילים בשלוש האוכלוסיות: 12 חובה, 5 קבע וקצינים ו־3 קמ״א. לכולם כתובות `@example.invalid`, שלא מקבלות מייל, מספרים אישיים שמתחילים ב־9 וניקוד התחלתי. כל `--extra` מוסיף חייל חובה עם כתובת בדיקה אמיתית, למשל לבדיקת Google ומייל. `.local` אינו נשמר ב־Git. מעלים את הקובץ ב־`/manage/imports`, בודקים את התצוגה המקדימה ומאשרים.

## בריאות ופעימת עובד

`GET /api/health` מחזיר JSON עם `status`, ‏`version`, ‏`checkedAt`, ‏`database` ו־`worker`. בתוך `worker` מופיעים `status`, ‏`lastBeatAt`, ‏`lastSuccessAt`, ‏`version` ו־`sameVersion`. אין בתשובה חשבונות, שמות, פרטי קשר או תוכן הודעות. היא ציבורית דרך ה־Tunnel וחושפת רק את מזהה הגרסה.

| מצב העובד | משמעות                                                                  |
| --------- | ----------------------------------------------------------------------- |
| `ok`      | פעימה בשלוש הדקות האחרונות                                              |
| `paused`  | מצב שחזור: יש פעימה, אך זקיפה ותזכורות אינן רצות. `lastSuccessAt` נשמר. |
| `stale`   | לא נרשמה פעימה יותר משלוש דקות                                          |
| `missing` | העובד טרם דיווח                                                         |

`status` הוא `ok` רק כשהעובד תקין ומאותה גרסה. אחרת הוא `degraded`. התשובה היא 503 רק כשהמסד אינו זמין. עיכוב של העובד לא יפעיל מחדש את האתר. בדיקת הקונטיינר של העובד מסתמכת על קובץ הפעימה, ו־Docker מסמן אותו כלא תקין אחרי שלוש דקות בלי ריצה. המנהל הטכני רואה את אותו מידע בפאנל ״מצב המערכת״ במסך ״תמונת מצב״.

## גיבוי יומי מוצפן

כרטיס [#27](https://github.com/ItayBar1/fair-shifts/issues/27), הכרעה 173. העובד מריץ את הגיבוי בתור נפרד מתחזוקת הדקה, כך שגיבוי ארוך אינו מעכב זקיפה ותזכורות.

- **מה נשמר:** `pg_dump` בפורמט custom יוצר תמונה עקבית של המסד הפעיל, בלי תור המשימות `pgboss`. הפלט עובר ישירות ל־`age --encrypt` עם המפתח הציבורי, ולכן לדיסק נכתב רק קובץ מוצפן. הקובץ המקומי נמחק בסיום, גם בכשל.
- **מתי:** כל יום מ־`BACKUP_TIME` (ברירת מחדל 03:30) לפי שעון ישראל, פעם אחת לכל תאריך. עובד שחוזר מהשבתה משלים את הגיבוי של אותו יום. בזמן מצב שחזור לא מתחיל גיבוי. המנהל הטכני יכול להפעיל ״גיבוי עכשיו״ במסך ״גיבוי ושחזור״.
- **״אומת״:** אחרי ההעלאה הקובץ נקרא מהיעד, וגודלו ו־SHA-256 שלו מושווים למה שהוצפן. זה אינו שחזור בדיקה; השחזור המבודד והתרגיל הרבעוני שייכים לכרטיס [#35](https://github.com/ItayBar1/fair-shifts/issues/35).
- **שמירה:** עד 30 עותקים. כשאין מקום נמחקים גיבויי היישום הוותיקים, אבל לא העותק המאומת האחרון. היישום רואה ב־Drive רק קבצים שיצר בעצמו (`drive.file`), ומוחק לצמיתות ולא לאשפה.
- **כשלים:** כשל זמני נוסה שוב אחרי 15 דקות ואחרי שעה. מפתח חסר, הרשאה שפגה ונפח חסר נכשלים מיד. התראה נשלחת לחשבון הטכני כהודעת אתר וכמייל (סוג העדפה ״תקלות תפעול״). ביומן העובד ובמסד נשמרת רק קטגוריית השגיאה.

### הגדרות ב־`app.env`

| משתנה                                                                                | משמעות                                                                                                                               |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `BACKUP_STORAGE`                                                                     | `drive` בסביבה אמיתית. ריק: הגיבוי כבוי, והמסך מציג זאת. `directory` מיועד לבדיקות מקומיות בלבד.                                     |
| `AGE_RECIPIENT`                                                                      | המפתח **הציבורי** (`age1…`). בדיקת התצורה דוחה מפתח פרטי.                                                                            |
| `BACKUP_TIME`                                                                        | שעת הגיבוי היומי בשעון ישראל, בתבנית `HH:MM`.                                                                                        |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` | לקוח OAuth ואסימון רענון של חשבון Google הייעודי, בהרשאה `drive.file` בלבד. אין להשתמש בחשבון של חייל או באותו לקוח של כניסת Google. |
| `GOOGLE_DRIVE_FOLDER_ID`                                                             | רשות. ריק: היישום יוצר תיקייה משלו ושומר בה. בהרשאת `drive.file` תיקייה שנוצרה ידנית אינה נגישה ליישום.                              |

### מפתח ההצפנה

```sh
age-keygen -o fair-shifts-backup.key   # on the technical admin's computer, not the server
age-keygen -y fair-shifts-backup.key   # prints the public key for AGE_RECIPIENT
```

הקובץ הפרטי נשמר מחוץ לשרת ומחוץ ל־Drive, לפחות בשני עותקים בידי המנהל הטכני. בלעדיו אי אפשר לפענח אף גיבוי. פענוח לבדיקה: `age --decrypt -i fair-shifts-backup.key <file> > backup.dump`, ואחריו `pg_restore` למסד מבודד בלבד.

חשבון Google, מצב האפליקציה ב־OAuth (במצב Testing אסימון הרענון פג אחרי שבעה ימים) ובדיקת ההעלאה והשחזור מול Drive אמיתי שייכים לכרטיס [#37](https://github.com/ItayBar1/fair-shifts/issues/37). עד אז הגיבוי לא נבדק מול Drive אמיתי.

## משלוח מייל ומכסה

בתמונת המצב מופיעה שורת ״משלוח מייל״, ובמסך ״משלוחי מייל״ מוצגים מכסת היום, התור, הממתינים למכסה ו־20 הכשלים האחרונים מהשבוע. מוצגים סוג המייל, הסיבה, מספר הניסיונות והמועדים בלבד, בלי נמענים ובלי תוכן (הכרעה 177).

- **מתי יוצא מייל:** קוד כניסה וקוד לאימות כתובת נשלחים תוך שניות. בזמן השמירה בתור נשלח אות PostgreSQL (`LISTEN`/`NOTIFY`, ערוץ `fair_shifts_mail_due`), שנמסר רק אחרי commit, והעובד מאזין לו בחיבור משלו. שאר ההודעות יוצאות בסבב הדקה, שהוא גם הגיבוי לאות שלא הגיע. אחרי ניתוק החיבור העובד מתחבר מחדש תוך 5 שניות, ורושם ביומן `Mail signal connection lost` (הכרעה 188).
- **כתובות בדיקה:** מייל לדומיין ששמור לבדיקות (`.invalid`, ‏`.test`, ‏`.example`, ‏`.localhost`, ‏`example.com/net/org`) לא נשלח ל־Brevo ולא נספר במכסה. הוא מסומן כדילוג (`reserved_address`), והודעת האתר נשארת (הכרעה 190). כך החיילים הסינתטיים ב־staging לא יוצרים מיילים שחוזרים.
- **מכסה:** 300 ביום לפי `MAIL_QUOTA_TIME_ZONE` (ברירת מחדל UTC). הודעות, כולל התראות גיבוי, נעצרות ב־290, ו־10 האחרונים שמורים לקודי כניסה ולאימות מייל. אין שדרוג אוטומטי למסלול בתשלום.
- **השהיה:** כשהספק דוחה את מפתח ה־API או את השולח, המשלוח מושהה לרבע שעה ומתחדש מעצמו. יש לבדוק את `BREVO_API_KEY` ו־`BREVO_SENDER_EMAIL`. כשהספק מודיע שהמכסה שלו נגמרה, המשלוח מושהה עד היום הבא.
- **דף הכניסה:** בזמן השהיה, או כשגם המכסה השמורה לקודים נגמרה, מי שמבקש קוד רואה הודעת עיכוב כללית ומופנה לאחראי. ההודעה זהה לכל כתובת.
- **כשלים:** ״הספק דחה את המייל״ פירושו כתובת או תוכן שנדחו, בלי ניסיון נוסף. ״גם אחרי ניסיונות חוזרים״ פירושו חמישה ניסיונות, או שתוקף המייל פג לפני הניסיון הבא. ״המכסה נגמרה״ פירושו שהמייל חיכה למכסה עד שתוקפו פג. בכל המקרים הודעת האתר והפעולה עצמה נשמרות.

## בדיקת התצורה ב־Docker

```sh
sh scripts/production-smoke.sh
```

הבדיקה בונה תמונה, מוודאת שבדיקת התצורה דוחה סודות פיתוח בלי להדפיס אותם, יוצרת תצורה סינתטית ומוודאת הרשאות 600 ושאתחול חוזר אינו דורס. אחר כך היא מעלה את המסד, האתר והעובד וממתינה לבריאות `ok` עם אותה גרסה ובלי שדות נוספים. היא בודקת שלמסד אין יציאה החוצה, הורגת את העובד ומוודאת שהופעל מחדש, עוצרת בתוך זמן החסד בלי SIGKILL, ומוודאת שהנתונים נשמרים אחרי `down` ו־`up`. בסוף היא מוחקת את הסביבה הזמנית. cloudflared אינו נבדק כאן, כי הוא דורש אסימון אמיתי; החיבור נבדק בכרטיס #25.

## מה עוד לא נבדק

- staging (#25): התוצאות בכרטיס. נותרה בדיקה של שמירת נתונים אחרי reboot, כשיש כבר נתונים.
- גיבוי מול Drive אמיתי (כרטיס #37) ושחזור מבודד עם החלת מחיקות (#35).
- פריסה אוטומטית (#36): נבדקה מול מאגר Git אמיתי עם פריסה מדומה (`scripts/auto-deploy-test.sh`). טרם הודגמה בשרת, כולל תקלה וחזרה, וגיבוי אוטומטי לפני מיגרציה טרם מומש.
- משלוח Brevo וכניסת Google בחשבונות בדיקה (כרטיסים #28 ו־#26).
