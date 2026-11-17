"""Folio's Word files: a .docx in, as the plain HTML Folio edits; that HTML out, as a real .docx.

No outside libraries: a .docx is a zip of XML, read and written here with the standard library. What carries both
ways: headings, paragraphs, bold / italic / underline / strike, text and highlight colour, sub and superscript,
links, bulleted and numbered lists (nested), quotes, code, tables, pictures, alignment, line and page breaks,
rules. What doesn't: tracked changes, comments, headers and footers, columns, text boxes, exact fonts and spacing.
"""
from __future__ import annotations

import base64
import html as _html
import re
import struct
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"w": W, "r": R, "a": A}
w = lambda t: f"{{{W}}}{t}"  # noqa: E731
MAX_IMG = 12_000_000  # bytes of pictures carried into the page, in total

HILITE = {"yellow": "#FFF59D", "green": "#B9F6CA", "cyan": "#B2EBF2", "magenta": "#F8BBD0", "blue": "#BBDEFB",
          "red": "#FFCDD2", "darkYellow": "#E6C200", "lightGray": "#E0E0E0", "darkGray": "#9E9E9E"}


# ---------------------------------------------------------------- .docx -> HTML

def to_html(path: str) -> str:
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        doc = ET.fromstring(z.read("word/document.xml"))
        rels = {}
        if "word/_rels/document.xml.rels" in names:
            for r in ET.fromstring(z.read("word/_rels/document.xml.rels")):
                rels[r.get("Id")] = (r.get("Target") or "", r.get("TargetMode") or "")
        styles = {}  # styleId -> lower-case name
        if "word/styles.xml" in names:
            for s in ET.fromstring(z.read("word/styles.xml")).iter(w("style")):
                n = s.find(w("name"))
                styles[s.get(w("styleId"))] = (n.get(w("val")) if n is not None else "").lower()
        bullets = _bullet_lists(z.read("word/numbering.xml")) if "word/numbering.xml" in names else {}
        budget = [MAX_IMG]

        def media(rid: str) -> str:
            target = rels.get(rid, ("", ""))[0]
            name = "word/" + target.lstrip("/") if not target.startswith("word/") else target
            if name not in names:
                return ""
            raw = z.read(name)
            if len(raw) > budget[0]:
                return ""
            budget[0] -= len(raw)
            ext = name.rsplit(".", 1)[-1].lower()
            mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif"}.get(ext)
            return f"data:{mime};base64,{base64.b64encode(raw).decode()}" if mime else ""

        def runs(p) -> str:
            out = []
            for n in p:
                if n.tag == w("r"):
                    out.append(run(n))
                elif n.tag == w("hyperlink"):
                    href = rels.get(n.get(f"{{{R}}}id"), ("", ""))[0]
                    inner = "".join(run(r) for r in n.iter(w("r")))
                    inner = re.sub(r'<span style="color:#0563C1">(.*?)</span>', r"\1", inner, flags=re.S | re.I).replace("<u>", "").replace("</u>", "")  # Word's own link look
                    out.append(f'<a href="{_html.escape(href, True)}">{inner}</a>' if href.startswith(("http", "mailto:")) else inner)
                elif n.tag in (w("ins"), w("smartTag"), w("sdt"), w("sdtContent")):
                    out.append(runs(n))
            return "".join(out)

        def run(r) -> str:
            pr = r.find(w("rPr"))
            bits = []
            for n in r:
                if n.tag == w("t"):
                    bits.append(_html.escape(n.text or "", False))
                elif n.tag == w("tab"):
                    bits.append("&emsp;")
                elif n.tag in (w("br"), w("cr")):
                    bits.append('<hr class="page-break">' if n.get(w("type")) == "page" else "<br>")
                elif n.tag == w("drawing"):
                    blip = n.find(".//a:blip", NS)
                    src = media(blip.get(f"{{{R}}}embed")) if blip is not None else ""
                    ext = n.find(".//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}extent")
                    wpx = f' width="{round(int(ext.get("cx")) / 9525)}"' if ext is not None and ext.get("cx", "").isdigit() else ""
                    if src:
                        bits.append(f'<img src="{src}"{wpx}{_free_at(n)}>')
            s = "".join(bits)
            if not s or pr is None:
                return s

            def on(tag):
                e = pr.find(w(tag))
                return e is not None and e.get(w("val"), "true") not in ("0", "false", "none")
            style = []
            c = pr.find(w("color"))
            if c is not None and re.fullmatch(r"[0-9A-Fa-f]{6}", c.get(w("val"), "")) and c.get(w("val")).upper() != "000000":
                style.append(f"color:#{c.get(w('val'))}")
            h = pr.find(w("highlight"))
            if h is not None and h.get(w("val")) in HILITE:
                style.append(f"background-color:{HILITE[h.get(w('val'))]}")
            sh = pr.find(w("shd"))
            if sh is not None and re.fullmatch(r"[0-9A-Fa-f]{6}", sh.get(w("fill"), "")) and h is None:
                style.append(f"background-color:#{sh.get(w('fill'))}")
            f = pr.find(w("rFonts"))
            mono = f is not None and re.search(r"mono|courier|consolas|menlo", (f.get(w("ascii")) or "").lower())
            if style:
                s = f'<span style="{";".join(style)}">{s}</span>'
            if mono or (pr.find(w("rStyle")) is not None and "code" in styles.get(pr.find(w("rStyle")).get(w("val")), "")):
                s = f"<code>{s}</code>"
            va = pr.find(w("vertAlign"))
            if va is not None and va.get(w("val")) in ("superscript", "subscript"):
                t = "sup" if va.get(w("val")) == "superscript" else "sub"
                s = f"<{t}>{s}</{t}>"
            for tag, h_ in (("strike", "s"), ("u", "u"), ("i", "i"), ("b", "b")):
                if on(tag):
                    s = f"<{h_}>{s}</{h_}>"
            return s

        def blocks(parent) -> str:
            out, lists = [], []  # lists: the open <ul>/<ol> tags, outermost first
            after_table = False

            def close(to=0):
                while len(lists) > to:
                    out.append(f"</li></{lists.pop()}>")
            for n in parent:
                if n.tag == w("tbl"):
                    close()
                    rows = []
                    for tr in n.findall(w("tr")):
                        cells = []
                        for tc in tr.findall(w("tc")):
                            span = tc.find(f"{w('tcPr')}/{w('gridSpan')}")
                            cs = f' colspan="{span.get(w("val"))}"' if span is not None and span.get(w("val"), "1") != "1" else ""
                            inner = blocks(tc)
                            one = re.fullmatch(r"<p>(.*)</p>", inner, re.S)  # a cell with one plain paragraph is just its text
                            cells.append(f"<td{cs}>{one.group(1) if one and '<p' not in one.group(1) else inner}</td>")
                        rows.append("<tr>" + "".join(cells) + "</tr>")
                    out.append("<table>" + "".join(rows) + "</table>")
                    after_table = True
                    continue
                if n.tag != w("p"):
                    continue
                was_table, after_table = after_table, False
                pr = n.find(w("pPr"))
                sid = pr.find(w("pStyle")).get(w("val")) if pr is not None and pr.find(w("pStyle")) is not None else ""
                name = styles.get(sid, sid.lower())
                jc = pr.find(w("jc")).get(w("val")) if pr is not None and pr.find(w("jc")) is not None else ""
                align = {"center": "center", "right": "right", "end": "right", "both": "justify"}.get(jc)
                st = f' style="text-align:{align}"' if align else ""
                num = pr.find(w("numPr")) if pr is not None else None
                inner = runs(n)
                if num is not None and num.find(w("numId")) is not None and num.find(w("numId")).get(w("val")) != "0":
                    lvl = int(num.find(w("ilvl")).get(w("val"))) if num.find(w("ilvl")) is not None else 0
                    lvl = min(lvl, len(lists))  # never skip a level
                    kind = "ul" if bullets.get((num.find(w("numId")).get(w("val")), lvl), True) else "ol"
                    if len(lists) > lvl + 1:
                        close(lvl + 1)
                    if len(lists) == lvl + 1 and lists[-1] == kind:
                        out.append("</li><li>")
                    else:
                        if len(lists) == lvl + 1:
                            close(lvl)
                        lists.append(kind)
                        out.append(f"<{kind}><li>")
                    out.append(inner)
                    continue
                close()
                m = re.fullmatch(r"heading (\d)", name)
                border = pr is not None and pr.find(f"{w('pBdr')}/{w('bottom')}") is not None
                if border and not inner:
                    out.append("<hr>")
                elif name == "title":
                    out.append(f"<h1{st}>{inner}</h1>")
                elif m:
                    out.append(f"<h{min(4, int(m.group(1)))}{st}>{inner}</h{min(4, int(m.group(1)))}>")
                elif "quote" in name:
                    out.append(f"<blockquote>{inner}</blockquote>")
                elif name in ("code", "source code", "html preformatted"):
                    out.append(f"<pre>{re.sub(r'</?code>', '', inner).replace('<br>', chr(10))}</pre>")
                elif inner == '<hr class="page-break">':
                    out.append(inner)
                elif not inner and was_table:
                    pass  # the empty paragraph Word wants after a table
                else:
                    out.append(f"<p{st}>{inner or '<br>'}</p>")
            close()
            return "".join(out)

        body = doc.find(w("body"))
        html = blocks(body) if body is not None else ""
        html = re.sub(r"</pre><pre>", "\n", html)  # code lines kept as one block
        return html or "<p><br></p>"


def _bullet_lists(raw: bytes) -> dict:
    """(numId, level) -> True for a bulleted level, False for a numbered one."""
    root = ET.fromstring(raw)
    fmts = {}
    for a in root.findall(w("abstractNum")):
        for lv in a.findall(w("lvl")):
            f = lv.find(w("numFmt"))
            fmts[(a.get(w("abstractNumId")), int(lv.get(w("ilvl"), "0")))] = (f.get(w("val")) if f is not None else "bullet") == "bullet"
    out = {}
    for n in root.findall(w("num")):
        a = n.find(w("abstractNumId"))
        if a is None:
            continue
        for (aid, lvl), b in fmts.items():
            if aid == a.get(w("val")):
                out[(n.get(w("numId")), lvl)] = b
    return out


# ---------------------------------------------------------------- HTML -> .docx

def _img_size(raw: bytes) -> tuple[int, int]:
    try:
        if raw[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", raw[16:24])
        if raw[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", raw[6:10])
        if raw[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(raw):
                if raw[i] != 0xFF:
                    i += 1
                    continue
                m = raw[i + 1]
                if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                    h, wd = struct.unpack(">HH", raw[i + 5:i + 9])
                    return wd, h
                i += 2 + struct.unpack(">H", raw[i + 2:i + 4])[0]
    except (struct.error, IndexError):
        pass
    return 480, 320


WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"


def _px(v) -> int | None:
    m = re.fullmatch(r"\s*(-?\d+(?:\.\d+)?)px\s*", v or "")
    return round(float(m.group(1))) if m else None


def _free_at(drawing) -> str:
    """A picture Word holds in front of the text, placed from its paragraph: Folio's free picture. Any other
    floating picture (text wrapped around it, or placed from the page) stays in the line, as before."""
    anc = drawing.find(f"{{{WP}}}anchor")
    if anc is None or anc.find(f"{{{WP}}}wrapNone") is None or anc.get("behindDoc") in ("1", "true"):
        return ""
    h, v = anc.find(f"{{{WP}}}positionH"), anc.find(f"{{{WP}}}positionV")
    if h is None or v is None or h.get("relativeFrom") not in ("column", "margin") or v.get("relativeFrom") not in ("paragraph", "line"):
        return ""
    try:
        x, y = (round(int(e.find(f"{{{WP}}}posOffset").text) / 9525) for e in (h, v))
    except (AttributeError, TypeError, ValueError):
        return ""
    return f' class="free" style="left:{x}px;top:{y}px"'


def _css(style: str) -> dict:
    out = {}
    for part in (style or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            out[k.strip().lower()] = v.strip()
    return out


def _hex(v: str) -> str:
    v = (v or "").strip().lower()
    m = re.fullmatch(r"#([0-9a-f]{6})", v)
    if m:
        return m.group(1).upper()
    m = re.fullmatch(r"#([0-9a-f])([0-9a-f])([0-9a-f])", v)
    if m:
        return "".join(c * 2 for c in m.groups()).upper()
    m = re.fullmatch(r"rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+).*\)", v)
    if m:
        return "".join(f"{min(255, int(x)):02X}" for x in m.groups())
    return ""


class _Writer(HTMLParser):
    BLOCK = {"p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "li", "td", "th"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out = [[]]           # a stack of block lists; a table cell collects into its own
        self.runs: list[str] = []
        self.para: dict = {}
        self.fmt: list[dict] = [{}]
        self.lists: list[tuple[str, int]] = []   # (ul|ol, numId)
        self.tables: list[list] = []
        self.links: list[str] = []
        self.images: list[tuple[str, bytes]] = []
        self.nums: list[str] = []                # extra numbered lists, each restarting at 1
        self.pre = 0
        self.skip = 0
        self.in_li_first = False

    # -- helpers
    def rpr(self) -> str:
        f = self.fmt[-1]
        x = ""
        if f.get("code"):
            x += '<w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Menlo"/>'
        if f.get("b"):
            x += "<w:b/>"
        if f.get("i"):
            x += "<w:i/>"
        if f.get("s"):
            x += "<w:strike/>"
        if f.get("color") or f.get("href"):
            x += f'<w:color w:val="{f.get("color") or "0563C1"}"/>'
        if f.get("code"):
            x += '<w:sz w:val="20"/>'
        if f.get("u") or f.get("href"):
            x += '<w:u w:val="single"/>'
        if f.get("bg"):
            x += f'<w:shd w:val="clear" w:color="auto" w:fill="{f["bg"]}"/>'
        elif f.get("code") and not self.pre:
            x += '<w:shd w:val="clear" w:color="auto" w:fill="EEEEEE"/>'
        if f.get("va"):
            x += f'<w:vertAlign w:val="{f["va"]}"/>'
        return f"<w:rPr>{x}</w:rPr>" if x else ""

    def text(self, t: str) -> None:
        if not t:
            return
        r = f'<w:r>{self.rpr()}<w:t xml:space="preserve">{escape(t)}</w:t></w:r>'
        href = self.fmt[-1].get("href")
        if href:
            self.links.append(href)
            r = f'<w:hyperlink r:id="rLink{len(self.links)}" w:history="1">{r}</w:hyperlink>'
        self.runs.append(r)

    def flush(self, force=False) -> None:
        if not self.runs and not force:
            self.para = {k: v for k, v in self.para.items() if k == "keep"}
            return
        p = self.para
        x = ""
        if p.get("style"):
            x += f'<w:pStyle w:val="{p["style"]}"/>'
        if p.get("num"):
            x += f'<w:numPr><w:ilvl w:val="{p["lvl"]}"/><w:numId w:val="{p["num"]}"/></w:numPr>'
        if p.get("rule"):
            x += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr>'
        if p.get("indent"):
            x += f'<w:ind w:left="{p["indent"]}"/>'
        if p.get("align"):
            x += f'<w:jc w:val="{p["align"]}"/>'
        self.out[-1].append(f"<w:p>{'<w:pPr>' + x + '</w:pPr>' if x else ''}{''.join(self.runs)}</w:p>")
        self.runs = []

    def start_para(self, **props) -> None:
        self.flush()
        self.para = props

    # -- parser events
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if self.skip or tag in ("script", "style", "head", "title"):
            self.skip += tag in ("script", "style", "head", "title")
            return
        css = _css(a.get("style", ""))
        align = {"center": "center", "right": "right", "justify": "both"}.get(css.get("text-align", "").lower())
        f = dict(self.fmt[-1])
        inline = True
        if tag in ("b", "strong"):
            f["b"] = True
        elif tag in ("i", "em"):
            f["i"] = True
        elif tag == "u":
            f["u"] = True
        elif tag in ("s", "strike", "del"):
            f["s"] = True
        elif tag == "code":
            f["code"] = True
        elif tag in ("sup", "sub"):
            f["va"] = "superscript" if tag == "sup" else "subscript"
        elif tag == "a":
            if (a.get("href") or "").startswith(("http://", "https://", "mailto:")):
                f["href"] = a["href"]
        elif tag in ("span", "font", "mark"):
            if tag == "mark":
                f["bg"] = "FFF59D"
        else:
            inline = False
        if inline:
            if css.get("font-weight", "") in ("bold", "600", "700", "800"):
                f["b"] = True
            if css.get("font-style") == "italic":
                f["i"] = True
            if "underline" in css.get("text-decoration", "") + css.get("text-decoration-line", ""):
                f["u"] = True
            if "line-through" in css.get("text-decoration", "") + css.get("text-decoration-line", ""):
                f["s"] = True
            c = _hex(css.get("color") or (a.get("color") if tag == "font" else "") or "")
            if c and c != "000000":
                f["color"] = c
            bg = _hex(css.get("background-color") or css.get("background") or "")
            if bg and bg != "FFFFFF":
                f["bg"] = bg
            self.fmt.append(f)
            return
        if tag == "br":
            self.runs.append("<w:r><w:br/></w:r>")
        elif tag == "hr":
            self.flush()
            if "page-break" in (a.get("class") or ""):
                self.out[-1].append('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
            else:
                self.para = {"rule": True}
                self.flush(force=True)
        elif tag == "img":
            self.image(a)
        elif tag in ("ul", "ol"):
            self.flush()
            if tag == "ol":
                self.nums.append("ol")
                num = 2 + len(self.nums)   # 1 = bullets, 2 = reserved, then one per numbered list
            else:
                num = 1
            self.lists.append((tag, num))
        elif tag == "li":
            kind, num = self.lists[-1] if self.lists else ("ul", 1)
            self.start_para(style="ListParagraph", num=num, lvl=min(8, max(0, len(self.lists) - 1)))
        elif tag == "table":
            self.flush()
            self.tables.append([])
        elif tag == "tr":
            if self.tables:
                self.tables[-1].append([])
        elif tag in ("td", "th"):
            if self.tables and self.tables[-1]:
                self.flush()
                self.out.append([])
                self.fmt.append({**self.fmt[-1], **({"b": True} if tag == "th" else {})})
                self.tables[-1][-1].append({"span": int(a.get("colspan") or 1) if str(a.get("colspan") or "1").isdigit() else 1})
                self.para = {"align": align} if align else {}
        elif tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self.start_para(style=f"Heading{min(4, int(tag[1]))}", align=align)
        elif tag == "blockquote":
            self.start_para(style="Quote")
        elif tag == "pre":
            self.start_para(style="Code")
            self.pre += 1
            self.fmt.append({**self.fmt[-1], "code": True})
        elif tag in ("p", "div"):
            keep = {k: v for k, v in self.para.items() if k in ("style", "num", "lvl")} if (not self.runs and self.para.get("num")) else {}
            self.start_para(**{**keep, **({"align": align} if align else {})}) if not keep else None
            indent = css.get("margin-left") or css.get("padding-left") or ""
            m = re.fullmatch(r"(\d+)px", indent)
            if m and int(m.group(1)) >= 20 and not keep:
                self.para["indent"] = int(m.group(1)) * 15

    def handle_endtag(self, tag):
        if self.skip:
            self.skip -= tag in ("script", "style", "head", "title")
            return
        if tag in ("b", "strong", "i", "em", "u", "s", "strike", "del", "code", "sup", "sub", "a", "span", "font", "mark"):
            if len(self.fmt) > 1:
                self.fmt.pop()
        elif tag in ("ul", "ol"):
            self.flush()
            if self.lists:
                self.lists.pop()
        elif tag in ("td", "th"):
            if self.tables and self.tables[-1] and len(self.out) > 1:
                self.flush()
                cell = self.out.pop()
                self.tables[-1][-1][-1]["xml"] = "".join(cell) or "<w:p/>"
                if len(self.fmt) > 1:
                    self.fmt.pop()
        elif tag == "table":
            if self.tables:
                self.out[-1].append(self.table(self.tables.pop()))
        elif tag == "pre":
            self.flush(force=True)
            self.pre = max(0, self.pre - 1)
            if len(self.fmt) > 1:
                self.fmt.pop()
        elif tag in ("p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "li"):
            self.flush(force=tag == "p")
            self.para = {}

    def handle_data(self, data):
        if self.skip:
            return
        if self.pre:
            lines = data.split("\n")
            for i, line in enumerate(lines):
                if i:
                    self.flush(force=True)
                    self.para = {"style": "Code"}
                self.text(line)
            return
        t = re.sub(r"[ \t\r\n\f]+", " ", data.replace(" ", " "))
        if not self.runs:
            t = t.lstrip(" ")
            if not t:
                return
        self.text(t)

    def image(self, a: dict) -> None:
        m = re.fullmatch(r"data:image/(png|jpeg|jpg|gif);base64,(.+)", a.get("src") or "", re.S)
        if not m:
            return
        try:
            raw = base64.b64decode(m.group(2))
        except ValueError:
            return
        ext = "jpeg" if m.group(1) == "jpg" else m.group(1)
        self.images.append((ext, raw))
        n = len(self.images)
        pw, ph = _img_size(raw)
        css = _css(a.get("style", ""))
        want = a.get("width") or css.get("width", "").replace("px", "")
        if str(want).isdigit() and pw:
            ph, pw = round(ph * int(want) / pw), int(want)
        cx, cy = pw * 9525, ph * 9525
        if cx > 5486400:
            cy, cx = round(cy * 5486400 / cx), 5486400
        x, y = _px(css.get("left")), _px(css.get("top"))
        free = "free" in (a.get("class") or "").split() and x is not None and y is not None
        if free:  # in front of the text, measured from the paragraph it sits in; kept on the paper
            x = max(-800000, min(x * 9525, max(0, 5486400 + 800000 - cx)))
            head = (f'<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="{251658240 + n}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">'
                    f'<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>{x}</wp:posOffset></wp:positionH>'
                    f'<wp:positionV relativeFrom="paragraph"><wp:posOffset>{y * 9525}</wp:posOffset></wp:positionV>'
                    f'<wp:extent cx="{cx}" cy="{cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>')
        else:
            head = f'<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="{cx}" cy="{cy}"/>'
        self.runs.append(
            f'<w:r><w:drawing>{head}'
            f'<wp:docPr id="{n}" name="Picture {n}"/><a:graphic xmlns:a="{A}"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
            f'<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="{n}" name="Picture {n}"/><pic:cNvPicPr/></pic:nvPicPr>'
            f'<pic:blipFill><a:blip r:embed="rImg{n}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
            f'<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
            f"</pic:pic></a:graphicData></a:graphic></wp:{'anchor' if free else 'inline'}></w:drawing></w:r>")

    @staticmethod
    def table(rows: list) -> str:
        rows = [r for r in rows if r]
        if not rows:
            return ""
        cols = max(sum(c["span"] for c in r) for r in rows)
        wd = 9000 // max(1, cols)
        x = ('<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>'
             + f'<w:gridCol w:w="{wd}"/>' * cols + "</w:tblGrid>")
        for r in rows:
            x += "<w:tr>"
            for c in r:
                span = f'<w:gridSpan w:val="{c["span"]}"/>' if c["span"] > 1 else ""
                x += f'<w:tc><w:tcPr><w:tcW w:w="{wd * c["span"]}" w:type="dxa"/>{span}</w:tcPr>{c.get("xml") or "<w:p/>"}</w:tc>'
            x += "</w:tr>"
        return x + "</w:tbl><w:p/>"


def _numbering(n_ol: int) -> str:
    def levels(bullet: bool) -> str:
        out = ""
        for i in range(9):
            fmt = "bullet" if bullet else ("decimal", "lowerLetter", "lowerRoman")[i % 3]
            txt = ("•", "◦", "▪")[i % 3] if bullet else f"%{i + 1}."
            out += (f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{fmt}"/><w:lvlText w:val="{txt}"/><w:lvlJc w:val="left"/>'
                    f'<w:pPr><w:ind w:left="{720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>')
        return out
    x = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="{W}">'
         f'<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>{levels(True)}</w:abstractNum>'
         f'<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>{levels(False)}</w:abstractNum>'
         '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>')
    for i in range(n_ol):
        x += (f'<w:num w:numId="{3 + i}"><w:abstractNumId w:val="1"/>'
              + "".join(f'<w:lvlOverride w:ilvl="{k}"><w:startOverride w:val="1"/></w:lvlOverride>' for k in range(9)) + "</w:num>")
    return x + "</w:numbering>"


STYLES = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="{W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
''' + "".join(
    f'<w:style w:type="paragraph" w:styleId="Heading{i}"><w:name w:val="heading {i}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    f'<w:pPr><w:keepNext/><w:spacing w:before="{b}" w:after="{a}"/><w:outlineLvl w:val="{i - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="{sz}"/><w:szCs w:val="{sz}"/></w:rPr></w:style>'
    for i, sz, b, a in ((1, 40, 360, 120), (2, 32, 280, 100), (3, 26, 240, 80), (4, 23, 200, 60))) + '''
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BBBBBB"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="555555"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Menlo" w:hAnsi="Menlo" w:cs="Menlo"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:tblPr><w:tblBorders>''' + "".join(
    f'<w:{s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>' for s in ("top", "left", "bottom", "right", "insideH", "insideV")) + '''</w:tblBorders></w:tblPr></w:style>
</w:styles>'''


def from_html(html: str, path: str) -> None:
    wr = _Writer()
    wr.feed(html or "")
    wr.close()
    wr.flush()
    body = "".join(wr.out[0]) or "<w:p/>"
    doc = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}" xmlns:r="{R}" '
           'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
           f'<w:body>{body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" '
           'w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>')
    rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    rels = (f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rStyles" Type="{rel}/styles" Target="styles.xml"/><Relationship Id="rNum" Type="{rel}/numbering" Target="numbering.xml"/>')
    for i, href in enumerate(wr.links, 1):
        rels += f'<Relationship Id="rLink{i}" Type="{rel}/hyperlink" Target="{escape(href, {chr(34): "&quot;"})}" TargetMode="External"/>'
    for i, (ext, _raw) in enumerate(wr.images, 1):
        rels += f'<Relationship Id="rImg{i}" Type="{rel}/image" Target="media/image{i}.{ext}"/>'
    rels += "</Relationships>"
    types = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
             '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>'
             '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
             '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
             '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>')
    root = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'<Relationship Id="rId1" Type="{rel}/officeDocument" Target="word/document.xml"/></Relationships>')
    tmp = Path(path).with_name(Path(path).name + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", root)
        z.writestr("word/document.xml", doc)
        z.writestr("word/_rels/document.xml.rels", rels)
        z.writestr("word/styles.xml", STYLES)
        z.writestr("word/numbering.xml", _numbering(len(wr.nums)))
        for i, (ext, raw) in enumerate(wr.images, 1):
            z.writestr(f"word/media/image{i}.{ext}", raw)
    tmp.replace(path)
