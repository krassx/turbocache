#!/bin/bash
# ThreadSanitizer gate for the arena's lock-free read path.
#
# TSAN cannot observe races between processes sharing an mmap, so the primary
# and workers are modelled as threads over the same code: identical atomics,
# fences and seqlock, only the isolation boundary differs.
#
# The seqlock payload copy is a DELIBERATE race: the writer memcpy's an entry
# while readers may be copying it, and the sequence check detects the torn read
# afterwards. That is the defining trick of a seqlock and it is UB by the letter
# of the C++ memory model. Rather than suppress it blindly (which would hide
# real bugs in the same functions), this asserts the SET of racing sites never
# grows. Anything new is a regression.
set -u
cd "$(dirname "$0")"
# TSAN attributes the SUMMARY to whichever thread detects the race, so the
# READER side of the deliberate payload copy shows up intermittently too.
# Naming only the writer frames made the gate flaky.
clang++ -std=c++17 -fsanitize=thread -O1 -g -o seqlock_tsan seqlock_tsan.cc || exit 1

fail=0
run() {                       # readers seconds arenaKB slots label
  TSAN_OPTIONS="halt_on_error=0 history_size=7 exitcode=0" ./seqlock_tsan "$1" "$2" "$3" "$4" >/tmp/tsan_run.out 2>&1
  printf "  %-26s\n" "$5"
  node analyze.js /tmp/tsan_run.out || fail=1
}

echo "  scenario                   result"
run 4 5 4096 16384 "steady state"
run 6 5 320  4096  "constant wrap-around"
run 8 5 256  2048  "wrap + index pressure"
run 2 5 1024 1024  "high index load factor"

# ASAN + UBSAN: different tools, different bugs. TSAN finds races; these find
# out-of-bounds, use-after-free, misaligned access and integer UB.
echo
echo "  ASan + UBSan"
clang++ -std=c++17 -fsanitize=address,undefined -fno-sanitize-recover=undefined \
        -O1 -g -o seqlock_asan seqlock_tsan.cc || exit 1
asan_run() {
  ASAN_OPTIONS="detect_leaks=0" ./seqlock_asan "$1" "$2" "$3" "$4" >/tmp/asan_run.out 2>&1
  local rc=$? corrupt reports
  corrupt=$(grep -oE 'CORRUPT=[0-9]+' /tmp/asan_run.out | cut -d= -f2)
  reports=$(grep -cE 'runtime error|AddressSanitizer' /tmp/asan_run.out)
  printf "  %-26s corrupt=%-4s sanitizer reports=%s\n" "$5" "${corrupt:-?}" "$reports"
  [ "${corrupt:-1}" != "0" ] && { echo "    FAIL: torn or wrong values"; fail=1; }
  [ "$reports" != "0" ] && { echo "    FAIL: sanitizer reports"; grep -E 'runtime error|ERROR' /tmp/asan_run.out | head -3; fail=1; }
  [ $rc -gt 1 ] && { echo "    FAIL: exited $rc"; fail=1; }
  return 0
}
asan_run 4 4 4096 16384 "steady state"
asan_run 6 4 320  4096  "constant wrap-around"
asan_run 2 4 1024 1024  "high index load factor"

[ $fail -eq 0 ] && echo "  PASS: no torn values, no unexpected race sites, no ASan/UBSan reports"
exit $fail
