import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AddAccountForm from '../../src/components/Account/AddAccountForm';
import AccountDetail from '../../src/components/Account/AccountDetail';
import { authenticate, AuthenticationError } from '../../src/apple/authenticate';
import type { AuthenticationContinuation } from '../../src/apple/authenticate';

const mocks = vi.hoisted(() => ({ addAccount: vi.fn(), updateAccount: vi.fn(), loadAccounts: vi.fn() }));
const account = { email: 'test@example.com', password: 'password', deviceIdentifier: 'AABBCCDDEEFF', cookies: [], store: '143465' };
vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/sap/client', () => ({ prepareSigner: vi.fn() }));
vi.mock('../../src/i18n', () => ({ default: { t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../src/components/common/SapStatus', () => ({ default: () => null }));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ ...mocks, accounts: [account], loading: false }) }));
vi.mock('../../src/apple/authenticate', async (original) => ({ ...await original<typeof import('../../src/apple/authenticate')>(), authenticate: vi.fn() }));
const continuation = { email: account.email, deviceId: account.deviceIdentifier, cookies: [{ name: 'challenge', value: 'secret' }] } as AuthenticationContinuation;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authenticate).mockRejectedValueOnce(new AuthenticationError('Verification required', true, continuation)).mockResolvedValue(account as any);
});
afterEach(cleanup);

async function startAdd() {
  render(<MemoryRouter><AddAccountForm /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('accounts.addForm.email'), { target: { value: account.email } });
  fireEvent.change(screen.getByLabelText('accounts.addForm.password'), { target: { value: account.password } });
  fireEvent.click(screen.getByRole('button', { name: 'accounts.addForm.signIn' }));
  return await screen.findByLabelText('accounts.addForm.code');
}
it('the add form passes the challenge into the verification request', async () => {
  fireEvent.change(await startAdd(), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'accounts.addForm.verify' }));
  await waitFor(() => expect(mocks.addAccount).toHaveBeenCalled());
  expect(vi.mocked(authenticate).mock.calls[1][5]).toBe(continuation);
  expect(vi.mocked(authenticate).mock.calls[0][3]).toBeUndefined();
});
it('editing the password abandons the previous challenge', async () => {
  await startAdd();
  fireEvent.change(screen.getByLabelText('accounts.addForm.password'), { target: { value: 'new-password' } });
  expect(screen.queryByLabelText('accounts.addForm.code')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'accounts.addForm.signIn' }));
  await waitFor(() => expect(authenticate).toHaveBeenCalledTimes(2));
  expect(vi.mocked(authenticate).mock.calls[1][5]).toBeUndefined();
});
it('reauthentication also passes the fresh challenge instead of only saved account cookies', async () => {
  render(<MemoryRouter initialEntries={['/accounts/test%40example.com']}><Routes><Route path='/accounts/:email' element={<AccountDetail />} /></Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'accounts.detail.reauth' }));
  fireEvent.change(await screen.findByLabelText('accounts.detail.code'), { target: { value: '123456' } });
  fireEvent.click(screen.getByRole('button', { name: 'accounts.detail.verify' }));
  await waitFor(() => expect(mocks.updateAccount).toHaveBeenCalled());
  expect(vi.mocked(authenticate).mock.calls[1][5]).toBe(continuation);
  expect(vi.mocked(authenticate).mock.calls[0][6]).toBe(account);
  expect(vi.mocked(authenticate).mock.calls[1][6]).toBe(account);
  expect(vi.mocked(authenticate).mock.calls[0][3]).toBeUndefined();
});
