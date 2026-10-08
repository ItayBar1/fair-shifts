import { AppError } from "./errors";

export const ACTION_BODY_LIMIT = 2 * 1024 * 1024;
export const AUTH_BODY_LIMIT = 16 * 1024;
export const JSON_DEPTH_LIMIT = 32;

const tooLarge = () =>
  new AppError("body_too_large", "הבקשה גדולה מדי או עמוקה מדי", 413);

/** The streamed count is authoritative, including absent or dishonest length headers. */
export async function readBoundedBody(
  request: Request,
  limit: number
): Promise<Buffer> {
  const length = request.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > limit) {
    await request.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

/** Scan before JSON.parse; punctuation inside quoted strings is not nesting. */
export function parseBoundedJson(buffer: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new AppError("invalid_json", "גוף הבקשה אינו JSON תקין", 400);
  }
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > JSON_DEPTH_LIMIT) throw tooLarge();
    } else if (character === "}" || character === "]") depth--;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("invalid_json", "גוף הבקשה אינו JSON תקין", 400);
  }
}

export async function boundedAuthRequest(request: Request) {
  if (["GET", "HEAD"].includes(request.method)) return request;
  const buffer = await readBoundedBody(request, AUTH_BODY_LIMIT);
  if (
    buffer.length &&
    ((request.headers.get("content-type") ?? "")
      .toLowerCase()
      .includes("json") ||
      ["{", "["].includes(buffer.toString("utf8").trimStart()[0]))
  )
    parseBoundedJson(buffer);
  // NextRequest's consumed body cannot be cloned. Rebuild from the URL and
  // headers after reading, and use the measured length for the replay.
  const headers = new Headers(request.headers);
  headers.set("content-length", String(buffer.length));
  return new Request(request.url, {
    method: request.method,
    headers,
    body: new Uint8Array(buffer),
    signal: request.signal,
    redirect: request.redirect,
  });
}
