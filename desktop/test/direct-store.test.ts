import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { DirectStore } from "../src/main/directStore.js";

it.each(["delete", "wal"])("reads a %s database without changing its journal mode", (mode) => {
  const dir = mkdtempSync(join(tmpdir(), "aitest-direct-store-"));
  const writer = new Database(join(dir, "test.db"));
  let reader: DirectStore | undefined;
  try {
    writer.pragma(`journal_mode = ${mode}`);
    writer.exec("CREATE TABLE testcase (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    writer.prepare("INSERT INTO testcase VALUES (?, ?)").run("case-1", JSON.stringify({ title: "before" }));

    reader = new DirectStore(join(dir, "test.db"));
    expect(reader.getCase("case-1")).toEqual({ title: "before" });
    expect(writer.pragma("journal_mode", { simple: true })).toBe(mode);

    writer.prepare("UPDATE testcase SET data=? WHERE id=?").run(JSON.stringify({ title: "after" }), "case-1");
    expect(reader.getCase("case-1")).toEqual({ title: "after" });
  } finally {
    reader?.close();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
