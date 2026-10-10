# העלאה לפרודקשן — דומיין קבוע, שולח Brevo ונתוני אמת

10.10.2026 · [#172](https://github.com/ItayBar1/fair-shifts/issues/172) · הכרעה 221 ב[יומן ההכרעות](open-decisions.md) · אפיון 1.75.

המסמך מתאר איך מחליפים את סביבת ה־staging הסינתטית בסביבת production על אותו שרת, עם דומיין קבוע ונתוני אמת. הוא משלים את [מדריך ההפעלה](operations.md), ואינו אישור לפתוח נתוני אמת: שער הקליטה לפי סעיף 7.6 באפיון נשאר בתוקף ([הכנה לנתוני אמת](real-data-readiness-2026-10-09.md)).

כל הפקודות כאן רצות בשרת, וההערות שבהן באנגלית (הכרעה 187). אין להדביק סודות לפקודה שנשמרת בהיסטוריית המסוף; עורכים את קובצי התצורה ב־`nano`.

## ההחלטות

- **סביבה אחת (הכרעה 221).** production מחליפה את staging על אותו שרת. אין סביבת בדיקות קבועה נוספת. ההגנות על עדכון הן בדיקות Docker ו־CI לפני מיזוג, גיבוי מאומת לפני שינוי מסד, בדיקת בריאות וחזרה אוטומטית כשאין שינוי מסד (הכרעות 186 ו־191). תיקון בקוד נבדק ב־Docker מקומי ובבדיקת העשן של התמונה (`scripts/production-smoke.sh`).
- **מסד חדש ולא ניקוי.** production עולה בפרויקט Compose חדש עם נפח ריק. נתוני הדמו נשארים בנפח של staging, עצור, לפחות שבוע, ונמחקים רק באישור המשתמש. כך אין צורך לנקות את מסד הדמו, ויש דרך חזרה עד הקליטה.
- **Calendar פעיל מההתחלה.** ההיקף `calendar.app.created` מוצג בקונסולת Google כ־non-sensitive, ופרויקט `fairshifts-backup` כבר במצב In production.
- **פתוח: מזהה החייל.** האם השדה ״מספר אישי״ יכיל את המספר הצבאי או מזהה פנימי של היחידה. הקוד מקבל כל מחרוזת ספרות ייחודית באורך 1–20 ואינו מאמת מבנה של מספר צבאי. ההכרעה תירשם באפיון וביומן לפני הייבוא.

## 1. לפני ההחלפה — על staging הסינתטי

אחרי ההחלפה לא תהיה סביבה עם נתוני דמה. לכן ההדגמות שנותרו נעשות קודם, ומתועדות בכרטיסים עצמם. תיעוד הוא תיאור של מה שנראה, בלי כתובות, קודים או צילומים עם פרטים אישיים.

| כרטיס                                                      | מה מדגימים                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#167](https://github.com/ItayBar1/fair-shifts/issues/167) | `health` מראה אתר ועובד ב־main העדכני (`4f5eeaa` או חדש יותר), ו־metrics של cloudflared מראים Go 1.26.9 וחיבורי Tunnel. דף הכניסה עונה 200 דרך הדומיין. |
| [#163](https://github.com/ItayBar1/fair-shifts/issues/163) | ייבוא קובץ סינתטי עם כתובת בדיקה אחת אמיתית: אין הזמנה בתור, כניסה בקוד לפני הפרסום, ״פרסום הזמנות״, ההזמנה מגיעה, ופתיחת האצווה מחדש מראה שפורסמה.     |
| [#144](https://github.com/ItayBar1/fair-shifts/issues/144) | מעבר קצר כחייל וכאחראי, במחשב ובנייד: ניווט, מרכז טיפול, מצב כהה.                                                                                       |
| [#114](https://github.com/ItayBar1/fair-shifts/issues/114) | הטכני מוסיף משתמש בודד, ממנה אותו לאחראי, והמשתמש נכנס עם המייל המאושר.                                                                                 |
| [#90](https://github.com/ItayBar1/fair-shifts/issues/90)   | הטכני מחליף את כתובתו באתר: קוד לכל אחת משתי הכתובות, והכניסה בכתובת החדשה.                                                                             |
| [#95](https://github.com/ItayBar1/fair-shifts/issues/95)   | פרסום כמה טיוטות יחד, כולל טיוטה חסומה שנשארת טיוטה, ומייל מרוכז אחד לחייל.                                                                             |
| [#34](https://github.com/ItayBar1/fair-shifts/issues/34)   | מחיקת חייל סינתטי בזמן ביצוע: הטיפול הדחוף נפתח, הזקיפה נעצרת, ו־`deletion-log verify` מוצא את הרשומה בקובץ ובעותק ב־Drive.                             |
| [#38](https://github.com/ItayBar1/fair-shifts/issues/38)   | מעבר עם קורא מסך (VoiceOver או NVDA) בכניסה, בלוח ובשיבוצים שלי.                                                                                        |

```sh
# Live version check for #167 (read only)
cd /opt/fair-shifts/app
sh scripts/production.sh health
cat /opt/fair-shifts/deploy-state/deployed; ls /opt/fair-shifts/deploy-state
```

## 2. תנאים מוקדמים

- **אישור הפעלה (סעיף 7.6):** הגוף המפעיל ובעל השליטה, מטרות והרשאה לעבד את המידע, הספקים (Cloudflare, ‏Brevo, ‏Google), אירוח בשרת פרטי, ונוסח היידוע לחיילים. המסמכים נשמרים אצל המפעיל ולא ב־Git. מומלץ לבדוק גם את סיווג המידע על לוח התורנויות עצמו.
- **מזהה החייל:** ההכרעה מהסעיף הקודם.
- **ערכי היחידה:** מחירון, תוספות, מנוחה, פטורים, כשירויות, דרגות ויתרות פתיחה, מאומתים בידי האחראים. אסור להשתמש בערכי הדוגמה.
- **דומיין:** נרכש ומנוהל ב־DNS של Cloudflare (Nameservers של Cloudflare). להלן `<domain>` הוא הכתובת שתשמש את האתר, למשל `shifts.<domain>` או הדומיין עצמו.

## 3. הכנת הספקים — לפני יום ההחלפה

אפשר להשלים את השלב הזה בזמן ש־staging עוד פעיל, כי אף אחד מהשינויים אינו מסיר את ההגדרות הקיימות.

**Brevo:**

1. **Senders, Domains & Dedicated IPs → Domains → Add a domain**, ומזינים את הדומיין.
2. Brevo מציג רשומות לאימות: קוד Brevo ב־TXT, ‏DKIM ו־DMARC. מוסיפים אותן ב־DNS של Cloudflare במצב **DNS only** (ענן אפור), או באימות האוטומטי אם Brevo מציע אותו ל־Cloudflare. מחכים עד שכל הרשומות מסומנות כמאומתות.
3. **Senders → Add a sender:** למשל `no-reply@<domain>` עם השם ״תורנויות״. זה הערך של `BREVO_SENDER_EMAIL`.
4. בודקים שה־API key הקיים פעיל. מכסת החינם (300 ביום) נשארת, והמערכת עוצרת לפני שהיא נגמרת.

אם רוצים לקבל מייל בכתובת בדומיין, למשל עבור המנהל הטכני, אפשר להשתמש ב־Cloudflare Email Routing להעברה לתיבה קיימת. אין חובה לעשות את זה.

**Google — לקוח הכניסה בפרויקט `fairshifts-backup`:**

1. **Branding → Authorized domains:** מוסיפים את הדומיין. אם Google מבקש אימות בעלות, מאמתים ב־Search Console עם רשומת TXT ב־Cloudflare.
2. **Clients → fair-shifts-staging:** מוסיפים מקור `https://<domain>` וכתובת חזרה `https://<domain>/api/auth/callback/google`. משאירים את כתובות ה־staging עד אחרי ההחלפה. אפשר לשנות את שם הלקוח ל־`fair-shifts`. המזהה והסוד לא משתנים.
3. **Data Access:** בודקים שמופיעים `openid`, ‏`email`, ‏`profile` ו־`calendar.app.created` בלבד, ושכולם מסומנים non-sensitive.

**Google Drive — גיבוי:** יוצרים בחשבון הייעודי תיקייה חדשה לגיבויי production, נפרדת מתיקיית ה־staging, ושומרים את המזהה שלה (`GOOGLE_DRIVE_FOLDER_ID`). לקוח Drive, אסימון הרענון ו־`AGE_RECIPIENT` נשארים. המפתח הפרטי של age נשאר מחוץ לשרת.

**Cloudflare Tunnel:** משתמשים באותו Tunnel. בלשונית **Routes** מוסיפים **Published application** עבור `<domain>` לשירות `http://app:3000`. ה־route הישן נשאר עד אחרי ההחלפה.

**HSTS בדומיין החדש:** כמו ב־staging, ב־**SSL/TLS → Edge Certificates → HSTS** מגדירים `max-age` של שנה, בלי includeSubDomains ובלי preload ([ראיות המעבר](security-live-transition-evidence.md)).

## 4. יום ההחלפה

הסדר חשוב: קודם עוצרים את staging, ורק אחר כך מזיזים את התצורה שלו.

```sh
cd /opt/fair-shifts/app
# 1. Pause automatic deployment and make sure the checkout is the live version
touch /opt/fair-shifts/deploy-state/paused
test "$(git rev-parse HEAD)" = "$(cat /opt/fair-shifts/deploy-state/deployed)" && echo "checkout matches the live version"

# 2. Stop staging; containers and volumes stay, nothing is deleted
export COMPOSE_PROJECT_NAME=fair-shifts-production-alpine
sh scripts/production.sh stop
sh scripts/production.sh ps -a

# 3. Keep the staging configuration aside, then create the production configuration
mv /opt/fair-shifts/config /opt/fair-shifts/config-staging
export COMPOSE_PROJECT_NAME=fair-shifts-live
sh scripts/production.sh init --environment=production --url=https://<domain>
```

ל־`init` נוצרות שש תצורות חדשות: סיסמאות מסד, סודות כניסה, מפתח הצפנה לתור המייל ומפתח חתימה ליומן המחיקות. **אין להעתיק סודות אלה מ־staging.** מעתיקים מ־`config-staging` רק את ערכי הספקים, בעורך:

| ערך                                                                                  | קבצים                                     |
| ------------------------------------------------------------------------------------ | ----------------------------------------- |
| `TUNNEL_TOKEN`                                                                       | `tunnel.env`                              |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_SYNC=true`              | `app.env`, `worker.env`                   |
| `MAIL_TRANSPORT=brevo`                                                               | `app.env`, `worker.env`                   |
| `BREVO_API_KEY`, `BREVO_SENDER_EMAIL=no-reply@<domain>`                              | `worker.env`                              |
| `MAIL_QUOTA_TIME_ZONE=Asia/Jerusalem`                                                | `app.env`, `worker.env`, `operations.env` |
| `BACKUP_STORAGE=drive`, `BACKUP_TIME`, `AGE_RECIPIENT`                               | `app.env`, `worker.env`, `operations.env` |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` | `worker.env`, `operations.env`            |
| `GOOGLE_DRIVE_FOLDER_ID` — **התיקייה החדשה**                                         | `worker.env`, `operations.env`            |

את המפתח הפרטי של חתימת המחיקות (`worker-secrets.env`) מעתיקים לאחסון התאוששות מחוץ לשרת, בודקים שאפשר לקרוא אותו, ורק אז מגדירים `DELETION_LOG_KEY_RECOVERY_CONFIRMED=true`.

```sh
# 4. Point the deployment timer at the new Compose project
sudo systemctl edit "fair-shifts-deploy@$USER.service"
#    in the override, set: Environment=COMPOSE_PROJECT_NAME=fair-shifts-live
sudo systemctl daemon-reload
systemctl show "fair-shifts-deploy@$USER.service" -p Environment

# 5. First deployment on an empty database, then health
cd /opt/fair-shifts/app
export COMPOSE_PROJECT_NAME=fair-shifts-live
sh scripts/production.sh deploy
sh scripts/production.sh health
git rev-parse HEAD > /opt/fair-shifts/deploy-state/deployed
rm /opt/fair-shifts/deploy-state/paused
```

אחרי ההחלפה, כל פקודת תפעול ידנית רצה עם `COMPOSE_PROJECT_NAME=fair-shifts-live`. בלי המשתנה, Compose משתמש בשם ברירת המחדל `fair-shifts-production` ולא ימצא את השירותים.

**חזרה עד הקליטה:** כל עוד לא נקלטו נתוני אמת, עוצרים את `fair-shifts-live`, מחזירים את `config-staging` ל־`config`, מחזירים את ה־override ל־`fair-shifts-production-alpine` ומפעילים את staging. אחרי הקליטה חוזרים רק משחזור גיבוי של production, לפי מדריך ההפעלה.

## 5. הקמה במסד הריק

1. **חשבונות ראשונים** ב־bootstrap, עם המייל של המנהל הטכני ושל האחראי הראשון ([הפקודה](operations.md#גישה-ותחזוקה), עם `COMPOSE_PROJECT_NAME=fair-shifts-live`). את קודי השחזור של הטכני שומרים מחוץ לשרת ומחוץ ל־Git.
2. **בדיקת ספקים:** קוד כניסה במייל מגיע לתיבת הדואר הנכנס מהשולח החדש. כניסה ב־Google עובדת בדומיין החדש. מסך ״משלוחי מייל״ אינו מציג השהיה.
3. **אחראי שני:** הטכני מוסיף אותו כמשתמש בודד וממנה אותו לאחראי (#114).
4. **הגדרות יחידה:** האחראים מזינים את הערכים המאומתים מסעיף 2.
5. **גיבוי ושחזור לפני הקליטה:** במסך ״גיבוי ושחזור״ מריצים גיבוי ומחכים ל״אומת״, ואז מבצעים [שחזור מבודד](operations.md#שחזור-מבודד-ותרגיל-רבעוני).

## 6. קליטת נתוני אמת

1. האחראי מעלה XLSX ב־`/manage/imports`, בודק את התצוגה המקדימה ושומר. נשמרים חיילים, חשבונות ויתרות, ולא נשלחות הזמנות (הכרעה 219).
2. בדיקות: מספר החיילים והיתרות תואמים לקובץ המקור, באצווה מוצג ״הזמנות טרם פורסמו״, ובמסך ״משלוחי מייל״ אין הזמנות בתור.
3. מריצים גיבוי נוסף ומחכים ל״אומת״.
4. כשהאחראי מחליט, הוא פותח את האצווה ולוחץ ״פרסום הזמנות״. 120 הזמנות נכנסות במכסה היומית. ההזמנות ליומן Google מתחילות רק אחרי שכל חייל נכנס ב־Google ומאשר.

## 7. אחרי ההחלפה

- מסירים את כתובות ה־staging מלקוח Google ואת ה־route הישן מה־Tunnel.
- `config-staging` ונפח המסד של `fair-shifts-production-alpine` נשמרים עצורים לפחות שבוע. מחיקה (`down --volumes` לפרויקט הישן בלבד, ומחיקת התיקייה) רק באישור המשתמש.
- מעדכנים את [מדריך ההפעלה](operations.md) ואת זיכרון הפרויקט: production הוא הסביבה הפעילה, ואילו כתובת ה־staging ופרויקט ה־Compose הקודם כבר אינם בשימוש.
- מכאן כל מיזוג ל־main נפרס על נתוני אמת, ולכן נדרש Review לכל PR (הכרעה 221).
