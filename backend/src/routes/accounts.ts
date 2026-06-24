import { Router, Request, Response } from "express";
import {
  deleteAccount,
  listAccounts,
  upsertAccount,
} from "../services/accountStore.js";
import type { Account } from "../types/index.js";

const router = Router();

function isAccount(value: unknown): value is Account {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<Account>;
  return (
    typeof account.email === "string" &&
    account.email.length > 0 &&
    typeof account.password === "string" &&
    typeof account.appleId === "string" &&
    typeof account.store === "string" &&
    typeof account.firstName === "string" &&
    typeof account.lastName === "string" &&
    typeof account.passwordToken === "string" &&
    typeof account.directoryServicesIdentifier === "string" &&
    Array.isArray(account.cookies) &&
    typeof account.deviceIdentifier === "string"
  );
}

function getEmailParam(req: Request): string | null {
  const value = req.params.email;
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

router.get("/accounts", async (_req: Request, res: Response) => {
  try {
    res.json(await listAccounts());
  } catch (error) {
    console.error(
      "List accounts error:",
      error instanceof Error ? error.message : error,
    );
    res.status(500).json({ error: "Failed to list accounts" });
  }
});

router.put("/accounts/:email", async (req: Request, res: Response) => {
  const email = getEmailParam(req);
  if (!email) {
    res.status(400).json({ error: "Missing account email" });
    return;
  }

  if (!isAccount(req.body)) {
    res.status(400).json({ error: "Invalid account payload" });
    return;
  }

  if (req.body.email !== email) {
    res.status(400).json({ error: "Route email must match account email" });
    return;
  }

  try {
    res.json(await upsertAccount(req.body));
  } catch (error) {
    console.error(
      "Save account error:",
      error instanceof Error ? error.message : error,
    );
    res.status(500).json({ error: "Failed to save account" });
  }
});

router.delete("/accounts/:email", async (req: Request, res: Response) => {
  try {
    const email = getEmailParam(req);
    if (!email) {
      res.status(400).json({ error: "Missing account email" });
      return;
    }

    await deleteAccount(email);
    res.status(204).end();
  } catch (error) {
    console.error(
      "Delete account error:",
      error instanceof Error ? error.message : error,
    );
    res.status(500).json({ error: "Failed to delete account" });
  }
});

export default router;
