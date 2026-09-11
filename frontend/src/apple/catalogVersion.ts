import { appleRequest } from './request';
import { storeIdToCountry } from './config';
import type { Account, Software } from '../types';

export class CatalogLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogLookupError';
  }
}

function versionId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)) return value;
  return undefined;
}

// Public iOS catalog lookup. Never send account credentials or cookies here.
export async function lookupCurrentIosVersion(account: Account, app: Software): Promise<string> {
  const store = (account.storeFront || account.store).split('-')[0];
  const country = storeIdToCountry(store);
  if (!country) throw new CatalogLookupError('Apple catalog lookup: unknown account region');
  if (!Number.isSafeInteger(app.id) || app.id <= 0) throw new CatalogLookupError('Apple catalog lookup: invalid app ID');

  const query = new URLSearchParams({
    version: '2', id: String(app.id), p: 'mdm-lockup', caller: 'MDM',
    platform: 'enterprisestore', cc: country.toLowerCase(), l: 'en',
  });
  const response = await appleRequest({
    method: 'GET',
    host: 'uclient-api.itunes.apple.com',
    path: '/WebObjects/MZStorePlatform.woa/wa/lookup?' + query,
    headers: { Accept: 'application/json' },
  }).catch(() => { throw new CatalogLookupError('Apple catalog request failed'); });
  const fail = (message: string) => new CatalogLookupError(
    `Apple catalog lookup: ${message} (HTTP ${response.status}; uclient-api.itunes.apple.com)`,
  );
  if (response.status !== 200) throw fail('request failed');

  let data;
  try { data = JSON.parse(response.body); } catch { throw fail('invalid JSON'); }
  const item = data?.results?.[String(app.id)];
  if (!item) throw fail('app unavailable in account region');
  if (app.bundleID && item.bundleId && item.bundleId !== app.bundleID) throw fail('app identity mismatch');
  const offer = Array.isArray(item.offers) ? item.offers[0] : undefined;
  if (!offer) throw fail('no offers');
  const id = versionId(offer.version?.externalId) ?? versionId(
    typeof offer.buyParams === 'string' ? new URLSearchParams(offer.buyParams).get('appExtVrsId') : undefined,
  );
  if (!id) throw fail('no current iOS version ID');
  return id;
}
