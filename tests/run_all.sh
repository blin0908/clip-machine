#!/bin/zsh
# Every test, from fastest to slowest. Stops at the first failing stage.
#   zsh tests/run_all.sh          # unit tests + cross-platform smoke + full engine suite + Chrome web suite + workflow
#   zsh tests/run_all.sh quick    # unit tests + smoke only (~30 s)
#   zsh tests/run_all.sh all      # also Firefox and Safari's engine (slow: ~40 min)
set -e
cd "$(dirname "$0")/.."
PY=.venv/bin/python
step() { print -P "\n%F{yellow}== $1%f"; }
step "formula.json in sync";     $PY scripts/export_formula.py --check
step "server tests";             $PY -m unittest tests/test_server.py
step "engine unit tests";        $PY -m unittest tests/test_engine_units.py
step "web formula tests";        node --test tests/formula.test.mjs
step "cross-platform smoke";     $PY tests/ci_smoke.py
[[ "$1" == "quick" ]] && { print -P "\n%F{green}Quick tests passed.%f"; exit 0; }
[[ -d tests/media ]] || { step "building test media"; zsh tests/make_media.sh; }
step "engine stress (17 cases)"; $PY tests/engine_stress.py | tee tests/engine_last.log; grep -q "17/17 passed" tests/engine_last.log
cd tests
B=chrome-desktop,chrome-android
[[ "$1" == "all" ]] && B=chrome-desktop,chrome-android,firefox-desktop,webkit-desktop,webkit-iphone
step "web suite ($B)";           BROWSER=$B node web-stress.mjs | grep --line-buffered -v "^   …" | tee web-last.log; grep -q " 0 fail" web-last.log
step "web workflow ($B)";        BROWSER=$B node web-pro.mjs | tee web-pro-last.log; grep -q "all checks passed" web-pro-last.log
step "edge cases (Chrome)";       node web-edge.mjs | tee web-edge-last.log; grep -q "all checks passed" web-edge-last.log
step "desktop workspace";        node desk-pro.mjs | tee desk-pro-last.log; grep -q "all checks passed" desk-pro-last.log
step "captions in 11 scripts";   node web-scripts.mjs | tee web-scripts-last.log; grep -q "all checks passed" web-scripts-last.log
[[ "$1" == "all" ]] && { step "Safari reload → fresh tab"; node web-safari-reload.mjs | tee web-safari-last.log; grep -q "all checks passed" web-safari-last.log; }
print -P "\n%F{green}All tests passed.%f"
