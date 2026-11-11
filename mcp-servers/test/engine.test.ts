import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runEngine } from "../src/engine.js";

const directories: string[] = [];

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function failingEngine(source: string) {
  const dir = mkdtempSync(join(tmpdir(), "aitest-engine-error-"));
  directories.push(dir);
  writeFileSync(join(dir, "aitest.py"), source);
  return runEngine([], { env: { PYTHONPATH: dir } });
}

describe("engine startup errors", () => {
  it("identifies missing Python modules and explains how to repair dependencies", async () => {
    await expect(failingEngine("raise ModuleNotFoundError(\"No module named 'yaml'\")"))
      .rejects.toThrow(/缺少模块 yaml.*解释器：python3.*npm run prepare:engine -w desktop/);
  });

  it("preserves diagnostics for other invalid output", async () => {
    await expect(failingEngine("import sys\nprint('invalid output')\nprint('startup failed', file=sys.stderr)"))
      .rejects.toThrow(/引擎输出无法解析：invalid output.*startup failed/);
  });
});
