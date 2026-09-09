#!/bin/bash
set -u
for m in bytes direct safe; do
  echo "############ LOAD mode=$m ############"
  MODE=$m WORKERS=4 MINUTES=${MINUTES:-7} COLD=200000 L2=$((192*1024*1024)) \
    node /app/loadtest/load.js 2>&1 | grep -vE "^  t= " || echo "  >>> $m EXITED NONZERO"
done
echo "############ DONE ############"
