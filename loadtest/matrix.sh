#!/bin/bash
# All three storage modes, both test shapes, sequentially (they share /dev/shm
# and the CPU budget, so overlapping them would measure contention).
set -u
for m in bytes direct safe; do
  echo "############ LOAD  mode=$m ############"
  MODE=$m WORKERS=4 MINUTES=${MINUTES:-6} COLD=200000 L2=$((192*1024*1024)) \
    node /app/loadtest/load.js 2>&1 | grep -vE "^  t= " || echo "  >>> LOAD $m EXITED NONZERO"
done
for m in bytes direct safe; do
  echo "############ ASYNC mode=$m ############"
  MODE=$m WORKERS=4 SECONDS=${SECONDS_PER:-45} CONC=64 COLD=200000 L2=$((192*1024*1024)) \
    node /app/loadtest/async.js 2>&1 | grep -vE "alive:" || echo "  >>> ASYNC $m EXITED NONZERO"
done
echo "############ MATRIX COMPLETE ############"
