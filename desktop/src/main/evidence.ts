import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** 渲染进程使用 data URL 加载证据，兼容 Vite 的 HTTP 页面和打包后的本地页面。 */
export async function readEvidenceImage(workspace: string, evidencePath: string): Promise<string> {
  const path = evidencePath.startsWith("file:") ? fileURLToPath(evidencePath) : evidencePath;
  const root = await realpath(workspace);
  let file: string;
  try { file = await realpath(resolve(root, path)); }
  catch { throw new Error("截图文件不存在或无法读取"); }
  const rel = relative(root, file);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("只能读取当前项目工作目录内的截图");
  const info = await stat(file);
  if (!info.isFile()) throw new Error("截图路径不是文件");
  if (info.size > 20 * 1024 * 1024) throw new Error("截图超过 20 MB，无法预览");
  const bytes = await readFile(file);
  const mime = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
      : ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) ? "image/gif"
        : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
  if (!mime) throw new Error("截图格式不支持，仅支持 PNG、JPEG、GIF 或 WebP");
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
