import type { AppleResponse } from './request';

// Do not expose response bodies, headers, query strings or account identifiers.
export function storeDiagnostic(response: AppleResponse, host: string, path: string, dict?: Record<string, any>): string {
  const code = String(dict?.failureType ?? '');
  const failure = /^-?\d{1,10}$/.test(code) ? `; Apple ${code}` : '';
  return `HTTP ${response.status}; ${host}${path.split('?')[0]}${failure}`;
}

export function storeRedirect(location: string, host: string, path: string, allowedPaths: string[]): URL {
  const url = new URL(location, `https://${host}${path}`);
  const storeHost = url.hostname === 'buy.itunes.apple.com' || /^p[0-9]+-buy\.itunes\.apple\.com$/.test(url.hostname);
  const dispatchHost = url.hostname === 'downloaddispatch.itunes.apple.com';
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !(storeHost || dispatchHost) || !allowedPaths.includes(url.pathname)) {
    throw new Error('Unsupported Apple store redirect endpoint');
  }
  return url;
}
