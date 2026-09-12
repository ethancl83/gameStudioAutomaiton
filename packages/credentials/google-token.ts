import { CredentialError, describeError } from './errors.js';

// The token endpoint is pinned. Credentials are never posted to endpoints
// taken from user-supplied data such as a service account JSON's token_uri.
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

export interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

function classifyHttpTokenError(status: number, providerCode: string | undefined): CredentialError {
  const suffix = providerCode ? ` (${providerCode})` : '';
  if (status === 429 || status >= 500) {
    // Transient endpoint trouble must not be presented as a broken grant;
    // callers retry instead of forcing the user through a new login.
    return new CredentialError(
      'token_temporarily_unavailable',
      `Google token endpoint returned HTTP ${status}${suffix}; retry later`,
      { retryable: true },
    );
  }
  if ((status === 400 || status === 401) && providerCode === 'invalid_grant') {
    return new CredentialError(
      'reauthorization_required',
      'Google rejected the grant as invalid or revoked; the connection must be re-authorized by the user',
    );
  }
  return new CredentialError('token_request_rejected', `Google token endpoint rejected the request with HTTP ${status}${suffix}`);
}

export async function postGoogleTokenRequest(
  fetchImplementation: typeof fetch,
  parameters: URLSearchParams,
): Promise<GoogleTokenResponse> {
  let response: Response;
  try {
    response = await fetchImplementation(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: parameters.toString(),
    });
  } catch (error) {
    throw new CredentialError(
      'token_temporarily_unavailable',
      `Google token endpoint request failed before a response was received: ${describeError(error)}`,
      { retryable: true, cause: error },
    );
  }
  let payload: Record<string, unknown> | undefined;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    payload = undefined;
  }
  if (!response.ok) {
    // Only the provider's stable error identifier is surfaced; descriptions
    // and payload bodies stay out of error messages.
    const providerCode = typeof payload?.error === 'string' ? payload.error : undefined;
    throw classifyHttpTokenError(response.status, providerCode);
  }
  if (!payload || typeof payload.access_token !== 'string' || payload.access_token === '') {
    throw new CredentialError('token_response_invalid', 'Google token endpoint returned a success response without an access token');
  }
  return payload as unknown as GoogleTokenResponse;
}
