/** An actionable diagnostic, with file, locale and message context. */
export class ArbError extends Error {
  override readonly name = "ArbError";

  constructor(message: string, context?: string, options?: ErrorOptions) {
    super(context === undefined ? message : `${context}: ${message}`, options);
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
