export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public details?: unknown
  ) {
    super(message);
  }
}
export function invariant(
  condition: unknown,
  code: string,
  message: string,
  status = 422,
  details?: unknown
): asserts condition {
  if (!condition) throw new AppError(code, message, status, details);
}
