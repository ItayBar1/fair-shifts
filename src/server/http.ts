import { ZodError } from "zod";
import { AppError } from "./errors";
/** Drizzle wraps the driver's error, so the SQLSTATE can sit one or two causes down. */
function uniqueViolation(error: unknown): boolean {
  let current = error;
  for (
    let depth = 0;
    depth < 3 && current && typeof current === "object";
    depth++
  ) {
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
export function errorResponse(error: unknown): Response {
  if (error instanceof AppError)
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      },
      { status: error.status }
    );
  if (error instanceof ZodError)
    return Response.json(
      {
        error: {
          code: "invalid_input",
          message: "יש לבדוק את השדות שסומנו",
          details: error.issues,
        },
      },
      { status: 422 }
    );
  if (uniqueViolation(error))
    return Response.json(
      {
        error: {
          code: "conflict",
          message: "רשומה או שיבוץ כבר קיימים. יש לרענן את המידע",
        },
      },
      { status: 409 }
    );
  console.error(
    "Request failed",
    error instanceof Error ? error.name : "unknown"
  );
  return Response.json(
    {
      error: {
        code: "internal_error",
        message: "הפעולה לא הושלמה. נסו שוב או פנו לאחראי",
      },
    },
    { status: 500 }
  );
}
export function verifyOrigin(request: Request) {
  const expected = new URL(
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
  ).origin;
  if (request.headers.get("origin") !== expected)
    throw new AppError("forbidden_origin", "מקור הבקשה אינו מורשה", 403);
}
