import crypto from "crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path from "path";
import { config } from "../config.js";
import type { Account } from "../types/index.js";

const ACCOUNT_FILE = "accounts.enc.json";
const FILE_VERSION = 1;
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const SALT_LENGTH = 16;

interface EncryptedAccountFile {
  version: number;
  kdf: "scrypt";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export class AccountStore {
  constructor(
    private readonly dataDir = config.dataDir,
    private readonly accessPassword = config.accessPassword,
  ) {}

  private get filePath(): string {
    return path.join(this.dataDir, ACCOUNT_FILE);
  }

  async listAccounts(): Promise<Account[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }

    try {
      const encrypted = JSON.parse(raw) as EncryptedAccountFile;
      return this.decrypt(encrypted);
    } catch (error) {
      throw new Error(
        "Unable to decrypt server account store. Verify ACCESS_PASSWORD matches the password used to create DATA_DIR/accounts.enc.json.",
      );
    }
  }

  async upsertAccount(account: Account): Promise<Account> {
    const accounts = await this.listAccounts();
    await this.saveAccounts([
      ...accounts.filter((existing) => existing.email !== account.email),
      account,
    ]);
    return account;
  }

  async deleteAccount(email: string): Promise<boolean> {
    const accounts = await this.listAccounts();
    const next = accounts.filter((account) => account.email !== email);
    if (next.length === accounts.length) return false;
    await this.saveAccounts(next);
    return true;
  }

  async saveAccounts(accounts: Account[]): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const encrypted = this.encrypt(accounts);
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tempPath, JSON.stringify(encrypted, null, 2), "utf8");
    try {
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  private deriveKey(salt: Buffer): Buffer {
    return crypto.scryptSync(this.accessPassword || "123456", salt, KEY_LENGTH);
  }

  private encrypt(accounts: Account[]): EncryptedAccountFile {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);
    const key = this.deriveKey(salt);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const plaintext = Buffer.from(JSON.stringify(accounts), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      version: FILE_VERSION,
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  private decrypt(encrypted: EncryptedAccountFile): Account[] {
    if (encrypted.version !== FILE_VERSION || encrypted.kdf !== "scrypt") {
      throw new Error("Unsupported account store format");
    }

    const salt = Buffer.from(encrypted.salt, "base64");
    const iv = Buffer.from(encrypted.iv, "base64");
    const tag = Buffer.from(encrypted.tag, "base64");
    const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
    const key = this.deriveKey(salt);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString("utf8"));
    if (!Array.isArray(parsed)) {
      throw new Error("Invalid account store payload");
    }
    return parsed as Account[];
  }
}

function defaultStore(): AccountStore {
  return new AccountStore(config.dataDir, config.accessPassword);
}

export async function listAccounts(): Promise<Account[]> {
  return defaultStore().listAccounts();
}

export async function upsertAccount(account: Account): Promise<Account> {
  return defaultStore().upsertAccount(account);
}

export async function deleteAccount(email: string): Promise<boolean> {
  return defaultStore().deleteAccount(email);
}
