---
name: Fair Shifts
description: תורנות הוגנת — פנקס חשבונות עמודתי שבו כלל ההגרלה מצויר כגאומטריה
colors:
  accent: "#2f5bd3"
  accent-hover: "color-mix(in oklab, #2f5bd3 86%, black)"
  accent-soft: "color-mix(in oklab, #2f5bd3 9%, #fbfcf9)"
  accent-text: "color-mix(in oklab, #2f5bd3 82%, black)"
  on-accent: "#ffffff"
  ledger-pad: "#e6eee1"
  ledger-sheet: "#fbfcf9"
  sheet-tint: "#eef3ea"
  fill: "#dfe8da"
  fill-hover: "#e7eee2"
  fill-strong: "#d0dccb"
  ink: "#14211c"
  ink-2: "#43554d"
  ink-3: "#55665e"
  rule-hairline: "#d0dccc"
  rule-strong: "#adc0aa"
  neutral-fill: "#8d9a92"
  cover: "#15231e"
  cover-2: "#1f3029"
  on-cover: "#f2f5f0"
  brand-highlight: "#c9d6cc"
  rule-red: "#b8403a"
  pencil: "#5f6a64"
  band-fill: "color-mix(in oklab, #14211c 10%, transparent)"
  band-hatch: "color-mix(in oklab, #14211c 22%, transparent)"
  success: "#1f7a52"
  success-soft: "#e3f1e8"
  warning: "#85600f"
  warning-soft: "#f8efd8"
  danger: "#b0333a"
  danger-soft: "#fae8e6"
  danger-border: "#eec5c2"
  info: "#3a5f9f"
  info-soft: "#e9eef6"
typography:
  display:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif'
    fontSize: "clamp(2.5rem, 4.5vw, 4.25rem)"
    fontWeight: 700
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  headline:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif'
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  title:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif'
    fontSize: "1.25rem"
    fontWeight: 650
    lineHeight: 1.35
  title-small:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif'
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.35
  figure:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif'
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    fontFeature: '"tnum", "lnum"'
  body:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif'
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
  control:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif'
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.35
  label:
    fontFamily: 'system-ui, -apple-system, "Segoe UI", "Noto Sans Hebrew", "Arial Hebrew", Arial, sans-serif'
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0.01em"
rounded:
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "10px"
  full: "999px"
spacing:
  "0-5": "2px"
  "1": "4px"
  "1-5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
  "8": "32px"
  "10": "40px"
  "12": "48px"
  "16": "64px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.on-accent}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.on-accent}"
  button-secondary:
    backgroundColor: "{colors.ledger-sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "36px"
  button-secondary-hover:
    backgroundColor: "{colors.fill-hover}"
  button-danger:
    backgroundColor: "{colors.ledger-sheet}"
    textColor: "{colors.danger}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
    height: "36px"
  button-danger-hover:
    backgroundColor: "{colors.danger-soft}"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "0 6px"
  badge-pencil:
    textColor: "{colors.pencil}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
  badge-ink:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
  badge-plain:
    textColor: "{colors.ink-2}"
    padding: "0"
  panel:
    backgroundColor: "{colors.ledger-sheet}"
    rounded: "{rounded.md}"
    padding: "24px"
  field-input:
    backgroundColor: "{colors.ledger-sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
    height: "40px"
  nav-link:
    backgroundColor: "transparent"
    textColor: "{colors.on-cover}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "4px 12px"
    height: "32px"
  nav-link-hover:
    backgroundColor: "{colors.cover-2}"
    textColor: "{colors.on-cover}"
  nav-link-active:
    backgroundColor: "{colors.ledger-sheet}"
    textColor: "{colors.ink}"
  nav-rail:
    backgroundColor: "{colors.cover}"
    textColor: "{colors.on-cover}"
    padding: "20px 12px"
    width: "248px"
  tab-bar:
    backgroundColor: "{colors.ledger-sheet}"
    textColor: "{colors.ink-2}"
    typography: "{typography.label}"
  tab-active:
    textColor: "{colors.accent-text}"
  date-tile:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
    width: "52px"
  next-duty-date:
    backgroundColor: "{colors.cover}"
    textColor: "{colors.ledger-sheet}"
    rounded: "{rounded.sm}"
    padding: "6px 8px"
    width: "52px"
  mine-mark:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.xs}"
    padding: "0 4px"
  stat:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.figure}"
    rounded: "0"
    padding: "12px 16px"
  stat-active:
    backgroundColor: "{colors.accent-soft}"
  band-strip:
    backgroundColor: "{colors.ledger-sheet}"
    rounded: "{rounded.md}"
    padding: "20px 24px 16px"
---

# Design System: Fair Shifts

## Overview

**Creative North Star: "פנקס החשבונות"**

הצדק בתורנויות הוא הנהלת חשבונות שנעשתה גלויה. כל המערכת בנויה כפנקס עמודתי מסודר: קרקע של נייר פנקס ירקרק־חיוור, גיליון כמעט לבן שעליו נרשמים הנתונים, קווי שוליים דקים בירוק־אפור וקו כפול מתחת לכל כותרת. הניווט הוא כריכת הפנקס, פס כהה בצד תחילת השורה. כלל ההגרלה (המינימום ועוד שווי המקום) אינו נשאר טקסט: הוא מצויר כגאומטריה על ציר ניקוד אחד, ברצועה מקווקוות. מקור העולם: הכרעה 241, על בסיס עקרונות הכרעה 218 שעדיין חלים.

הצפיפות היא של פנקס, לא של לוח מחוונים. מספרים נכתבים בספרות טבלאיות ישרות, שורות נרשמות בקווים ולא בכרטיסים, ומצב מתואר בעיפרון ובדיו: טיוטה כתובה בעיפרון (אפור, מקווקו), מה שפורסם כתוב בדיו (רציף). הכחול של המותג מופיע רק על מה שאפשר ללחוץ עליו או מה שנבחר, והאדום מופיע כקו שוליים אחד: ״עכשיו״ וגבול הרצועה.

העולם דוחה במפורש את שפת לוח המחוונים של SaaS: שורות כרטיסי סטטיסטיקה, אריחי אייקון צבועים, פסי צד בהתראות, תגיות גלולה ושכבות זכוכית.

**Key Characteristics:**

- קרקע פנקס ירקרקה, גיליון לבן, קווים דקים וקו כפול (`3px double`) מתחת לכל כותרת.
- כריכה כהה לניווט; העמוד הפתוח הוא גיליון שנשלף מהכריכה.
- ספרות טבלאיות ישרות (`tabular-nums lining-nums`) בכל ספירה וניקוד.
- עיפרון לטיוטה, דיו לפרסום, מילה פשוטה למצב שגרתי.
- רצועת ההגרלה כגאומטריה: מינימום בדיו, רצועה מקווקוות, גבול אדום מקווקו, הצופה מסומן בדיו.
- גופן המערכת בלבד, מצב כהה וניגודיות מוגברת מתוך הגדרות המכשיר.

## Colors

פלטה של פנקס: ירוקים־אפורים שקטים לנייר ולקווים, דיו כמעט שחור, כחול אחד למה שנלחץ ואדום אחד לקו השוליים.

### Primary

- **דיו כחול של המותג** (accent): כפתור ראשי, טאב פעיל, כפתור שווי שנבחר ברצועה, נתון שנבחר בשורת הסיכום (קו תחתון כחול ומילוי רך), טבעת מיקוד. גוני הריחוף, הרקע הרך והטקסט נגזרים ממנו ב־`color-mix` ואינם צבעים עצמאיים.

### Tertiary

- **קו שוליים אדום** (rule-red): קו ״עכשיו״ ביומן היומי וגבול הרצועה בלבד.

### Neutral

- **נייר פנקס** (ledger-pad): קרקע העמוד, וגם ימים מחוץ לחודש בלוח השנה.
- **גיליון** (ledger-sheet): משטח הלוחות, השדות, הכפתור המשני וסרגל הטאבים בטלפון.
- **גוון גיליון** (sheet-tint): שבת בלוח השנה, הודעות מידע ותבנית הייבוא.
- **מילויים** (fill, fill-hover, fill-strong): ריחוף ולחיצה על שורות וכפתורים משניים.
- **דיו** (ink, ink-2, ink-3): טקסט ראשי, משני ושלישי. הדיו גם מסמן ״שלי״ וגם את המינימום על הציר.
- **קו דק וקו חזק** (rule-hairline, rule-strong): קווי שורות; הקו החזק לקווים כפולים, לגבולות שדות ולשורת הסיכום.
- **כריכה** (cover, cover-2, on-cover): פס הניווט וצד הסיפור בדף הכניסה. אותו גוון משמש `surface-inverse` לאריח התאריך של התורנות הבאה ולמספר היום של היום.
- **עיפרון** (pencil): כל מה שעדיין טיוטה.

### Status

- **הצלחה, אזהרה, סכנה ומידע** (success, warning, danger, info ומשטחיהם הרכים): צבעי הטקסט שומרים על ניגודיות 4.5:1 על המשטח הרך של עצמם. משמשים בתגיות ובהודעות, לא כקישוט.

### Theme overrides

- **מצב כהה** (`prefers-color-scheme: dark`): ״הפנקס בלילה״. הקרקע `#0d1412`, הגיליון `#131c19`, הדיו `#e5ebe6`, ה־accent `#3d68e0` וטקסט ה־accent `#8fa9f5`, ה־rule-red `#e0665d`, העיפרון `#9aa69f`. הכריכה `#17251f` היא הלוח הבהיר מעט מהקרקע, והעמוד הפעיל בה הוא גיליון בהיר (`#e5ebe6` על `#0d1412`).
- **ניגודיות מוגברת** (`prefers-contrast: more`): מחזקת את `--text-2`, `--text-3`, `--separator`, `--separator-strong` ו־`--pencil`, בבהיר (`#2f3f38`, `#3a4a43`, `#8a9a8e`, `#66786b`, `#424c46`) ובכהה (`#c9d4ce`, `#b3c0b9`, `#6a7a71`, `#8fa097`, `#c2ccc6`).
- **על הכריכה** (`.login-story`): הדיו, הקווים והרצועה מתהפכים לגוונים בהירים כדי שהרצועה תיקרא כמו על נייר; קו השוליים שם `#f08a82`.

### Named Rules

**The Blue Ink Rule.** ה־accent (`#2f5bd3`) מסמן רק מה שאפשר ללחוץ עליו או מה שנבחר. כותרת, אייקון, נתון או סימון של ״שלי״ אינם כחולים.

**The Mine Is Marked Rule.** ״אני״ ו״שלי״ מסומנים בדיו ובסימן (מסגרת בדיו, סימן ״שלי״, אייקון, קו תחתון כפול), לעולם לא בצבע לבדו (אפיון 7.6).

**The One Red Line Rule.** `--rule-red` שמור לקו ״עכשיו״ ולגבול הרצועה. שגיאות ומחיקות משתמשות ב־`--danger`, לא בקו השוליים.

**The Pencil and Ink Rule.** טיוטה כתובה בעיפרון: תגית מקווקוות בצבע `--pencil`, ושורת טיוטה כולה (כותרת ואריח תאריך מקווקו) בעיפרון. מה שפורסם כתוב בדיו: תגית רציפה בצבע הדיו. מצב שגרתי, כמו חייל פעיל, הוא מילה ולא תגית.

## Typography

**Display Font:** גופן המערכת (`system-ui`, עם `-apple-system`, `"Segoe UI"`, `"Noto Sans Hebrew"`, `"Arial Hebrew"`, `Arial`)
**Body Font:** אותו גופן
**Label/Mono Font:** אין גופן נפרד; ספרות טבלאיות דרך `font-variant-numeric`

**Character:** גופן הפלטפורמה, מוכר ומהיר, בלי הורדת גופן. האופי מגיע ממשקלים, מספרות טבלאיות ומהקווים הכפולים, לא מגופן תצוגה.

### Hierarchy

- **Display** (700, `clamp(2.5rem, 4.5vw, 4.25rem)`, 1.08): כותרת הסיפור בדף הכניסה בלבד, עד `14ch`.
- **Headline** (700, 2rem, 1.2): כותרת העמוד (`h1`), מעל קו כפול.
- **Title** (650, 1.25rem, 1.35): כותרות לוחות (`h2`) ושם החודש בלוח השנה.
- **Title small** (600, 1.0625rem, 1.35): כותרות משנה (`h3`) ושם התורנות הבאה.
- **Figure** (700, 1.25rem, 1.2, ספרות טבלאיות): נתוני שורת הסיכום וספרות הקבלה. נתון גדול (`.stat-value`) עולה ל־2rem.
- **Body** (400, 0.9375rem, 1.55): טקסט רגיל; פסקאות ב־1.65. שדות קלט ב־0.9375rem.
- **Control** (600, 0.8125rem): כפתורים, קישורי ניווט, שורות תורנות וטבלאות.
- **Label** (600, 0.75rem): תגיות, כותרות טבלה, תוויות נתונים, טקסט קטן. זו הרצפה.

### Named Rules

**The Platform Font Rule.** גופן המערכת בלבד. אין הורדת גופן רשת, ואין גופן תצוגה שמחליף אותו.

**The Ledger Numerals Rule.** כל ספירה, ניקוד, תאריך בתוך אריח, טבלה, ציר הרצועה וקבלת ההגרלה נכתבים ב־`tabular-nums lining-nums`, כדי שעמודות יתיישרו כמו בפנקס.

**The 12px Floor Rule.** שום טקסט אינו קטן מ־`--text-caption` (0.75rem, 12px). כל הגדלים נכתבים ב־rem מתוך הסקאלה, כדי שהגדרת גודל הטקסט של הדפדפן תגדיל גם את הפריסה.

## Layout

רשת של 4px (`--space-*`), מ־2px עד 64px. בשולחן העבודה: פס ניווט קבוע ברוחב 248px בצד תחילת השורה (218px מתחת ל־1100px), ותוכן ברוחב עד 1460px עם ריפוד `24px 40px 48px`. מעל התוכן סרגל עליון דביק בגובה 56px על קרקע הפנקס, שמקבל קו תחתון רק בגלילה.

כותרת עמוד יושבת מעל קו כפול. מתחתיה שורת סיכום אחת של ארבעה נתונים בקווים (גבולות עליון ותחתון, קו דק בין נתונים), לא שורת כרטיסים. רשימות הן שורות פנקס: ריפוד אנכי ו־קו דק מתחת, בלי מסגרת לכל פריט. בתוך לוח, גם רשימת ״השיבוצים שלי״ הופכת לשורות של הגיליון.

בטלפון (עד 760px) הניווט של החייל עובר לסרגל טאבים תחתון של חמישה טאבים על גיליון אטום, עם קו כפול עליון ותוספת `safe-area-inset-bottom`. הלוח מצטמצם לריפוד 20px, וטבלת החיילים הופכת לרשימה. התורנות הבאה מוצגת ככרטיסייה, ואחריה יומן לפי ימים שמתחיל היום, עם קו ״עכשיו״ אדום וימים שעברו מקופלים.

### Named Rules

**The Ruled Rows Rule.** בתוך גיליון, פריטים הם שורות מקווקוות בקו דק, לא כרטיסים בתוך כרטיס.

**The Double Rule Rule.** קו כפול (`3px double`, בצבע הקו החזק) מסמן ראש: כותרת עמוד, ראש טבלה, ימי השבוע בלוח, ראש הכרטיסייה של התורנות הבאה ושל רצועת הניקוד, סרגל הטאבים, וכותרת טופס הכניסה. היום הנוכחי ביומן מקבל קו כפול בדיו.

## Elevation & Depth

העולם שטוח. עומק מועבר בטון (קרקע, גיליון, כריכה) ובקווים, לא בצל. רק מה שצף מעל העמוד מטיל צל.

### Shadow Vocabulary

- **Segment** (`box-shadow: 0 1px 2px rgb(20 33 28 / 0.06)`): הכפתור הנבחר בבורר מקטעים, כמו לשונית מורמת.
- **Toast** (`box-shadow: 0 8px 24px rgb(20 33 28 / 0.14)`): הודעה צפה.
- **Dialog** (`box-shadow: 0 24px 64px rgb(20 33 28 / 0.22)`): חלון דו־שיח וסרגל הבחירה הצף.

במצב כהה הצללים מבוססים על שחור בשקיפות 0.4, 0.5 ו־0.6. מאחורי דו־שיח יש מסך האפלה (`--scrim`).

### Named Rules

**The Only What Floats Rule.** משטח במנוחה אינו מטיל צל. לוח, שורה ונתון נשענים על קווים; צל שמור לדו־שיח, להודעה צפה ולבחירה בבורר מקטעים.

## Shapes

פנקס חתוך ישר: פינות קטנות ועקביות. 3px לתגיות, אירועי לוח וסימן ״שלי״; 4px לכפתורים, שדות, קישורי ניווט ואריחי תאריך; 6px לגיליונות ולכרטיסיות; 10px לדו־שיח בלבד. אירוע שנמשך כמה ימים הוא פס אחד שהחיבורים שלו ישרים ופתוחים.

סימן המותג הוא אות אחת בתוך ריבוע בקו דק, מעל קו כפול שמצויר ברקע. הקווקוו האלכסוני (`repeating-linear-gradient` ב־135°, קו 1px כל 6px) קיים רק ברצועת ההגרלה.

### Named Rules

**The Hatching Belongs to the Band Rule.** קווקוו מופיע רק ברצועה. ימים מחוץ לחודש, מצבים מבוטלים ומקומות ריקים הם נייר חשוף, לא קווקוו.

## Components

### Buttons

פעולה כתובה, לא כפתור צבעוני גדול.

- **Shape:** פינות של 4px, גובה מינימלי 36px (2.25rem), ריפוד `8px 16px`.
- **Primary:** מילוי accent וטקסט לבן. אחד לכל תצוגה.
- **Hover / Focus:** ריחוף מכהה את ה־accent ב־`color-mix`; לחיצה מקטינה ל־`scale(0.97)`; מעברי צבע של 120ms.
- **Secondary:** גיליון עם קו חזק וטקסט בדיו; בריחוף מילוי רך וקו בדיו שלישי.
- **Danger:** גיליון עם קו `--danger-border` וטקסט `--danger`; בריחוף משטח `--danger-soft`.

### Badges

- **Style:** מילה בקו דק, פינות 3px, 12px במשקל 600, רקע שקוף. גוני מצב בקו ובטקסט; רק `danger` מקבלת משטח רך.
- **Lifecycle:** טיוטה בעיפרון (קו מקווקו), פורסם בדיו (קו רציף בצבע הדיו), פעיל כמילה פשוטה בלי מסגרת.

### Cards / Containers

- **Corner Style:** 6px.
- **Background:** גיליון על קרקע הפנקס.
- **Shadow Strategy:** בלי צל (ראו Elevation & Depth).
- **Border:** קו דק אחד. כרטיסיית התורנות הבאה ורצועת הניקוד מקבלות קו כפול עליון.
- **Internal Padding:** 24px (20px בטלפון).

### Inputs / Fields

- **Style:** גיליון, קו חזק, פינות 4px, גובה 40px, ריפוד `8px 12px`, טקסט 0.9375rem.
- **Focus:** הקו הופך ל־accent עם טבעת רכה של 3px (accent ב־25%), בלי outline.
- **Error / Disabled:** קו `--danger` רק אחרי שהשדה ננטש (`:user-invalid`). כפתור מושבת בשקיפות 0.55; כפתור שממתין לשרת (`aria-busy`) בשקיפות 0.8 עם סמן התקדמות.

### Navigation

- **Rail:** פס כריכה כהה ברוחב 248px. קישורים בטקסט 13px על `on-cover` בשקיפות; ריחוף ב־cover-2; העמוד הפתוח הוא גיליון שנשלף מהכריכה (רקע הגיליון וטקסט בדיו). ראשי קבוצות בתווית 12px מעל קו בהיר דק. מונה הוא תגית בהירה מרובעת.
- **Tab bar (טלפון):** חמישה טאבים על גיליון אטום עם קו כפול עליון; הטאב הפעיל בטקסט accent. גיליון ״עוד״ הוא נייר, וקישוריו בדיו.

### Duty rows and date tiles

שורת תורנות היא שורה בפנקס: אריח תאריך בקו דק (52px רוחב), כותרת ופרטים, מקומות בספרות טבלאיות. שורה שלי מקבלת אריח במסגרת דיו וסימן ״שלי״ בקו דיו. שורת טיוטה כתובה כולה בעיפרון.

### Summary line

שורת הסיכום היא ארבעה נתונים בקו אחד: גבולות עליון ותחתון בקו חזק, קו דק בין נתון לנתון, בלי רקע ובלי פינות. נתון לחיץ שנבחר מקבל משטח accent רך וקו תחתון פנימי של 2px ב־accent.

### Calendar

גיליון של שבעה טורים עם ראש ימים מעל קו כפול. שבת בגוון הגיליון; ימים מחוץ לחודש על נייר הפנקס. תורנויות היחידה בקו חזק דק; תורנות שלי במסגרת דיו, במשקל 700 ועם אייקון ״שלי״. היום מסומן במספר יום על אריח כריכה.

### Next duty ticket

כרטיסייה על גיליון עם קו כפול עליון: אריח תאריך הפוך (כריכה) עם היום במספר גדול, שם התורנות, טווח וספירה לאחור.

### Band strip (signature)

ציר ניקוד אחד בגובה 4.5rem. לכל ציון עמודה דקה (6px, בדיו שלישי); העמודה של הצופה עבה יותר (8px) ובדיו, ומתחת לה משולש ותווית בדיו. המינימום הוא קו דיו רציף של 2px; הרצועה מקווקוות עד גבול אדום מקווקו של 2px, שהתווית שלו קוראת פנימה לרצועה. לאחראי יש בורר שווי מקום של כפתורים קטנים; הנבחר ב־accent. על אותו ציר נבנית קבלת ההגרלה של החייל: שישה נתונים בשלושה טורים מקווקווים, והניקוד של הצופה בקו תחתון כפול. הקבלה מציגה מספרים בלבד (הכרעה 240).

### Motion

CSS בלבד (מדיניות CSP מחמירה). עקומה אחת, `cubic-bezier(0.2, 0.8, 0.2, 1)`, בשלושה משכים: 120ms לריחוף ובחירה, 200ms לדו־שיח ולמסך האפלה, 320ms למעבר ערכת נושא. כניסות דרך `@starting-style`, בלי קפיצה. ב־`prefers-reduced-motion` שום דבר לא מחליק, מתכווץ או קופץ; משטחים רק נמוגים, בקצרה.

## Do's and Don'ts

### Do:

- **Do** להשתמש בגופן המערכת (`--font-sans`) בלבד, בלי הורדת גופן רשת.
- **Do** לשמור את ה־accent (`#2f5bd3`) למה שאפשר ללחוץ עליו או מה שנבחר.
- **Do** לסמן ״אני״ ו״שלי״ בדיו ובסימן (מסגרת, סימן ״שלי״, אייקון או קו תחתון כפול), לעולם לא בצבע לבדו (אפיון 7.6).
- **Do** לכתוב טיוטה בעיפרון (מקווקו, `--pencil`), פרסום בדיו (רציף, `--text`), ומצב שגרתי כמילה פשוטה.
- **Do** לכתוב כל ספירה וניקוד ב־`tabular-nums lining-nums`.
- **Do** להגדיר כל צבע חדש כ־token ולתת לו ערך במצב כהה ובניגודיות מוגברת, בבהיר ובכהה.
- **Do** לבנות תנועה ב־CSS בלבד מתוך `--ease-out` ו־`--duration-*`, ולכבד `prefers-reduced-motion` ו־`prefers-reduced-transparency`.
- **Do** לשמור על רצפה של 12px (`--text-caption`) לכל טקסט, בגדלים ב־rem מתוך הסקאלה.
- **Do** לשמור את שמות ה־class שבדיקות ה־e2e בוחרות בהם: `.stat`, `.task-item`, `.duty-list .duty-row`, `section.panel` לכל סוג בקטלוג, ו־`.badge`.

### Don't:

- **Don't** להשתמש ב־`--rule-red` לשום דבר מלבד קו ״עכשיו״ וגבול הרצועה.
- **Don't** לקווקו שום דבר מחוץ לרצועה.
- **Don't** להוסיף פס צד צבעוני (`border-inline-start` עבה) להודעה, לשורה או לכרטיס.
- **Don't** לשים אייקון בתוך אריח צבוע.
- **Don't** לעצב תגית כגלולה (`--radius-full`); תגית היא מילה בקו דק עם פינות של 3px.
- **Don't** להשתמש בזכוכית, בשקיפות על רקע מטושטש או ב־`backdrop-filter`.
- **Don't** להוסיף כותרת־על (kicker או eyebrow) מעל כותרת.
- **Don't** לקנן כרטיס בתוך כרטיס; בתוך גיליון, פריטים הם שורות.
- **Don't** לבנות שורת כרטיסי סטטיסטיקה; נתונים נכתבים בשורת סיכום אחת בקווים.
- **Don't** להטיל צל על משטח במנוחה.
- **Don't** להניע תנועה מ־JavaScript או מסגנון מוטבע; התנועה כתובה ב־CSS בלבד, בגלל ה־CSP המחמיר.
