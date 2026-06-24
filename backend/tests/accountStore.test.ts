import { mkdtemp, readFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountStore } from "../src/services/accountStore.js";
import type { Account } from "../src/types/index.js";

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
  pod: "25",
};

describe("AccountStore", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "asspp-accounts-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns an empty list when the account file does not exist", async () => {
    const store = new AccountStore(tempDir, "123456");

    await expect(store.listAccounts()).resolves.toEqual([]);
  });

  it("encrypts accounts on disk and reads them back", async () => {
    const store = new AccountStore(tempDir, "123456");

    await store.upsertAccount(mockAccount);

    await expect(store.listAccounts()).resolves.toEqual([mockAccount]);
    const raw = await readFile(path.join(tempDir, "accounts.enc.json"), "utf8");
    expect(raw).toContain('"ciphertext"');
    expect(raw).not.toContain("secret");
    expect(raw).not.toContain("token123");
  });

  it("replaces an existing account with the same email", async () => {
    const store = new AccountStore(tempDir, "123456");

    await store.upsertAccount(mockAccount);
    await store.upsertAccount({ ...mockAccount, firstName: "Updated" });

    await expect(store.listAccounts()).resolves.toMatchObject([
      { email: "test@example.com", firstName: "Updated" },
    ]);
  });

  it("deletes accounts by email", async () => {
    const store = new AccountStore(tempDir, "123456");

    await store.upsertAccount(mockAccount);
    await store.deleteAccount(mockAccount.email);

    await expect(store.listAccounts()).resolves.toEqual([]);
  });

  it("reports a diagnostic error when the password cannot decrypt the file", async () => {
    const store = new AccountStore(tempDir, "123456");
    await store.upsertAccount(mockAccount);

    const wrongPasswordStore = new AccountStore(tempDir, "wrong-password");

    await expect(wrongPasswordStore.listAccounts()).rejects.toThrow(
      /ACCESS_PASSWORD/,
    );
  });
});
