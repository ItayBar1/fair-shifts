# שחזורים סינתטיים לביקורת 18.10.2026

ראיות ל[דוח הביקורת](../production-audit-2026-10-18.md), שאומתו ב־Docker מול `69c1cd7`. הקבצים נשמרים כ־`.txt` כדי שלא להוסיף לסוויטה הרגילה בדיקות שמדגימות תקלות פתוחות. בעת תיקון מעבירים את המקרים הרלוונטיים ל־`tests/integration` ומעדכנים את הדוח.

| קובץ                                                                   | תוצאה צפויה לפני תיקון                                                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [auth-role-and-erasure.test.ts.txt](auth-role-and-erasure.test.ts.txt) | שתי בדיקות נכשלות: replay אחרי הורדת תפקיד ומחיקה עם `manager_email_change`              |
| [contact-retention.test.ts.txt](contact-retention.test.ts.txt)         | בדיקה נכשלת: גוף הסיכום נשאר לאחר מחיקת הפנייה                                           |
| [domain-integrity.test.ts.txt](domain-integrity.test.ts.txt)           | בדיקת חציית נרמול נכשלת; בדיקת הקפאת יתרת אחראי עוברת                                    |
| [drive-scope.ts.txt](drive-scope.ts.txt)                               | exit 0 מאשר שחיפוש יומן מחזיר קובץ מתיקייה אחרת; זו הוכחת הבאג, לא בדיקת ההתנהגות הרצויה |

השחזורים משתמשים בזהויות מומצאות וב־`example.invalid`, בלי פנייה לספק אמיתי. בדיקות PostgreSQL מנקות את המסד שלהן. מריצים אותן רק בפרויקט Docker זמני ובמסדים הייעודיים להלן, ולא מול נתוני פיתוח שרוצים לשמור או מול production.

## PostgreSQL

מריצים משורש המאגר. הפונקציה בונה תמונה מהעץ הנוכחי וממפה את קובץ הראיה כבדיקת Vitest. כל אחת משלוש הקריאות צפויה להסתיים ב־exit 1 לפני תיקון; בודקים שפלט הכשל תואם לממצא, ולא לשגיאת תשתית.

```sh
audit_project="fs-audit-reproduce-$$"
sh scripts/docker.sh -p "$audit_project" --profile test up -d --wait test-db

reproduce() {
  audit_database="$1"
  audit_file="$2"
  sh scripts/docker.sh -p "$audit_project" exec -T test-db createdb -U fair_shifts "$audit_database" || return
  sh scripts/docker.sh -p "$audit_project" --profile test run --build --rm --no-deps \
    -e DATABASE_URL="postgresql://fair_shifts:test-only@test-db:5432/$audit_database" \
    -e TEST_DATABASE_URL="postgresql://fair_shifts:test-only@test-db:5432/$audit_database" \
    -v "$PWD/docs/audit-reproductions/$audit_file:/app/tests/integration/audit-repro.test.ts:ro" \
    tests sh -c 'pnpm db:migrate && pnpm exec vitest run tests/integration/audit-repro.test.ts --no-file-parallelism'
}

reproduce fair_shifts_auth_audit_test auth-role-and-erasure.test.ts.txt
reproduce fair_shifts_contact_audit_test contact-retention.test.ts.txt
reproduce fair_shifts_domain_audit_test domain-integrity.test.ts.txt

# Remove this disposable project only after inspecting the results.
sh scripts/docker.sh -p "$audit_project" --profile test down -v --remove-orphans --rmi local
```

## Drive

הספק כולו מדומה בתוך התהליך. הרשת כבויה ואין מסד. הבדיקה גם מאמתת ש־`listBackups` כן מוסיף סינון תיקייה, כדי להבחין בין שני המסלולים.

```sh
docker build --target tooling -t fair-shifts-audit-repro .
docker run --rm -i --network none --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges -v "$PWD/src:/app/src:ro" \
  fair-shifts-audit-repro node --import tsx --input-type=module \
  < docs/audit-reproductions/drive-scope.ts.txt
docker image rm fair-shifts-audit-repro
```
