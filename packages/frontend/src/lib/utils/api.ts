/**
 * CSRF-aware fetch wrapper for API calls.
 *
 * Reads the `resonant_csrf` cookie and sends it as an `x-csrf-token` header
 * on all state-changing requests (POST, PUT, PATCH, DELETE).
 * Also ensures `credentials: 'include'` is always set.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function getCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)resonant_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  const method = (options.method || 'GET').toUpperCase();

  // Attach CSRF token for state-changing methods
  if (!SAFE_METHODS.has(method)) {
    const token = getCsrfToken();
    if (token) {
      headers.set('x-csrf-token', token);
    }
  }

  return fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });
}
