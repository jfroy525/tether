// Side panel, repo chats only: Changes (what's uncommitted and unpushed) and History (a branch tree of commits with
// the PRs, Actions runs and deploys on them). Links go to GitHub when the commit or branch is there.

const encPath = p => String(p).split("/").map(encodeURIComponent).join("/");
const isoAgo = iso => iso ? ago(Date.parse(iso) / 1000) : "";
const linkTo = (url, text, title = "") => url ? `<a class="rp-a" data-url="${esc(url)}" title="${esc(title || url)}">${text}</a>` : "";
const nums = f => f.add == null ? `<span class="ln">binary</span>` : `<span class="ln">+${f.add} −${f.del || 0}</span>`;
const MARKS = { modified: "M", added: "A", untracked: "U", deleted: "D", renamed: "R" };

function wireLinks(root) {
  root.onclick = e => {
    const a = e.target.closest("[data-url]");
    if (a) { e.preventDefault(); e.stopPropagation(); api().open_url(a.dataset.url); }
  };
}

// One file row: status letter, name, folder, +/- lines, then Open in VS Code and GitHub on hover.
function fileRow({ f, key, gh, onDiff, editorPath }) {
  const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
  const r = el("div", "file rp-file" + (state.openFile === key ? " on" : ""),
    `<span class="k ${f.kind}">${MARKS[f.kind] || "M"}</span><span class="fn"></span><span class="dir"></span>${nums(f)}` +
    `<span class="acts">${editorPath ? `<span class="open" title="Open in VS Code">↗</span>` : ""}${gh ? linkTo(gh, "GitHub", "Open this file on GitHub") : ""}</span>`);
  r.querySelector(".fn").textContent = f.path.split("/").pop();
  r.querySelector(".dir").textContent = dir;
  r.title = f.path;
  const open = r.querySelector(".open");
  if (open) open.onclick = e => { e.stopPropagation(); api().open_in_editor(editorPath); };
  r.onclick = async e => {
    if (e.target.closest("[data-url]")) return;
    const box = r.parentElement;
    const was = state.openFile === key;
    box.querySelectorAll(".panel-diff").forEach(n => n.remove());
    box.querySelectorAll(".file").forEach(n => n.classList.remove("on"));
    state.openFile = was ? null : key;
    if (was) return;
    r.classList.add("on");
    const d = await onDiff();
    const wrap = el("div", "panel-diff");
    wrap.appendChild(makeDiff(d, { file: editorPath || "" }));
    r.after(wrap);
  };
  return r;
}

// ---------- Changes ----------
// Top to bottom: GitHub's main (latest change, what each deploy target has, whether your copy has pulled it), this
// branch when it isn't main, its uncommitted and unpushed work, open PRs, then unmerged branches. Empty sections hide.
const st = (cls, text, url) => `<span class="rp-st ${cls}">${url ? linkTo(url, esc(text)) : esc(text)}</span>`;
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
async function renderChanges(S, body, fresh) {
  const c = await api().repo_changes(repoDir(S));
  if (state.active !== S.sid || state.tab !== "changes" || !state.panel) return;
  const frag = document.createDocumentFragment();
  const gh = c.github, branch = c.branch;
  const mainBox = el("div", "rp-main");
  frag.appendChild(mainBox);
  if (branch !== c.default) {
    const head = el("div", "rp-blk rp-curblk");
    head.innerHTML = `<div class="top"><span class="nm mono">${gh && c.on_remote && !c.gone ? linkTo(`${gh}/tree/${encPath(branch)}`, esc(branch), "Branch on GitHub") : esc(branch)}</span><span class="w">Current</span></div>` +
      `<div class="rp-line rp-cur">${curLine(c, null, c.default)}</div>`;
    head.querySelector(".rp-cur").statusOf = c;
    frag.appendChild(head);
  }

  const groups = [["staged", "Staged"], ["unstaged", "Changed"], ["untracked", "New files"]];
  const box = el("div", "rp-files");
  groups.forEach(([g, label]) => {
    const fs = c.files.filter(f => f.group === g);
    if (!fs.length) return;
    box.appendChild(el("div", "rp-sec", `${label}<span>${fs.length}</span>`));
    fs.forEach(f => box.appendChild(fileRow({
      f, key: `${c.root}/${f.path}`, editorPath: `${c.root}/${f.path}`,
      gh: gh && c.on_remote && f.kind !== "untracked" && f.kind !== "added" ? `${gh}/blob/${encPath(branch)}/${encPath(f.path)}` : "",
      onDiff: () => api().repo_diff(repoDir(S), f.path),
    })));
  });
  if (c.files.length) frag.appendChild(box);

  if (c.unpushed.length) {
    const up = el("div", "rp-files");
    up.appendChild(el("div", "rp-sec", `Not pushed<span>${c.unpushed.length}</span>`));
    c.unpushed.forEach(u => up.appendChild(commitLine(S, { sha: u.sha, short: u.short, subject: u.subject, when: u.when, pushed: false }, gh)));
    frag.appendChild(up);
  }
  const work = el("div", "rp-work");
  frag.appendChild(work);
  body.innerHTML = "";
  body.appendChild(frag);
  wireLinks(body);
  state.openWork = state.openWork || {};
  const last = state.openWork[c.root];
  if (last) drawOpenWork(last, body, mainBox, work, gh, branch);
  else mainBox.innerHTML = `<div class="rp-dim rp-wait">Checking GitHub…</div>`;
  renderOpenWork(S, body, mainBox, work, gh, branch, fresh);
}

// Fetched after the rest so local changes show straight away. The fetch runs at most every five minutes (↻ forces
// it); when one just ran, the whole panel and top bar redraw once so "up to date" lines match GitHub.
async function renderOpenWork(S, body, mainBox, box, gh, branch, fresh) {
  const w = await api().repo_open_work(repoDir(S), !!fresh);
  if (state.active !== S.sid || state.tab !== "changes" || !box.isConnected || !w.git) return;
  state.openWork[w.root] = w;
  if (w.fetched) return refreshRepo();
  drawOpenWork(w, body, mainBox, box, gh, branch);
}
// One line per item: a dot and the state that matters most, then the details in grey.
const dotLine = (cls, head, rest = [], url = "") => `<span class="rp-st ${cls}">${url ? linkTo(url, esc(head)) : esc(head)}</span>` +
  rest.filter(Boolean).map(r => `<span class="rest"> · ${esc(r)}</span>`).join("");
const RANK = { bad: 3, warn: 2, ok: 1, info: 0 };
function worstLine(items) {  // items: [cls, text, url]; the most serious goes first and sets the dot
  const list = items.filter(Boolean).sort((a, b) => RANK[b[0]] - RANK[a[0]]);
  if (!list.length) return "";
  return dotLine(list[0][0], list[0][1], list.slice(1).map(x => x[1]), list[0][2]);
}
function curLine(c, b, main) {
  const pr = b?.pr, open = pr && (pr.state === "open" || pr.state === "draft");
  const ahead = b && !b.merged && b.ahead_main ? ["info", `${plural(b.ahead_main, "commit")} not in ${main}`] : null;
  if (pr?.state === "merged") return dotLine("ok", `Merged in PR #${pr.number}`, [c.gone ? "deleted on GitHub" : ""], pr.url);
  return worstLine([
    c.gone ? ["warn", "Deleted on GitHub"] : !c.upstream && !c.on_remote ? ["warn", "Not on GitHub yet"] : null,
    c.ahead ? ["warn", `${c.ahead} to push`] : null, c.behind ? ["warn", `${c.behind} to pull`] : null,
    open ? ["ok", `PR #${pr.number} open`, pr.url] : pr?.state === "closed" ? ["bad", `PR #${pr.number} closed`, pr.url] : null,
    !c.gone && c.upstream && !c.ahead && !c.behind ? ["info", "Up to date with GitHub"] : null, ahead,
  ]);
}
function branchLine(b, main) {
  const pr = b.pr;
  if (b.merged) return dotLine("info", pr?.state === "merged" ? `Merged in PR #${pr.number}` : "Merged", [!b.remote ? "deleted on GitHub" : ""], pr?.url || "");
  return worstLine([
    pr && (pr.state === "open" || pr.state === "draft") ? ["ok", `PR #${pr.number} open`, pr.url] : pr?.state === "closed" ? ["bad", `PR #${pr.number} closed`, pr.url] : null,
    b.unpushed ? ["warn", `${b.unpushed} not pushed`] : null,
    !b.remote ? ["warn", "Only on this Mac"] : null,
    b.ahead_main ? ["info", `${plural(b.ahead_main, "commit")} not in ${main}`] : null,
  ]);
}
function prLine(p, branch) {
  const c = p.checks;
  return worstLine([
    c.failed ? ["bad", `${plural(c.failed, "check")} failing`] : c.pending ? ["warn", "Checks running"] : c.total ? ["ok", "Checks pass"] : null,
    p.review === "APPROVED" ? ["ok", "Approved"] : p.review === "CHANGES_REQUESTED" ? ["bad", "Changes requested"] : p.draft ? ["info", "Draft"] : ["warn", "Needs review"],
    ["info", `${p.branch === branch ? "this branch" : p.branch} → ${p.base}`], p.author ? ["info", p.author] : null,
  ]);
}
const block = (name, right, lines) => el("div", "rp-blk", `<div class="top"><span class="nm">${name}</span><span class="w">${right}</span></div>${lines}`);

function drawOpenWork(w, body, mainBox, box, gh, branch) {
  const m = w.main_status;
  mainBox.innerHTML = "";
  if (m && m.sha) {
    const latest = m.prs.length ? linkTo(`${gh}/pull/${m.prs[0]}`, `#${m.prs[0]} ${esc(m.subject)}`, "Pull request on GitHub") : linkTo(`${gh}/commit/${m.sha}`, esc(m.subject), "Commit on GitHub");
    const rows = m.targets.map(t => {
      const when = isoAgo(t.at), app = t.on_main === null;
      const v = app ? dotLine("info", `Deployed ${when} ago`, [], t.url)
        : !t.on_main ? dotLine("info", "From a branch", [`${when} ago`], t.url)
        : !t.since ? dotLine("ok", "Up to date", [], t.url)
        : dotLine("warn", `Missing ${t.prs.length ? t.prs.map(n => `#${n}`).join(", ") : plural(t.since, "change")}`, [`last deploy ${when} ago`], t.url);
      return `<span class="k">${esc(app ? "App" : t.target)}</span><span class="v">${v}</span>`;
    });
    if (m.local) rows.push(`<span class="k">This Mac</span><span class="v">${m.behind ? dotLine("warn", `${m.behind} behind`, ["not pulled"]) : dotLine("ok", "Up to date")}</span>`);
    const b = block(`<span class="mono">${gh ? linkTo(`${gh}/tree/${encPath(m.main)}`, esc(m.main), "On GitHub") : esc(m.main)}</span>`, ago(m.when),
      `<div class="rp-line sub">${latest}</div>${rows.length ? `<div class="rp-kv">${rows.join("")}</div>` : ""}`);
    b.classList.add("rp-mainblk");
    mainBox.appendChild(b);
  }
  const cur = body.querySelector(".rp-cur");
  if (cur?.statusOf) cur.innerHTML = curLine(cur.statusOf, w.branches.find(b => b.current), w.main);

  box.innerHTML = "";
  if (w.prs.length) {
    const prs = el("div", "rp-files");
    prs.appendChild(el("div", "rp-sec", `Open pull requests<span>${w.prs.length}</span>`));
    for (const p of w.prs) prs.appendChild(block(linkTo(p.url, `#${p.number} ${esc(p.title)}`, "Open on GitHub"), isoAgo(p.updated), `<div class="rp-line">${prLine(p, branch)}</div>`));
    box.appendChild(prs);
  }
  const others = w.branches.filter(b => !b.current);
  const open = others.filter(b => !b.merged), merged = others.filter(b => b.merged);
  const row = b => {
    const r = block(`<span class="mono">${gh && b.remote ? linkTo(`${gh}/tree/${encPath(b.name)}`, esc(b.name), "Branch on GitHub") : esc(b.name)}</span>`, ago(b.when), `<div class="rp-line">${branchLine(b, w.main)}</div>`);
    r.title = b.subject;
    return r;
  };
  if (open.length || merged.length) {
    const brs = el("div", "rp-files");
    if (open.length) {
      brs.appendChild(el("div", "rp-sec", `Not merged<span>${open.length}</span>`));
      open.forEach(b => brs.appendChild(row(b)));
    }
    if (merged.length) {
      const d = el("details", "rp-merged", `<summary class="rp-sec">Merged<span>${merged.length}</span></summary>`);
      merged.forEach(b => d.appendChild(row(b)));
      brs.appendChild(d);
    }
    box.appendChild(brs);
  }
  wireLinks(mainBox); wireLinks(box); wireLinks(body.querySelector(".rp-curblk") || el("div"));
}

// A commit as one line that opens to its files (used under "Not pushed").
function commitLine(S, cm, gh) {
  const wrap = el("div", "rp-commit");
  const line = el("div", "rp-cl", `<span class="h mono"></span><span class="s"></span><span class="w"></span>`);
  line.querySelector(".h").textContent = cm.short;
  line.querySelector(".s").textContent = cm.subject;
  line.querySelector(".w").textContent = cm.when;
  wrap.appendChild(line);
  line.onclick = () => toggleCommit(S, wrap, cm, gh);
  return wrap;
}
async function toggleCommit(S, wrap, cm, gh) {
  state.histOpen = state.histOpen || new Set();
  const open = wrap.querySelector(".rp-cfiles");
  if (open) { open.remove(); state.histOpen.delete(cm.sha); return; }
  state.histOpen.add(cm.sha);
  const box = el("div", "rp-cfiles", `<div class="rp-dim">Loading…</div>`);
  wrap.appendChild(box);
  const files = await api().repo_commit(repoDir(S), cm.sha);
  box.innerHTML = "";
  const links = el("div", "rp-links");
  links.innerHTML = (cm.pushed && gh ? linkTo(`${gh}/commit/${cm.sha}`, "Commit on GitHub") : `<span class="rp-dim">Not on GitHub yet</span>`) +
    `<a class="rp-a" data-copy="${esc(cm.sha)}">Copy hash</a>`;
  links.querySelector("[data-copy]").onclick = e => { e.stopPropagation(); navigator.clipboard.writeText(cm.sha); toast("Copied " + cm.sha.slice(0, 7)); };
  box.appendChild(links);
  files.forEach(f => box.appendChild(fileRow({
    f, key: `${cm.sha}:${f.path}`, editorPath: "",
    gh: cm.pushed && gh && f.kind !== "deleted" ? `${gh}/blob/${cm.sha}/${encPath(f.path)}` : "",
    onDiff: () => api().repo_commit_diff(repoDir(S), cm.sha, f.path),
  })));
  if (!files.length) box.appendChild(el("div", "rp-dim", "No file changes (a merge)."));
  wireLinks(box);
}

// ---------- History: the branch tree ----------
const VIEW_KEYS = { names: "Branch names", remotes: "Remote branches", tags: "Tags", prs: "Pull requests", deploys: "Deploys", runs: "Actions runs" };

async function repoView(top) {
  state.repoViews = state.repoViews || {};
  if (!state.repoViews[top]) state.repoViews[top] = await api().repo_view(top);
  return state.repoViews[top];
}
async function saveView(top, patch) {
  state.repoViews[top] = await api().repo_view_save(top, { ...state.repoViews[top], ...patch });
  return state.repoViews[top];
}

function layoutGraph(commits) {
  const idx = new Map(commits.map((c, i) => [c.sha, i]));
  let lanes = [], width = 1;
  const rows = commits.map(c => {
    let col = lanes.indexOf(c.sha), fresh = false;
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; lanes[col] = c.sha; fresh = true; }
    const before = lanes.slice();
    before.forEach((s, i) => { if (s === c.sha && i !== col) lanes[i] = null; });  // branches joining here
    const ps = c.parents.filter(p => idx.has(p)), outs = [];
    lanes[col] = ps.length ? ps[0] : null;
    if (ps.length) outs.push(col);
    ps.slice(1).forEach(p => {
      let j = lanes.indexOf(p);
      if (j < 0) { j = lanes.indexOf(null); if (j < 0 || j === col) j = lanes.length; lanes[j] = p; }
      outs.push(j);
    });
    const after = lanes.slice();
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, before.length, after.length);
    return { col, fresh, before, after, outs, tail: !ps.length && c.parents.length > 0, sha: c.sha };
  });
  return { rows, width };
}

function laneSvg(r, W, step, ny, isHead) {
  const x = k => 8 + k * step, col = r.col, parts = [];
  const color = k => `var(--lane${k % 6})`;
  const ln = (k, x1, y1, x2, y2, extra = "") => parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color(k)}"${extra}/>`);
  const curve = (k, x1, y1, x2, y2) => parts.push(`<path d="M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}" stroke="${color(k)}" fill="none"/>`);
  r.before.forEach((s, k) => {
    if (s == null) return;
    if (k === col) { if (!r.fresh) ln(k, x(k), 0, x(k), ny); }
    else if (s === r.sha) curve(k, x(k), 0, x(col), ny);
    else ln(k, x(k), 0, x(k), "100%");
  });
  r.outs.forEach(j => {
    if (j === col) ln(col, x(col), ny, x(col), "100%");
    else {
      curve(j, x(col), ny, x(j), ny + 14);
      if (r.before[j] == null || r.before[j] === r.sha) ln(j, x(j), ny + 14, x(j), "100%");
    }
  });
  if (r.tail) ln(col, x(col), ny, x(col), "100%", ` stroke-dasharray="2 3" opacity=".6"`);
  parts.push(isHead ? `<circle cx="${x(col)}" cy="${ny}" r="4.5" fill="var(--side-bg)" stroke="${color(col)}" stroke-width="2.5"/>`
    : `<circle cx="${x(col)}" cy="${ny}" r="4" fill="${color(col)}"/>`);
  return `<svg class="lanes" width="${W}" height="100%">${parts.join("")}</svg>`;
}
function laneContinue(after, W, step) {
  const lines = after.map((s, k) => s == null ? "" : `<line x1="${8 + k * step}" y1="0" x2="${8 + k * step}" y2="100%" stroke="var(--lane${k % 6})"/>`).join("");
  return `<svg class="lanes" width="${W}" height="100%">${lines}</svg>`;
}

// PRs, runs and deploys, attached to the commit they belong to.
function placeMarks(commits, m, view) {
  const by = new Map(), shas = new Set(commits.map(c => c.sha));
  const add = (sha, html) => { if (!by.has(sha)) by.set(sha, []); by.get(sha).push(html); };
  const dot = cls => `<i class="md ${cls}"></i>`;
  if (view.prs) (m.prs || []).forEach(p => {
    const sha = shas.has(p.merge) ? p.merge : shas.has(p.head) ? p.head : "";
    if (!sha) return;
    const cls = { open: "ok", merged: "accent", draft: "dim", closed: "dim" }[p.state] || "dim";
    add(sha, linkTo(p.url, `${dot(cls)}PR #${p.number} ${p.state}`, `${p.title} · ${p.branch} → ${p.base}`));
  });
  if (view.runs) {
    const hidden = new Set(view.hide_workflows || []), seen = new Set();
    (m.runs || []).forEach(r => {
      if (!shas.has(r.sha) || hidden.has(r.workflow) || seen.has(r.sha + r.workflow)) return;
      seen.add(r.sha + r.workflow);  // newest run per workflow and commit
      const cls = r.state === "success" ? "ok" : ["failure", "cancelled", "timed_out", "startup_failure"].includes(r.state) ? "bad" : "warn";
      const word = { success: "passed", failure: "failed", cancelled: "cancelled" }[r.state] || r.state.replace(/_/g, " ");
      add(r.sha, linkTo(r.url, `${dot(cls)}${esc(r.workflow)} ${esc(word)}`, `${r.title} · ${isoAgo(r.at)} ago`));
    });
  }
  if (view.deploys) {
    // Databricks deploys come from the working copy, so they're placed by time: the newest commit on this branch
    // made before the deploy.
    const head = commits.find(c => c.refs.some(r => r.kind === "head")) || commits[0];
    const chain = [], bySha = new Map(commits.map(c => [c.sha, c]));
    for (let c = head; c; c = bySha.get(c.parents[0])) chain.push(c);
    const groups = new Map();
    (m.deploys || []).forEach(d => {
      let sha = d.sha && shas.has(d.sha) ? d.sha : "";
      if (!sha && d.tag) sha = (commits.find(c => c.refs.some(r => r.kind === "tag" && r.name === d.tag)) || {}).sha || "";
      if (!sha && d.source === "databricks" && chain.length) {
        const t = Date.parse(d.at);
        if (t < Date.parse(chain[chain.length - 1].at)) return;  // older than what's shown
        sha = (chain.find(c => Date.parse(c.at) <= t) || {}).sha || "";
      }
      if (!sha) return;
      const k = sha + "|" + d.source + "|" + d.target;
      if (!groups.has(k)) groups.set(k, { sha, list: [] });
      groups.get(k).list.push(d);
    });
    groups.forEach(({ sha, list }) => {
      list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
      const d = list[0], st = d.state || "";
      const cls = ["succeeded", "success", "published", ""].includes(st) ? "ok" : ["failed", "failure", "error"].includes(st) ? "bad" : "warn";
      const what = d.source === "release" ? `Released ${esc(d.target)}` : `Deployed ${esc(d.target)}${list.length > 1 ? ` ${list.length}×` : ""}`;
      const tip = list.map(x => `${new Date(x.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${x.state || "done"}${x.message ? " · " + x.message : ""}`).join("\n")
        + (d.source === "databricks" ? "\nFrom the working copy, so it may include changes made after this commit" : "");
      const url = d.url || (d.source === "databricks" && m.host ? `${m.host.replace(/\/$/, "")}/apps/${encodeURIComponent(d.target)}` : "");
      add(sha, url ? linkTo(url, `${dot(cls)}${what}`, tip) : `<span class="rp-m" title="${esc(tip)}">${dot(cls)}${what}</span>`);
    });
  }
  return by;
}

async function renderHistory(S, body, fresh) {
  const st = state.repo.status;
  if (!st?.git) return;
  const top = st.root, view = await repoView(top);
  state.histOpen = state.histOpen || new Set();
  const g = await api().repo_graph(repoDir(S), view.scope, view.count);
  if (state.active !== S.sid || state.tab !== "history" || !state.panel) return;
  state.repo.marks = state.repo.marks?.root === top && !fresh ? state.repo.marks : { root: top };
  draw();
  const m = await api().repo_marks(repoDir(S), view);
  if (state.active !== S.sid || state.tab !== "history") return;
  state.repo.marks = { root: top, ...m };
  draw();

  function draw() {
    const m = state.repo.marks, gh = g.github;
    const scrollTop = body.scrollTop;
    body.innerHTML = "";
    body.appendChild(historyTools(S, top, view, m));
    if (!g.commits?.length) { body.appendChild(el("div", "panel-empty", "No commits yet.")); return; }
    const step = 12, { rows, width } = layoutGraph(g.commits);
    const W = 8 + Math.min(width, 12) * step;
    const ny = view.compact ? 11 : 13;
    const marks = placeMarks(g.commits, m, view);
    const list = el("div", "hist" + (view.compact ? " compact" : ""));
    list.style.setProperty("--lanes-w", W + "px");
    g.commits.forEach((c, i) => {
      const r = rows[i];
      const refs = c.refs.filter(x => x.kind === "head" || (x.kind === "local" && view.names) || (x.kind === "remote" && view.remotes) || (x.kind === "tag" && view.tags));
      const refHtml = refs.map(x => {
        const url = gh && (x.kind === "tag" ? `${gh}/releases/tag/${encPath(x.name)}` : x.kind === "remote" ? `${gh}/tree/${encPath(x.name.replace(/^[^/]+\//, ""))}` : "");
        const word = `<i class="md ${x.kind === "tag" ? "dim" : ""}" style="${x.kind === "tag" ? "" : `background: var(--lane${r.col % 6})`}"></i>${esc(x.name)}`;
        return `<span class="rp-ref ${x.kind}">${url ? linkTo(url, word) : word}</span>`;
      }).join("");
      const isHead = c.refs.some(x => x.kind === "head");
      const row = el("div", "hrow" + (state.histOpen.has(c.sha) ? " open" : ""));
      row.innerHTML = laneSvg(r, W, step, ny, isHead) +
        `<div class="hb"><div class="hs"></div><div class="hm"><span class="mono">${c.pushed && gh ? linkTo(`${gh}/commit/${c.sha}`, c.sha.slice(0, 7), "Commit on GitHub") : c.sha.slice(0, 7)}</span>` +
        `<span>${esc(c.author)}</span><span>${isoAgo(c.at)}</span>${c.pushed ? "" : `<span><i class="md warn"></i>not pushed</span>`}</div>` +
        (refHtml || marks.has(c.sha) ? `<div class="hx">${refHtml}${(marks.get(c.sha) || []).map(h => `<span class="rp-m">${h}</span>`).join("")}</div>` : "") + `</div>`;
      row.querySelector(".hs").textContent = c.subject;
      row.querySelector(".hs").title = c.subject;
      const wrap = el("div", "hwrap");
      wrap.appendChild(row);
      row.onclick = e => {
        if (e.target.closest("[data-url]")) return;
        row.classList.toggle("open");
        toggleCommit(S, wrap, { sha: c.sha, short: c.sha.slice(0, 7), subject: c.subject, pushed: c.pushed }, gh).then(() => {
          const box = wrap.querySelector(".rp-cfiles");
          if (box) box.insertAdjacentHTML("afterbegin", laneContinue(r.after, W, step));
        });
      };
      list.appendChild(wrap);
      if (state.histOpen.has(c.sha)) { state.histOpen.delete(c.sha); row.onclick({ target: row }); }
    });
    body.appendChild(list);
    if (!m.prs && !m.deploys) body.appendChild(el("div", "rp-dim rp-loading", "Loading PRs, runs and deploys…"));
    wireLinks(body);
    body.scrollTop = scrollTop;
  }
}

// Above the tree: which branches, and the View options (saved per repo).
function historyTools(S, top, view, m) {
  const box = el("div", "rp-tools");
  const scopes = [["current", "This branch"], ["local", "Local"], ["all", "All"]];
  box.innerHTML = `<div class="seg rp-scope">${scopes.map(([v, t]) => `<button data-scope="${v}" class="${view.scope === v ? "on" : ""}">${t}</button>`).join("")}</div>` +
    `<button class="btn ghost rp-viewbtn${state.histView ? " on" : ""}">View</button>`;
  box.querySelectorAll("[data-scope]").forEach(b => b.onclick = async () => { await saveView(top, { scope: b.dataset.scope }); renderPanel(); });
  box.querySelector(".rp-viewbtn").onclick = () => { state.histView = !state.histView; renderPanel(); };
  if (!state.histView) return box;
  const wrap = el("div", "rp-toolwrap");
  wrap.appendChild(box);
  const v = el("div", "rp-view");
  const workflows = [...new Set((m.runs || []).map(r => r.workflow))].sort();
  const hidden = new Set(view.hide_workflows || []);
  v.innerHTML = `<div class="rp-vrow"><span>Commits</span><div class="seg">${[30, 60, 120, 250].map(n => `<button data-count="${n}" class="${+view.count === n ? "on" : ""}">${n}</button>`).join("")}</div></div>` +
    `<div class="rp-vgrid">${Object.entries(VIEW_KEYS).map(([k, t]) => `<label><input type="checkbox" data-k="${k}"${view[k] !== false ? " checked" : ""}> ${t}</label>`).join("")}` +
    `<label><input type="checkbox" data-k="compact"${view.compact ? " checked" : ""}> Compact rows</label></div>` +
    (workflows.length ? `<div class="rp-vsub">Actions workflows</div><div class="rp-vgrid">${workflows.map(w => `<label><input type="checkbox" data-wf="${esc(w)}"${hidden.has(w) ? "" : " checked"}> ${esc(w)}</label>`).join("")}</div>` : "") +
    `<div class="rp-vsub">Databricks apps</div><input class="rp-app" type="text" placeholder="${esc((m.apps || []).join(", ") || "none found")}" value="${esc(view.app || "")}">` +
    `<div class="rp-vfoot"><a class="rp-a" data-reset>Reset to defaults</a></div>`;
  v.querySelectorAll("[data-count]").forEach(b => b.onclick = async () => { await saveView(top, { count: +b.dataset.count }); renderPanel(); });
  v.querySelectorAll("[data-k]").forEach(i => i.onchange = async () => { await saveView(top, { [i.dataset.k]: i.checked }); renderPanel(); });
  v.querySelectorAll("[data-wf]").forEach(i => i.onchange = async () => {
    const h = new Set(state.repoViews[top].hide_workflows || []);
    i.checked ? h.delete(i.dataset.wf) : h.add(i.dataset.wf);
    await saveView(top, { hide_workflows: [...h] }); renderPanel();
  });
  const app = v.querySelector(".rp-app");
  const saveApp = async () => { if (app.value.trim() !== (view.app || "")) { await saveView(top, { app: app.value.trim() }); renderPanel(true); } };
  app.onkeydown = e => { e.stopPropagation(); if (e.key === "Enter") saveApp(); };
  app.onblur = saveApp;
  v.querySelector("[data-reset]").onclick = async () => { state.repoViews[top] = await api().repo_view_save(top, {}); renderPanel(); };
  wrap.appendChild(v);
  return wrap;
}
