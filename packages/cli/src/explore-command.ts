/**
 * `codemaps explore` — localhost dashboard, the human trust surface (Phase 1).
 *
 * Deliberately NOT a whole-repo graph hairball (VISION §2: curated, task-scoped
 * views; §8 risk table). Three panels backed by the same engine the agents use:
 *   Risk       — sortable hotspot/bus-factor table
 *   Guardrails — zones + invariants with one-click confirm/reject (the same
 *                durable decision as `codemaps guardrails confirm`)
 *   Impact     — symbol search -> blast radius
 *
 * Zero front-end deps: one embedded HTML page + a tiny JSON API.
 */

import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  buildRiskIndex,
  decide,
  impact,
  loadCodemap,
  locate,
  resolveTarget,
  saveCodemap,
  toRiskCache,
} from "@codemaps/core";
import { loadGraph, runIndex } from "./graph-commands.js";

const execFileAsync = promisify(execFile);

export async function runExplore(args: string[]): Promise<number> {
  const portFlag = args.indexOf("--port");
  const port = portFlag >= 0 ? Number(args[portFlag + 1]) || 4177 : 4177;

  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    console.error("codemaps explore: not inside a git repository.");
    return 1;
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    try {
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGE);
      } else if (url.pathname === "/api/risk") {
        const index = await buildRiskIndex(repoRoot);
        json(res, toRiskCache(index));
      } else if (url.pathname === "/api/guardrails") {
        json(res, await loadCodemap(repoRoot));
      } else if (url.pathname === "/api/decide" && req.method === "POST") {
        const body = JSON.parse(await readBody(req)) as { id: string; status: "confirmed" | "rejected" };
        const codemap = await loadCodemap(repoRoot);
        const who = await gitUser(repoRoot);
        const result = decide(codemap, body.id, body.status, who, new Date().toISOString().slice(0, 10));
        if (typeof result === "string") return json(res, { error: result }, 400);
        await saveCodemap(repoRoot, codemap);
        json(res, result);
      } else if (url.pathname === "/api/impact") {
        const q = url.searchParams.get("symbol") ?? "";
        let graph = await loadGraph(repoRoot);
        if (!graph) {
          await runIndex();
          graph = await loadGraph(repoRoot);
        }
        if (!graph) return json(res, { error: "no graph" }, 500);
        const id = resolveTarget(graph, q);
        const result = id ? impact(graph, id) : null;
        json(res, result ?? { error: `"${q}" not found` }, result ? 200 : 404);
      } else if (url.pathname === "/api/locate") {
        const q = url.searchParams.get("q") ?? "";
        let graph = await loadGraph(repoRoot);
        if (!graph) return json(res, []);
        json(res, locate(graph, q, 15));
      } else {
        res.writeHead(404).end();
      }
    } catch (err) {
      json(res, { error: String(err) }, 500);
    }
  });

  server.listen(port, () => {
    console.log(`[codemaps] explorer at http://localhost:${port}  (ctrl-c to stop)`);
  });
  return 0;
}

function json(res: import("node:http").ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    req.on("data", (d) => (buf += d));
    req.on("end", () => resolve(buf));
  });
}

async function gitUser(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoRoot, "config", "user.name"]);
    return stdout.trim() || "unknown";
  } catch {
    return "unknown";
  }
}

const PAGE = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><title>Codemaps</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.45 -apple-system, system-ui, sans-serif; margin: 0; background: #0d1117; color: #e6edf3; }
  header { padding: 14px 22px; border-bottom: 1px solid #21262d; display: flex; gap: 14px; align-items: baseline; }
  h1 { font-size: 16px; margin: 0; } h1 span { color: #f78166; }
  main { display: grid; grid-template-columns: 1.2fr 1fr; gap: 18px; padding: 18px 22px; }
  section { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 14px 16px; }
  section.wide { grid-column: 1 / -1; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: #8b949e; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 500; cursor: pointer; }
  .pct-hi { color: #f85149; font-weight: 600; } .pct-mid { color: #d29922; } .pct-lo { color: #3fb950; }
  .mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .badge { border-radius: 10px; padding: 1px 8px; font-size: 11px; }
  .proposed { background: #1f6feb33; color: #58a6ff; } .confirmed { background: #23863633; color: #3fb950; }
  button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 2px 10px; cursor: pointer; font-size: 12px; }
  button:hover { border-color: #8b949e; }
  input { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; padding: 6px 10px; width: 320px; }
  .note { color: #8b949e; font-size: 12px; margin-top: 8px; }
</style></head>
<body>
<header><h1><span>◆</span> Codemaps</h1><div class="note">local · derived from git + code — the same answers your agent gets</div></header>
<main>
  <section>
    <h2>🔥 Risk — where is this fragile?</h2>
    <table id="risk"><thead><tr><th>file</th><th>hotspot</th><th>changes</th><th>bus</th><th>owner</th></tr></thead><tbody></tbody></table>
    <div class="note">hotspot = change-frequency × complexity, percentile within this repo · bus = authors covering >50% of changes</div>
  </section>
  <section>
    <h2>🛡️ Guardrails — what must stay true?</h2>
    <table id="rails"><thead><tr><th>guardrail</th><th>where</th><th>status</th><th></th></tr></thead><tbody></tbody></table>
    <div class="note">confirm = durable human decision, versioned in codemap/guardrails.json</div>
  </section>
  <section class="wide">
    <h2>💥 Impact — what breaks if I change this?</h2>
    <input id="q" placeholder="symbol name, e.g. buildRiskIndex" autofocus>
    <div id="impact" style="margin-top:10px"></div>
  </section>
</main>
<script>
const pctClass = p => p >= 80 ? 'pct-hi' : p >= 50 ? 'pct-mid' : 'pct-lo';
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

fetch('/api/risk').then(r => r.json()).then(d => {
  const rows = Object.entries(d.files).sort((a,b) => b[1].hotspotPercentile - a[1].hotspotPercentile).slice(0, 25);
  document.querySelector('#risk tbody').innerHTML = rows.map(([p, f]) =>
    '<tr><td class="mono">' + esc(p) + '</td><td class="' + pctClass(f.hotspotPercentile) + '">' + f.hotspotPercentile +
    '</td><td>' + f.commits + '</td><td>' + (f.busFactor === 1 ? '⚠️ 1' : f.busFactor) + '</td><td>' + esc(f.topOwner) + '</td></tr>').join('');
});

function loadRails() {
  fetch('/api/guardrails').then(r => r.json()).then(d => {
    const rows = d.guardrails.filter(g => g.status !== 'rejected')
      .sort((a,b) => (b.status === 'confirmed') - (a.status === 'confirmed') || (b.material === true) - (a.material === true)).slice(0, 30);
    document.querySelector('#rails tbody').innerHTML = rows.map(g =>
      '<tr><td>' + esc(g.statement).slice(0, 90) + '</td><td class="mono">' + esc(g.path) + (g.line ? ':' + g.line : '') +
      '</td><td><span class="badge ' + g.status + '">' + g.status + '</span></td><td>' +
      (g.status === 'proposed'
        ? '<button onclick="dec(\\''+g.id+'\\',\\'confirmed\\')">✓</button> <button onclick="dec(\\''+g.id+'\\',\\'rejected\\')">✕</button>'
        : '') + '</td></tr>').join('');
  });
}
function dec(id, status) {
  fetch('/api/decide', { method: 'POST', body: JSON.stringify({ id, status }) }).then(loadRails);
}
loadRails();

let t;
document.getElementById('q').addEventListener('input', e => {
  clearTimeout(t);
  t = setTimeout(() => {
    const q = e.target.value.trim();
    if (!q) return document.getElementById('impact').innerHTML = '';
    fetch('/api/impact?symbol=' + encodeURIComponent(q)).then(r => r.json()).then(d => {
      if (d.error) return document.getElementById('impact').innerHTML = '<div class="note">' + esc(d.error) + '</div>';
      document.getElementById('impact').innerHTML =
        '<b>' + esc(d.target.name) + '</b> <span class="mono">' + esc(d.target.loc ? d.target.loc.path + ':' + d.target.loc.startLine : '') + '</span>' +
        '<div class="note">direct ' + d.directDependents.length + ' · transitive ' + d.transitiveDependents.length +
        ' · tests ' + d.affectedTests.length + ' · confidence ' + d.confidence + ' (static floor)</div>' +
        '<table><tbody>' + d.directDependents.slice(0, 15).map(n =>
          '<tr><td>' + esc(n.name) + '</td><td class="mono">' + esc(n.loc ? n.loc.path + ':' + n.loc.startLine : '') + '</td></tr>').join('') +
        '</tbody></table>';
    });
  }, 250);
});
</script>
</body></html>`;
