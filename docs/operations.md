# הפעלה ב־Ubuntu עם Docker ו־Cloudflare Tunnel

29.09.2026 · כרטיס [#24](https://github.com/ItayBar1/fair-shifts/issues/24) (FS-25) · הכרעה 167 ב[יומן ההכרעות](open-decisions.md).

המסמך מתאר את תצורת ההפעלה שבמאגר ואת אופן השימוש בה. מ־30.09.2026 תועדה סביבת staging סינתטית על שרת המשתמש, דרך Cloudflare Tunnel (כרטיס [#25](https://github.com/ItayBar1/fair-shifts/issues/25) נסגר לאחר ההדגמה). אין ראיית סביבת production. הפריסה האוטומטית (כרטיס [#36](https://github.com/ItayBar1/fair-shifts/issues/36), הכרעה 186) מתוארת בהמשך. [ביקורת 05.10.2026](audits/2026-10-05/backlog-operations.md) בדקה את התיעוד והקוד; לא בוצע בה חיבור לשרת או אימות מצבו החי.

כל פלט שנקרא בשרת כתוב באנגלית: סקריפטים, יומני קונטיינרים ו־systemd, הודעות בדיקת התצורה, הערות ב־`app.env` וההערות בבלוקי הפקודות כאן. מסוף Linux מציג עברית משמאל לימין (הכרעה 187). ממשק האתר נשאר בעברית. הגיבוי (כרטיס [#27](https://github.com/ItayBar1/fair-shifts/issues/27)) מתואר בהמשך; בכרטיס [#37](https://github.com/ItayBar1/fair-shifts/issues/37) תועדו גיבויים וכשלי ספק מול Drive אמיתי, אך תרגיל הורדה, פענוח ושחזור מבודד ממנו עם החלת המחיקות טרם הוכח. שימוש בנתוני אמת מותר רק אחרי שער הפיילוט שבאפיון.

## מה יש במאגר

| קובץ                                | תפקיד                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `compose.production.yaml`           | ההפעלה: מסד, אתר, עובד ו־cloudflared. נפרד מ־`compose.yaml` של הפיתוח, שכולל סודות סינתטיים ואסור לחשוף אותו לאינטרנט. |
| `scripts/production.sh`             | עטיפה ל־Compose: `init`, `deploy`, `health` וכל פקודת Compose אחרת (`ps`, `logs`, `stop`, `down`).                     |
| `scripts/init-production-config.ts` | יוצר את קובצי התצורה עם סודות אקראיים. רץ בתוך תמונת היישום, ואינו דורס קבצים קיימים.                                  |
| `scripts/check-config.ts`           | בודק את המשתנים לפני מיגרציה ולפני עליית האתר או העובד. שגיאה עוצרת את הקונטיינר; ההודעות מציינות שם משתנה בלי ערך.    |
| `scripts/production-smoke.sh`       | בדיקת התצורה ב־Docker עם נתונים וסודות סינתטיים (פירוט בהמשך). רצה גם ב־CI.                                            |
| `scripts/auto-deploy.sh`            | פריסה אוטומטית של main אחרי שהבדיקות עברו, מטיימר systemd (`scripts/systemd`). פירוט בהמשך.                            |
| `scripts/restore.ts`                | שחזור מבודד מגיבוי, תרגיל רבעוני והחלפת המסד החי (`pnpm restore`). פירוט בסעיף ״שחזור מבודד ותרגיל רבעוני״.            |
| `scripts/technical-email.ts`        | החלפת כתובת המנהל הטכני דרך השרת כשאין גישה לכתובת הנוכחית (`pnpm technical-email`). פירוט בסעיף ״סביבת ה־staging״.    |
| `scripts/calendar-recover.ts`       | התאוששות מיצירת יומן שתוצאתה אינה ידועה, עם אימות מזהה קיים או אישור מפורש לנסות שוב.                                  |
| `/api/health`                       | בריאות האתר, המסד ופעימת העובד, בלי מידע אישי. הפירוט מוצג גם למנהל הטכני ב״תמונת מצב״.                                |

## מבנה ההפעלה

- **db** — PostgreSQL 18 עם נפח קבוע `postgres-data`. הוא מחובר רק לרשת `internal`, שאין לה יציאה אל מחוץ לשרת, ואין לו פורט פתוח.
- **app** — Next.js במצב production. בכל עלייה נבדקת התצורה, ואחר כך מוחלות המיגרציות תחת נעילה. גם לו אין פורט פתוח; הגישה אליו עוברת רק דרך cloudflared ברשת הפנימית של Compose.
- **worker** — אותה תמונה ואותה גרסה של האתר. הוא עולה רק אחרי שהאתר תקין, כלומר אחרי המיגרציות. כל דקה הוא רושם פעימה במסד ובקובץ שבודקת בדיקת הבריאות של הקונטיינר.
- **נפח `deletion-log`** — נפח נפרד שהעובד כותב אליו את יומן המחיקות העצמאי (בסעיף הבא). הוא אינו חלק מהמסד ולא מהגיבויים, ואסור למחוק אותו: `down --volumes` מוחק גם אותו.
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

**גיבוי לפני מיגרציה (הכרעה 191):** כש־`BACKUP_STORAGE` מוגדר, לפני פריסה של גרסה עם שינוי מסד הטיימר מריץ `scripts/backup-before-deploy.ts` בעובד של הגרסה שעדיין פעילה. הפקודה מחכה לגיבוי שכבר ממתין או רץ, מבקשת גיבוי משלה ומחכה ל״אומת״, גם דרך הניסיונות החוזרים אחרי 15 דקות ואחרי שעה. רק אז הגרסה נפרסת. במסך ״גיבוי ושחזור״ הריצה מסומנת ״לפני עדכון גרסה״. הגרסה נעצרת כשהגיבוי נכשל סופית (החשבון הטכני מקבל את ההתראה הרגילה), כשהעובד לא לקח את הריצה 10 דקות אחרי מועדה, או כשמצב שחזור פעיל. ב־production בלי גיבוי מוגדר גרסה כזו נעצרת. ב־staging בלי גיבוי (`BACKUP_STORAGE` ריק) היא נפרסת בלי גיבוי, ובלוג נכתב זאת. זו החלטת המשתמש, כי הנתונים סינתטיים. גם אחרי גיבוי, פריסה שנכשלה אחרי המיגרציה אינה חוזרת אוטומטית; הנוהל לחזרה מהגיבוי בסעיף ״עדכון, מיגרציה וחזרה למצב קודם״ בהמשך.

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
rm /opt/fair-shifts/deploy-state/stopped            # retry a stopped commit, e.g. after a CI re-run passed or a backup was fixed
```

יחידה שנכשלה מופיעה ב־`systemctl --failed`. גרסה שנעצרה בלי גיבוי מאומת (`no verified backup` בלוג): בודקים את הריצה במסך ״גיבוי ושחזור״ ואת העובד (`sh scripts/production.sh logs --tail 50 worker`), מתקנים, ומוחקים את `stopped` כדי לנסות שוב. כדי לפרוס ידנית בזמן שהטיימר פעיל, משהים קודם ומחדשים אחרי הפריסה. אחרי פריסה ידנית של commit אחר מ־main, רושמים אותו: `git rev-parse HEAD > /opt/fair-shifts/deploy-state/deployed`.

## סביבת ה־staging

כרטיס [#25](https://github.com/ItayBar1/fair-shifts/issues/25), הכרעה 189. סביבה סינתטית לתרגול ההפעלה ולבדיקות מול ספקים אמיתיים. אין בה נתוני חיילים אמיתיים.

| פריט    | ערך                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| כתובת   | `https://classly-studio-management.uk`. זה דומיין של אתר קודם שהוסר מהשרת, והוא משמש זמנית לבדיקות. החלפה: `BETTER_AUTH_URL`, ה־Route ב־Tunnel, ה־redirect ב־Google והשולח ב־Brevo.                                            |
| שרת     | Ubuntu של המשתמש. הקוד ב־`/opt/fair-shifts/app`, התצורה ב־`/opt/fair-shifts/config`, מצב הפריסה ב־`/opt/fair-shifts/deploy-state`.                                                                                             |
| תצורה   | `DEPLOYMENT_ENVIRONMENT=staging`, ‏`MAIL_TRANSPORT=brevo` ושולח מאומת, ‏`MAIL_QUOTA_TIME_ZONE=Asia/Jerusalem`. גיבוי Drive תועד כמופעל ב־#37. Google הוקם עם משתמשי בדיקה; מצב OAuth הנוכחי דורש אימות ישיר לפני הרחבת השימוש. |
| עדכון   | הטיימר של הפריסה האוטומטית (בסעיף הקודם). שירותים אחרים שרצים באותו שרת לא שייכים לפרויקט, ואין לגעת בהם.                                                                                                                      |
| חשבונות | מנהל טכני ואחראי מ־`bootstrap`, עם כתובות הבדיקה של המשתמש. הכתובות לא נשמרות במאגר. קודי השחזור של הטכני נשמרים אצל המשתמש.                                                                                                   |

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
- **החלפת כתובת המנהל הטכני (#90, הכרעה 204):** בדרך כלל באתר, במסך ״החשבון שלי״ של הטכני: נשלחים שני קודים, אחד לכל כתובת. כשאין גישה לכתובת הנוכחית (למשל הטכני עזב), מי שיש לו גישה לשרת מריץ שתי פקודות. הראשונה שולחת קוד לכתובת החדשה בלבד, והמייל יוצא מהעובד, ולכן הוא חייב לרוץ:

```sh
cd /opt/fair-shifts/app
sh scripts/production.sh exec -T -e TECHNICAL_CURRENT_EMAIL=<current address> -e TECHNICAL_NEW_EMAIL=<new address> \
  -e TECHNICAL_CHANGE_REASON="<reason, at least 5 characters>" app node_modules/.bin/tsx scripts/technical-email.ts request
# the code arrives at the new address and is valid for 10 minutes; then:
sh scripts/production.sh exec -T -e TECHNICAL_CURRENT_EMAIL=<current address> -e TECHNICAL_CHANGE_CODE=<code> \
  app node_modules/.bin/tsx scripts/technical-email.ts confirm
```

אחרי האישור: ההחלפה מבטלת את כל החיבורים של החשבון ואת קישור Google, מבטלת את קודי השחזור הישנים ומדפיסה קודים חדשים פעם אחת, שנשמרים מחוץ למאגר. היא אינה משחררת חשבון נעול (`recover`), וכתובת לבדיקות שמורה (הכרעה 190) אינה מקבלת מייל. אחרי ההחלפה נכנסים עם הכתובת החדשה, בקוד או ב־Google. אותה פקודה מעבירה את החשבון הטכני של ה־staging לחשבון הייעודי של הפרויקט.

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
- **״אומת״:** אחרי ההעלאה הקובץ נקרא מהיעד, וגודלו ו־SHA-256 שלו מושווים למה שהוצפן. זה אינו שחזור בדיקה; השחזור המבודד והתרגיל הרבעוני בסעיף ״שחזור מבודד ותרגיל רבעוני״.
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
age-keygen -o ~/fair-shifts-backup.key   # on the technical admin's computer, outside the repository, not the server
age-keygen -y ~/fair-shifts-backup.key   # prints the public key for AGE_RECIPIENT
```

הקובץ הפרטי נשמר מחוץ לשרת ומחוץ ל־Drive, לפחות בשני עותקים בידי המנהל הטכני. בלעדיו אי אפשר לפענח אף גיבוי. פענוח לבדיקה: `age --decrypt -i fair-shifts-backup.key <file> > backup.dump`, ואחריו `pg_restore` למסד מבודד בלבד.

### חיבור Drive וחידוש הרשאה

כרטיס [#37](https://github.com/ItayBar1/fair-shifts/issues/37). ההגדרה בחשבון Google הייעודי:

1. פרויקט Cloud נפרד מהפרויקט של כניסת Google, ובו Google Drive API מופעל.
2. ב־Google Auth Platform: ב־Audience ‏External, ב־Data Access ההרשאה `.../auth/drive.file` בלבד, והאפליקציה מפורסמת (**In production**). במצב Testing אסימון הרענון פג אחרי שבעה ימים.
3. לקוח OAuth מסוג Web application, עם redirect ‏`https://developers.google.com/oauthplayground`. סוד הלקוח מוצג פעם אחת בלבד, ונשמר מיד במנהל הסיסמאות.
4. אסימון רענון ב־[OAuth Playground](https://developers.google.com/oauthplayground):
   - בגלגל השיניים: Access type ‏Offline, ו־**Use your own OAuth credentials** עם הלקוח מסעיף 3.
   - ההרשאה `drive.file`, התחברות עם החשבון הייעודי, ואז Exchange.
   - **במסך ההסכמה צריך להופיע שם האפליקציה מ־Branding.** אם מופיע "Google OAuth 2.0 Playground", האסימון שייך ללקוח של Google ויידחה. הגיבוי ייכשל כ"הרשאה פגה", ויש להסיר את הגישה של Playground ב־[האפליקציות המקושרות](https://myaccount.google.com/connections).

**הרשאה שפגה או בוטלה:** הגיבוי נכשל מיד, בלי ניסיונות חוזרים, והחשבון הטכני מקבל הודעה ומייל. מפיקים אסימון חדש לפי סעיף 4 ומחליפים רק אותו:

```sh
cd /opt/fair-shifts/app && [ "$(git rev-parse HEAD)" = "$(cat /opt/fair-shifts/deploy-state/deployed)" ] && touch /opt/fair-shifts/deploy-state/paused && echo "OK: timer paused" || echo "STOP: checkout differs from the live version"
read -rsp 'Drive refresh token: ' token; echo   # paste this line on its own
env=/opt/fair-shifts/config/app.env; { grep -v '^GOOGLE_DRIVE_REFRESH_TOKEN=' "$env"; printf 'GOOGLE_DRIVE_REFRESH_TOKEN=%s\n' "$token"; } > "$env.new" && chmod 600 "$env.new" && mv "$env.new" "$env"; unset token
sh scripts/production.sh up -d --wait --no-build --force-recreate app worker && sh scripts/production.sh health && rm -f /opt/fair-shifts/deploy-state/paused
```

אחר כך מריצים ״גיבוי עכשיו״ ומוודאים שהוא מגיע ל״אומת״.

**מה נבדק מול Drive אמיתי ב־staging (01.10.2026):**

- גיבוי יומי וגיבוי ידני אומתו.
- **הרשאה שבוטלה:** כשל מיידי בניסיון אחד, עם הודעה ומייל, ואחר כך חזרה לעבודה עם אסימון חדש.
- **כשל רשת:** ניתוק זמני של העובד. הריצה נכשלה זמנית, נוסתה שוב אחרי 15 דקות ואומתה בניסיון השני, בלי התראה.
- **שמירה של 30 עותקים:** 28 גיבויים ברצף. נשארו 30 עותקים, שני הוותיקים נמחקו לצמיתות (לא לאשפה), וקובץ שהועלה ידנית לתיקיית הגיבויים וקובץ מחוץ לה נשארו.
- **נפח:** המקום הפנוי שהמסך מציג תואם את Google. נפח שנגמר באמת לא נבדק מול Drive, כי צריך למלא 15GB; ההתנהגות הזאת נבדקה ב־Docker.

ההורדה, הפענוח והשחזור המבודד מ־Drive שייכים ל־#35 ול־#37.

## יומן מחיקות עצמאי ושחזור מחיקות

כרטיס [#34](https://github.com/ItayBar1/fair-shifts/issues/34), הכרעה 196. גיבוי מחזיר את המצב שהיה ברגע שנוצר, ולכן מחיקת משתמש שנעשתה אחריו מתבטלת בשחזור ומידע שנמחק חוזר. כדי למנוע זאת כל מחיקה נרשמת ביומן שאינו חלק מהמסד.

- **מה ביומן:** שורה לכל מחיקה, עם מזהה פנימי של החייל, מועד המחיקה ושרשרת גיבובים (SHA-256) לשורה הקודמת. אין שם, מספר אישי, פרטי קשר או סיבה, ולכן שמירתו מחוץ למסד אינה שומרת מידע רגיש.
- **איפה:** הקובץ `deletion-log.jsonl` בנפח `deletion-log` (בקונטיינר: `DELETION_LOG_DIRECTORY=/var/lib/fair-shifts-deletion-log`, מוגדר ב־`compose.production.yaml`, ואין צורך לשנות את `app.env`). עותק שלו נשמר בתיקיית הגיבויים ב־Drive כקובץ נפרד, שאינו נספר במחזור 30 העותקים. כשהגיבוי כבוי (`BACKUP_STORAGE` ריק) אין עותק, ואז אובדן הנפח הוא אובדן היומן. יומן ריק אינו מועתק; העותק הראשון נוצר עם המחיקה הראשונה.
- **כתיבה:** המחיקה רושמת בעסקתה רשומה ממתינה, והעובד כותב אותה ליומן תוך שניות (אות `fair_shifts_deletion_log`) ובסבב הדקה. כתיבה שנכשלה אינה מעכבת מחיקה: הרשומה ממתינה וניסיון חוזר נעשה בכל דקה. כשל שנמשך עשר דקות מדווח לחשבון הטכני פעם ביום, בהודעת אתר ובמייל בסוג ״תקלות תפעול״. בלוג העובד: `Deletion log failure: …`.
- **מה מוצג לטכני:** שורת ״יומן מחיקות עצמאי״ במסך ״מצב המערכת״: כבוי, תקלה בכתיבה, לא אומת, מספר ממתינות, ללא עותק ב־Drive או עותק מתעכב. אימות יומי (בלי דרישה לגישה ל־Drive) מעדכן את השורה.
- **נזק:** קובץ שנחתך באמצע שורה אחרי קריסה מתוקן מעצמו. קובץ שנשבר, או שחסר כשיש היסטוריה, אינו מקבל שורות והעובד מנסה להחזיר אותו מהעותק ב־Drive; אם גם זה לא אפשרי, נוצרת התראה. עותק ב־Drive שנמצא לפני הקובץ המקומי או מספר היסטוריה אחרת אינו נדרס.

### אחרי שחזור מגיבוי

בשחזור, אחרי שהמסד שוחזר ולפני שהאתר והעובד נפתחים למשתמשים (מצב שחזור, `RESTORE_MODE=true` או שורת `restore` במסד), מריצים בשרת, בתיקיית היישום:

```sh
export FAIR_SHIFTS_CONFIG_DIR=/opt/fair-shifts/config
# 1. Read only: is the log whole, do its copies agree, does the database know anything it lacks?
sh scripts/production.sh run --rm --no-deps worker node_modules/.bin/tsx scripts/deletion-log.ts verify
# 2. Verify again and apply the deletions the restored database does not show yet.
sh scripts/production.sh run --rm --no-deps worker node_modules/.bin/tsx scripts/deletion-log.ts apply
```

- `verify` מדפיס מצב כל עותק (מקומי ובאחסון), את הסיבות לאי־אימות ואזהרות (עותק שחסר או מפגר). קוד יציאה 0 רק כשהיומן מאומת.
- `apply` מחילה כל מחיקה שביומן ושהמסד אינו מציג, לפי הסדר ובמועד המקורי, כמו מחיקה רגילה: פינוי שיבוצים עתידיים, סימון שיבוצים בתורנות שהחלה לטיפול דחוף, הסרת מידע רגיש וביטול גישה. חייל שכבר נמחק או שאינו במסד מדולג. הרצה חוזרת אינה משנה דבר. הפעולה נרשמת ביומן הפעולות, והאחראים מקבלים הודעה ומייל. בסיום החוסם `deletion_log` של שער השחזור יורד. השער נפתח לגישה ולמשלוח רק כשכל החוסמים ירדו; בדיקות נוספות של השחזור (#35) מצטרפות לאותו שער.
- **יומן חסר או לא מאומת:** `apply` משאירה את הגישה והמשלוח חסומים ומדפיסה את הסיבה (`no_log`, ‏`local_broken`, ‏`remote_broken`, ‏`remote_unreadable`, ‏`diverged`, ‏`database_ahead`, ‏`database_mismatch`, ‏`unlogged_deletions`). מתקנים (למשל מחזירים את הקובץ או את העותק) ומריצים שוב. אם אי אפשר, ואחרי בירור מה נמחק מאז הגיבוי, אפשר לשחרר את החסימה בפקודה עם סיבה ועם משפט האישור המדויק:

```sh
DELETION_LOG_REASON="no log copy exists; deletions since the backup were checked by hand" \
DELETION_LOG_ACKNOWLEDGE="deleted data may return" \
sh scripts/production.sh run --rm --no-deps -e DELETION_LOG_REASON -e DELETION_LOG_ACKNOWLEDGE \
  worker node_modules/.bin/tsx scripts/deletion-log.ts acknowledge
```

הפקודה נרשמת ביומן הפעולות עם הסיבה ועם סיבות אי־האימות, והאחראים מקבלים הודעה שמידע שנמחק עלול לחזור. היא אינה מחילה מחיקות: מחיקות שנעשו אחרי הגיבוי ואינן ביומן חוזרות על ידי אחראי.

השחזור המבודד עצמו, בדיקות הנתונים הנוספות שלו והתרגיל הרבעוני בסעיף הבא, והם משתמשים באותן פקודות ובאותו שער: שחזור שנועד לעלות לאוויר מריץ את החלת המחיקות בעצמו, ופקודות היומן כאן נשארות לטיפול ביומן שלא אומת. הכתיבה של היומן ל־Drive נבדקה עד כה מול אחסון תיקייה בלבד; בדיקה מול Drive אמיתי שייכת ל־#37.

## שחזור מבודד ותרגיל רבעוני

כרטיס [#35](https://github.com/ItayBar1/fair-shifts/issues/35), הכרעה 200. גיבוי שלא שוחזר אינו הוכחה שאפשר לשחזר אותו. הפקודה `restore` טוענת גיבוי **למסד נפרד** לצד החי, מעלה אותו לסכמה של הגרסה, סוגרת אותו מאחורי שער השחזור, מחילה את המחיקות מהיומן העצמאי ובודקת אותו. המסד החי אינו משתנה עד ההחלפה המפורשת.

```sh
# All commands run in a one-off worker container; the database must be up.
export FAIR_SHIFTS_CONFIG_DIR=/opt/fair-shifts/config
fsr() { sh scripts/production.sh run --rm --no-deps -T worker node_modules/.bin/tsx scripts/restore.ts "$@"; }
fsr list                      # the encrypted backups in the storage; before-update marks the one taken before a migration
fsr fetch > backup.dump.age   # newest verified backup (or --backup <name>) to the standard output
fsr drill ...                 # restore into <database>_drill, check, report, drop it
fsr restore ...               # restore into <database>_restore and keep it
fsr promote                   # swap it in place of the live database (site and worker stopped)
```

### מה נבדק

הדוח מדפיס מצב לכל בדיקה. כישלון (`FAIL`) פוסל את העותק; אזהרה (`WARN`) מדווחת ואינה חוסמת. הדוח כולל מספרים ומזהים פנימיים בלבד, בלי שמות, מספרים אישיים או פרטי קשר.

| בדיקה                     | מה היא מוכיחה                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `migrations_known`        | כל מיגרציה בגיבוי מוכרת לגרסה. גיבוי של גרסה חדשה נדחה בלי בדיקות נוספות; גיבוי ישן מועלה לגרסה הנוכחית |
| `versions`                | גרסאות הרשומות חיוביות (כישלון); גרסה בנתונים שאינה זהה לעמודה היא אזהרה                                |
| `assignment_links`        | כל שיבוץ מצביע לתורנות, למקום ולחייל, והמקום שייך לתורנות                                               |
| `deleted_soldier_seats`   | חייל שנמחק אינו מחזיק מקום בתורנות שטרם התחילה                                                          |
| `balances_present`        | לכל חייל יש יתרה                                                                                        |
| `ledger_arithmetic`       | בכל רישום ביומן הניקוד אחרי = לפני + סכום, ואף ערך אינו שלילי                                           |
| `balances_match_ledger`   | יתרת כל חייל שווה לסכום יומן הניקוד שלו                                                                 |
| `credited_have_ledger`    | שיבוץ שנזקף הגיע ליומן, או שממתינה לו החלטת ניקוד                                                       |
| `no_double_credit`        | שיבוץ שמור או מוחזק אינו נושא זקיפת ביצוע                                                               |
| `performance_orphans`     | אזהרה: זקיפת ביצוע שאין לה שיבוץ                                                                        |
| `accounts`                | כל חשבון שייך לחייל קיים, וחשבון של חייל שנמחק הוסר                                                     |
| `technical_account`       | קיים חשבון טכני פעיל                                                                                    |
| `deleted_soldier_residue` | לחייל שנמחק לא נשארו פרטי קשר, תנאי התאמה, רשומות והודעות מלפני המחיקה, חומר כניסה או מיילים בתור       |

אחרי הבדיקות מופיעה שורת היומן (`Deletion log: applied through entry N` או `BLOCKED`). התוצאה: `PASSED`, `NEEDS_DELETION_LOG` (הנתונים תקינים, והיומן לא אומת: העותק נשאר סגור עד הפקודה של הכרעה 196) או `FAILED`. קוד היציאה 0 רק ב־`PASSED`.

### מפתח הפענוח אינו על השרת

המפתח הפרטי של age נשמר רק אצל הטכני (סעיף ״מפתח ההצפנה״). כדי שגם הטקסט הגלוי לא ייכתב לדיסק של השרת, מפענחים במחשב הטכני ומזרימים לשרת:

```sh
# On the technical admin's computer. <name> is a file name from "restore list".
ssh server 'cd /opt/fair-shifts/app && FAIR_SHIFTS_CONFIG_DIR=/opt/fair-shifts/config sh scripts/production.sh run --rm --no-deps -T worker node_modules/.bin/tsx scripts/restore.ts fetch --backup <name>' > backup.dump.age
age --decrypt -i ~/fair-shifts-backup.key backup.dump.age |
  ssh server 'cd /opt/fair-shifts/app && FAIR_SHIFTS_CONFIG_DIR=/opt/fair-shifts/config sh scripts/production.sh run --rm --no-deps -T worker node_modules/.bin/tsx scripts/restore.ts drill --dump - --point <name>'
```

אפשר גם להוריד את הקובץ ידנית מ־Drive (החשבון הייעודי מציג את הקבצים שהיישום יצר), או להשתמש ב־`--file` וב־`--identity` כשהטכני בוחר להניח מפתח זמני בשרת: הקבצים צריכים להיות מחוברים לקונטיינר של הריצה (`run -v <path>:/run/identity:ro`, ו־`--identity /run/identity`), ולהימחק אחריה. בלי `--dump`, `--file` או גיבוי מוגדר ב־Drive, הפקודה מסרבת.

### תרגיל רבעוני

מבצע הטכני אחת לרבעון, ובכל מקרה כשההתראה ״הגיע הזמן לתרגיל שחזור״ מגיעה (אחרי 100 יום, ושוב כל 30 יום). התרגיל אינו נוגע במסד החי, בגישה, בקובץ היומן או במיילים, ולכן אפשר לבצעו בשרת פעיל.

1. `fsr list`: מוודאים שיש גיבוי מאומת מהימים האחרונים.
2. מריצים `drill` לפי הפקודה לעיל (עם `--dump -` מהמחשב הטכני).
3. קוראים את הדוח: `PASSED`, יומן מחיקות שהוחל (`Deletion log: applied`), ומספרי השורות סבירים (חיילים, שיבוצים, רישומי ניקוד).
4. ב״מצב המערכת״ מופיעה השורה ״תרגיל שחזור אחרון״ עם התאריך. תרגיל שנכשל מוצג ״הניסיון האחרון נכשל״ ואינו מאפס את הספירה.

כשל בתרגיל הוא ממצא: בודקים מה הדוח מציין, ומריצים תרגיל נוסף על גיבוי אחר (`--backup`). אין להסיק שהגיבוי תקין עד שתרגיל עבר. תרגיל בסביבת פיתוח, עם נתונים סינתטיים בלבד, רץ ב־Docker: `sh scripts/docker.sh --profile test run --build --rm tests pnpm vitest run tests/integration/restore.test.ts --no-file-parallelism` יוצר גיבוי מוצפן, מוחק חייל אחרי הגיבוי ומשחזר.

### שחזור שנועד לעלות לאוויר

בכל שחזור אובדים שינויים שנעשו אחרי מועד הגיבוי: שיבוצים, אילוצים, בקשות, נעילות והרשאות; קוד שחזור טכני שנוצל אחריו חוזר להיות בר־שימוש; ומיילים שנשלחו מאז עלולים להישלח שוב. היומן העצמאי מחזיר רק מחיקות. לכן שחזור הוא החלטה של הטכני.

```sh
# On the server: stop the site and the worker; the database container stays up.
cd /opt/fair-shifts/app
export FAIR_SHIFTS_CONFIG_DIR=/opt/fair-shifts/config
sh scripts/production.sh stop app worker
# On the technical admin's computer: decrypt, and pipe the plaintext into the restore.
age --decrypt -i ~/fair-shifts-backup.key backup.dump.age |
  ssh server 'cd /opt/fair-shifts/app && FAIR_SHIFTS_CONFIG_DIR=/opt/fair-shifts/config sh scripts/production.sh run --rm --no-deps -T worker node_modules/.bin/tsx scripts/restore.ts restore --dump - --point <name>'
# On the server: swap it in, start, check.
fsr promote                                           # renames the live database aside, the copy into its place
sh scripts/production.sh up -d --wait --no-build app worker
sh scripts/production.sh health
```

- **אם הבדיקות עברו (`PASSED`):** `promote` מחליף את המסד. המסד הקודם נשמר בשם `<database>_before_restore_<time>`; מוחקים אותו כשאין בו עוד צורך, כי הוא מכיל את כל המידע החי.
- **`NEEDS_DELETION_LOG`:** `promote` אפשרי, והמערכת נשארת סגורה. מתקנים את היומן ומריצים `deletion-log apply`, או אחרי בירור `deletion-log acknowledge` (סעיף ״אחרי שחזור מגיבוי״ למעלה).
- **`FAILED`:** העותק נשמר לבדיקה (`<database>_restore`), המסד החי לא נגע, ו־`promote` מסרב. בוחרים גיבוי אחר, ובסוף מוחקים את העותק: `sh scripts/production.sh exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "drop database <database>_restore"'`.
- **מה קורה בפתיחה:** כל החיבורים, קודי הכניסה ואסימוני האימות הממתינים מבוטלים וכולם נכנסים מחדש; מיילים ממתינים מבוטלים; האחראים והטכני מקבלים הודעת אתר ומייל עם מועד הגיבוי (הכרעה 200). אחרי הפתיחה הטכני בודק אילו חשבונות ננעלו, שוחררו או שינו הרשאה אחרי מועד הגיבוי, ומחזיר אותם.
- **קבצי גיבוי ב־Drive** שנוצרו אחרי הגיבוי ששוחזר אינם ידועים למסד המשוחזר ואינם נספרים במחזור 30 העותקים. מוחקים אותם ידנית כשהם מיותרים.
- `promote` מסרב כשיש חיבור פתוח לאחד המסדים; עוצרים קודם את האתר והעובד. אם `restore` או `promote` נכשלו באמצע, המסד החי נשאר כפי שהיה.

### עדכון, מיגרציה וחזרה למצב קודם

הפריסה האוטומטית מריצה גיבוי מאומת לפני גרסה שמשנה את המסד (סעיף ״גיבוי לפני מיגרציה״), ואינה חוזרת אוטומטית אחרי מיגרציה שנכשלה: היא עוצרת את הגרסה (`stopped`) ומחכה לטכני.

1. עוצרים את הטיימר ומחזירים את התיקייה לגרסה שרצה: `touch /opt/fair-shifts/deploy-state/paused`, ואחר כך `git checkout --detach "$(cat /opt/fair-shifts/deploy-state/deployed)"`. תיקייה שאינה על `main` אינה נפרסת, והקובץ `deployed` עדיין מחזיק את הגרסה התקינה.
2. `sh scripts/production.sh build app` בונה את התמונה של הגרסה התקינה (`APP_VERSION` נקבע מה־commit).
3. עוצרים אתר ועובד, מוצאים ב־`list` את הגיבוי המסומן `before-update` (הגיבוי שנלקח ממש לפני המיגרציה), ומשחזרים אותו לפי הסעיף הקודם, עם כלי השחזור של הגרסה התקינה (התמונה שנבנתה בשלב 2), שסכמתה תואמת לגיבוי. כלי של גרסה חדשה יודע גם לשחזר גיבוי ישן: הוא מעלה אותו לסכמה הנוכחית.
4. מעלים את הגרסה התקינה: `sh scripts/production.sh up -d --wait --no-build app worker` ובודקים `health`. נתונים שנכתבו אחרי הגיבוי אובדים; מחיקות מוחלות מהיומן.
5. כשתיקון נכנס ל־`main`: `git checkout main && git pull --ff-only`, ואז `rm /opt/fair-shifts/deploy-state/paused`. הגרסה שנעצרה (`stopped`) מוחלפת בגרסה החדשה.

גרסה שבדיקות ה־CI שלה נכשלו אינה נפרסת כלל, וגרסה בלי שינוי מסד שנכשלה בפריסה חוזרת אוטומטית לתמונה הקודמת.

## משלוח מייל ומכסה

בתמונת המצב מופיעה שורת ״משלוח מייל״, ובמסך ״משלוחי מייל״ מוצגים מכסת היום, התור, הממתינים למכסה ו־20 הכשלים האחרונים מהשבוע. מוצגים סוג המייל, הסיבה, מספר הניסיונות והמועדים בלבד, בלי נמענים ובלי תוכן (הכרעה 177).

- **מתי יוצא מייל:** קוד כניסה וקוד לאימות כתובת נשלחים תוך שניות. בזמן השמירה בתור נשלח אות PostgreSQL (`LISTEN`/`NOTIFY`, ערוץ `fair_shifts_mail_due`), שנמסר רק אחרי commit, והעובד מאזין לו בחיבור משלו. שאר ההודעות יוצאות בסבב הדקה, שהוא גם הגיבוי לאות שלא הגיע. אחרי ניתוק החיבור העובד מתחבר מחדש תוך 5 שניות, ורושם ביומן `Mail signal connection lost` (הכרעה 188).
- **כתובות בדיקה:** מייל לדומיין ששמור לבדיקות (`.invalid`, ‏`.test`, ‏`.example`, ‏`.localhost`, ‏`example.com/net/org`) לא נשלח ל־Brevo ולא נספר במכסה. הוא מסומן כדילוג (`reserved_address`), והודעת האתר נשארת (הכרעה 190). כך החיילים הסינתטיים ב־staging לא יוצרים מיילים שחוזרים.
- **מכסה:** 300 ביום לפי `MAIL_QUOTA_TIME_ZONE` (ברירת מחדל UTC). מגדירים בו את אזור הזמן של החשבון ב־Brevo, שבו המכסה שלו מתאפסת בחצות, כדי ששני הצדדים יספרו את אותו יום. ב־staging זה `Asia/Jerusalem`. הודעות, כולל התראות גיבוי, נעצרות ב־290, ו־10 האחרונים שמורים לקודי כניסה ולאימות מייל. אין שדרוג אוטומטי למסלול בתשלום.
- **השהיה:** כשהספק דוחה את מפתח ה־API או את השולח, המשלוח מושהה לרבע שעה ומתחדש מעצמו. יש לבדוק את `BREVO_API_KEY` ו־`BREVO_SENDER_EMAIL`. כשהספק מודיע שהמכסה שלו נגמרה, המשלוח מושהה עד היום הבא.
- **דף הכניסה:** בזמן השהיה, או כשגם המכסה השמורה לקודים נגמרה, מי שמבקש קוד רואה הודעת עיכוב כללית ומופנה לאחראי. ההודעה זהה לכל כתובת.
- **כשלים:** ״הספק דחה את המייל״ פירושו כתובת או תוכן שנדחו, בלי ניסיון נוסף. ״גם אחרי ניסיונות חוזרים״ פירושו חמישה ניסיונות, או שתוקף המייל פג לפני הניסיון הבא. ״המכסה נגמרה״ פירושו שהמייל חיכה למכסה עד שתוקפו פג. בכל המקרים הודעת האתר והפעולה עצמה נשמרות.

## תורנויות ביומן Google

כרטיס [#92](https://github.com/ItayBar1/fair-shifts/issues/92), הכרעות 195 ו־205. חייל שנכנס ב־Google ונתן את ההרשאה מקבל את תורנויותיו ביומן ״תורנויות״ בחשבון שלו. היכולת **כבויה** עד שמדליקים אותה בשרת, ובמצב כבוי הכניסה ב־Google ומסכי האתר אינם משתנים.

**סדר ההפעלה (החלטת המשתמש, 02.10.2026):** קודם מעבירים את לקוח ה־OAuth של כניסת Google לחשבון הייעודי של הפרויקט (אותו חשבון שמחזיק את הגיבוי ב־Drive והמיועד להיות המנהל הטכני, כרטיס #90), ורק אחרי זה מוסיפים לו את הרשאת היומן:

**אימות 06.10.2026:** מזהה הלקוח הציבורי מתוך תצורת ה־staging תואם ללקוח `fair-shifts-staging` בפרויקט `fairshifts`. החשבון הייעודי נוסף לפרויקט כ־Owner באישור המשתמש, ותוצאת השמירה אומתה ב־IAM; הבעלים הקודם נשאר. אין צורך להחליף מזהה או סוד בשרת. פרויקט `fairshifts-backup` ולקוח `fair-shifts-backup` נשארים נפרדים. לקוח הכניסה נמצא ב־Testing עם שלושה משתמשי בדיקה. לאחר אישור מפורש של המשתמש לתנאים, **Calendar API הופעל** וסטטוס `Enabled` אומת; ההיקף `calendar.app.created` נשמר לצד היקפי הכניסה `openid`, ‏`userinfo.email` ו־`userinfo.profile`, עם אישור `Data access changes saved`. בקונסולה ארבעתם מוצגים תחת `Your non-sensitive scopes`; אין היקפים רגישים או מוגבלים מוצהרים. נותרו מיזוג הקוד, הדלקת הדגל והדגמה ב־staging; אין כאן ראיה לסנכרון אמיתי שהושלם.

1. בפרויקט Cloud של לקוח הכניסה: **Google Calendar API** מופעל.
2. ב־Google Auth Platform, ב־Data Access: ההרשאה `https://www.googleapis.com/auth/calendar.app.created` בנוסף ל־`openid`, ‏`email` ו־`profile`. זו ההרשאה היחידה שהאתר מבקש: יומן שהאתר יוצר בעצמו.
3. בדיקה בקונסולה, במסך ההסכמה: סיווג ההיקף (רגיש או לא) ומספר המשתמשים המותר לפני אימות. אפליקציה ציבורית שמבקשת היקף רגיש חייבת באימות Google: דומיין קבוע, מדיניות פרטיות ציבורית והצדקה להיקף. **במצב Testing אסימון הרענון פג אחרי שבעה ימים**, והחיילים יתבקשו לאשר שוב. הדומיין של staging זמני.
4. מדליקים את המתג ומעלים מחדש את האתר והעובד (בשרת עם טיימר הפריסה, כמו ב״שינוי ערך ב־`app.env`״):

```sh
# Switch the calendar sync on; the app and the worker read it when they start
env=/opt/fair-shifts/config/app.env; { grep -v '^GOOGLE_CALENDAR_SYNC=' "$env"; printf 'GOOGLE_CALENDAR_SYNC=true\n'; } > "$env.new" && chmod 600 "$env.new" && mv "$env.new" "$env"
sh scripts/production.sh deploy
```

בדיקת התצורה דוחה `GOOGLE_CALENDAR_SYNC=true` בלי `GOOGLE_CLIENT_ID` ו־`GOOGLE_CLIENT_SECRET`. הלקוח של הגיבוי (`drive.file`) נשאר נפרד ואין להוסיף לו את הרשאת היומן.

- **איך זה עובד:** העובד מריץ כל דקה, בתור נפרד (`calendar-sync`), השוואה בין האירועים שצריכים להיות לכל חייל עם הרשאה תקפה לבין אלה שנרשמו, ומשנה ב־Google רק את ההפרש. האירוע מגיע ליומן עד כדקה או שתיים אחרי הפעולה. הריצה נעצרת במצב שחזור ובזמן שהשער סגור.
- **מה נשמר:** אסימון רענון מוצפן באותו מפתח של סודות המייל (`MAIL_ENCRYPTION_KEY`), ורשומה לכל אירוע. אסימוני Google אינם נשמרים בטבלת הכניסה, ואינם נרשמים ביומנים. מחיקת משתמש מוחקת אותם ומנסה להסיר את האירועים העתידיים.
- **כשל זמני:** ההשהיה גדלה מדקה לשש שעות, ו־`Retry-After` של Google מכובד. בלוג העובד מופיעה רק שורה כמו `Calendar sync failed GoogleError`, בלי תשובת Google. הסיבה האחרונה לכל חשבון נשמרת כקטגוריה בלבד (`rate`, ‏`transient`, ‏`configuration`, ‏`permission_lost`).
- **הרשאה שבוטלה או פגה:** הסנכרון של אותו חשבון נעצר, החייל רואה במסך ההעדפות ״אישור הרשאה ליומן״ ומקבל הודעת אתר אחת. אין מה לתקן בשרת.
- **שגיאת תצורה (`configuration`):** בדרך כלל Calendar API לא מופעל בפרויקט, או שלקוח ה־OAuth שונה. בודקים את שני הסעיפים הראשונים לעיל.
- **ספירה בלי לחשוף תוכן:**

```sh
# Count calendar links by state, switch and last failure category; no tokens, names or addresses are printed
sh scripts/production.sh exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select state, enabled, error_code, count(*) from calendar_link group by 1,2,3"'
```

### יצירת יומן שתוצאתה אינה ידועה

אם התשובה ליצירת יומן אבדה, הסנכרון מושהה בקטגוריה `calendar_creation_uncertain` (או `calendar_creation_pending` לאחר קריסה). במסך החייל מופיעה המתנה לטיפול טכני. כניסה נוספת ב־Google אינה מוחקת את הסימון. אין ניסיון אוטומטי ליצור עוד יומן: [רשימת היומנים](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list) דורשת הרשאה רחבה יותר, בעוד [קריאת יומן לפי מזהה](https://developers.google.com/workspace/calendar/api/v3/reference/calendars/get) אפשרית בהרשאה המצומצמת.

מפעיל השרת מברר עם חשבון הבדיקה אם יומן ״תורנויות״ נוצר, ומעתיק את מזהה היומן מתוך הגדרותיו ב־Google. `adopt` מאמתת שם ואזור זמן באמצעות ההרשאה, ואז משלימה רק אם החשבון וההרשאה לא השתנו. אין בדיקת ספק תוך נעילה. מזהים ואסימונים אינם נכתבים בפלט.

```sh
# Use the internal account ID and the verified calendar ID from Google Calendar settings.
sh scripts/production.sh run --rm --no-deps \
  -e CALENDAR_ACCOUNT_ID="<internal-account-id>" \
  -e CALENDAR_CREATED_ID="<verified-app-created-calendar-id>" \
  -e CALENDAR_RECOVERY_REASON="<reason, at least 5 characters>" \
  app node_modules/.bin/tsx scripts/calendar-recover.ts adopt

# Only after checking that no calendar was created; this permits a new create attempt.
sh scripts/production.sh run --rm --no-deps \
  -e CALENDAR_ACCOUNT_ID="<internal-account-id>" \
  -e CALENDAR_RECOVERY_REASON="<reason, at least 5 characters>" \
  -e CALENDAR_RECOVERY_ACKNOWLEDGE="no calendar was created" \
  app node_modules/.bin/tsx scripts/calendar-recover.ts retry
```

ממתינים לסיום חכירת העובד (עד חמש דקות) לפני הטיפול. בהחלפת כתובת מייל מוסרים האסימון וקישורי היומן הישן, ומנסים להסיר אירועים עתידיים ולבטל הרשאה אחרי העסקה. מיגרציה 0012 מנקה גם אסימוני Google לא מוצפנים שנשמרו בגרסאות הקודמות; הרשאת יומן חדשה מתקבלת בכניסה ב־Google.

## בדיקת התצורה ב־Docker

```sh
sh scripts/production-smoke.sh
```

הבדיקה בונה תמונה, מוודאת שבדיקת התצורה דוחה סודות פיתוח בלי להדפיס אותם, יוצרת תצורה סינתטית ומוודאת הרשאות 600 ושאתחול חוזר אינו דורס. אחר כך היא מעלה את המסד, האתר והעובד וממתינה לבריאות `ok` עם אותה גרסה ובלי שדות נוספים. היא בודקת שלמסד אין יציאה החוצה, הורגת את העובד ומוודאת שהופעל מחדש, עוצרת בתוך זמן החסד בלי SIGKILL, ומוודאת שהנתונים נשמרים אחרי `down` ו־`up`. בסוף היא מוחקת את הסביבה הזמנית. cloudflared אינו נבדק כאן, כי הוא דורש אסימון אמיתי; החיבור נבדק בכרטיס #25.

## מה עוד לא נבדק

- תורנויות ביומן Google (#92) נבדקו ב־Docker מול Google מדומה בלבד: ההרשאה, ההתנהגות של Google לאירוע או ליומן שנמחקו, התזכורות ביומן והאסימון שפג ב־Testing טרם נבדקו מול חשבון אמיתי.
- staging (#25), כניסת Google (#26) ו־Brevo (#28) נבדקו בחשבונות בדיקה, והתוצאות מתועדות בכרטיסים. חריגה מהמכסה של הספק נבדקה רק ב־Docker.
- הגיבוי נבדק מול Drive אמיתי ב־01.10.2026 (ראו "חיבור Drive וחידוש הרשאה"), חוץ מנפח שנגמר באמת. עדיין לא נבדקו: עותק יומן המחיקות ב־Drive, שנוצר רק עם המחיקה הראשונה, ושחזור מבודד מגיבוי שהורד מ־Drive אמיתי (#37). השחזור המבודד, הבדיקות, החלפת המסד והתרגיל נבדקו ב־Docker מול מסד ואחסון תיקייה (#35); נוהל החזרה אחרי מיגרציה שנכשלה טרם הודגם בשרת.
- פריסה אוטומטית (#36): רצה בשרת, ותקלה וחזרה הודגמו שם ב־30.09.2026. הגיבוי לפני מיגרציה נבדק ב־Docker בלבד (`scripts/auto-deploy-test.sh` ו־`tests/integration/backup.test.ts`), הגיבוי ב־staging מחובר ל־Drive מ־01.10.2026, ולכן ההדגמה בשרת תהיה במיזוג הראשון שמשנה את המסד. נוהל שחזור אחרי מיגרציה שנכשלה שייך ל־#35.
