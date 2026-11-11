#!/usr/bin/env bash
# 准备随桌面安装包附带的引擎 Python 依赖（纯 Python，兼容用户机器上任意 Python 3.10+）。
# 用法：scripts/prepare-engine-deps.sh [输出目录，默认 .release/engine-deps]
set -euo pipefail
OUT="${1:-.release/engine-deps}"
PY="${PYTHON:-python3}"
rm -rf "$OUT"
mkdir -p "$OUT"
"$PY" -m pip install --quiet --no-compile --target "$OUT" openpyxl pyyaml httpx pytest pymysql pg8000
# PyYAML 的 C 扩展绑定构建机的 Python 版本；删掉后自动回退到纯 Python 实现
find "$OUT" \( -name "_yaml*.so" -o -name "_yaml*.pyd" \) -delete
rm -rf "$OUT/_yaml" "$OUT/bin"
echo "引擎依赖已准备：${OUT}（$(du -sh "${OUT}" | cut -f1)）"
