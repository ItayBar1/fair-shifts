import yauzl from "yauzl";
import { AppError } from "./errors";

export const COMPRESSED_WORKBOOK_LIMIT = 5 * 1024 * 1024;
export const INFLATED_WORKBOOK_LIMIT = 50 * 1024 * 1024;
export const WORKBOOK_ENTRY_LIMIT = 2000;
const invalid = (message = "מבנה הקובץ פגום") =>
  new AppError("invalid_workbook", message);

/** Inflate and discard one entry at a time; advertised sizes are never the budget. */
export async function validateWorkbookArchive(buffer: Buffer) {
  if (buffer.length <= 22 || buffer.length > COMPRESSED_WORKBOOK_LIMIT)
    throw invalid("נדרש קובץ XLSX עד 5MB");
  let archive: yauzl.ZipFile;
  try {
    archive = await yauzl.fromBufferPromise(buffer, {
      lazyEntries: true,
      validateEntrySizes: false,
      strictFileNames: true,
    });
  } catch {
    throw invalid();
  }
  let entries = 0,
    total = 0;
  const names = new Set<string>();
  try {
    if (archive.entryCount === 0 || archive.entryCount > WORKBOOK_ENTRY_LIMIT)
      throw invalid("מבנה או גודל הקובץ אינם נתמכים");
    for await (const entry of archive.eachEntry()) {
      if (
        ++entries > WORKBOOK_ENTRY_LIMIT ||
        names.has(entry.fileName) ||
        entry.isEncrypted() ||
        ![0, 8].includes(entry.compressionMethod)
      )
        throw invalid();
      names.add(entry.fileName);
      if (entry.uncompressedSize > INFLATED_WORKBOOK_LIMIT)
        throw invalid("הקובץ גדול מדי לאחר פתיחה; יש לפצל את הנתונים");
      const stream = await archive.openReadStreamPromise(entry);
      let actual = 0;
      for await (const chunk of stream) {
        actual += chunk.length;
        total += chunk.length;
        if (total > INFLATED_WORKBOOK_LIMIT) {
          stream.destroy();
          throw invalid("הקובץ גדול מדי לאחר פתיחה; יש לפצל את הנתונים");
        }
      }
      // Reject conflicting metadata only after counting every actual byte.
      if (actual !== entry.uncompressedSize) throw invalid();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  } finally {
    archive.close();
  }
}
