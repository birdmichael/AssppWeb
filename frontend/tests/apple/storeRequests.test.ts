import { beforeEach, expect, it, vi } from 'vitest';
import { purchaseApp } from '../../src/apple/purchase';
import { getDownloadInfo } from '../../src/apple/download';
import { appleRequest } from '../../src/apple/request';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import type { Account, Software } from '../../src/types';
vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
const account = { email: 'test@example.com', password: 'secret', passwordToken: 'token', directoryServicesIdentifier: '123', deviceIdentifier: 'AABBCCDDEEFF', store: '143465', storeFront: '143465-1,29', cookies: [] } as Account;
const app = { id: 123456, price: 0 } as Software;
const response = (dict: object, status = 200, headers: Record<string, string> = {}) => ({ status, statusText: '', body: buildPlist(dict), headers, rawHeaders: [] as [string, string][] });
const download = () => response({ songList: [{ URL: 'https://example.com/app.ipa', metadata: { bundleShortVersionString: '1.0', bundleVersion: '1' }, sinfs: [{ id: 0, sinf: 'AQID' }] }] });
beforeEach(() => vi.resetAllMocks());
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
