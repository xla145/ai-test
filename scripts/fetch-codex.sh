#!/usr/bin/env bash
# 下载随桌面安装包附带的 Codex 二进制（锁定版本），取自 npm 上 @openai/codex 的平台包。
# 用法：scripts/fetch-codex.sh [输出目录，默认 .release/codex]
#   平台默认取当前 Node 的 process.platform-process.arch（如 darwin-arm64、win32-x64、linux-x64），
#   可用 CODEX_TARGET 覆盖；版本可用 CODEX_VERSION 覆盖。
# 输出目录保持平台包内 vendor/<target-triple>/ 的原始布局（bin/、codex-resources/、codex-path/、
# codex-package.json）：codex 依赖这个布局找到沙箱、rg 等辅助程序，不能只拷贝 bin/codex。
#
# 升级 Codex：改下面的默认版本号，并按 desktop/src/main/codex/protocol.ts 的说明做回归验证。
set -euo pipefail
VERSION="${CODEX_VERSION:-0.167.0}"
TARGET="${CODEX_TARGET:-$(node -p 'process.platform + "-" + process.arch')}"
OUT="${1:-.release/codex}"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

echo "下载 Codex ${VERSION}（${TARGET}）"
(cd "${TMP}" && npm pack --silent "@openai/codex@${VERSION}-${TARGET}" >/dev/null && tar -xzf ./*.tgz)

vendor="$(find "${TMP}/package/vendor" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [ -z "${vendor}" ] || [ ! -f "${vendor}/codex-package.json" ]; then
  echo "平台包结构不符合预期：缺少 vendor/<target>/codex-package.json" >&2
  exit 1
fi

rm -rf "${OUT}"
mkdir -p "$(dirname "${OUT}")"
mv "${vendor}" "${OUT}"
# 语音运行时（约 50MB）只用于语音输入，客户端用不到
rm -rf "${OUT}/codex-resources/voice"

bin="${OUT}/bin/codex"
[ -f "${bin}.exe" ] && bin="${bin}.exe"
if [ ! -f "${bin}" ]; then
  echo "未找到 Codex 可执行文件：${bin}" >&2
  exit 1
fi
chmod +x "${OUT}/bin/"* "${OUT}/codex-path/"* 2>/dev/null || true
# 只有目标平台就是本机时才能运行校验
if [ -z "${CODEX_TARGET:-}" ]; then
  "${bin}" --version
fi
echo "Codex 已准备：${OUT}（$(du -sh "${OUT}" | cut -f1)）"
