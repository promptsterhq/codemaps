#!/usr/bin/env bash
# End-to-end smoke test — verifies the whole local product in one run.
#   ./scripts/e2e-smoke.sh            # test against this repo
#   ./scripts/e2e-smoke.sh /path/repo # test against any TS/Python git repo
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
CLI="$ROOT/packages/cli/dist/index.js"
TARGET="${1:-$ROOT}"
PASS=0; FAIL=0

check() { # check <name> <command...>
  local name="$1"; shift
  if out=$("$@" 2>&1); then echo "  ✅ $name"; PASS=$((PASS+1));
  else echo "  ❌ $name"; echo "$out" | head -5 | sed 's/^/       /'; FAIL=$((FAIL+1)); fi
}

echo "== build =="
check "pnpm build" pnpm build

echo "== unit tests =="
check "core tests (node:test)" pnpm --filter @codemaps/core test

echo "== six lenses (CLI) against $TARGET =="
cd "$TARGET"
check "init"        node "$CLI" init --force
check "orient"      node "$CLI" orient
check "risk"        node "$CLI" risk .
check "guardrails"  node "$CLI" guardrails .
check "security"    node "$CLI" security .
check "index"       node "$CLI" index
check "locate"      node "$CLI" locate index
# impact needs a real symbol; take the top locate hit.
SYM=$(node "$CLI" locate index --json | node -e "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{const h=JSON.parse(b);console.log(h[0]?h[0].node.name:'')})")
if [ -n "$SYM" ]; then check "impact ($SYM)" node "$CLI" impact "$SYM"; else echo "  ⚠️  impact skipped (no symbol)"; fi

echo "== MCP server over stdio (all six tools) =="
MCP_OUT=$( (printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"risk","arguments":{"path":"."}}}' ; sleep 3) \
  | node "$CLI" serve 2>/dev/null \
  | node -e "let b='';process.stdin.on('data',d=>b+=d);process.stdin.on('end',()=>{
      let tools=[],callOk=false;
      for(const l of b.split('\n').filter(Boolean)){try{const m=JSON.parse(l);
        if(m.id===2)tools=m.result.tools.map(t=>t.name);
        if(m.id===3)callOk=!m.error;}catch{}}
      console.log(tools.sort().join(',')+'|'+callOk);})" )
if [ "$MCP_OUT" = "guardrails,impact,locate,orient,risk,security|true" ]; then
  echo "  ✅ MCP: six tools listed + live risk call"; PASS=$((PASS+1))
else
  echo "  ❌ MCP: got '$MCP_OUT'"; FAIL=$((FAIL+1))
fi

echo "== PreToolUse hook contract =="
HOOK_OUT=$(echo "{\"hook_event_name\":\"PreToolUse\",\"cwd\":\"$TARGET\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$TARGET/pnpm-lock.yaml\"}}" | node "$CLI" hook)
case "$HOOK_OUT" in
  *permissionDecision*deny*) echo "  ✅ hook: confirmed zone denies"; PASS=$((PASS+1));;
  *additionalContext*)       echo "  ✅ hook: advisory context (zone not confirmed here)"; PASS=$((PASS+1));;
  "")                        echo "  ✅ hook: silent allow (no guardrails on file)"; PASS=$((PASS+1));;
  *)                         echo "  ❌ hook: unexpected output: $HOOK_OUT"; FAIL=$((FAIL+1));;
esac

echo "== explorer =="
node "$CLI" explore --port 4991 >/dev/null 2>&1 &
EXP_PID=$!
sleep 2
if curl -sf http://localhost:4991/api/risk >/dev/null && curl -sf http://localhost:4991/ | grep -q Codemaps; then
  echo "  ✅ explorer serves dashboard + API"; PASS=$((PASS+1))
else
  echo "  ❌ explorer failed"; FAIL=$((FAIL+1))
fi
kill $EXP_PID 2>/dev/null

echo
echo "== RESULT: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
