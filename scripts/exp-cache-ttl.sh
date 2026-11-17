#!/bin/bash
REPO=/Users/biel/Projects/agent
mkdir -p /tmp/agent-ttl; PARENT=$(mktemp -d /tmp/agent-ttl/p-XXXX)
PROF=$(NODE_OPTIONS= node $REPO/scripts/prepare-agent-test.mjs --temp-parent $PARENT | python3 -c "import sys,json; print(json.load(sys.stdin)['root'])")
SID=$(uuidgen | tr A-Z a-z); LOG=/tmp/agent-ttl/usage.jsonl; : > $LOG
turn() { cd $REPO; AGENT_TTL=$2 AGENT_TTL_LOG=$LOG AGENT_LEARN=0 AGENT_DISPATCHER=0 $PROF/launch.sh -p --session-id $SID -e $REPO/scripts/exp-cache-ttl.ext.mjs --model anthropic/claude-haiku-5-5 "Responda só: $3" >/dev/null 2>&1
  python3 - "$1" <<'PY'
import json,sys
L=[json.loads(l) for l in open('/tmp/agent-ttl/usage.jsonl')]
u=[x for x in L if x['type']=='message_start'][-1]['u']
print(sys.argv[1].ljust(34), 'read',u.get('cache_read_input_tokens'),'write',u.get('cache_creation_input_tokens'), 'detalhe', u.get('cache_creation'))
PY
}
turn "A 5m (cria)"            5m um
turn "B 1h mesmo prefixo"     1h dois
echo "esperando 6 min (5m expira)..."; sleep 370
turn "C após 6 min, 1h"       1h tres
