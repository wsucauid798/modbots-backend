export class DomainError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const badRequest = (code: string, message: string): DomainError =>
  new DomainError(code, message, 400);

export const notFound = (code: string, message: string): DomainError =>
  new DomainError(code, message, 404);

export const conflict = (code: string, message: string): DomainError =>
  new DomainError(code, message, 409);

export const forbidden = (code: string, message: string): DomainError =>
  new DomainError(code, message, 403);

export const unauthorized = (code: string, message: string): DomainError =>
  new DomainError(code, message, 401);
