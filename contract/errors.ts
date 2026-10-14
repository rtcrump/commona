export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export const ApiErrorCode = {
  Unauthorized: "unauthorized",
  Forbidden: "forbidden",
  NotFound: "not_found",
  Validation: "validation",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export interface ErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    /** Set on audited refusals. Absent on malformed requests. */
    reason?: string;
  };
}

export const ERROR_MESSAGE: Record<ApiErrorCode, string> = {
  unauthorized: "Missing or invalid token.",
  forbidden: "Not allowed.",
  not_found: "Not found.",
  validation: "Invalid request.",
};
