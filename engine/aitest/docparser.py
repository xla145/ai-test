"""需求文档解析（doc-parser）：Word / PDF / Markdown 统一转 Markdown 后按章节切块。

上下文裁剪：后续只把相关章节传给模型。
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .models import Requirement

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")


@dataclass
class Section:
    title: str
    level: int
    path: list[str]
    content: str


def to_markdown(path: str | Path) -> str:
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix in (".md", ".markdown", ".txt"):
        return p.read_text(encoding="utf-8")
    if suffix == ".docx":
        try:
            import mammoth  # type: ignore

            with p.open("rb") as f:
                return mammoth.convert_to_markdown(f).value
        except ImportError:
            pass
        if shutil.which("pandoc"):
            return subprocess.run(["pandoc", str(p), "-t", "gfm"], capture_output=True, text=True, check=True).stdout
        raise RuntimeError("解析 Word 需要安装 mammoth（pip install aitest-engine[docs]）或 pandoc")
    if suffix == ".pdf":
        try:
            import pdfplumber  # type: ignore
        except ImportError as e:
            raise RuntimeError("解析 PDF 需要安装 pdfplumber（pip install aitest-engine[docs]）") from e
        with pdfplumber.open(str(p)) as pdf:
            return "\n\n".join(page.extract_text() or "" for page in pdf.pages)
    raise ValueError(f"不支持的文档类型：{suffix}")


def split_sections(markdown: str, max_chars: int = 4000) -> list[Section]:
    sections: list[Section] = []
    stack: list[tuple[int, str]] = []
    title, level, buf = "", 0, []
    in_code = False

    def flush() -> None:
        text = "\n".join(buf).strip()
        if text or title:
            path = [t for _, t in stack]
            # 超长章节再按段落切块
            chunks = _chunk(text, max_chars) if text else [""]
            for i, chunk in enumerate(chunks):
                suffix = f" ({i + 1}/{len(chunks)})" if len(chunks) > 1 else ""
                sections.append(Section(title=(title or "前言") + suffix, level=level, path=path or ["前言"], content=chunk))

    for line in markdown.splitlines():
        if line.strip().startswith("```"):
            in_code = not in_code
        m = None if in_code else _HEADING.match(line)
        if m:
            flush()
            level, title, buf = len(m.group(1)), m.group(2).strip(), []
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, title))
        else:
            buf.append(line)
    flush()
    return [s for s in sections if s.content or s.title]


def _chunk(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    out, cur = [], ""
    for para in re.split(r"\n\s*\n", text):
        if cur and len(cur) + len(para) + 2 > max_chars:
            out.append(cur)
            cur = ""
        cur = f"{cur}\n\n{para}" if cur else para
    if cur:
        out.append(cur)
    return out


def parse_requirement(path: str | Path, project_id: str = "") -> list[Requirement]:
    md = to_markdown(path)
    return [
        Requirement(project_id=project_id, source_file=str(path), section=" / ".join(s.path), content=s.content)
        for s in split_sections(md)
    ]
