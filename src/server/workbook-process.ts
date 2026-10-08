import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "./errors";
import { COMPRESSED_WORKBOOK_LIMIT } from "./workbook-archive";
import type { ImportRow } from "./import-workbook";

export const WORKBOOK_TIMEOUT_MS = 10_000;
export const WORKBOOK_HEAP_MIB = 128;
export const WORKBOOK_RSS_LIMIT = 256 * 1024 * 1024;
// Bound concurrent parsers as well as each parser. Reject excess work for retry.
let running = false;
// Production ships a compiled child. Tooling can use TS. Keep this launch out of
// Turbopack's fork-path rewriting; the child is deliberately not a Next bundle.
const forkChild = fork.bind(undefined);

export async function parseWorkbookInProcess(
  buffer: Buffer
): Promise<ImportRow[]> {
  if (buffer.length <= 22 || buffer.length > COMPRESSED_WORKBOOK_LIMIT)
    throw new AppError("invalid_workbook", "נדרש קובץ XLSX עד 5MB");
  if (running)
    throw new AppError("import_busy", "קובץ אחר בבדיקה. נסו שוב בעוד רגע", 429);
  running = true;
  try {
    const compiledChild = join(
      process.cwd(),
      "runtime/src/server/import-workbook-child.mjs"
    );
    const compiled = existsSync(compiledChild);
    return await new Promise<ImportRow[]>((resolve, reject) => {
      const child = forkChild(
        compiled
          ? compiledChild
          : join(process.cwd(), "src/server/import-workbook-child.ts"),
        [],
        {
          execArgv: [
            `--max-old-space-size=${WORKBOOK_HEAP_MIB}`,
            "--max-semi-space-size=4",
            ...(compiled ? [] : ["--import", "tsx"]),
          ],
          env: { NODE_ENV: "production" },
          serialization: "advanced",
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        }
      );
      let settled = false;
      const failed = () =>
        new AppError(
          "invalid_workbook",
          "בדיקת הקובץ נעצרה. יש לפצל את הנתונים או לשמור שוב לפי התבנית"
        );
      const finish = (error?: Error, rows?: ImportRow[]) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearInterval(memory);
        child.once("close", () => {
          if (error) reject(error);
          else resolve(rows!);
        });
        child.kill("SIGKILL");
      };
      const deadline = setTimeout(() => finish(failed()), WORKBOOK_TIMEOUT_MS);
      let reading = false;
      const memory = setInterval(() => {
        if (reading || !child.pid || settled) return;
        reading = true;
        // Linux is the supported runtime. Fail closed if resource accounting is unavailable.
        void readFile(`/proc/${child.pid}/status`, "utf8")
          .then((status) => {
            const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
            if (!match || Number(match[1]) * 1024 > WORKBOOK_RSS_LIMIT)
              finish(failed());
          })
          .catch(() => {
            if (!settled) finish(failed());
          })
          .finally(() => {
            reading = false;
          });
      }, 100);
      child.once("error", () => finish(failed()));
      child.once("exit", () => {
        if (!settled) finish(failed());
      });
      child.once("message", (message: unknown) => {
        if (!message || typeof message !== "object") return finish(failed());
        const reply = message as {
          rows?: ImportRow[];
          error?: {
            code: string;
            message: string;
            status: number;
            details?: unknown;
          };
        };
        if (reply.error)
          return finish(
            new AppError(
              reply.error.code,
              reply.error.message,
              reply.error.status,
              reply.error.details
            )
          );
        if (!Array.isArray(reply.rows) || reply.rows.length > 500)
          return finish(failed());
        finish(undefined, reply.rows);
      });
      child.send(buffer, (error) => {
        if (error) finish(failed());
      });
    });
  } finally {
    running = false;
  }
}
