import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readEvidenceImage } from "../src/main/evidence.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/6kAAAAASUVORK5CYII=", "base64");
let root: string;
let workspace: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "aitest-evidence-"));
  workspace = join(root, "workspace");
  await mkdir(join(workspace, "evidence"), { recursive: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("loads relative, absolute and file URL paths containing Chinese, spaces and #", async () => {
  const path = join(workspace, "evidence", "人工复核 # 1.png");
  await writeFile(path, png);
  for (const input of ["evidence/人工复核 # 1.png", path, pathToFileURL(path).href]) {
    expect(await readEvidenceImage(workspace, input)).toBe(`data:image/png;base64,${png.toString("base64")}`);
  }
});

it("rejects paths and symlinks that escape the project workspace", async () => {
  const outside = join(root, "outside.png");
  await writeFile(outside, png);
  await symlink(outside, join(workspace, "evidence", "link.png"));
  for (const input of [outside, "../outside.png", "evidence/link.png"]) {
    await expect(readEvidenceImage(workspace, input)).rejects.toThrow("当前项目工作目录");
  }
});

it("reports missing files and rejects non-image contents even with a png extension", async () => {
  await expect(readEvidenceImage(workspace, "missing.png")).rejects.toThrow("不存在");
  await writeFile(join(workspace, "fake.png"), "<html>not an image</html>");
  await expect(readEvidenceImage(workspace, "fake.png")).rejects.toThrow("格式不支持");
});
