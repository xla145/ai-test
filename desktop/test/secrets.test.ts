import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrokerSecretResolver } from "@ai-test/mcp-servers";
import { describe, expect, it } from "vitest";
import { SecretStore, startSecretBroker, type Cipher } from "../src/main/secrets.js";

const cipher: Cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, "utf8").reverse(),
  decryptString: (b) => Buffer.from(b).reverse().toString("utf8"),
};

describe("secrets", () => {
  it("stores encrypted secrets and serves them only with the broker token", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sec-")), "secrets.json");
    const store = new SecretStore(file, cipher);
    store.set(SecretStore.ref("p1", "test"), { authToken: "Bearer abc", authHeader: "X-Token" });
    expect(readFileSync(file, "utf8")).not.toContain("Bearer abc");
    expect(new SecretStore(file, cipher).get(SecretStore.ref("p1", "test"))?.authToken).toBe("Bearer abc");

    const broker = await startSecretBroker(store);
    try {
      const ok = await new BrokerSecretResolver(broker.url, broker.token).resolve("p1", "test");
      expect(ok).toEqual({ AITEST_AUTH_TOKEN: "Bearer abc", AITEST_AUTH_HEADER: "X-Token" });
      expect(await new BrokerSecretResolver(broker.url, broker.token).resolve("p1", "prod")).toEqual({});
      await expect(new BrokerSecretResolver(broker.url, "wrong").resolve("p1", "test")).rejects.toThrow("401");
    } finally {
      await broker.close();
    }
  });

  it("injects role accounts and opens role views through the broker", async () => {
    const store = new SecretStore(join(mkdtempSync(join(tmpdir(), "sec-")), "s.json"), cipher);
    store.set(SecretStore.roleRef("p1", "admin"), { username: "alice", password: "pw" });
    const opened: string[] = [];
    const broker = await startSecretBroker(store, { openView: async (p, role) => { opened.push(`${p}/${role}`); return "aitest-view=1"; } });
    try {
      const r = new BrokerSecretResolver(broker.url, broker.token);
      const env = await r.resolve("p1", "test", { roles: ["admin", "viewer"] });
      expect(JSON.parse(env.AITEST_ROLES)).toEqual([{ role: "admin", username: "alice", password: "pw" }]);
      expect(await r.openView("p1", "admin")).toBe("aitest-view=1");
      expect(opened).toEqual(["p1/admin"]);
    } finally {
      await broker.close();
    }
  });

  it("refuses to store secrets in plain text", () => {
    const store = new SecretStore(join(mkdtempSync(join(tmpdir(), "sec-")), "s.json"), { ...cipher, isEncryptionAvailable: () => false });
    expect(() => store.set("r", { authToken: "x" })).toThrow("钥匙串");
  });
});
