#!/bin/bash
REPO=/Users/biel/Projects/agent
mkdir -p /tmp/agent-ttl; PARENT=$(mktemp -d /tmp/agent-ttl/p-XXXX)
PROF=$(NODE_OPTIONS= node $REPO/scripts/prepare-juice-test.mjs --temp-parent $PARENT | python3 -c "import sys,json; print(json.load(sys.stdin)['root'])")
SID=$(uuidgen | tr A-Z a-z); LOG=/tmp/agent-ttl/mix.jsonl; : > $LOG
LONG=$(python3 -c "print(' '.join(['contexto%d'%i for i in range(900)]))")
turn() { cd $REPO; AGENT_CKPT=$2 AGENT_TTL_LOG=$LOG AGENT_LEARN=0 AGENT_DISPATCHER=0 $PROF/launch.sh -p --session-id $SID -e $REPO/scripts/exp-cache-mix.ext.mjs --model anthropic/claude-haiku-5-5 "$3" >/dev/null 2>&1
  python3 -c "
import json; u=json.loads(open('$LOG').read().strip().split('\n')[-1]); c=u.get('cache_creation') or {}
print('$1'.ljust(40),'read',u.get('cache_read_input_tokens'),'· escrita 1h',c.get('ephemeral_1h_input_tokens'),'· escrita 5m',c.get('ephemeral_5m_input_tokens'))"; }
turn "T1 base (sys 1h, cauda 5m)"          0 "Guarde isto e responda só ok: $LONG"
turn "T2 base, imediato"                   0 "Responda só: dois. $LONG"
turn "T3 + checkpoint 1h, imediato"        1 "Responda só: tres"
echo "esperando 6 min..."; sleep 370
turn "T4 + checkpoint, após 6 min"         1 "Responda só: quatro"
