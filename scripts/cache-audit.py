#!/usr/bin/env python3
"""Auditoria de prompt cache das sessões do Pi (durable-sessions, só leitura).

Para cada chamada ao modelo lê usage (input, cacheRead, cacheWrite) e custo; detecta
"quebras" (cacheRead < 60% do contexto da chamada anterior) e atribui uma causa:
ocioso (gap > TTL), troca de modelo, compactação, mudança de seção/tools, ou
"sem causa visível" (em geral poda de contexto feita por extensão, ex. jev).
Simula o custo do lado da entrada com TTL de 5 min (atual) e de 1 h.

  python3 scripts/cache-audit.py [--days 7] [--root ~/.pi/agent/durable-sessions]

Valores em preço de API (equivalente de cota em assinatura OAuth).
"""
import argparse, collections, glob, json, os, sqlite3, time

ap = argparse.ArgumentParser()
ap.add_argument("--days", type=float, default=7)
ap.add_argument("--root", default=os.path.expanduser("~/.pi/agent/durable-sessions"))
ap.add_argument("--by-provider", action="store_true", help="quebras separadas por provider (ex.: openai-codex)")
args = ap.parse_args()

def calls_of(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = con.execute("select record from entries order by commit_seq").fetchall()
    except sqlite3.Error:
        return []
    out, between = [], collections.Counter()
    for (rec,) in rows:
        d = json.loads(rec); kind = d.get("kind")
        if kind == "pi.assistant":
            for m in d.get("model") or []:
                u = m.get("usage")
                if not u or m.get("provider") == "faux":
                    continue
                out.append(dict(model=m.get("model"), prov=m.get("provider"), u=u, t=m.get("timestamp"), between=dict(between)))
                between = collections.Counter()
        elif kind not in ("pi.tool-result", "pi.user"):
            between[kind] += 1
            if kind == "pi.system":
                for m in d.get("model") or []:
                    if m.get("toolsAdded") or m.get("toolsRemoved"): between["tools"] += 1
                    if m.get("sections"): between["sections"] += 1
    return out

def ctx_of(u): return u["input"] + u["cacheRead"] + u["cacheWrite"]
def price_in(u):
    c = u.get("cost", {})
    if u.get("cacheRead"): return c.get("cacheRead", 0) / u["cacheRead"] / 0.1
    if u.get("cacheWrite"): return c.get("cacheWrite", 0) / u["cacheWrite"] / 1.25
    if u.get("input"): return c.get("input", 0) / u["input"]
    return 0

def cause(gap, cl, prev):
    b = cl["between"]
    if cl["model"] != prev["model"]: return "troca de modelo"
    if any("compact" in k for k in b): return "compactação"
    if gap > 3600: return "ocioso > 1 h"
    if gap > 300: return "ocioso 5 min–1 h"
    if "tools" in b: return "mudança de tools"
    if "sections" in b: return "seção do prompt mudou"
    if b: return "outro: " + ",".join(sorted(b))
    return "sem causa visível (poda/edição de contexto)"

files = [f for f in glob.glob(os.path.join(args.root, "*/*/session.sqlite")) if time.time() - os.path.getmtime(f) < args.days * 86400]
total = collections.Counter(); causes = collections.defaultdict(lambda: [0, 0.0]); sim = collections.Counter()
for f in files:
    prev = None
    for cl in calls_of(f):
        u = cl["u"]; c = u.get("cost", {}); ctx = ctx_of(u)
        for k in ("input", "output", "cacheRead", "cacheWrite", "total"): total[k] += c.get(k, 0)
        if prev and prev["prov"] == cl["prov"]:
            gap = (cl["t"] - prev["t"]) / 1000 if cl["t"] and prev["t"] else 0
            p = price_in(u); pctx = ctx_of(prev["u"])
            broke = pctx > 15000 and u["cacheRead"] < 0.6 * pctx
            if broke:
                lost = pctx - u["cacheRead"]
                extra = lost * p * ((1.25 - 0.1) if cl["prov"] == "anthropic" else 0.9)
                k = cause(gap, cl, prev)
                if args.by_provider: k = f"{cl['prov']}: {k}"
                causes[k][0] += 1; causes[k][1] += extra
            if cl["prov"] == "anthropic" and cl["model"] == prev["model"] and p:
                structural = broke and gap <= 300
                pre = min(pctx, ctx)
                for pol, ttl, wmul in (("5 min", 300, 1.25), ("1 h", 3600, 2.0)):
                    cached = u["cacheRead"] if structural else (pre if gap <= ttl else 0)
                    sim[pol] += (cached * 0.1 + (ctx - cached) * wmul) * p
        prev = cl

print(f"{len(files)} sessões, últimos {args.days:g} dias")
print("custo: " + " · ".join(f"{k} ${v:,.0f}" for k, v in total.items()))
print("\nquebras de cache (custo extra estimado):")
for k, (n, v) in sorted(causes.items(), key=lambda x: -x[1][1]):
    print(f"  {k:60s} {n:5d}  ${v:8.2f}")
print(f"  {'total':45s} {sum(n for n, _ in causes.values()):5d}  ${sum(v for _, v in causes.values()):8.2f}")
print("\nsimulação Anthropic (lado da entrada): " + " · ".join(f"TTL {k}: ${v:,.0f}" for k, v in sim.items()))
