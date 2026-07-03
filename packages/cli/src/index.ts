#!/usr/bin/env node
/**
 * codemaps CLI — the PLG entry point.
 *
 *   codemaps init     Index the repo, write AGENTS.md, register the MCP server.
 *   codemaps index    (Re)build the code graph into .codemaps/graph.db.
 *   codemaps serve    Start the local MCP server so agents can query the lenses.
 *   codemaps explore  Open the localhost visual explorer (Phase 1).
 *
 * Phase 0 wires `index` (tree-sitter -> SQLite), `init` (AGENTS.md generation),
 * and `serve` (MCP). Commands are stubbed here so the surface is stable first.
 */

import { CODEMAPS_CORE_VERSION } from "@codemaps/core";
import { runRisk } from "./risk-command.js";
import { runGuardrails } from "./guardrails-command.js";
import { runImpact, runIndex, runLocate } from "./graph-commands.js";
import { runInit } from "./init-command.js";
import { runHook } from "./hook-command.js";
import { runExplore } from "./explore-command.js";
import { runSecurity } from "./security-command.js";
import { runOrient } from "./orient-command.js";

type Command =
  | "risk"
  | "orient"
  | "security"
  | "guardrails"
  | "impact"
  | "locate"
  | "init"
  | "index"
  | "serve"
  | "explore"
  | "hook"
  | "help"
  | "version";

function parse(argv: string[]): { command: Command; rest: string[] } {
  const cmd = argv[2];
  const rest = argv.slice(3);
  switch (cmd) {
    case "risk":
    case "orient":
    case "security":
    case "guardrails":
    case "impact":
    case "locate":
    case "init":
    case "index":
    case "serve":
    case "explore":
    case "hook":
      return { command: cmd, rest };
    case "-v":
    case "--version":
    case "version":
      return { command: "version", rest };
    default:
      return { command: "help", rest };
  }
}

const HELP = `codemaps — local-first intent & risk layer for AI coding agents

Usage: codemaps <command>

  orient             What is this system? (components, entry points, comms)
  risk <path>        How dangerous is this code to touch? (hotspots, churn,
                     ownership, bus-factor — derived from git history)
  guardrails <path>  What must stay true here? (do-not-touch zones, invariants)
  security <path>    Security-critical surface (beta): guards, auth gates,
                     injection sinks, secrets, weak crypto
  impact <symbol>    What breaks if I change this? (reverse blast radius)
  locate <query>     Where does this concept live? (symbol/file search)
  index              (Re)build the code graph (.codemaps/graph.json)
  init               Index the repo, generate AGENTS.md, register the MCP server
  serve              Start the local MCP server (agents query the six lenses)
  explore            Open the visual explorer (coming in Phase 1)
  version            Print version

Docs: https://codemaps.dev`;

async function main(): Promise<void> {
  const { command, rest } = parse(process.argv);
  switch (command) {
    case "version":
      console.log(`codemaps ${CODEMAPS_CORE_VERSION}`);
      break;
    case "risk":
      process.exitCode = await runRisk(rest);
      break;
    case "guardrails":
      process.exitCode = await runGuardrails(rest);
      break;
    case "security":
      process.exitCode = await runSecurity(rest);
      break;
    case "orient":
      process.exitCode = await runOrient(rest);
      break;
    case "impact":
      process.exitCode = await runImpact(rest);
      break;
    case "locate":
      process.exitCode = await runLocate(rest);
      break;
    case "index":
      process.exitCode = await runIndex();
      break;
    case "init":
      process.exitCode = await runInit(rest);
      break;
    case "serve": {
      const { startServer } = await import("@codemaps/mcp");
      await startServer();
      // stdio server stays alive until the client disconnects.
      break;
    }
    case "hook":
      process.exitCode = await runHook();
      break;
    case "explore":
      process.exitCode = await runExplore(rest);
      break;
    case "help":
      console.log(HELP);
      break;
  }
}

void main();
