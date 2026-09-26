export class RouteError extends Error {
  constructor(message: string, readonly code: string, readonly cause?: unknown) {
    super(message);
    this.name = "RouteError";
  }
}

export class ProfileValidationError extends RouteError {
  constructor(message: string) {
    super(message, "PROFILE_VALIDATION");
    this.name = "ProfileValidationError";
  }
}
