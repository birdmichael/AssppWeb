import type { AppleResponse } from './request';

// Do not expose response bodies, headers, query strings or account identifiers.
export function storeDiagnostic(response: AppleResponse, host: string, path: string, dict?: Record<string, any>): string {
  const code = String(dict?.failureType ?? '');
  const failure = /^-?\d{1,10}$/.test(code) ? `; Apple ${code}` : '';
  const fields: string[] = [];
  if (dict) {
    fields.push('songList=' + (Array.isArray(dict.songList) ? dict.songList.length : dict.songList === undefined ? 'missing' : 'invalid'));
    if (typeof dict.authorized === 'boolean') fields.push('authorized=' + dict.authorized);
    if (Number.isSafeInteger(dict.status)) fields.push('status=' + dict.status);
    if (Number.isSafeInteger(dict['download-queue-item-count'])) fields.push('queue=' + dict['download-queue-item-count']);
    if (['purchaseSuccess', 'failure', 'error'].includes(dict.jingleDocType)) fields.push('type=' + dict.jingleDocType);
    if (dict.action) fields.push('action=present');
    if (dict.dialog) fields.push('dialog=present');
  }
  return `HTTP ${response.status}; ${host}${path.split('?')[0]}${failure}${fields.length ? '; ' + fields.join('; ') : ''}`;
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
