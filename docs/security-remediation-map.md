# מפת תיקוני ביקורת האבטחה

09.10.2026 · מקור: PR #121 ו[התוכנית המאושרת](../plans/2026-10-07-security-remediation.md). כל עשר הקבוצות ו[המעקב #122](https://github.com/ItayBar1/fair-shifts/issues/122) נסגרו עם ראיות פרטניות. [ראיות המעבר והספקים](security-live-transition-evidence.md) ו[ראיות שרשרת האספקה](security-supply-chain-evidence.md) נשמרות לצד הבדיקות. אין כאן קובצי ניצול או העתקי לוגי הביקורת.

## תשעת הממצאים המקוריים

| מספר ומזהה מקורי                                                                       | כרטיס ומימוש     | רגרסיות שנשמרות                                                                                                                            |
| -------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 · `fair-shifts:email-change:manager-peer-account-takeover`                           | #123 → #133      | [שינוי מייל והרשאות](../tests/integration/technical-email.test.ts), [דפדפן](../tests/e2e/technical-email-change.spec.ts)                   |
| 2 · `auth/otp-anonymous-account-lockout`                                               | #124 → #134      | [OTP, שריפת קוד, המתנה ומקביליות](../tests/integration/otp-protection.test.ts), [כניסה](../tests/integration/auth.test.ts)                 |
| 3 · `auth/request-code-mail-quota-exhaustion`                                          | #124 → #134      | [מכסות וניסיונות חוזרים](../tests/integration/otp-protection.test.ts), [משלוח](../tests/integration/mail-delivery.test.ts)                 |
| 4 · `auth/otp-account-existence-oracle`                                                | #124 → #134      | [תשובות בקשת קוד ושחזור](../tests/integration/otp-protection.test.ts), [כניסה ושחזור](../tests/integration/auth.test.ts)                   |
| 5 · `src/server/auth/index.ts:databaseHooks:google-link-not-rechecked-under-user-lock` | #125 → #135      | [קישור Google ומרוצים](../tests/integration/auth.test.ts), [מסלול OAuth](../tests/integration/google-sign-in.test.ts)                      |
| 6 · `fair-shifts/manager-alert-mail-ignores-recipient-service-end`                     | #132 → #136      | [הרשאה ושירות במשלוח](../tests/integration/security-mail.test.ts), [התראות](../tests/integration/notifications.test.ts)                    |
| 7 · `fair-shifts/seat-offer-mail-sent-after-withdrawal`                                | #132 → #136      | [רלוונטיות הצעות ומכסות נמענים](../tests/integration/security-mail.test.ts)                                                                |
| 8 · `fair-shifts:soldier-deletion:email-outbox-request-reason-residue`                 | #126 → #138/#139 | [שאריות מחיקה ומיילי הצד השני](../tests/integration/security-erasure.test.ts), [מחיקת חייל](../tests/integration/soldier-deletion.test.ts) |
| 9 · `fair-shifts:soldier-deletion:command-results-superseded-contact-residue`          | #126 → #138/#139 | [קשר היסטורי, שיוך ותפוגת תוצאות](../tests/integration/security-erasure.test.ts), [שחזור](../tests/integration/restore.test.ts)            |

## חשדות משאבים והקשחות נוספות

| קבוצה                                                                                                                | כרטיס ומימוש          | ראיות ורגרסיות                                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| גוף בקשה מוגבל · `src/app/api/v1/actions/route.ts:POST:unbounded-request-json`                                       | #127 → #138/#139      | [קריאה מוגבלת ועומק JSON](../tests/unit/bounded-body.test.ts), גבולות הנתיבים בסוויטת היחידה                                                                                                         |
| XLSX · `import-workbook:validateArchive-declared-size-not-enforced-on-inflate`                                       | #127 → #138/#139      | [פריסה בפועל](../tests/unit/workbook-archive.test.ts), [תהליך מפענח](../tests/unit/workbook-process.test.ts)                                                                                         |
| קריאת השיבוצים; הממצא `src/server/my-assignments.ts:readMyAssignments:cross-site-get-advances-feed-cursor` נשאר דחוי | #127 → #138/#139      | [תמונה עקבית ומקביליות](../tests/integration/my-assignments.test.ts); ההקשחה אינה קבלה של הממצא הדחוי                                                                                                |
| הצפנה ויומן חתום                                                                                                     | #128 → #140           | [AAD ותג](../tests/unit/secrets.test.ts), [הסבה](../tests/integration/security-conversion.test.ts), [יומן מחיקות](../tests/integration/deletion-log.test.ts), שחזור לא־ריק מול Drive בראיות המעבר    |
| CSP, HSTS ובריאות                                                                                                    | #129 → #141           | [דפדפן ייצור](../tests/e2e/browser-security.spec.ts), [מדיניות](../tests/unit/browser-security.test.ts), אימות HSTS בשכבת Cloudflare                                                                 |
| הפרדת סודות ומסד                                                                                                     | #130 → #142/#146/#158 | [תצורה](../tests/unit/service-configuration.test.ts), [הרשאות PostgreSQL](../tests/integration/database-permissions.test.ts), [הרשאות תמונה](../scripts/image-permissions-test.sh), פריסת הטיימר החי |
| שרשרת אספקה והגנת main                                                                                               | #131 → #143/#152      | [סריקה וחריגות](../tests/unit/supply-chain.test.ts), [כללי מאגר](../tests/unit/repository-rules.test.ts), API והיסטוריית הכללים בראיות המעבר                                                         |

## ממצא שרשרת אספקה מאוחר

סריקת #160 גילתה CVE-2026-78667 ו־CVE-2026-97031 ב־Go 1.26.8 של Tunnel. #161 עוקב אחר התיקון; #162 מוזג ב־a9eaa29 עם Go 1.26.9, Husky ו־CI ירוקים וסריקת התמונה ללא High/Critical. ראיות הפריסה והסקירה עדיין דורשות השלמה; #160 נשאר draft. אלה ממצאים חדשים מעבר ל־12 המזהים המקוריים.

## גבולות הראיות

- מצב חשבון לפני כניסה והודעות ניהול היסטוריות נשארו לפי ההחלטה; אלה סיכונים שהתקבלו. עצם פתיחת ״השיבוצים שלי״ נשאר ממצא דחוי.
- מייל שנמסר לספק אינו ניתן למשיכה. חתימות אינן מגינות מהשתלטות על העובד והמפתח יחד, או מוכיחות ששני עותקים חתומים ישנים לא הוחזרו לאחור.
- משאבים נבדקו ב־Docker מוגבל בלבד. נפח Drive חסר נבדק מול ספק מדומה; המשתמש אישר מגבלה זו לסגירת #37. בדיקות ספק אמיתי מפורטות בנפרד.
- ‏braces הוסר מעץ התלויות ומהתמונה ב־#168, והחריגות שלו בוטלו לפני הפקיעה ב־22.10.2026. אין תיקון upstream. שתי אזהרות גרסאות בשחזור נשארו מתועדות.
- #158 מוזג בזמן שכלל אישור המפתח השני היה כבוי; הוא הוחזר לאחר המיזוג. אין Review רשום ב־API. המשתמש מסר שהשינוי אושר; אין להציג זאת כראיית אכיפה. הכללים הנוכחיים פעילים ללא bypass, והנוהל המחייב לא השתנה.
- תיקיית הדוח מוסרת ב־PR נפרד לאחר הסגירות. המחיקה אינה שכתוב היסטוריית Git, אינה ביקורת אבטחה מקיפה חדשה ואינה אישור פיילוט או שימוש בנתוני אמת.
