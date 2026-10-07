import { describe, expect, it } from "vitest";
import {
  validateWorkbookArchive,
  INFLATED_WORKBOOK_LIMIT,
} from "../../src/server/workbook-archive";
import { zipFixture } from "../zip-fixture";

describe("actual sequential ZIP inflation budget", () => {
  it("counts actual bytes even when the directory advertises one byte", async () => {
    const compressed = zipFixture([
      {
        name: "xl/sharedStrings.xml",
        data: Buffer.alloc(INFLATED_WORKBOOK_LIMIT + 1, 0x41),
        advertisedSize: 1,
      },
    ]);
    expect(compressed.length).toBeLessThan(5 * 1024 * 1024);
    await expect(validateWorkbookArchive(compressed)).rejects.toMatchObject({
      code: "invalid_workbook",
      message: "הקובץ גדול מדי לאחר פתיחה; יש לפצל את הנתונים",
    });
  });
  it("shares the actual 50MiB budget across sequential entries", async () => {
    const data = Buffer.alloc(26 * 1024 * 1024, 0x42);
    await expect(
      validateWorkbookArchive(
        zipFixture([
          { name: "first.xml", data },
          { name: "second.xml", data },
        ])
      )
    ).rejects.toMatchObject({
      message: "הקובץ גדול מדי לאחר פתיחה; יש לפצל את הנתונים",
    });
  });
  it("rejects size conflicts, duplicate paths, unsafe paths and more than 2000 entries", async () => {
    await expect(
      validateWorkbookArchive(
        zipFixture([
          { name: "a.xml", data: Buffer.alloc(4), advertisedSize: 1 },
        ])
      )
    ).rejects.toMatchObject({ code: "invalid_workbook" });
    await expect(
      validateWorkbookArchive(
        zipFixture([
          { name: "a.xml", data: Buffer.alloc(0) },
          { name: "a.xml", data: Buffer.alloc(0) },
        ])
      )
    ).rejects.toMatchObject({ code: "invalid_workbook" });
    await expect(
      validateWorkbookArchive(
        zipFixture([{ name: "../a.xml", data: Buffer.alloc(0) }])
      )
    ).rejects.toMatchObject({ code: "invalid_workbook" });
    await expect(
      validateWorkbookArchive(
        zipFixture(
          Array.from({ length: 2001 }, (_, id) => ({
            name: `${id}.xml`,
            data: Buffer.alloc(0),
          }))
        )
      )
    ).rejects.toMatchObject({ code: "invalid_workbook" });
  });
  it("accepts a valid archive while discarding entry content", async () => {
    await expect(
      validateWorkbookArchive(
        zipFixture([{ name: "xl/test.xml", data: Buffer.from("synthetic") }])
      )
    ).resolves.toBeUndefined();
  });
});
