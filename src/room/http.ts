import { ApiErrorCode, ERROR_MESSAGE, HTTP_STATUS, type ApiErrorCode as ApiCode, type ErrorBody } from "../../contract/index.js";

export class RoomHttpError extends Error {
  readonly status: number;
  readonly code: ApiCode;
  readonly reason?: string;

  constructor(status: number, code: ApiCode, reason?: string) {
    super(ERROR_MESSAGE[code]);
    this.name = "RoomHttpError";
    this.status = status;
    this.code = code;
    if (reason !== undefined) this.reason = reason;
  }

  body(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.reason !== undefined ? { reason: this.reason } : {}),
      },
    };
  }

  static unauthorized(): RoomHttpError {
    return new RoomHttpError(HTTP_STATUS.unauthorized, ApiErrorCode.Unauthorized);
  }

  static badRequest(): RoomHttpError {
    return new RoomHttpError(HTTP_STATUS.badRequest, ApiErrorCode.Validation);
  }

  static forbidden(reason?: string): RoomHttpError {
    return new RoomHttpError(HTTP_STATUS.forbidden, ApiErrorCode.Forbidden, reason);
  }

  static notFound(): RoomHttpError {
    return new RoomHttpError(HTTP_STATUS.notFound, ApiErrorCode.NotFound);
  }
}
