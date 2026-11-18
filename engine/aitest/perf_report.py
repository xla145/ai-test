"""性能测试 HTML 报告：概览卡片、延迟分布、门槛判定、分步统计。

复用 reports.py 的设计语言——单文件 HTML、样式内联、dark mode。
"""

from __future__ import annotations

import html
import json
from datetime import datetime
from pathlib import Path
from typing import Any

_CSS = """
:root{--fg:#1f2329;--muted:#6b7280;--line:#e5e7eb;--bg:#f6f7f9;--card:#fff;--ok:#16a34a;--bad:#dc2626;--warn:#d97706;--brand:#3b6ef5}
@media(prefers-color-scheme:dark){:root{--fg:#e5e7eb;--muted:#9ca3af;--line:#2d3139;--bg:#111317;--card:#1a1d23}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:32px 20px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 12px}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.card .label{font-size:12px;color:var(--muted);font-weight:500}.card .val{font-size:24px;font-weight:700;margin-top:2px}
.bar-wrap{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:20px;margin-top:16px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px;text-transform:uppercase;letter-spacing:.04em;background:rgba(127,127,127,.06)}
tr:last-child td{border-bottom:none}
.tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500}
.passed{background:rgba(22,163,74,.12);color:var(--ok)}.failed{background:rgba(220,38,38,.12);color:var(--bad)}
.stopped{background:var(--line);color:var(--muted)}.degraded{background:rgba(217,119,6,.12);color:var(--warn)}
footer{margin-top:32px;color:var(--muted);font-size:12px}
"""

STATUS_LABEL = {"passed": "通过", "failed": "未通过", "stopped": "已停止", "error": "执行错误", "degraded": "已退化"}


def _e(s: str) -> str:
    return html.escape(str(s))


def _fmt_time(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, OSError):
        return iso


def _fmt_bytes(n: float | int | None) -> str:
    if n is None:
        return "—"
    if n < 1024:
        return f"{n:.0f} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / 1024 / 1024:.1f} MB"


def _pct_bar(label: str, value: float | None, max_val: float, color: str = "var(--brand)") -> str:
    """水平百分位条（inline SVG 风格 div）。"""
    if value is None:
        return f'<div style="margin:4px 0"><span class="muted">{_e(label)}：—</span></div>'
    width = min(value / max_val * 100, 100) if max_val > 0 else 0
    return (
        f'<div style="margin:6px 0;display:flex;align-items:center;gap:8px">'
        f'<span style="width:50px;text-align:right;font-weight:500;font-size:13px">{_e(label)}</span>'
        f'<div style="flex:1;height:20px;background:var(--line);border-radius:4px;overflow:hidden">'
        f'<div style="width:{width:.1f}%;height:100%;background:{color};border-radius:4px"></div></div>'
        f'<span class="mono" style="width:80px">{value:.1f} ms</span></div>'
    )


def render_perf_html(results: list[dict[str, Any]]) -> str:
    """把一个或多个性能执行结果渲染为单文件 HTML。"""
    if not results:
        raise ValueError("没有可生成报告的性能执行记录")

    e = _e
    r = results[0]  # 主结果
    opts = r.get("options") or {}
    method = opts.get("method", "GET")
    status = r.get("status", "unknown")

    parts: list[str] = [
        f"<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        f"<meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>性能报告 · {e(method)} {e(opts.get('path', '/'))}</title>"
        f"<style>{_CSS}</style></head><body><div class='wrap'>",
    ]

    # ---- Header ----
    parts.append(f"<h1>性能测试报告</h1>")
    parts.append(
        f"<div class='muted'>{e(method)} {e(opts.get('path', '/'))} · "
        f"环境 {e(r.get('env', '—'))} · "
        f"{e(_fmt_time(r.get('startedAt', '')))} · "
        f"<span class='tag {e(status)}'>{e(STATUS_LABEL.get(status, status))}</span>"
        f"</div>"
    )

    # ---- Overview cards ----
    parts.append("<div class='cards'>")
    parts.append(f"<div class='card'><div class='label'>总请求</div><div class='val'>{r.get('requests') or '—'}</div></div>")
    rps = r.get("requestsPerSecond")
    parts.append(f"<div class='card'><div class='label'>RPS</div><div class='val'>{f'{rps:.1f}' if rps is not None else '—'}</div></div>")
    fr = r.get("failureRate")
    parts.append(f"<div class='card'><div class='label'>失败率</div><div class='val' style='color:{'var(--bad)' if fr and fr > 0 else 'inherit'}'>{f'{fr:.2%}' if fr is not None else '—'}</div></div>")
    p95 = r.get("p95Ms")
    parts.append(f"<div class='card'><div class='label'>P95 延迟</div><div class='val'>{f'{p95:.1f} ms' if p95 is not None else '—'}</div></div>")
    parts.append(f"<div class='card'><div class='label'>数据发送</div><div class='val' style='font-size:18px'>{_fmt_bytes(r.get('dataSentBytes'))}</div></div>")
    parts.append(f"<div class='card'><div class='label'>数据接收</div><div class='val' style='font-size:18px'>{_fmt_bytes(r.get('dataReceivedBytes'))}</div></div>")
    parts.append("</div>")

    # ---- Latency percentiles ----
    p50 = r.get("p50Ms")
    p90 = r.get("p90Ms")
    p99 = r.get("p99Ms")
    max_ms = r.get("maxMs")
    bar_max = max(filter(None, [p50, p90, p95, p99, max_ms, 1]))
    parts.append("<div class='bar-wrap'><h2 style='margin:0 0 8px'>延迟分布</h2>")
    parts.append(_pct_bar("P50", p50, bar_max, "var(--ok)"))
    parts.append(_pct_bar("P90", p90, bar_max, "var(--brand)"))
    parts.append(_pct_bar("P95", p95, bar_max, "var(--warn)"))
    parts.append(_pct_bar("P99", p99, bar_max, "var(--bad)"))
    avg = r.get("avgMs")
    min_ms = r.get("minMs")
    parts.append(
        f"<div class='muted' style='margin-top:8px;font-size:12px'>"
        f"avg {f'{avg:.1f}' if avg is not None else '—'} ms · "
        f"min {f'{min_ms:.1f}' if min_ms is not None else '—'} ms · "
        f"max {f'{max_ms:.1f}' if max_ms is not None else '—'} ms"
        f"</div></div>"
    )

    # ---- Threshold results ----
    parts.append("<h2>门槛判定</h2><table><tr><th>指标</th><th>阈值</th><th>实际</th><th>结果</th></tr>")
    tp = r.get("thresholdsPassed", False)
    p95_threshold = opts.get("p95Ms", "—")
    max_fr = opts.get("maxFailureRate", "—")
    p95_ok = p95 is not None and p95_threshold != "—" and p95 < p95_threshold
    fr_ok = fr is not None and max_fr != "—" and fr <= max_fr
    parts.append(
        f"<tr><td>P95 延迟</td><td>&lt; {p95_threshold} ms</td>"
        f"<td>{f'{p95:.1f} ms' if p95 is not None else '—'}</td>"
        f"<td><span class='tag {'passed' if p95_ok else 'failed'}'>"
        f"{'通过' if p95_ok else '未通过'}</span></td></tr>"
    )
    parts.append(
        f"<tr><td>失败率</td><td>≤ {max_fr}</td>"
        f"<td>{f'{fr:.4f}' if fr is not None else '—'}</td>"
        f"<td><span class='tag {'passed' if fr_ok else 'failed'}'>"
        f"{'通过' if fr_ok else '未通过'}</span></td></tr>"
    )
    parts.append("</table>")

    # ---- Step breakdown (scenario) ----
    steps = r.get("steps")
    if steps:
        parts.append("<h2>分步统计</h2><table>")
        parts.append("<tr><th>步骤</th><th>请求数</th><th>P95</th><th>平均</th><th>失败率</th></tr>")
        for s in steps:
            sfr = s.get("failureRate", 0)
            sp95 = s.get("p95Ms")
            savg = s.get("avgMs")
            sp95_str = f"{sp95:.1f} ms" if sp95 is not None else "—"
            savg_str = f"{savg:.1f} ms" if savg is not None else "—"
            fail_color = "var(--bad)" if sfr > 0 else "inherit"
            parts.append(
                f"<tr><td>{e(s.get('name', '—'))}</td>"
                f"<td>{s.get('requests', '—')}</td>"
                f"<td>{sp95_str}</td>"
                f"<td>{savg_str}</td>"
                f"<td style='color:{fail_color}'>{sfr:.2%}</td></tr>"
            )
        parts.append("</table>")

    # ---- Degradation ----
    deg = r.get("degradation")
    if deg and deg.get("degraded"):
        parts.append("<h2>退化检测</h2><table><tr><th>检测项</th></tr>")
        for d in deg.get("details", []):
            parts.append(f"<tr><td style='color:var(--warn)'>{e(d)}</td></tr>")
        parts.append("</table>")

    # ---- Trend (if multiple results) ----
    if len(results) > 1:
        trend_items = [r2 for r2 in results if r2.get("p95Ms") is not None]
        if len(trend_items) >= 2:
            parts.append("<h2>P95 趋势</h2>")
            _render_trend_svg(parts, trend_items)

    # ---- Config summary ----
    parts.append("<h2>执行配置</h2><table>")
    parts.append(f"<tr><td>VU 数</td><td>{opts.get('vus', '—')}</td></tr>")
    ramp_up = opts.get("rampUp")
    ramp_down = opts.get("rampDown")
    if ramp_up:
        parts.append(f"<tr><td>Ramp-up</td><td>{ramp_up} 秒</td></tr>")
    parts.append(f"<tr><td>稳态时长</td><td>{opts.get('seconds', '—')} 秒</td></tr>")
    if ramp_down:
        parts.append(f"<tr><td>Ramp-down</td><td>{ramp_down} 秒</td></tr>")
    auth_label = "是" if opts.get("auth", True) else "否"
    role_name = opts.get("role")
    role_suffix = f"（角色：{e(role_name)}）" if role_name else ""
    parts.append(f"<tr><td>鉴权</td><td>{auth_label}{role_suffix}</td></tr>")
    parts.append("</table>")

    parts.append(
        f"<footer>由 AIProbe 生成 · {e(datetime.now().astimezone().strftime('%Y-%m-%d %H:%M:%S'))} · "
        f"性能执行不调用模型</footer></div></body></html>"
    )
    return "".join(parts)


def _render_trend_svg(parts: list[str], items: list[dict[str, Any]]) -> None:
    """简单的 SVG 折线图：X 时间、Y P95 延迟。"""
    w, h = 700, 200
    padding = 50
    n = len(items)
    vals = [float(it["p95Ms"]) for it in items]
    max_v = max(vals) * 1.15 or 1

    def x(i: int) -> float:
        return padding + (w - 2 * padding) * i / max(n - 1, 1)

    def y(v: float) -> float:
        return h - padding - (h - 2 * padding) * v / max_v

    points = " ".join(f"{x(i):.1f},{y(v):.1f}" for i, v in enumerate(vals))
    parts.append(f"<div style='overflow-x:auto'><svg viewBox='0 0 {w} {h}' width='{w}' style='max-width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px'>")
    # Grid lines
    for frac in (0, 0.25, 0.5, 0.75, 1):
        yy = y(max_v * frac)
        label = f"{max_v * frac:.0f}"
        parts.append(f"<line x1='{padding}' y1='{yy:.1f}' x2='{w - padding}' y2='{yy:.1f}' stroke='var(--line)' stroke-dasharray='4'/>")
        parts.append(f"<text x='{padding - 6}' y='{yy:.1f}' text-anchor='end' fill='var(--muted)' font-size='10' dominant-baseline='middle'>{label}</text>")
    # Polyline
    parts.append(f"<polyline points='{points}' fill='none' stroke='var(--brand)' stroke-width='2'/>")
    # Data points
    for i, v in enumerate(vals):
        status = items[i].get("status", "")
        color = "var(--bad)" if status in ("failed", "error", "degraded") else "var(--brand)"
        parts.append(f"<circle cx='{x(i):.1f}' cy='{y(v):.1f}' r='4' fill='{color}'/>")
    # X labels (first and last)
    if items:
        parts.append(f"<text x='{x(0):.1f}' y='{h - 10}' text-anchor='start' fill='var(--muted)' font-size='10'>{_e(_fmt_time(items[0].get('startedAt', '')))}</text>")
        if n > 1:
            parts.append(f"<text x='{x(n-1):.1f}' y='{h - 10}' text-anchor='end' fill='var(--muted)' font-size='10'>{_e(_fmt_time(items[-1].get('startedAt', '')))}</text>")
    # Y axis label
    parts.append(f"<text x='10' y='{h / 2}' fill='var(--muted)' font-size='10' transform='rotate(-90 10 {h / 2})'>P95 (ms)</text>")
    parts.append("</svg></div>")


def render_perf_report(results: list[dict[str, Any]], out: Path) -> Path:
    """生成性能 HTML 报告并写入文件。"""
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render_perf_html(results), encoding="utf-8")
    return out
