import { pool } from "../src/server/db";
import { recoverCalendarCreation } from "../src/server/calendar/recovery";
import { AppError } from "../src/server/errors";
import { GoogleError } from "../src/server/calendar/google";

// Server output is English. Never print tokens, calendar IDs or provider responses.
let status = 0;
try {
  const [mode] = process.argv.slice(2);
  if (mode !== "adopt" && mode !== "retry")
    throw new AppError(
      "usage",
      "Usage: pnpm calendar:recover adopt|retry. Set CALENDAR_ACCOUNT_ID and CALENDAR_RECOVERY_REASON. For adopt set CALENDAR_CREATED_ID. For retry set CALENDAR_RECOVERY_ACKNOWLEDGE='no calendar was created' after checking Google Calendar."
    );
  await recoverCalendarCreation({
    mode,
    accountId: process.env.CALENDAR_ACCOUNT_ID,
    reason: process.env.CALENDAR_RECOVERY_REASON,
    ...(mode === "adopt"
      ? { calendarId: process.env.CALENDAR_CREATED_ID }
      : {
          acknowledgement: process.env.CALENDAR_RECOVERY_ACKNOWLEDGE,
        }),
  });
  console.log(
    "Calendar creation recovered. The worker will reconcile the published duties."
  );
} catch (error) {
  console.error(
    error instanceof AppError || error instanceof GoogleError
      ? error.message
      : "Calendar recovery failed; check the input and database availability"
  );
  status = 1;
} finally {
  await pool.end();
}
process.exit(status);
