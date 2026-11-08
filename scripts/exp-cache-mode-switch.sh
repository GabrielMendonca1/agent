#!/bin/bash
# Experimento: trocar simple/complex no meio da sessão quebra o prompt cache? Cinco turnos curtos
# (Haiku por padrão; MODEL=provider/id para outro) numa sessão do perfil Agent temporário.
# Esperado após a fase C do plano de cache: "read" alto também nas linhas "->".

set -e
REPO=/Users/biel/Projects/agent
PARENT=$(mktemp -d /tmp/agent-cache-exp-XXXX)
PROF=$(NODE_OPTIONS= node $REPO/scripts/prepare-juice-test.mjs --temp-parent $PARENT | python3 -c "import sys,json; print(json.load(sys.stdin)['root'])")
ENVJ=$PROF/environment.json
JH=$(python3 -c "import json; print(json.load(open('$ENVJ'))['AGENT_JUICE_HOME'])")
JS=$(python3 -c "import json; print(json.load(open('$ENVJ'))['AGENT_JUICE_STATE'])")
SID=$(uuidgen | tr A-Z a-z)
MODEL=${MODEL:-anthropic/claude-haiku-5-5}
mode() { AGENT_JUICE_ENABLED=1 AGENT_JUICE_HOME="$JH" AGENT_JUICE_STATE="$JS" NODE_OPTIONS= node --input-type=module -e "import { setJuiceMode } from '$REPO/agent/juice/client.mjs'; setJuiceMode(process.argv[1]);" "$1"; }
turn() { cd $REPO; AGENT_LEARN=0 AGENT_DISPATCHER=0 $PROF/launch.sh -p --mode json --session-id $SID --model $MODEL "$2" 2>/dev/null \
  | python3 -c "
import sys,json
u=None
for l in sys.stdin:
    try: d=json.loads(l)
    except: continue
    m=d.get('message') or {}
    if d.get('type')=='message_end' and m.get('role')=='assistant' and m.get('usage'): u=m['usage']
print('$1'.ljust(26), 'in',u['input'],'read',u['cacheRead'],'write',u['cacheWrite'],'out',u['output']) if u else print('$1 sem usage')"; }
mode complex; turn "1 complex" "Responda só: um"
turn "2 complex (mesmo modo)" "Responda só: dois"
mode simple;  turn "3 -> simple" "Responda só: três"
turn "4 simple (mesmo modo)" "Responda só: quatro"
mode complex; turn "5 -> complex" "Responda só: cinco"
rm -rf $PARENT
