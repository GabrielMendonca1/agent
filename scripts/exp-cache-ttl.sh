#!/bin/bash
REPO=/Users/biel/Projects/mark-pi
mkdir -p /tmp/mark-ttl; PARENT=$(mktemp -d /tmp/mark-ttl/p-XXXX)
PROF=$(NODE_OPTIONS= node $REPO/scripts/prepare-juice-test.mjs --temp-parent $PARENT | python3 -c "import sys,json; print(json.load(sys.stdin)['root'])")
SID=$(uuidgen | tr A-Z a-z); LOG=/tmp/mark-ttl/usage.jsonl; : > $LOG
turn() { cd $REPO; MARK_TTL=$2 MARK_TTL_LOG=$LOG MARK_LEARN=0 MARK_DISPATCHER=0 $PROF/launch.sh -p --session-id $SID -e $REPO/scripts/exp-cache-ttl.ext.mjs --model anthropic/claude-haiku-5-5 "Responda só: $3" >/dev/null 2>&1
  python3 - "$1" <<'PY'
import json,sys
L=[json.loads(l) for l in open('/tmp/mark-ttl/usage.jsonl')]
u=[x for x in L if x['type']=='message_start'][-1]['u']
print(sys.argv[1].ljust(34), 'read',u.get('cache_read_input_tokens'),'write',u.get('cache_creation_input_tokens'), 'detalhe', u.get('cache_creation'))
PY
}
turn "A 5m (cria)"            5m um
turn "B 1h mesmo prefixo"     1h dois
echo "esperando 6 min (5m expira)..."; sleep 370
turn "C após 6 min, 1h"       1h tres
