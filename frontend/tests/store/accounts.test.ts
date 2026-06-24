import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccountsStore } from "../../src/store/accounts";
import type { Account } from "../../src/types";

const DB_NAME = "asspp-accounts";
const STORE_NAME = "accounts";

const mockAccount: Account = {
  email: "test@example.com",
  password: "secret",
  appleId: "test@example.com",
  store: "143441",
  firstName: "Test",
  lastName: "User",
  passwordToken: "token123",
  directoryServicesIdentifier: "dsid123",
  cookies: [],
  deviceIdentifier: "abcdef123456",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

async function seedLegacyAccounts(accounts: Account[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "email" });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(STORE_NAME, "readwrite");
      for (const account of accounts) {
        tx.objectStore(STORE_NAME).put(account);
      }
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

describe("store/accounts", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await deleteDb(DB_NAME);
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    useAccountsStore.setState({ accounts: [], loading: false });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await deleteDb(DB_NAME);
  });

  it("loads accounts from the server", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([mockAccount]));

    await useAccountsStore.getState().loadAccounts();

    expect(fetchMock).toHaveBeenCalledWith("/api/accounts", { headers: {} });
    expect(useAccountsStore.getState().accounts).toEqual([mockAccount]);
  });

  it("adds an account through the server API", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(mockAccount));

    await useAccountsStore.getState().addAccount(mockAccount);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/accounts/${encodeURIComponent(mockAccount.email)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mockAccount),
      },
    );
    expect(useAccountsStore.getState().accounts).toEqual([mockAccount]);
  });

  it("updates an account through the server API", async () => {
    const updated = { ...mockAccount, firstName: "Updated" };
    useAccountsStore.setState({ accounts: [mockAccount], loading: false });
    fetchMock.mockResolvedValueOnce(jsonResponse(updated));

    await useAccountsStore.getState().updateAccount(updated);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/accounts/${encodeURIComponent(updated.email)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updated),
      },
    );
    expect(useAccountsStore.getState().accounts).toEqual([updated]);
  });

  it("removes an account through the server API", async () => {
    useAccountsStore.setState({ accounts: [mockAccount], loading: false });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await useAccountsStore.getState().removeAccount(mockAccount.email);

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/accounts/${encodeURIComponent(mockAccount.email)}`,
      { method: "DELETE", headers: {} },
    );
    expect(useAccountsStore.getState().accounts).toEqual([]);
  });

  it("migrates legacy IndexedDB accounts when the server is empty", async () => {
    await seedLegacyAccounts([mockAccount]);
    fetchMock
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse(mockAccount));

    await useAccountsStore.getState().loadAccounts();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/accounts/${encodeURIComponent(mockAccount.email)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mockAccount),
      },
    );
    expect(useAccountsStore.getState().accounts).toEqual([mockAccount]);
  });

  it("does not migrate legacy IndexedDB accounts when server accounts exist", async () => {
    await seedLegacyAccounts([{ ...mockAccount, email: "legacy@example.com" }]);
    fetchMock.mockResolvedValueOnce(jsonResponse([mockAccount]));

    await useAccountsStore.getState().loadAccounts();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAccountsStore.getState().accounts).toEqual([mockAccount]);
  });
});
