import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PurchaseError } from '../../src/apple/purchase';
import { useDownloadAction } from '../../src/hooks/useDownloadAction';
const mocks = vi.hoisted(() => ({ purchase: vi.fn().mockResolvedValue({ updatedCookies: [] }), authenticate: vi.fn(), update: vi.fn() }));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ updateAccount: mocks.update }) }));
vi.mock('../../src/apple/purchase', async (original) => ({ ...await original<typeof import('../../src/apple/purchase')>(), purchaseApp: mocks.purchase }));
vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../src/apple/authenticate', () => ({ authenticate: mocks.authenticate }));
vi.mock('../../src/apple/download', () => ({ getDownloadInfo: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
it('acquires a license with the existing authenticated session without starting hidden 2FA', async () => {
  const account = { email: 'test@example.com', store: '143465', passwordToken: 'valid-token' } as any;
  const app = { id: 123, name: 'Test', price: 0 } as any;
  const { result } = renderHook(() => useDownloadAction());
  await result.current.acquireLicense(account, app);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  expect(mocks.purchase).toHaveBeenCalledWith(account, app);
  expect(mocks.update).toHaveBeenCalledWith({ ...account, cookies: [] });
});

beforeEach(() => { vi.clearAllMocks(); mocks.authenticate.mockReset(); mocks.purchase.mockReset().mockResolvedValue({ updatedCookies: [] }); });
const account = { email: 'test@example.com', password: 'password', deviceIdentifier: 'AABBCCDDEEFF', cookies: [{ name: 'old-session' }], store: '143465', passwordToken: 'expired-token' } as any;
const app = { id: 123, name: 'Test', price: 0 } as any;
it('renews only after 2034 and retries once using the newly stored account', async () => {
  const renewed = { ...account, passwordToken: 'fresh-token', cookies: [] };
  mocks.purchase.mockRejectedValueOnce(new PurchaseError('Expired', '2034'));
  mocks.authenticate.mockResolvedValueOnce(renewed);
  const { result } = renderHook(() => useDownloadAction());
  await result.current.acquireLicense(account, app);
  expect(mocks.authenticate).toHaveBeenCalledWith(account.email, account.password, undefined, undefined, account.deviceIdentifier);
  expect(mocks.purchase).toHaveBeenNthCalledWith(2, renewed, app);
  expect(mocks.update).toHaveBeenCalledWith(renewed);
});
it('does not resume buying with the old token when renewal fails', async () => {
  mocks.purchase.mockRejectedValueOnce(new PurchaseError('Expired', '2034'));
  mocks.authenticate.mockRejectedValueOnce(new Error('Verification required'));
  const { result } = renderHook(() => useDownloadAction());
  await expect(result.current.acquireLicense(account, app)).rejects.toThrow('Verification required');
  expect(mocks.purchase).toHaveBeenCalledTimes(1);
  expect(mocks.update).not.toHaveBeenCalled();
});
it('stops if the renewed token is also rejected', async () => {
  mocks.purchase.mockRejectedValue(new PurchaseError('Expired', '2034'));
  mocks.authenticate.mockResolvedValueOnce({ ...account, passwordToken: 'fresh-token' });
  const { result } = renderHook(() => useDownloadAction());
  await expect(result.current.acquireLicense(account, app)).rejects.toThrow('Expired');
  expect(mocks.authenticate).toHaveBeenCalledTimes(1);
  expect(mocks.purchase).toHaveBeenCalledTimes(2);
});
it('does not authenticate again for unrelated purchase failures', async () => {
  mocks.purchase.mockRejectedValueOnce(new PurchaseError('Unavailable', '2059'));
  const { result } = renderHook(() => useDownloadAction());
  await expect(result.current.acquireLicense(account, app)).rejects.toThrow('Unavailable');
  expect(mocks.authenticate).not.toHaveBeenCalled();
});
