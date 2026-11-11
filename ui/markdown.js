// A small markdown renderer for Claude's replies: headings, paragraphs, lists, code fences, tables
// (sortable, via window.makeTable), Mermaid diagrams (via window.drawDiagrams), quotes, rules, links, bold/italic/inline code. Escapes all HTML.
(function () {
  const esc = s => s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // File paths (VS Code style): a/b/c.py, ~/x/y.md, /abs/path.png, with optional :line or #Lline.
  const PATH_RE = /(^|[\s(\[,'"])((?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)+[\w@.+-]+\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)?)(?=$|[\s),.;:!?\]'"])/g;
  const BARE_FILE = /^[\w@.+-]+\.(?:py|js|ts|tsx|jsx|json|md|sql|yml|yaml|toml|sh|html|css|ipynb|txt|csv|png|jpg|jpeg|gif|svg|java|scala|go|rs|rb|kt|swift|c|h|cpp|xml|cfg|ini|lock)(?::\d+(?:-\d+)?)?$/i;
  // ~/… or /… paths may have spaces in folder names (~/Claude Outputs/x.md); checked against the disk later.
  const ABS_SPACED = /(^|[\s(\[,'"])((?:~|\/Users)\/(?:[\w@.+-]+(?: [\w@.+-]+)*\/)+[\w@.+-]+\.[A-Za-z0-9]{1,8}(?::\d+(?:-\d+)?|#L\d+(?:-L?\d+)?)?)(?=$|[\s),.;:!?\]'"])/g;
  const pathLink = (p, text) => `<a class="path" data-path="${esc(p)}" title="${esc(p)}">${text}</a>`;

  function inline(s) {
    const codes = [];
    const hold = h => { codes.push({ html: h }); return `\u0000${codes.length - 1}\u0000`; };
    s = s.replace(/`([^`\n]+)`/g, (_, c) => {
      // a/b/c.py, ~/x/y/, /abs/dir/, folder/ (checked against the disk afterwards, so a false match just stays text)
      const looksPath = /^(?:~\/|\.{1,2}\/|\/)?(?:[\w@. +-]+\/)*[\w@. +-]*[\w-](?::\d+(?:-\d+)?)?\/?$/.test(c) && /\//.test(c) && !/\s\/|\/\s/.test(c) || BARE_FILE.test(c);
      return hold(looksPath ? `<code>${pathLink(c, esc(c))}</code>` : `<code>${esc(c)}</code>`);
    });
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => hold(/^https?:/.test(u)
      ? `<a href="${esc(u)}" data-href="${esc(u)}">${esc(alt || u)}</a>` : pathLink(u, esc(alt || u))));
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => hold(/^(https?|mailto):/.test(u)
      ? `<a href="${esc(u)}" data-href="${esc(u)}">${inline(t)}</a>` : pathLink(u, inline(t))));
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, p, u) => p + hold(`<a href="${esc(u)}" data-href="${esc(u)}">${esc(u)}</a>`));
    s = s.replace(ABS_SPACED, (_, p, path) => p + hold(pathLink(path, esc(path))));
    s = s.replace(PATH_RE, (_, p, path) => p + hold(pathLink(path, esc(path))));
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i].html);
  }

  const splitRow = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, "|"));

  function render(src, streaming) {
    const lines = src.replace(/\r/g, "").split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      const fence = l.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
      if (fence) {
        const close = fence[1], lang = fence[2] || "";
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
        const closed = i < lines.length;  // a diagram draws once its fence closes, not while it streams in
        i++;
        out.push(`<div class="code"${closed && /^mermaid$/i.test(lang) ? " data-diagram" : ""}><div class="code-head"><span>${esc(lang)}</span><button class="copy" data-copy>copy</button></div>` +
          `<pre><code>${esc(body.join("\n"))}</code></pre></div>`);
        continue;
      }
      if (/^\s*$/.test(l)) { i++; continue; }
      const h = l.match(/^(#{1,6})\s+(.*)/);
      if (h) { const n = Math.min(4, h[1].length); out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (/^\s*\|.*\|/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const cols = splitRow(l);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
        out.push({ table: { columns: cols, rows } });
        continue;
      }
      if (/^\s*>/.test(l)) {
        const q = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
        out.push(`<blockquote>${render(q.join("\n")).html}</blockquote>`);
        continue;
      }
      const li = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
      if (li) {
        const ordered = /\d/.test(li[2]);
        const items = [];
        const base = li[1].length;
        while (i < lines.length) {
          const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
          if (m && m[1].length <= base + 1) { items.push([m[3]]); i++; continue; }
          if (items.length && /^\s{2,}\S/.test(lines[i])) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
          break;
        }
        const tag = ordered ? "ol" : "ul", first = ordered ? parseInt(li[2], 10) : 1;
        out.push(`<${tag}${first > 1 ? ` start="${first}"` : ""}>` + items.map(it => {
          const [first, ...rest] = it;
          const sub = rest.length && /^([-*+]|\d+[.)])\s/.test(rest[0]) ? render(rest.join("\n")).html : (rest.length ? " " + inline(rest.join(" ")) : "");
          return `<li>${inline(first)}${sub}</li>`;
        }).join("") + `</${tag}>`);
        continue;
      }
      const para = [];
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(```|~~~|#{1,6}\s|>|\|)/.test(lines[i]) && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
    return { parts: out, html: out.map(p => typeof p === "string" ? p : "").join("") };
  }

  // Fills `el` with the rendered markdown; tables become sortable table cards.
  // "<answers>Yes | No</answers>" as a reply's last line is for Tether's answer buttons, not for reading.
  // While a reply streams, a half-arrived tag at the very end is held back too.
  window.stripAnswers = function (src, streaming) {
    src = (src || "").replace(/\s*<answers>[\s\S]*?<\/answers>\s*$/, "");
    return streaming ? src.replace(/\s*<answers>[\s\S]*$/, "").replace(/\s*<(a(n(s(w(e(r(s)?)?)?)?)?)?)?$/, "") : src;
  };
  window.renderMarkdown = function (el, src, streaming) {
    const { parts } = render(window.stripAnswers(src, streaming), streaming);
    el.innerHTML = "";
    let buf = "";
    const flush = () => { if (buf) { el.insertAdjacentHTML("beforeend", buf); buf = ""; } };
    for (const p of parts) {
      if (typeof p === "string") { buf += p; continue; }
      flush();
      el.appendChild(window.makeTable({ columns: p.table.columns, rows: p.table.rows, inline: true }));
    }
    flush();
    if (window.drawDiagrams && el.querySelector("[data-diagram]")) window.drawDiagrams(el);
  };
  window.mdInline = inline;
  window.escapeHtml = esc;
})();
