import { authHeaders } from '../api/client';
import { readPlistResponse } from './plistResponse';
import { SUPPORTED_SAP_VERSION } from './sap/types';
import type { SapEndpoints } from './sap/types';

export interface BagOutput {
  authURL: string;
  sapEndpoints: SapEndpoints;
  updateURL?: string;
}

// This plist protocol only supports the store authentication endpoint.
// Never guess a native /fast path or silently downgrade to unsigned login.
export function validateAuthURL(rawURL: string): URL {
  const url = new URL(rawURL);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !(url.hostname === 'buy.itunes.apple.com' || /^p[0-9]+-buy\.itunes\.apple\.com$/.test(url.hostname)) ||
    url.pathname !== '/WebObjects/MZFinance.woa/wa/authenticate') {
    throw new Error('Unsupported Apple authentication endpoint');
  }
  return url;
}

export async function fetchBag(deviceId: string): Promise<BagOutput> {
  const resp = await fetch('/api/bag?guid=' + encodeURIComponent(deviceId), { headers: authHeaders() });
  if (!resp.ok) {
    throw new Error('Apple bag: HTTP ' + resp.status + '; login stopped before sending credentials');
  }
  const dict = readPlistResponse({ status: resp.status, body: await resp.text() }, 'bag', 'init.itunes.apple.com', '/bag.xml');
  const value = (key: string) => dict[key] ?? dict.urlBag?.[key];
  const authURL = value('authenticateAccount');
  if (typeof authURL !== 'string') throw new Error('Apple bag: authentication endpoint missing');
  validateAuthURL(authURL);
  const setupURL = value('sign-sap-setup');
  const certificateURL = value('sign-sap-setup-cert');
  const version = Number(value('sign-sap-version'));
  if (typeof setupURL !== 'string' || typeof certificateURL !== 'string' || version !== SUPPORTED_SAP_VERSION) {
    throw new Error('Apple bag: missing or unsupported SAP configuration');
  }
  for (const [endpoint, host] of [[setupURL, 'fpinit.itunes.apple.com'], [certificateURL, 's.mzstatic.com']]) {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port) {
      throw new Error('Apple bag: unsupported SAP endpoint');
    }
  }
  const updateURL = value('updateProduct');
  return { authURL, sapEndpoints: { setupURL, certificateURL, version },
    ...(typeof updateURL === 'string' ? { updateURL } : {}),
  };
}
