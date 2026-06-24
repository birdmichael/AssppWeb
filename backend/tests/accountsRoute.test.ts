import crypto from "crypto";
import { mkdtemp, rm } from "fs/promises";
import os from "os";
import path from "path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { accessAuth } from "../src/middleware/accessAuth.js";
import accountsRoutes from "../src/routes/accounts.js";
import type { Account } from "../src/types/index.js";

const accessToken = crypto.createHash("sha256").update("123456").digest("hex");

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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", accessAuth);
  app.use("/api", accountsRoutes);
  return app;
}

describe("Accounts Route", () => {
  const originalDataDir = config.dataDir;
  let tempDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "asspp-route-accounts-"));
    config.dataDir = tempDir;
    app = createApp();
  });

  afterEach(async () => {
    config.dataDir = originalDataDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rejects requests without an access token", async () => {
    const res = await request(app).get("/api/accounts");

    expect(res.status).toBe(401);
  });

  it("lists, upserts, and deletes accounts with a valid access token", async () => {
    const headers = { "X-Access-Token": accessToken };

    const empty = await request(app).get("/api/accounts").set(headers);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const saved = await request(app)
      .put(`/api/accounts/${encodeURIComponent(mockAccount.email)}`)
      .set(headers)
      .send(mockAccount);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ email: "test@example.com" });

    const listed = await request(app).get("/api/accounts").set(headers);
    expect(listed.body).toMatchObject([{ email: "test@example.com" }]);

    const deleted = await request(app)
      .delete(`/api/accounts/${encodeURIComponent(mockAccount.email)}`)
      .set(headers);
    expect(deleted.status).toBe(204);

    const afterDelete = await request(app).get("/api/accounts").set(headers);
    expect(afterDelete.body).toEqual([]);
  });

  it("rejects mismatched route and body emails", async () => {
    const res = await request(app)
      .put("/api/accounts/other%40example.com")
      .set({ "X-Access-Token": accessToken })
      .send(mockAccount);

    expect(res.status).toBe(400);
  });
});
