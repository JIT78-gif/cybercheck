export class DomainError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 400, "validation_failed");
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 404, "not_found");
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(message: string) {
    super(message, 422, "insufficient_funds");
  }
}
