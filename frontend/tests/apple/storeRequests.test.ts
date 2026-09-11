import { beforeEach, expect, it, vi } from 'vitest';
import { purchaseApp } from '../../src/apple/purchase';
import { getDownloadInfo } from '../../src/apple/download';
import { appleRequest } from '../../src/apple/request';
import { fetchBag } from '../../src/apple/bag';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import type { Account, Software } from '../../src/types';
import type { BagOutput } from '../../src/apple/bag';
vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));
const account = { email: 'test@example.com', password: 'secret', passwordToken: 'token', directoryServicesIdentifier: '123', deviceIdentifier: 'AABBCCDDEEFF', store: '143465', storeFront: '143465-1,29', cookies: [] } as Account;
const app = { id: 123456, price: 0 } as Software;
const response = (dict: object, status = 200, headers: Record<string, string> = {}) => ({ status, statusText: '', body: buildPlist(dict), headers, rawHeaders: [] as [string, string][] });
const download = () => response({ songList: [{ URL: 'https://example.com/app.ipa', metadata: { bundleShortVersionString: '1.0', bundleVersion: '1' }, sinfs: [{ id: 0, sinf: 'AQID' }] }] });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchBag).mockResolvedValue({} as BagOutput);
});
it('preserves the complete Apple storefront on license requests', async () => {
  vi.mocked(appleRequest).mockResolvedValue(response({ jingleDocType: 'purchaseSuccess', status: 0 }));
  await purchaseApp(account, app);
  expect(vi.mocked(appleRequest).mock.calls[0][0].headers?.['X-Apple-Store-Front']).toBe('143465-1,29');
});
it('uses the generic store dispatch without inventing a pod and includes serialNumber', async () => {
  vi.mocked(appleRequest).mockResolvedValue(download());
  await getDownloadInfo(account, app);
  const req = vi.mocked(appleRequest).mock.calls[0][0];
  expect(req.host).toBe('buy.itunes.apple.com');
  expect(parsePlist(req.body!).serialNumber).toBe('0');
});
it('includes the Apple failure code when its purchase message is unknown', async () => {
  vi.mocked(appleRequest).mockResolvedValue(response({ failureType: '9999', customerMessage: 'An unknown error has occurred.' }));
  await expect(purchaseApp(account, app)).rejects.toThrow('9999');
});
it('reports HTTP and endpoint context for a plist without download items', async () => {
  vi.mocked(appleRequest).mockResolvedValue(response({ dialog: { explanation: 'Please review your account.' } }));
  await expect(getDownloadInfo(account, app)).rejects.toThrow('HTTP 200');
});

it('follows a purchase pod redirect preserving the body and new cookies', async () => {
  vi.mocked(appleRequest)
    .mockResolvedValueOnce({ ...response({}, 302, { location: 'https://p18-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/buyProduct' }), rawHeaders: [['set-cookie', 'session=new; Domain=.itunes.apple.com; Path=/']] })
    .mockResolvedValueOnce(response({ jingleDocType: 'purchaseSuccess', status: 0 }));
  await purchaseApp(account, app);
  const calls = vi.mocked(appleRequest).mock.calls.map(([r]) => r);
  expect(calls[1].host).toBe('p18-buy.itunes.apple.com');
  expect(calls[1].body).toBe(calls[0].body);
  expect(calls[1].cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'new' })]));
});
it('accepts an explicit license-already-exists code, but not an arbitrary HTTP 500', async () => {
  vi.mocked(appleRequest).mockResolvedValueOnce(response({ failureType: '5002' }));
  await expect(purchaseApp(account, app)).resolves.toBeDefined();
  vi.mocked(appleRequest).mockResolvedValueOnce(response({}, 500));
  await expect(purchaseApp(account, app)).rejects.toThrow('HTTP 500');
});
it('does not send purchase credentials to unrelated redirect targets', async () => {
  vi.mocked(appleRequest).mockResolvedValue(response({}, 302, { location: 'https://example.com/collect' }));
  await expect(purchaseApp(account, app)).rejects.toThrow('redirect endpoint');
  expect(appleRequest).toHaveBeenCalledTimes(1);
});
it.each([purchaseApp, getDownloadInfo])('recognizes device verification failure and retains code 1008', async (action) => {
  vi.mocked(appleRequest).mockResolvedValue(response({ failureType: '1008', customerMessage: 'An unknown error has occurred.' }));
  await expect(action(account, app)).rejects.toMatchObject({ code: '1008' });
});
it('keeps historical version and device parameters when falling back to redownload', async () => {
  vi.mocked(appleRequest).mockResolvedValueOnce(response({ failureType: '5002' })).mockResolvedValueOnce(download());
  await getDownloadInfo(account, app, '98765');
  const calls = vi.mocked(appleRequest).mock.calls.map(([r]) => r);
  expect(parsePlist(calls[0].body!).externalVersionId).toBe('98765');
  expect(parsePlist(calls[1].body!).appExtVrsId).toBe('98765');
  expect(parsePlist(calls[1].body!).serialNumber).toBe('0');
});

it('tries redownload once after an HTTP 200 empty songList while retaining cookies and requested version', async () => {
  vi.mocked(appleRequest).mockResolvedValueOnce({ ...response({ authorized: false, status: 0, songList: [] }), rawHeaders: [['set-cookie', 'session=continue; Domain=.itunes.apple.com; Path=/']] }).mockResolvedValueOnce(download());
  const result = await getDownloadInfo(account, app, '98765');
  expect(result.output.downloadURL).toBe('https://example.com/app.ipa');
  const req = vi.mocked(appleRequest).mock.calls[1][0];
  expect(req.host).toBe('downloaddispatch.itunes.apple.com');
  expect(parsePlist(req.body!).appExtVrsId).toBe('98765');
  expect(req.cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'continue' })]));
  expect(appleRequest).toHaveBeenCalledTimes(2);
});
it('reports both empty responses and authorization flags without repeating forever or leaking values', async () => {
  vi.mocked(appleRequest).mockResolvedValue(response({ authorized: false, status: 0, songList: [], passwordToken: 'secret-token', accountInfo: { appleId: 'private@example.com' } }));
  const err = await getDownloadInfo(account, app).catch(e => e);
  expect(appleRequest).toHaveBeenCalledTimes(2);
  expect(err.message).toContain('authorized=false');
  expect(err.message).toContain('volumeStoreDownloadProduct');
  expect(err.message).toContain('/r/redownload');
  expect(err.message).not.toContain('secret-token');
  expect(err.message).not.toContain('private@example.com');
  expect(err.message).not.toContain('AABBCCDDEEFF');
});
it.each([{ failureType: '9610' }, { failureType: '1008' }, { dialog: { explanation: 'Review terms' } }])('does not retry explicit business errors through redownload', async (dict) => {
  vi.mocked(appleRequest).mockResolvedValue(response(dict));
  await expect(getDownloadInfo(account, app)).rejects.toThrow();
  expect(appleRequest).toHaveBeenCalledTimes(1);
});

const emptyServerError = () => ({ ...response({}, 500), body: '' });
const currentVersion = () => ({ ...response({}), body: JSON.stringify({ results: { [app.id]: { offers: [{ version: { externalId: 890654806 } }] } } }) });
it('recovers an empty unversioned redownload 500 with one catalog-pinned retry and the same session', async () => {
  vi.mocked(appleRequest)
    .mockResolvedValueOnce(response({ authorized: false, status: 0, songList: [] }))
    .mockResolvedValueOnce({ ...emptyServerError(), rawHeaders: [['set-cookie', 'session=continue; Domain=.itunes.apple.com; Path=/']] })
    .mockResolvedValueOnce(currentVersion())
    .mockResolvedValueOnce(download());
  const result = await getDownloadInfo(account, app);
  expect(result.output.downloadURL).toBe('https://example.com/app.ipa');
  const calls = vi.mocked(appleRequest).mock.calls.map(([r]) => r);
  expect(calls).toHaveLength(4);
  expect(calls[2].host).toBe('uclient-api.itunes.apple.com');
  expect(calls[2].cookies).toBeUndefined();
  expect(calls[3].host).toBe('downloaddispatch.itunes.apple.com');
  expect(calls[3].path).toBe('/r/redownload?guid=AABBCCDDEEFF');
  expect(parsePlist(calls[3].body!)).toEqual({ creditDisplay: '', serialNumber: '0', guid: account.deviceIdentifier, salableAdamId: app.id, appExtVrsId: '890654806' });
  expect(calls[3].headers).toEqual(calls[1].headers);
  expect(calls[3].cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'continue' })]));
  expect(result.updatedCookies).toEqual(calls[3].cookies);
});
it('never replaces an explicitly selected historical version after a dispatch 500', async () => {
  vi.mocked(appleRequest).mockResolvedValueOnce(response({ songList: [] })).mockResolvedValueOnce(emptyServerError());
  await expect(getDownloadInfo(account, app, '98765')).rejects.toThrow('HTTP 500');
  expect(appleRequest).toHaveBeenCalledTimes(2);
  expect(parsePlist(vi.mocked(appleRequest).mock.calls[1][0].body!).appExtVrsId).toBe('98765');
});
it.each([
  { ...emptyServerError(), status: 401 },
  { ...emptyServerError(), status: 403 },
  { ...emptyServerError(), status: 429 },
  { ...emptyServerError(), status: 503 },
  { ...emptyServerError(), body: '<html>Maintenance private-message</html>' },
  response({ failureType: '2034' }, 500),
])('does not use catalog recovery for other HTTP or Apple errors', async (reply) => {
  vi.mocked(appleRequest).mockResolvedValueOnce(response({ songList: [] })).mockResolvedValueOnce(reply);
  const error = await getDownloadInfo(account, app).catch(e => e);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).not.toContain('private-message');
  expect(appleRequest).toHaveBeenCalledTimes(2);
});
it('does not apply dispatch recovery to a primary endpoint 500', async () => {
  vi.mocked(appleRequest).mockResolvedValueOnce(emptyServerError());
  await expect(getDownloadInfo(account, app)).rejects.toThrow('HTTP 500');
  expect(appleRequest).toHaveBeenCalledTimes(1);
});
it('stops after a pinned retry fails and retains the full diagnostic chain without account secrets', async () => {
  vi.mocked(appleRequest)
    .mockResolvedValueOnce(response({ authorized: false, songList: [], passwordToken: 'private-token' }))
    .mockResolvedValueOnce(emptyServerError())
    .mockResolvedValueOnce(currentVersion())
    .mockResolvedValueOnce(emptyServerError());
  const error = await getDownloadInfo(account, app).catch(e => e);
  expect(appleRequest).toHaveBeenCalledTimes(4);
  expect(error.message).toContain('volumeStoreDownloadProduct; songList=0; authorized=false');
  expect(error.message.match(/HTTP 500/g)).toHaveLength(2);
  expect(error.message).toContain('body=empty -> retry=current-iOS-version -> HTTP 500');
  expect(error.message).not.toContain('private-token');
  expect(error.message).not.toContain(account.deviceIdentifier);
});
it('preserves both download errors when the app has no current version in the account region', async () => {
  vi.mocked(appleRequest)
    .mockResolvedValueOnce(response({ songList: [] }))
    .mockResolvedValueOnce(emptyServerError())
    .mockResolvedValueOnce({ ...response({}), body: '{"results":{}}' });
  const error = await getDownloadInfo(account, app).catch(e => e);
  expect(error.message).toContain('app unavailable in account region');
  expect(error.message).toContain('volumeStoreDownloadProduct');
  expect(error.message).toContain('/r/redownload; body=empty');
  expect(appleRequest).toHaveBeenCalledTimes(3);
});
