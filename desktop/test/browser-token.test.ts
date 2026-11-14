import { describe, expect, it } from "vitest";
import { browserClientHeaders, browserToken, requestToken } from "../src/main/browserToken.js";

describe("browser token extraction", () => {
  it("reads raw, JSON encoded and wrapped tokens without duplicating Bearer", () => {
    expect(browserToken([["Admin-Token", '"abc"']])).toBe("Bearer abc");
    expect(browserToken([["access_token", '{"value":"abc","expire":123}']])).toBe("Bearer abc");
    expect(browserToken([["token", "Bearer abc"], ["token", "abc"]])).toBe("Bearer abc");
    expect(browserToken([["custom", "abc"]], "custom", "")).toBe("abc");
  });
  it("rejects missing or ambiguous credentials and ignores refresh tokens", () => {
    expect(() => browserToken([["refresh_token", "refresh"]])).toThrow("未找到");
    expect(() => browserToken([["token", "abc"], ["access_token", "other"]])).toThrow("多个");
    expect(browserToken([["token", "abc"], ["access_token", "other"]], "access_token")).toBe("Bearer other");
    expect(() => browserToken([["token", "abc\r\ninjected: value"]])).toThrow("无效");
  });
  it("finds tokens inside persisted stores and namespaced caches", () => {
    expect(browserToken([["store", JSON.stringify({ auth: { accessToken: "abc", refreshToken: "ignored" } })]])).toBe("Bearer abc");
    expect(browserToken([["vueuse", JSON.stringify({ "app-access-token": { v: '"abc"' } })]])).toBe("Bearer abc");
    expect(browserToken([["cache", encodeURIComponent(JSON.stringify({ token: "abc" }))]])).toBe("Bearer abc");
    expect(browserToken([["token", '{"value":"\\\"abc\\\""}']])).toBe("Bearer abc");
    expect(browserToken([["token", '{"access_token":"abc"}']], "token")).toBe("Bearer abc");
  });
  it("allows exact nested paths and reports available keys without leaking values", () => {
    const entries: [string, string][] = [["store", '{"auth":{"credential":"secret-value"}}']];
    expect(browserToken(entries, "store.auth.credential")).toBe("Bearer secret-value");
    expect(() => browserToken(entries)).toThrow("当前存储键名：store");
    try { browserToken(entries); } catch (error) { expect(String(error)).not.toContain("secret-value"); }
    expect(() => browserToken([["refresh", '{"token":"secret"}']])).toThrow("未找到");
  });
});

describe("request token capture", () => {
  const origins = new Set(["https://app.example.com", "https://api.example.com"]);
  it("uses the complete configured header only from the current system", () => {
    expect(requestToken("https://api.example.com/profile", origins, { authorization: "Bearer live-token" }, "Authorization")).toBe("Bearer live-token");
    expect(requestToken("https://app.example.com/api/user", origins, { "X-Token": "custom" }, "x-token")).toBe("custom");
    expect(requestToken("https://other.example.com/api", origins, { Authorization: "Bearer other" }, "Authorization")).toBeUndefined();
    expect(requestToken("https://api.example.com/profile", origins, { Authorization: "Bearer undefined" }, "Authorization")).toBeUndefined();
    expect(requestToken("https://api.example.com/profile", origins, { Cookie: "session=abc" }, "Authorization")).toBeUndefined();
  });
});

describe("client-bound browser credentials", () => {
  const token = `Bearer header.${Buffer.from(JSON.stringify({ clientid: "web-client" })).toString("base64url")}.signature`;
  it("keeps the client header required alongside the browser token", () => {
    expect(browserClientHeaders(token)).toEqual({ clientid: "web-client" });
    expect(browserClientHeaders(token, { ClientId: "observed-client" })).toEqual({ clientid: "observed-client" });
    expect(browserClientHeaders("opaque-token")).toEqual({});
    expect(browserClientHeaders(`header.${Buffer.from('{"clientid":"bad\\r\\nheader"}').toString("base64url")}.sig`)).toEqual({});
  });
});
