import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import { expect, it, vi } from "vitest";
import { listenLocal } from "./fixtures/listen.js";

it.each(["EPERM", "EADDRINUSE"])("rejects fixture setup with the original %s error", async code => {
  const server = new EventEmitter() as Server;
  const error = Object.assign(new Error(code), { code });
  server.listen = vi.fn(() => { queueMicrotask(() => server.emit("error", error)); return server; }) as any;
  await expect(listenLocal(server)).rejects.toBe(error);
  expect(server.listenerCount("error")).toBe(0);
  expect(server.listenerCount("listening")).toBe(0);
});

it("resolves only on listening and removes setup listeners", async () => {
  const server = new EventEmitter() as Server;
  server.listen = vi.fn(() => { queueMicrotask(() => server.emit("listening")); return server; }) as any;
  await listenLocal(server);
  expect(server.listen).toHaveBeenCalledWith(0, "127.0.0.1");
  expect(server.listenerCount("error")).toBe(0);
  expect(server.listenerCount("listening")).toBe(0);
});
