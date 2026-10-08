import { decodeImportWorkbook, importRows } from "./import-workbook";
import { AppError } from "./errors";

function reply(message: unknown) {
  const encoded = JSON.stringify(message);
  const bytes = Buffer.byteLength(encoded);
  process.send?.(
    bytes <= 2 * 1024 * 1024
      ? JSON.parse(encoded)
      : {
          error: {
            code: "invalid_workbook",
            message: "הקובץ מורכב מדי. יש לפצל את הנתונים",
            status: 422,
          },
        }
  );
}

// One parse per fresh process. No database or provider secrets are inherited.
process.once("message", async (buffer: unknown) => {
  try {
    if (!Buffer.isBuffer(buffer))
      throw new AppError("invalid_workbook", "מבנה הקובץ פגום");
    const rows = importRows.parse(await decodeImportWorkbook(buffer));
    reply({ rows });
  } catch (error) {
    const failure =
      error instanceof AppError
        ? error
        : new AppError(
            "invalid_workbook",
            "לא ניתן לקרוא את הקובץ. יש לשמור XLSX לפי התבנית"
          );
    reply({
      error: {
        code: failure.code,
        message: failure.message,
        status: failure.status,
        details: failure.details,
      },
    });
  }
});
