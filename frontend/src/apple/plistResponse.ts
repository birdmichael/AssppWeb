import { parsePlist } from './plist';
import type { AppleResponse } from './request';

// Apple's legacy services also return a Document wrapper or a bare dictionary.
// Accept these XML forms, while rejecting HTML error pages and malformed XML.
export function parseApplePlist(body: string): Record<string, any> {
  const doc = new DOMParser().parseFromString(body.trim(), 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Invalid Apple XML');
  let root: Element = doc.documentElement;
  if (root.nodeName === 'Document') {
    if (root.children.length !== 1 || !root.firstElementChild) throw new Error('Invalid Apple Document');
    root = root.firstElementChild;
  }
  if (root.nodeName !== 'plist' && root.nodeName !== 'dict') throw new Error('Invalid Apple plist root');
  if (root.nodeName === 'plist' && (root.children.length !== 1 || root.firstElementChild?.nodeName !== 'dict')) {
    throw new Error('Apple response is not a single dictionary');
  }
  const xml = new XMLSerializer().serializeToString(root);
  const dict = parsePlist(root.nodeName === 'dict' ? '<plist version="1.0">' + xml + '</plist>' : xml);
  if (!dict || typeof dict !== 'object' || Array.isArray(dict) || dict instanceof Uint8Array || dict instanceof Date) {
    throw new Error('Apple response is not a dictionary');
  }
  return dict;
}

export function readPlistResponse(response: Pick<AppleResponse, 'status' | 'body'>, phase: string, host: string, path: string): Record<string, any> {
  try { return parseApplePlist(response.body); } catch {
    const body = response.body.trim();
    const kind = !body ? 'empty' : /<(?:!doctype\s+html|html)\b/i.test(body) ? 'html' : 'invalid-xml';
    throw new Error(`Apple ${phase}: invalid plist response (HTTP ${response.status}; ${host}${path.split('?')[0]}; body=${kind})`);
  }
}
