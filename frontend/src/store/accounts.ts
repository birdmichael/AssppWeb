import { create } from "zustand";
import { openDB } from "idb";
import { apiDelete, apiGet, apiPut } from "../api/client";
import type { Account } from "../types";

const DB_NAME = "asspp-accounts";
const STORE_NAME = "accounts";

async function readLegacyAccounts(): Promise<Account[]> {
  const db = await openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "email" });
      }
    },
  });
  try {
    return (await db.getAll(STORE_NAME)) as Account[];
  } finally {
    db.close();
  }
}

function deleteLegacyDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

function accountPath(email: string): string {
  return `/api/accounts/${encodeURIComponent(email)}`;
}

interface AccountsState {
  accounts: Account[];
  loading: boolean;
  loadAccounts: () => Promise<void>;
  addAccount: (account: Account) => Promise<void>;
  removeAccount: (email: string) => Promise<void>;
  updateAccount: (account: Account) => Promise<void>;
  clearAccounts: () => Promise<void>;
}

export const useAccountsStore = create<AccountsState>((set, get) => ({
  accounts: [],
  loading: true,

  loadAccounts: async () => {
    set({ loading: true });
    try {
      const serverAccounts = await apiGet<Account[]>("/api/accounts");
      if (serverAccounts.length > 0) {
        set({ accounts: serverAccounts, loading: false });
        return;
      }

      const legacyAccounts = await readLegacyAccounts();
      if (legacyAccounts.length === 0) {
        set({ accounts: [], loading: false });
        return;
      }

      const migrated: Account[] = [];
      for (const account of legacyAccounts) {
        migrated.push(await apiPut<Account>(accountPath(account.email), account));
      }
      await deleteLegacyDatabase();
      set({ accounts: migrated, loading: false });
    } catch (error) {
      set({ loading: false });
      throw error;
    }
  },

  addAccount: async (account: Account) => {
    const saved = await apiPut<Account>(accountPath(account.email), account);
    set({
      accounts: [
        ...get().accounts.filter((a) => a.email !== saved.email),
        saved,
      ],
    });
  },

  removeAccount: async (email: string) => {
    await apiDelete(accountPath(email));
    set({ accounts: get().accounts.filter((a) => a.email !== email) });
  },

  updateAccount: async (account: Account) => {
    const saved = await apiPut<Account>(accountPath(account.email), account);
    const exists = get().accounts.some((a) => a.email === saved.email);
    set({
      accounts: exists
        ? get().accounts.map((a) => (a.email === saved.email ? saved : a))
        : [...get().accounts, saved],
    });
  },

  clearAccounts: async () => {
    for (const account of get().accounts) {
      await apiDelete(accountPath(account.email));
    }
    set({ accounts: [] });
  },
}));
