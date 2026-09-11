import { beforeEach, expect, it, vi } from 'vitest';
import { getDownloadInfo } from '../../src/apple/download';
import { fetchBag } from '../../src/apple/bag';
import { appleRequest } from '../../src/apple/request';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { updateEndpoint } from '../../src/apple/config';
import type { BagOutput } from '../../src/apple/bag';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));
const account = { email: 'test@example.com', passwordToken: 'private-token', directoryServicesIdentifier: '123', deviceIdentifier: 'AABBCCDDEEFF', store: '143465', storeFront: '143465-1,29', pod: '34', cookies: [] } as unknown as Account;
const app = { id: 6451407032, bundleID: 'com.phoenix.video', price: 0 } as Software;
const version = '891078265';
const updateURL = 'https://downloaddispatch.itunes.apple.com/up/updateProduct';
const response = (dict: object, status = 200) => ({ status, statusText: '', body: buildPlist(dict), headers: {}, rawHeaders: [] as [string, string][] });
const empty500 = () => ({ ...response({}, 500), body: '' });
const item = () => ({ URL: 'https://example.com/app.ipa', metadata: {
  itemId: app.id, softwareVersionExternalIdentifier: Number(version), softwareVersionBundleId: app.bundleID,
  bundleShortVersionString: '7.3.7', bundleVersion: '737',
}, sinfs: [{ id: 0, sinf: 'AQID' }] });
const primary = () => response({ authorized: false, status: 0, songList: [], 'download-queue-item-count': 1, jingleDocType: 'purchaseSuccess' });
const pinnedFailure = () => vi.mocked(appleRequest).mockResolvedValueOnce(primary()).mockResolvedValueOnce(empty500());

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchBag).mockResolvedValue({ updateURL } as BagOutput);
});

it('recovers the reported China app sequence while retaining the version, device and current cookies', async () => {
  vi.mocked(appleRequest)
    .mockResolvedValueOnce(primary())
    .mockResolvedValueOnce(empty500())
    .mockResolvedValueOnce({ ...response({}), body: JSON.stringify({ results: { [app.id]: { bundleId: app.bundleID, offers: [{ version: { externalId: Number(version) } }] } } }) })
    .mockResolvedValueOnce({ ...empty500(), rawHeaders: [['set-cookie', 'session=current; Domain=.itunes.apple.com; Path=/']] })
    .mockResolvedValueOnce(response({ songList: [item()] }));
  const result = await getDownloadInfo(account, app);
  const requests = vi.mocked(appleRequest).mock.calls.map(([r]) => r);
  expect(requests).toHaveLength(5);
  expect(fetchBag).toHaveBeenCalledExactlyOnceWith(account.deviceIdentifier);
  expect(requests[4].host).toBe('downloaddispatch.itunes.apple.com');
  expect(requests[4].path).toBe('/up/updateProduct?guid=' + account.deviceIdentifier);
  expect(requests[4].body).toBe(requests[3].body);
  expect(requests[4].headers).toEqual(requests[3].headers);
  expect(parsePlist(requests[4].body!)).toEqual({ creditDisplay: '', serialNumber: '0', guid: account.deviceIdentifier, salableAdamId: app.id, appExtVrsId: version });
  expect(requests[4].cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'current' })]));
  expect(result.output.bundleShortVersionString).toBe('7.3.7');
  expect(result.updatedCookies).toEqual(requests[4].cookies);
});
it('preserves a user-selected historical version through updateProduct without catalog lookup', async () => {
  const historical = item();
  historical.metadata.softwareVersionExternalIdentifier = 12345;
  pinnedFailure().mockResolvedValueOnce(response({ songList: [historical] }));
  await getDownloadInfo(account, app, '12345');
  expect(appleRequest).toHaveBeenCalledTimes(3);
  expect(parsePlist(vi.mocked(appleRequest).mock.calls[2][0].body!).appExtVrsId).toBe('12345');
});
it('stops after one update failure and preserves the complete sanitized diagnostic chain', async () => {
  pinnedFailure().mockResolvedValueOnce(empty500());
  const error = await getDownloadInfo(account, app, version).catch(e => e);
  expect(appleRequest).toHaveBeenCalledTimes(3);
  expect(fetchBag).toHaveBeenCalledTimes(1);
  expect(error.message).toContain('volumeStoreDownloadProduct');
  expect(error.message).toContain('/r/redownload; body=empty -> retry=updateProduct -> HTTP 500');
  expect(error.message).toContain('/up/updateProduct; body=empty');
  expect(error.message).not.toContain(account.deviceIdentifier);
  expect(error.message).not.toContain(account.passwordToken);
});
it.each(['9610', '2034', '2042', '5002'])('preserves structured Apple failure %s without another fallback', async (code) => {
  pinnedFailure().mockResolvedValueOnce(response({ failureType: code }));
  await expect(getDownloadInfo(account, app, version)).rejects.toMatchObject({ code });
  expect(appleRequest).toHaveBeenCalledTimes(3);
});
it.each([
  response({ songList: [] }),
  response({ songList: [item(), item()] }),
  response({ songList: [item()] }, 500),
  response({ songList: [item()], customerMessage: 'Cannot process request' }),
])('rejects ambiguous or unsuccessful update responses', async (reply) => {
  pinnedFailure().mockResolvedValueOnce(reply);
  await expect(getDownloadInfo(account, app, version)).rejects.toThrow();
  expect(appleRequest).toHaveBeenCalledTimes(3);
});
it.each([
  ['itemId', 1], ['itemId', undefined],
  ['softwareVersionExternalIdentifier', 1], ['softwareVersionExternalIdentifier', undefined],
  ['softwareVersionBundleId', 'wrong.app'], ['softwareVersionBundleId', undefined],
])('rejects a missing or different app/version identity (%s)', async (key, value) => {
  const invalid = item();
  Object.assign(invalid.metadata, { [key as string]: value });
  pinnedFailure().mockResolvedValueOnce(response({ songList: [invalid] }));
  await expect(getDownloadInfo(account, app, version)).rejects.toThrow('does not match');
});
it.each([
  { ...empty500(), status: 403 }, { ...empty500(), status: 429 }, { ...empty500(), status: 503 },
  { ...empty500(), body: '<html>maintenance</html>' }, response({}, 500), response({ songList: [] }),
])('does not try updateProduct for other dispatch responses', async (reply) => {
  vi.mocked(appleRequest).mockResolvedValueOnce(primary()).mockResolvedValueOnce(reply);
  await expect(getDownloadInfo(account, app, version)).rejects.toThrow();
  expect(appleRequest).toHaveBeenCalledTimes(2);
  expect(fetchBag).not.toHaveBeenCalled();
});
it('stops if the public bag is unavailable without exposing its error contents', async () => {
  pinnedFailure();
  vi.mocked(fetchBag).mockRejectedValue(new Error('private-data'));
  const error = await getDownloadInfo(account, app, version).catch(e => e);
  expect(error.message).toContain('update endpoint lookup failed');
  expect(error.message).toContain('HTTP 500');
  expect(error.message).not.toContain('private-data');
  expect(appleRequest).toHaveBeenCalledTimes(2);
});
it.each([
  undefined, 'https://example.com/up/updateProduct', updateURL + '?other=value',
])('does not send update credentials to a missing or invalid bag endpoint', async (url) => {
  pinnedFailure();
  vi.mocked(fetchBag).mockResolvedValue({ updateURL: url } as BagOutput);
  await expect(getDownloadInfo(account, app, version)).rejects.toThrow('update endpoint');
  expect(appleRequest).toHaveBeenCalledTimes(2);
});
it.each([
  'https://example.com/up/updateProduct',
  'https://buy.itunes.apple.com/up/updateProduct',
  'https://downloaddispatch.itunes.apple.com/r/redownload',
])('rejects unrelated update redirect targets', async (location) => {
  pinnedFailure().mockResolvedValueOnce({ ...response({}, 302), headers: { location } });
  await expect(getDownloadInfo(account, app, version)).rejects.toThrow('redirect endpoint');
  expect(appleRequest).toHaveBeenCalledTimes(3);
});
it.each([
  '', 'http://downloaddispatch.itunes.apple.com/up/updateProduct',
  'https://user@downloaddispatch.itunes.apple.com/up/updateProduct',
  'https://downloaddispatch.itunes.apple.com:443/up/updateProduct',
  updateURL + '?', updateURL + '#fragment',
  'https://downloaddispatch.itunes.apple.com/up/%75pdateProduct',
])('rejects unsupported endpoint syntax %s', (url) => {
  expect(() => updateEndpoint(url, account.deviceIdentifier)).toThrow('Unsupported Apple update endpoint');
});
