# שחזורי ביקורת — Docker בלבד

קבצים אלה הם מקורות בדיקות שנשמרו כטקסט לצורך סקירה ותיקון. הם אינם מתגלים ב־Vitest/Playwright בסוויטה הרגילה. שני שחזורי ההתנהגות נכשלו בקוד הבסיס `33eb99a`, ומיועדים להפוך לבדיקות רגרסיה כחלק מתיקון הבאגים. שער Husky הרגיל נותר פעיל ללא עקיפה.

הרצה משורש המאגר; אין להשתמש במסד פיתוח או production. כל פקודת אינטגרציה/דפדפן רצה לבדה מול מסד הבדיקות שלה.

```sh
# Actual performer and rest: expected to fail on the audited baseline (six cases).
sh scripts/docker.sh -p fs-audit-repro --profile test run --build --rm \
  -v "$PWD/docs/audits/2026-10-05/reproductions/performer-rest.test.ts.txt:/app/tests/unit/audit-domain.test.ts:ro" \
  tests pnpm exec vitest run tests/unit/audit-domain.test.ts

# Expired transfer with a delayed worker: expected to fail on the audited baseline.
sh scripts/docker.sh -p fs-audit-repro --profile test run --build --rm \
  -v "$PWD/docs/audits/2026-10-05/reproductions/expired-transfer.test.ts.txt:/app/tests/integration/audit-transfer.test.ts:ro" \
  tests sh -c 'pnpm db:migrate && pnpm exec vitest run tests/integration/audit-transfer.test.ts --no-file-parallelism'

# Delete only the temporary audit project's resources.
sh scripts/docker.sh -p fs-audit-repro --profile test down --volumes --remove-orphans
```

הבדיקה השנייה בודקת תשובה עסקית 409 וסגירת ההצעה; התוצאה שנמדדה היא 500 והצעה `awaiting_consent`. הדוח אינו טוען שהכשל שוחזר גם בהחלפה הדדית.

`browser-probe.ts.txt` הוא גישוש שנוסף לעותק זמני של `tests/e2e/screens-sweep.spec.ts` בתוך קונטיינר. לפניו תוקנה ההמתנה של `sharedSessions` בעותק הזמני: מיד אחרי `await login(page, key)` ולפני `page.close()` ממתינים ל־H1 המדויק של `screens[key][0].title`. אחרת הכותרת של מסך הכניסה יכולה לסיים את ההמתנה מוקדם מדי. מתקינים `axe-core@4.14.0` ב־`/tmp/axe-audit` בתוך קונטיינר E2E בלבד, ממפים תיקיית פלט סינתטית ל־`/audit-output`, ומריצים רק `--grep "external audit"` בפרויקט Compose נפרד. הגישוש מתעד שמות ודגלי עוגיות בלבד, בלי ערכים. תוצאות הסריקה מסוכמות בדוח הנגישות; קובצי JSON וצילומי מסך זמניים אינם נשמרים במאגר.
