"""Other models through a gateway.

When Claude Code talks to a gateway (ANTHROPIC_BASE_URL in ~/.claude/settings.json or the environment) that also
serves non-Claude models in Anthropic's format, those models work in Claude Code with --model <id>. This module
finds which ones actually answer, as cheaply as possible:

- the gateway's model list (GET /v1/models) costs nothing; it is read at most once a day
- a model is checked once, when it first appears: one request with a 1-token reply (a third of a cent at most)
- a model that failed is checked again daily; failures cost nothing (the gateway refuses before any model runs)
- a working model is not rechecked by itself: it drops out when the gateway stops listing it, or when a real
  chat is refused on it (engine reports that); Check now in Settings rechecks everything

Requests go through curl: Python's own SSL fails on networks that inspect traffic with their own certificate.
"""
from __future__ import annotations

import concurrent.futures as cf
import json
import os
import re
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path

DAY = 86400
# not chat models, or copies of one under another name
SKIP = re.compile(r"\d{4}-\d{2}-\d{2}|audio|realtime|transcribe|tts|whisper|dall-?e|sora|image|embed|search|similarity|moderation|"
                  r"^ada|^babbage|^curie|^davinci|35-turbo|instruct|canvas|computer-use|deep-research|model-router|"
                  r"-ingest$|-scout$|-router$", re.I)
MAKERS = {"openai": "OpenAI", "gpt": "OpenAI", "o1": "OpenAI", "o3": "OpenAI", "o4": "OpenAI", "moonshotai": "Moonshot",
          "zai-org": "Z.ai", "deepseek-ai": "DeepSeek", "nvidia": "NVIDIA", "meta-models": "Meta", "meta-llama": "Meta",
          "reflection": "Reflection", "mistralai": "Mistral", "qwen": "Qwen", "google": "Google", "xai": "xAI"}
HOSTS = {"azure": "Azure", "baseten-api": "Baseten", "bedrock": "Bedrock", "vertex": "Vertex", "openrouter": "OpenRouter"}
IGNORE_TOOLS = ("Your gateway may add tools named listToolFiles, readToolFile, getToolDocs and executeToolCode to "
                "your tool list. They are not available in this app: never call them. Use the tools Claude Code gives you.")


def is_other(model: str) -> bool:
    """A model id that isn't Claude: gateway ids look like 'azure/gpt-6.1-sol'."""
    m = (model or "").lower()
    return "/" in m and "claude" not in m and not m.startswith("anthropic/")


def _claude_settings() -> dict:
    try:
        return json.loads((Path.home() / ".claude" / "settings.json").read_text())
    except (OSError, ValueError):
        return {}


def base_url() -> str:
    s = _claude_settings()
    url = os.environ.get("ANTHROPIC_BASE_URL") or (s.get("env") or {}).get("ANTHROPIC_BASE_URL") or ""
    url = url.strip().rstrip("/")
    if not url or urllib.parse.urlparse(url).hostname in (None, "api.anthropic.com"):
        return ""
    return url


def host() -> str:
    return urllib.parse.urlparse(base_url()).hostname or ""


def _token() -> str:
    s = _claude_settings()
    env = {**(s.get("env") or {}), **os.environ}
    for k in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
        if env.get(k):
            return env[k]
    helper = s.get("apiKeyHelper")
    if helper:
        try:
            return subprocess.run(helper, shell=True, capture_output=True, text=True, timeout=15).stdout.strip()
        except (OSError, subprocess.SubprocessError):
            return ""
    return ""


def _curl(path: str, body: dict | None, token: str, timeout: int = 40) -> tuple[int, dict]:
    url = path if path.startswith("http") else base_url() + path
    cmd = ["curl", "-s", "-m", str(timeout), url, "-H", "Authorization: Bearer " + token,
           "-H", "x-api-key: " + token, "-H", "anthropic-version: 2023-06-01", "-w", "\n%{http_code}"]
    if body is not None:
        cmd += ["-H", "content-type: application/json", "-d", json.dumps(body)]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout + 5).stdout
    except (OSError, subprocess.SubprocessError):
        return 0, {}
    text, _, code = out.rpartition("\n")
    try:
        return int(code or 0), json.loads(text) if text.strip() else {}
    except ValueError:
        return int(code or 0) if code.isdigit() else 0, {}


def _err(d: dict) -> str:
    e = d.get("error")
    return (e.get("message") if isinstance(e, dict) else str(e or ""))[:160]


def name(mid: str) -> str:
    """'azure/gpt-6.1-sol' -> 'GPT 6.1 Sol'; 'baseten-api/moonshotai/Kimi-K3.1-Pro' -> 'Kimi K3.1 Pro'."""
    last = mid.split("/")[-1]
    words = [w for w in re.split(r"[-_\s]+", last) if w]
    out = []
    for w in words:
        if w.lower() in ("gpt", "oss"):
            out.append(w.upper())
        elif re.fullmatch(r"\d+(\.\d+)?b", w):  # 120b -> 120B
            out.append(w.upper())
        elif w.islower() and w.isalpha():
            out.append(w.capitalize())
        else:
            out.append(w)
    return " ".join(out)


def maker(mid: str) -> str:
    parts = mid.split("/")
    org = parts[1] if len(parts) > 2 else parts[-1].split("-")[0]
    return MAKERS.get(org.lower(), org[:1].upper() + org[1:])


def where(mid: str) -> str:
    first = mid.split("/")[0]
    return HOSTS.get(first.lower(), first[:1].upper() + first[1:])


def _per_m(p) -> str:
    try:
        v = float(p) * 1e6
    except (TypeError, ValueError):
        return ""
    return f"${v:.2f}".replace(".00", "") if v < 10 else f"${v:.0f}"


class OtherModels:
    """The working non-Claude models, kept in <support>/other_models.json."""

    def __init__(self, support: Path, emit):
        self.file = support / "other_models.json"
        self.emit = emit
        self.lock = threading.Lock()
        self.busy = False
        try:
            self.data = json.loads(self.file.read_text())
        except (OSError, ValueError):
            self.data = {}
        self.data.setdefault("models", {})
        self.data.setdefault("custom", [])

    def _save(self):
        tmp = self.file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, indent=1))
        tmp.replace(self.file)

    # ----- what the page shows
    def listing(self) -> dict:
        gw = base_url()
        if not gw:
            return {"on": False, "models": []}
        out = []
        for mid, m in self.data["models"].items():
            if not m.get("ok"):
                continue
            p = m.get("price") or {}
            bits = [name(mid), where(mid)]  # the menu shows what follows the name as its second line
            if p.get("prompt"):
                bits.append(f"{_per_m(p.get('prompt'))} in / {_per_m(p.get('completion'))} out per M tokens")
            else:
                bits.append("price not listed")
            if m.get("context"):
                c = m["context"]
                bits.append((f"{c / 1e6:.2f}".rstrip("0").rstrip(".") + "M" if c >= 1e6 else f"{round(c / 1000)}k") + " context")
            out.append({"value": mid, "displayName": name(mid), "group": maker(mid), "description": " · ".join(bits)})
        out.sort(key=lambda x: (x["group"].lower(), x["displayName"].lower()))
        n_checked = sum(1 for m in self.data["models"].values() if m.get("checked"))
        return {"on": True, "host": host(), "models": out, "checked_at": self.data.get("checked_at"),
                "listed_at": self.data.get("listed_at"), "tried": n_checked, "busy": self.busy}

    def price(self, mid: str) -> dict | None:
        return (self.data["models"].get(mid) or {}).get("price") or None

    # ----- checks
    def _check_one(self, mid: str, token: str) -> dict:
        code, d = _curl("/v1/messages", {"model": mid, "max_tokens": 1, "messages": [{"role": "user", "content": "ok"}]}, token)
        return {"ok": code == 200, "code": code, "err": "" if code == 200 else _err(d), "checked": time.time()}

    def refresh(self, full: bool = False) -> None:
        """Read the gateway's list (free) at most daily, then check new models and ones that failed before.
        full: recheck every model now (Settings › Check now)."""
        if not base_url() or self.busy:
            return
        if not full and time.time() - (self.data.get("listed_at") or 0) < DAY:
            return
        self.busy = True
        self.emit({"type": "other_models", **self.listing()})
        try:
            token = _token()
            if not token:
                return
            # the gateway's own list keeps provider prefixes (azure/gpt-6.1-sol), which its Anthropic path takes as
            # model ids; some gateways strip them from the list under the Anthropic path, so try the root first
            u = urllib.parse.urlparse(base_url())
            rows, code, d = None, 0, {}
            for url in (f"{u.scheme}://{u.netloc}/v1/models", base_url() + "/v1/models"):
                code, d = _curl(url, None, token, 30)
                rows = d.get("data") if isinstance(d, dict) else None
                if code == 200 and isinstance(rows, list) and any(is_other(r.get("id") or "") for r in rows):
                    break
            if code != 200 or not isinstance(rows, list):
                print(f"[models] gateway list failed: HTTP {code} {_err(d) if isinstance(d, dict) else ''}", flush=True)
                return
            listed = {}
            for r in rows:
                mid = r.get("id") or ""
                if is_other(mid) and not SKIP.search(mid.split("/", 1)[1] if "/" in mid else mid):
                    listed[mid] = r
            for mid in self.data["custom"]:
                listed.setdefault(mid, {})
            with self.lock:
                models = self.data["models"]
                for gone in [m for m in models if m not in listed]:
                    models.pop(gone)
                for mid, r in listed.items():
                    m = models.setdefault(mid, {})
                    if r.get("pricing"):
                        m["price"] = {k: r["pricing"].get(k) for k in ("prompt", "completion", "input_cache_read", "input_cache_write")}
                    if r.get("context_length"):
                        m["context"] = r["context_length"]
                todo = [mid for mid, m in models.items() if full or not m.get("checked") or not m.get("ok")]
            with cf.ThreadPoolExecutor(8) as ex:
                results = dict(zip(todo, ex.map(lambda x: self._check_one(x, token), todo)))
            with self.lock:
                for mid, res in results.items():
                    if mid in self.data["models"]:
                        self.data["models"][mid].update(res)
                self.data["listed_at"] = time.time()
                if todo:
                    self.data["checked_at"] = time.time()
                self._save()
            ok = sum(1 for r in results.values() if r["ok"])
            print(f"[models] {len(listed)} listed, checked {len(todo)}: {ok} answered", flush=True)
        finally:
            self.busy = False
            self.emit({"type": "other_models", **self.listing()})

    def refresh_later(self, full: bool = False) -> None:
        threading.Thread(target=self.refresh, args=(full,), daemon=True).start()

    def add(self, mid: str) -> dict:
        """Other model…: check a typed id once and keep it if it answers."""
        mid = (mid or "").strip()
        if not mid or not re.fullmatch(r"[\w.\-/:@\[\]]+", mid):
            return {"error": "That doesn't look like a model ID."}
        if not base_url():
            return {"error": "Claude Code isn't using a gateway, so only Claude models are available."}
        token = _token()
        res = self._check_one(mid, token) if token else {"ok": False, "code": 0, "err": "No key for the gateway."}
        if not res["ok"]:
            return {"error": f"{host()} didn't accept {mid}" + (f" ({res['code']}: {res['err']})" if res["code"] else ": no answer.")}
        with self.lock:
            self.data["models"].setdefault(mid, {}).update(res)
            if mid not in self.data["custom"]:
                self.data["custom"].append(mid)
            self._save()
        self.emit({"type": "other_models", **self.listing()})
        return {"ok": True, "value": mid, "displayName": name(mid)}

    def refused(self, mid: str, status: int, err: str = "") -> None:
        """A real chat was refused on this model: hide it until a later check finds it working again."""
        with self.lock:
            m = self.data["models"].get(mid)
            if m is None:
                return
            m.update({"ok": False, "code": status, "err": err[:160], "checked": time.time()})
            self._save()
        print(f"[models] {mid} refused in a chat ({status}); hidden", flush=True)
        self.emit({"type": "other_models", **self.listing()})

    def reprice(self, cost: dict) -> dict:
        """Claude Code guesses prices for models it doesn't know; use the gateway's listed price instead."""
        rows = cost.get("models") or []
        if not any(is_other(r.get("model") or "") for r in rows):
            return cost
        total, guessed = 0.0, []
        for r in rows:
            mid = r.get("model") or ""
            p = self.price(mid) if is_other(mid) else None
            if p and p.get("prompt"):
                f = lambda k: float(p.get(k) or 0)
                r["usd"] = ((r.get("input") or 0) * f("prompt") + (r.get("output") or 0) * f("completion")
                            + (r.get("cache_read") or 0) * (f("input_cache_read") or f("prompt"))
                            + (r.get("cache_write") or 0) * (f("input_cache_write") or f("prompt")))
            elif is_other(mid):
                guessed.append(name(mid))
            total += r.get("usd") or 0
        rows.sort(key=lambda r: -(r.get("usd") or 0))
        return {**cost, "usd": total, "models": rows, "guessed": guessed, "unknown_model_cost": False}
