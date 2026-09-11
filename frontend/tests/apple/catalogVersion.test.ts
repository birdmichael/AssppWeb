import { beforeEach, expect, it, vi } from 'vitest';
import { lookupCurrentIosVersion } from '../../src/apple/catalogVersion';
import { appleRequest } from '../../src/apple/request';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
const account = { store: '143465', storeFront: '143465-1,29', passwordToken: 'private-token', cookies: [{ name: 'session', value: 'private-cookie' }] } as Account;
const app = { id: 414478124, bundleID: 'com.tencent.xin' } as Software;
const response = (data: unknown, status = 200) => ({ status, statusText: '', body: JSON.stringify(data), headers: {}, rawHeaders: [] });
const catalog = (offer: unknown) => response({ results: { [app.id]: { bundleId: app.bundleID, offers: [offer] } } });
beforeEach(() => vi.resetAllMocks());

it.each([890654806, '890654806'])('uses the China iOS catalog without transmitting credentials (version %s)', async (id) => {
  vi.mocked(appleRequest).mockResolvedValue(catalog({ version: { externalId: id } }));
  await expect(lookupCurrentIosVersion(account, app)).resolves.toBe('890654806');
  const request = vi.mocked(appleRequest).mock.calls[0][0];
  expect(request.host).toBe('uclient-api.itunes.apple.com');
  expect(request.method).toBe('GET');
  const url = new URL('https://' + request.host + request.path);
  expect(url.pathname).toBe('/WebObjects/MZStorePlatform.woa/wa/lookup');
  expect(Object.fromEntries(url.searchParams)).toEqual({ version: '2', id: String(app.id), p: 'mdm-lockup', caller: 'MDM', platform: 'enterprisestore', cc: 'cn', l: 'en' });
  expect(request.headers).toEqual({ Accept: 'application/json' });
  expect(request.cookies).toBeUndefined();
  expect(request.body).toBeUndefined();
});
it('uses the authenticated storefront and supports legacy accounts with only a region ID', async () => {
  vi.mocked(appleRequest).mockResolvedValue(catalog({ version: { externalId: 123 } }));
  await lookupCurrentIosVersion({ ...account, storeFront: '143441-1,29' }, app);
  await lookupCurrentIosVersion({ ...account, storeFront: undefined }, app);
  expect(vi.mocked(appleRequest).mock.calls[0][0].path).toContain('cc=us');
  expect(vi.mocked(appleRequest).mock.calls[1][0].path).toContain('cc=cn');
});
it('falls back to the offer version in buyParams without copying purchase parameters', async () => {
  vi.mocked(appleRequest).mockResolvedValue(catalog({ buyParams: 'productType=C&appExtVrsId=890654806&pricingParameters=STDQ' }));
  await expect(lookupCurrentIosVersion(account, app)).resolves.toBe('890654806');
});
it.each([
  { results: {} },
  { results: { [app.id]: { offers: [] } } },
  { results: { [app.id]: { bundleId: 'wrong.app', offers: [{ version: { externalId: 123 } }] } } },
  { results: { [app.id]: { offers: [{ version: { externalId: 'invalid' } }] } } },
  { results: { [app.id]: { offers: [{ version: { externalId: 9007199254740992 } }] } } },
  null,
])('rejects unavailable or invalid catalog data', async (data) => {
  vi.mocked(appleRequest).mockResolvedValue(response(data));
  await expect(lookupCurrentIosVersion(account, app)).rejects.toThrow('Apple catalog lookup:');
  expect(appleRequest).toHaveBeenCalledTimes(1);
});
it('rejects an unknown account region without guessing another store', async () => {
  await expect(lookupCurrentIosVersion({ ...account, store: 'unknown', storeFront: undefined }, app)).rejects.toThrow('unknown account region');
  expect(appleRequest).not.toHaveBeenCalled();
});
it.each([
  { ...response({}, 403), body: 'private-response' },
  { ...response({}), body: 'private-invalid-json' },
])('reports catalog errors without including response content', async (reply) => {
  vi.mocked(appleRequest).mockResolvedValue(reply);
  const error = await lookupCurrentIosVersion(account, app).catch(e => e);
  expect(error.message).toContain('HTTP ' + reply.status);
  expect(error.message).not.toContain('private-');
});
