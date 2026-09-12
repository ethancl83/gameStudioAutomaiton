export type CredentialErrorCode =
  | 'invalid_id'
  | 'invalid_credentials'
  | 'invalid_scopes'
  | 'credential_not_found'
  | 'vault_locked'
  | 'vault_unavailable'
  | 'master_key_missing'
  | 'decrypt_failed'
  | 'storage_corrupted'
  | 'unsupported_provider'
  | 'jwt_invalid'
  | 'token_response_invalid'
  | 'token_request_rejected'
  | 'token_temporarily_unavailable'
  | 'reauthorization_required'
  | 'invalid_redirect_uri'
  | 'invalid_oauth_input'
  | 'oauth_state_invalid'
  | 'oauth_state_expired'
  | 'oauth_exchange_incomplete';

/**
 * Every failure surfaced by this package carries a stable `code` and a
 * message that must never contain secret material (tokens, keys, codes,
 * verifiers, credential values). Provider error identifiers such as
 * "invalid_grant" are allowed; provider error descriptions are not.
 */
export class CredentialError extends Error {
  readonly code: CredentialErrorCode;
  readonly retryable: boolean;

  constructor(code: CredentialErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CredentialError';
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
