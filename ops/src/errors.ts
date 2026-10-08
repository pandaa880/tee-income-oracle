/** An ops failure with a stable `code` (tests and the CLI match on it, not on the message). */
export class OpsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpsError';
    this.code = code;
  }
}
