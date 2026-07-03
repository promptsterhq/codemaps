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

type Command = "init" | "index" | "serve" | "explore" | "help" | "version";

function parse(argv: string[]): Command {
  const cmd = argv[2];
  switch (cmd) {
    case "init":
    case "index":
    case "serve":
    case "explore":
      return cmd;
    case "-v":
    case "--version":
    case "version":
      return "version";
    default:
      return "help";
  }
}

const HELP = `codemaps — local-first context engine for AI coding agents

Usage: codemaps <command>

  init       Index the repo, generate AGENTS.md, register the MCP server
  index      (Re)build the code graph
  serve      Start the local MCP server (agents query the six lenses)
  explore    Open the visual explorer (coming in Phase 1)
  version    Print version

Docs: https://codemaps.dev`;

function main(): void {
  const command = parse(process.argv);
  switch (command) {
    case "version":
      console.log(`codemaps ${CODEMAPS_CORE_VERSION}`);
      break;
    case "init":
    case "index":
    case "serve":
    case "explore":
      console.log(`[codemaps] "${command}" is not implemented yet (Phase 0 in progress).`);
      break;
    case "help":
      console.log(HELP);
      break;
  }
}

main();
