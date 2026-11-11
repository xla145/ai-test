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

describe("secrets inherited from the big project", () => {
  it("falls back to the parent's token and role accounts, own values win", async () => {
    const { secretEnvFor } = await import("../src/main/secrets.js");
    const file = join(mkdtempSync(join(tmpdir(), "sec-")), "secrets.json");
    const store = new SecretStore(file, cipher);
    store.set(SecretStore.ref("grp", "test"), { authToken: "Bearer group" });
    store.set(SecretStore.roleRef("grp", "admin"), { username: "g-admin", password: "1" });
    store.set(SecretStore.roleRef("child", "guest"), { username: "c-guest", password: "2" });

    const inherited = secretEnvFor(store, "child", "test", ["admin", "guest"], "grp");
    expect(inherited.AITEST_AUTH_TOKEN).toBe("Bearer group");
    expect(JSON.parse(inherited.AITEST_ROLES).map((r: { username: string }) => r.username)).toEqual(["g-admin", "c-guest"]);
    // 没有大项目时不会串用其它项目的凭据
    expect(secretEnvFor(store, "child", "test", ["admin"])).toEqual({});

    store.set(SecretStore.ref("child", "test"), { authToken: "Bearer child" });
    expect(secretEnvFor(store, "child", "test", [], "grp").AITEST_AUTH_TOKEN).toBe("Bearer child");

    const broker = await startSecretBroker(store, { parentOf: (id) => (id === "child" ? "grp" : undefined) });
    try {
      store.delete(SecretStore.ref("child", "test"));
      expect(await new BrokerSecretResolver(broker.url, broker.token).resolve("child", "test"))
        .toEqual({ AITEST_AUTH_TOKEN: "Bearer group" });
    } finally {
      await broker.close();
    }
    expect(store.deletePrefix("aitest:grp:")).toBe(2);
  });
});

describe("API multi-account secrets", () => {
  it("injects all roles' accounts and tokens, inheriting from the big project", async () => {
    const { secretEnvFor, ALL_ROLES } = await import("../src/main/secrets.js");
    const file = join(mkdtempSync(join(tmpdir(), "sec-")), "secrets.json");
    const store = new SecretStore(file, cipher);
    store.set(SecretStore.roleRef("grp", "运营"), { username: "ops", password: "1", token: "Bearer group-ops" });
    store.set(SecretStore.roleRef("child", "买家"), { username: "buyer", password: "2" });
    store.set(SecretStore.roleRef("child", "财务"), { username: "", password: "", token: "Bearer fin" });
    expect(store.roleNames("child").sort()).toEqual(["买家", "财务"]);

    const env = secretEnvFor(store, "child", "test", [ALL_ROLES], "grp");
    expect(JSON.parse(env.AITEST_ROLES)).toEqual([
      { role: "买家", username: "buyer", password: "2" },
      { role: "运营", username: "ops", password: "1" },
    ]);
    // 只有 token、没有账号密码的角色不进入 AITEST_ROLES
    expect(JSON.parse(env.AITEST_ROLE_TOKENS)).toEqual({ 财务: "Bearer fin", 运营: "Bearer group-ops" });
    // 不指定角色时不注入任何角色凭据
    expect(secretEnvFor(store, "child", "test", [], "grp")).toEqual({});
  });
});
