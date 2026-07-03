/** `codemaps orient` — lens 1: what is this system, how do its parts talk? */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { orient } from "@codemaps/core";

const execFileAsync = promisify(execFile);

export async function runOrient(args: string[]): Promise<number> {
  const json = args.includes("--json");
  let repoRoot: string;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    console.error("codemaps orient: not inside a git repository.");
    return 1;
  }

  const report = await orient(repoRoot);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log(`\n🧭 ORIENT — ${report.repoName}`);
  if (report.components.length > 0) {
    console.log(`\n   COMPONENTS:`);
    for (const c of report.components) {
      console.log(`   • ${c.name}  (${c.paths.join(", ")})${c.language ? `  [${c.language}]` : ""}`);
      if (c.responsibility) console.log(`       ${c.responsibility}`);
    }
  }
  if (report.entryPoints.length > 0) {
    console.log(`\n   ENTRY POINTS:`);
    for (const e of report.entryPoints.slice(0, 8)) console.log(`   • ${e}`);
  }
  if (report.communication.length > 0) {
    console.log(`\n   COMMUNICATION:`);
    const byStyle = new Map<string, string[]>();
    for (const c of report.communication) {
      const list = byStyle.get(c.style) ?? [];
      list.push(c.via);
      byStyle.set(c.style, list);
    }
    for (const [style, vias] of byStyle) console.log(`   • ${style}: ${vias.join(", ")}`);
  }
  console.log(`\n   [provenance: ${report.provenance} from manifests · confidence ${report.confidence}]\n`);
  return 0;
}
