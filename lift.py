"""
Lift it onto the Shelf: a table boxed on screen becomes a page you can sort and filter, plus a CSV for Claude.

The Mac reads the box (screen.ocr_boxes, on this Mac, nothing sent anywhere). Pieces of text are grouped into
rows, and columns come from where the pieces sit across rows. If too little text comes back to make a table
(a chart, a picture), the caller sends the picture to Claude instead.
"""

from __future__ import annotations

import csv
import html
import io
import json
import re
import time
from pathlib import Path

import screen

NUM = re.compile(r"^[-+(]?[$€£]?\s?[-+]?\d[\d,]*(\.\d+)?\s?[%)]?[KMB]?$", re.I)


def folder() -> Path:
    """~/Claude Outputs/Lifted tables if that folder exists, else Tether's own support folder."""
    outs = Path.home() / "Claude Outputs"
    base = outs / "Lifted tables" if outs.is_dir() else Path.home() / "Library/Application Support/Tether/lifted"
    base.mkdir(parents=True, exist_ok=True)
    return base


def columns(rows: list[list[dict]]) -> list[tuple[float, float]]:
    """Column bands (left, right as 0-1 of the picture): spans of the pieces in rows with more than one piece,
    merged where they overlap. Single pieces (titles, notes) don't set columns."""
    spans = sorted((b["x"], b["x"] + b["w"]) for row in rows if len(row) > 1 for b in row)
    bands: list[list[float]] = []
    for a, z in spans:
        if bands and a <= bands[-1][1]:
            bands[-1][1] = max(bands[-1][1], z)
        else:
            bands.append([a, z])
    return [(a, z) for a, z in bands]


def table(boxes: list[dict]) -> tuple[str, list[str], list[list[str]]]:
    """(title, header, body rows) from the pieces of text. Title is a lone line above the table, if any."""
    rows = screen.ocr_rows(boxes)
    title_bits = []
    while rows and len(rows[0]) == 1 and len(rows) > 2:  # lines above the table, before the first row of cells
        title_bits.append(rows.pop(0)[0]["s"])
    # the data rows set the columns: a heading often comes back as one piece over two columns ("Claims Denied")
    bands = columns(rows[1:]) if sum(len(r) > 1 for r in rows[1:]) >= 2 else columns(rows)
    if len(bands) < 2:
        return "", [], []

    def nearest(x: float) -> int:
        return min(range(len(bands)), key=lambda i: 0 if bands[i][0] <= x <= bands[i][1]
                   else min(abs(x - bands[i][0]), abs(x - bands[i][1])))

    grid = []
    for row in rows:
        cells = [""] * len(bands)
        for b in row:
            over = [i for i, (a, z) in enumerate(bands) if a < b["x"] + b["w"] and b["x"] < z]
            words = b["s"].split()
            if len(over) > 1 and len(words) == len(over):  # one piece across columns, one word each
                for i, w in zip(over, words):
                    cells[i] = (cells[i] + " " + w).strip()
                continue
            k = nearest(b["x"] + b["w"] / 2)
            cells[k] = (cells[k] + " " + b["s"]).strip()
        grid.append(cells)
    header, body = grid[0], grid[1:]
    if body and all(NUM.match(c.replace(" ", "")) for c in header if c):  # no header row: the first row is data
        header, body = [f"Column {i + 1}" for i in range(len(bands))], grid
    header = [h or f"Column {i + 1}" for i, h in enumerate(header)]
    return " ".join(title_bits)[:120], header, body


def gutters(path: Path, rows: list[list[dict]]) -> list[float]:
    """Where one column ends and the next begins (0-1 across), from the picture: upright strips with no ink in
    any row of text, at least half a line wide. One-pixel gridlines count as blank."""
    import numpy as np
    import AppKit
    rep = AppKit.NSBitmapImageRep.imageRepWithContentsOfFile_(str(path))
    if rep is None:
        return []
    w, h = rep.pixelsWide(), rep.pixelsHigh()
    cs = AppKit.NSColorSpace.genericGrayColorSpace()
    gray = rep.bitmapImageRepByConvertingToColorSpace_renderingIntent_(cs, AppKit.NSColorRenderingIntentDefault)
    if gray is None or gray.samplesPerPixel() != 1 or gray.bitsPerSample() != 8:
        return []
    buf = np.frombuffer(bytes(gray.bitmapData()), dtype=np.uint8)
    stride = gray.bytesPerRow()
    if buf.size < stride * h:
        return []
    img = buf[: stride * h].reshape(h, stride)[:, :w].astype(np.int16)
    edge = np.concatenate([img[0], img[-1], img[:, 0], img[:, -1]])
    bg = int(np.median(edge))
    ink = np.abs(img - bg) > 45
    bands = [(int(r[0]["t"] * h), int(min(1, r[0]["t"] + max(b["h"] for b in r)) * h)) for r in rows if r]
    if len(bands) < 2:
        return []
    cover = np.mean([ink[a:max(a + 1, z)].any(axis=0) for a, z in bands], axis=0)
    blank = cover <= 0.05
    line = int(np.median([b["h"] for r in rows for b in r]) * h)
    # gridlines: narrow runs of ink in nearly every row count as blank
    x = 0
    while x < w:
        if not blank[x]:
            z = x
            while z < w and not blank[z]:
                z += 1
            if z - x <= max(3, line * 0.15) and cover[x:z].min() >= 0.8:
                blank[x:z] = True
            x = z
        x += 1
    ink_cols = np.where(~blank)[0]
    if ink_cols.size == 0:
        return []
    left, right = ink_cols[0], ink_cols[-1]
    cuts, x = [], left
    while x <= right:
        if blank[x]:
            z = x
            while z <= right and blank[z]:
                z += 1
            if z - x >= max(4, line * 0.5):
                cuts.append((x + z) / 2 / w)
            x = z
        x += 1
    return cuts


def table_by_columns(path: Path, boxes: list[dict]) -> tuple[str, list[str], list[list[str]]] | None:
    """Columns found in the picture, each read on its own so tightly packed cells don't run together."""
    rows = screen.ocr_rows(boxes)
    title_bits = []
    while rows and len(rows[0]) == 1 and len(rows) > 2:
        title_bits.append(rows.pop(0)[0]["s"])
    if len(rows) < 2:
        return None
    cuts = gutters(path, rows)
    if not cuts:
        return None
    top = rows[0][0]["t"]
    bottom = max(b["t"] + b["h"] for r in rows for b in r)
    edges = [0.0, *cuts, 1.0]
    centers = [r[0]["t"] + max(b["h"] for b in r) / 2 for r in rows]
    grid = [[""] * (len(edges) - 1) for _ in rows]
    pad = 0.004
    for k in range(len(edges) - 1):
        roi = (max(0.0, edges[k] - pad), max(0.0, top - pad * 2), min(1.0, edges[k + 1] + pad) - max(0.0, edges[k] - pad),
               min(1.0, bottom + pad * 2) - max(0.0, top - pad * 2))
        for b in screen.ocr_boxes(path, roi):
            c = b["t"] + b["h"] / 2
            i = min(range(len(rows)), key=lambda j: abs(centers[j] - c))
            grid[i][k] = (grid[i][k] + " " + b["s"]).strip()
    grid = [r for r in grid if any(r)]
    keep = [k for k in range(len(edges) - 1) if any(r[k] for r in grid)]
    grid = [[r[k] for k in keep] for r in grid]
    if len(keep) < 2 or len(grid) < 2:
        return None
    header, body = grid[0], grid[1:]
    if all(NUM.match(c.replace(" ", "")) for c in header if c):
        header, body = [f"Column {i + 1}" for i in range(len(keep))], grid
    header = [h or f"Column {i + 1}" for i, h in enumerate(header)]
    return " ".join(title_bits)[:120], header, body


def lift(screen_n: int, region: dict) -> dict:
    """Box → files. {"page", "csv", "title", "rows", "cols"}, or {"picture": path} when there's no table to read,
    or {"error"}."""
    png, err = screen.capture_region(screen_n, region)
    if not png:
        return {"error": err}
    boxes = screen.ocr_boxes(png)
    got = table_by_columns(png, boxes) if boxes else None
    title, header, body = got or table(boxes)
    filled = sum(bool(c) for r in body for c in r) / max(1, len(body) * len(header))
    if len(body) < 2 or filled < 0.5:  # not really a table
        return {"picture": str(png)}  # a chart or a picture: Claude rebuilds it from the picture
    png.unlink(missing_ok=True)
    stamp = time.strftime("%Y-%m-%d %H.%M.%S")
    name = re.sub(r"[^\w -]+", "", title)[:50].strip() or "Lifted table"
    base = folder() / f"{name} {stamp}"
    buf = io.StringIO()
    csv.writer(buf).writerows([header, *body])
    Path(f"{base}.csv").write_text(buf.getvalue())
    Path(f"{base}.html").write_text(page(title or "Lifted table", header, body))
    return {"page": f"{base}.html", "csv": f"{base}.csv", "title": title or "Lifted table", "rows": len(body), "cols": len(header)}


def page(title: str, header: list[str], body: list[list[str]]) -> str:
    """One self-contained page: filter box, click a heading to sort (numbers sort as numbers), row count."""
    data = json.dumps({"h": header, "r": body}).replace("</", "<\\/")
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>{html.escape(title)}</title>
<style>
  :root {{ --bg: #f7f8f9; --card: #fff; --text: #1d2327; --text-2: #5b6670; --line: #e3e7ea; --hover: #f0f3f5; --accent: #0b6e86; }}
  @media (prefers-color-scheme: dark) {{ :root {{ --bg: #15191d; --card: #1b2026; --text: #e7ebee; --text-2: #97a2ab; --line: #2a3138; --hover: #222a31; --accent: #4fb3c9; }} }}
  body {{ margin: 0; padding: 20px; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, "SF Pro Text", sans-serif; }}
  h1 {{ font-size: 17px; font-weight: 600; margin: 0 0 12px; }}
  .bar {{ display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }}
  input {{ flex: 1; max-width: 280px; font: inherit; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--text); outline: none; }}
  input:focus {{ border-color: var(--accent); }}
  .n {{ color: var(--text-2); font-size: 13px; }}
  .wrap {{ overflow: auto; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ padding: 7px 12px; text-align: left; border-bottom: 1px solid var(--line); white-space: nowrap; }}
  th {{ position: sticky; top: 0; background: var(--card); font-weight: 600; cursor: pointer; user-select: none; }}
  th:hover {{ color: var(--accent); }}
  th .s {{ color: var(--accent); margin-left: 4px; }}
  td.num, th.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  tr:last-child td {{ border-bottom: 0; }}
  tbody tr:hover {{ background: var(--hover); }}
</style></head>
<body>
<h1>{html.escape(title)}</h1>
<div class="bar"><input id="q" placeholder="Filter" spellcheck="false"><span class="n" id="n"></span></div>
<div class="wrap"><table><thead><tr id="h"></tr></thead><tbody id="b"></tbody></table></div>
<script>
const D = {data};
const num = s => {{ const t = String(s).replace(/[$€£,\\s%KMB]/gi, "").replace(/^\\((.*)\\)$/, "-$1"); return t !== "" && !isNaN(+t) ? +t : null; }};
const isNum = D.h.map((_, i) => {{ const v = D.r.map(r => r[i]).filter(Boolean); return v.length && v.filter(x => num(x) !== null).length / v.length > .7; }});
let key = -1, dir = 1;
function draw() {{
  const q = document.getElementById("q").value.trim().toLowerCase();
  let rows = D.r.filter(r => !q || r.join(" ").toLowerCase().includes(q));
  if (key >= 0) rows = [...rows].sort((a, b) => {{
    const x = a[key], y = b[key];
    if (isNum[key]) return ((num(x) ?? -Infinity) - (num(y) ?? -Infinity)) * dir;
    return String(x).localeCompare(String(y), undefined, {{ numeric: true }}) * dir;
  }});
  document.getElementById("h").innerHTML = D.h.map((h, i) => `<th class="${{isNum[i] ? "num" : ""}}" data-i="${{i}}">${{esc(h)}}${{i === key ? `<span class="s">${{dir > 0 ? "↑" : "↓"}}</span>` : ""}}</th>`).join("");
  document.getElementById("b").innerHTML = rows.map(r => `<tr>${{r.map((c, i) => `<td class="${{isNum[i] ? "num" : ""}}">${{esc(c)}}</td>`).join("")}}</tr>`).join("");
  document.getElementById("n").textContent = rows.length === D.r.length ? `${{D.r.length}} rows` : `${{rows.length}} of ${{D.r.length}} rows`;
  document.querySelectorAll("th").forEach(th => th.onclick = () => {{ const i = +th.dataset.i; dir = key === i ? -dir : 1; key = i; draw(); }});
}}
const esc = s => String(s).replace(/[&<>"]/g, c => ({{ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }})[c]);
document.getElementById("q").oninput = draw;
draw();
</script>
</body></html>
"""
