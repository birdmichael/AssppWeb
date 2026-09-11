import { renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useDownloadAction } from '../../src/hooks/useDownloadAction';
const mocks = vi.hoisted(() => ({ purchase: vi.fn().mockResolvedValue({ updatedCookies: [] }), authenticate: vi.fn(), update: vi.fn() }));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ updateAccount: mocks.update }) }));
vi.mock('../../src/apple/purchase', () => ({ purchaseApp: mocks.purchase }));
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
