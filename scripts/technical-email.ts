import { pool } from "../src/server/db";
import {
  confirmServerEmailChange,
  requestServerEmailChange,
} from "../src/server/auth/technical-email";

// Output is English: it is read on the server (decision 187). No code or
// address is printed back; the recovery codes are shown once, like `recover`.
const usage = `Usage: pnpm technical-email <command>

  request   send a code to the new address. Needs TECHNICAL_CURRENT_EMAIL,
            TECHNICAL_NEW_EMAIL and TECHNICAL_CHANGE_REASON (at least 5 characters)
  confirm   enter the code from the new address and move the account.
            Needs TECHNICAL_CURRENT_EMAIL and TECHNICAL_CHANGE_CODE`;

const [command] = process.argv.slice(2);
let status = 0;
try {
  if (command === "request") {
    await requestServerEmailChange(
      process.env.TECHNICAL_CURRENT_EMAIL ?? "",
      process.env.TECHNICAL_NEW_EMAIL ?? "",
      process.env.TECHNICAL_CHANGE_REASON ?? ""
    );
    console.log(
      "A code was queued for the new address and is valid for 10 minutes. The worker sends it. Then run: pnpm technical-email confirm"
    );
  } else if (command === "confirm") {
    const codes = await confirmServerEmailChange(
      process.env.TECHNICAL_CURRENT_EMAIL ?? "",
      process.env.TECHNICAL_CHANGE_CODE ?? ""
    );
    console.log(
      "The address was changed. All connections of the account were ended and its Google link was removed; sign in again with the new address."
    );
    console.log(
      "The previous recovery codes no longer work. New codes, shown once; keep them outside the repository:"
    );
    console.log(codes.join("\n"));
  } else {
    console.error(usage);
    status = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Failed");
  status = 1;
} finally {
  await pool.end();
}
process.exit(status);
