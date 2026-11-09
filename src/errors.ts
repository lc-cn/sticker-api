export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    opts: { retryable?: boolean; details?: unknown; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryable = opts.retryable ?? (statusCode === 503 || statusCode === 429);
    this.details = opts.details;
    this.headers = opts.headers;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, { details });
