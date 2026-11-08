# goal — audit.html reference

Load only when creating or extending `<project>/.pi/goals/<id>/audit.html`.

## Rules

- **Standalone**: one file, inline CSS only. No JavaScript, no CDN, no web fonts, no external images.
- **Human summary, not thinking**: no chain-of-thought, no transcripts, no raw tool logs. One row per *material* decision or action — it changes behaviour, costs money or time, is hard to undo, or resolves an ambiguity. Routine reads, greps and formatting are not material.
- **Two writes per row**: append the row with `status=pending` *before* acting, then patch that same row's Result/Status/Time cells after verification.
- **Append-only history**: never delete or rewrite past rows. Failures, reversals and steps resumed in a later session all stay, in order.
- **Escape** `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` in every cell. Keep cells to one or two sentences.
- Update the header line (status, budgets used) in place each step; rows never move.

## Template

```html
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>goal &lt;id&gt; — audit</title>
<style>
 body{font:15px/1.5 -apple-system,Segoe UI,sans-serif;margin:2rem;max-width:60rem;color:#1b1b1b}
 h1{font-size:1.3rem;margin:0 0 .25rem}
 .meta{color:#555;font-size:.9rem;margin-bottom:1.5rem}
 table{border-collapse:collapse;width:100%}
 th,td{border:1px solid #d0d0d0;padding:.5rem .6rem;vertical-align:top;text-align:left}
 th{background:#f3f3f3;font-size:.85rem;text-transform:uppercase;letter-spacing:.03em}
 td.s{white-space:nowrap;font-weight:600}
 .pending{color:#8a6d00}.ok{color:#1d6f2a}.fail{color:#a01b1b}.blocked{color:#7a3ea1}
 tr:nth-child(even) td{background:#fafafa}
</style>
</head>
<body>
<h1>goal &lt;id&gt; — &lt;resultado em uma frase&gt;</h1>
<p class="meta">
 Done when: &lt;predicado&gt; · Verify: <code>&lt;comando&gt;</code><br>
 Status: <strong>running</strong> · Budgets: 3/10 iters · 41m/2h · stall 0 · Checkpoint: .pi/goals/&lt;id&gt;/state.md
</p>
<table>
<thead><tr><th>#</th><th>Decisão / ação</th><th>Alternativa rejeitada + motivo</th><th>Verificação</th><th>Quando</th><th>Status</th></tr></thead>
<tbody>
<!-- ROWS: append below, never reorder -->
<tr><td>1</td>
    <td>Trocar o parser para <code>fast-xml-parser</code> no módulo de import.</td>
    <td><code>xml2js</code>: sem suporte a streaming, dobraria a memória no arquivo de 200&nbsp;MB.</td>
    <td><code>npm test -- import</code>: 14/14 passam (antes 11/14).</td>
    <td>2025-06-02 14:22</td>
    <td class="s ok">ok</td></tr>
<tr><td>2</td>
    <td>Rodar a migração de índice em produção.</td>
    <td>Rodar sozinho: irreversível e fora do charter.</td>
    <td>—</td>
    <td>2025-06-02 14:40</td>
    <td class="s blocked">blocked</td></tr>
<tr><td>3</td>
    <td>Extrair <code>normalize()</code> para <code>lib/xml.ts</code>.</td>
    <td>Deixar inline: duplicaria em 3 chamadas.</td>
    <td>pendente</td>
    <td>2025-06-02 14:52</td>
    <td class="s pending">pending</td></tr>
</tbody>
</table>
</body>
</html>
```

## Row skeleton to append

```html
<tr><td>N</td><td>&lt;o que foi feito e por quê, 1–2 frases&gt;</td><td>&lt;alternativa&gt;: &lt;motivo curto&gt;</td><td>pendente</td><td>YYYY-MM-DD HH:MM</td><td class="s pending">pending</td></tr>
```

After verifying, replace only that row's last three cells: verification result, time of the result, and `class="s ok|fail|blocked"` with the matching word. A failed attempt keeps its row and gets a new row for the retry.
