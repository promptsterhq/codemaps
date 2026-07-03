/**
 * The code graph — Codemaps' deterministic, precise substrate.
 *
 * Design intent: agents need *certainty* about callers and blast radius, not the
 * "chunks that look similar" that vector embeddings return. Every node and edge
 * here is derived statically (tree-sitter / LSP) or from git history — never
 * inferred by an LLM at query time. This is the layer competitors using
 * embeddings are retreating from; it's our defensible core.
 */

/** A stable identifier for a node, e.g. `ts:src/auth/session.ts#createSession`. */
export type NodeId = string;

export type NodeKind =
  | "file"
  | "module"
  | "function"
  | "method"
  | "class"
  | "interface"
  | "variable"
  | "route" // HTTP/route handler entry point
  | "schema" // DB table / model / migration target
  | "external"; // third-party symbol we depend on but don't own

export interface SourceLocation {
  path: string; // repo-relative
  startLine: number;
  endLine: number;
}

export interface GraphNode {
  id: NodeId;
  kind: NodeKind;
  name: string;
  language: string; // "typescript" | "python" | ...
  loc?: SourceLocation;
  /** Signature only — never full bodies. Token-efficient, like aider's repo map. */
  signature?: string;
}

export type EdgeKind =
  | "imports"
  | "calls"
  | "references"
  | "implements"
  | "extends"
  | "reads" // dataflow: reads from a source (input, request, env)
  | "writes" // dataflow: writes to a sink (db, response, fs)
  | "cochange"; // derived from git: changed together without a static link

export interface GraphEdge {
  from: NodeId;
  to: NodeId;
  kind: EdgeKind;
  /** For git-derived edges (cochange): strength/confidence in [0,1]. */
  weight?: number;
}

export interface CodeGraph {
  nodes: ReadonlyMap<NodeId, GraphNode>;
  /** Forward adjacency: node -> outgoing edges. */
  outgoing(id: NodeId): readonly GraphEdge[];
  /** Reverse adjacency: node -> incoming edges. The basis of blast radius. */
  incoming(id: NodeId): readonly GraphEdge[];
}
