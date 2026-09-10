// Native-layer regressions found by adversarial review: TTL across the uint32
// epoch wrap, and the log's wrap gap.
//
// expiresAt is a uint32 count of milliseconds since the arena was created, so it
// wraps at 49.7 days of primary uptime. A plain `exp <= now` compare is wrong
// across that boundary: an entry whose expiry crosses 2^32 gets a small `exp`
// while `now` is still large, so it reads as already expired and is dead on
// arrival for the entire length of its TTL.
#include "store.h"
#include "store_ops.h"
#include <stdio.h>
#include <vector>

static int fails = 0;
static void ok(bool c, const char* m) { printf("  %s  %s\n", c ? "ok  " : "FAIL", m); if (!c) fails++; }

int main() {
  const char* NM = "/tcexpirytest";
  shmUnlink(NM);
  Store s;
  if (!s.create(NM, 8u << 20, 1u << 12, MODE_LOG2)) { printf("  create failed\n"); return 1; }

  struct Case { const char* label; uint64_t uptime; };
  Case cases[] = {
    {"fresh arena",             0},
    {"1s before the wrap",      0xFFFFFFFFull - 1000},
    {"just after the wrap",     0x100000000ull + 500},
    {"mid-range",               0x80000000ull},
  };
  const uint32_t TTL = 5000;
  for (auto& c : cases) {
    // epochTicksNs, not epochMs: the arena epoch is on the tick clock now.
    s.h->epochTicksNs = ticksNs() - c.uptime * 1000000ull;
    uint32_t now = nowRelMs(s);
    uint32_t exp = now + TTL;
    char m[160];
    snprintf(m, sizeof m, "%s: live now, live just before expiry, dead just after", c.label);
    ok(!tcExpired(exp, now) && !tcExpired(exp, now + TTL - 100) && tcExpired(exp, now + TTL + 100), m);
  }

  // 0 always means "no expiry", at every point in the cycle.
  ok(!tcExpired(0, 0) && !tcExpired(0, 0xFFFFFFFFu) && !tcExpired(0, 0x80000000u),
     "expiresAt 0 is immortal regardless of the clock");

  // The naive predicate this replaced gets the wrap case wrong. Asserting that
  // keeps the test honest about what it is protecting.
  {
    uint32_t now = 0xFFFFFFFFu - 1000, exp = now + TTL;   // wraps to 3999
    bool naiveSaysExpired = (exp != 0 && exp <= now);
    ok(naiveSaysExpired && !tcExpired(exp, now),
       "the naive `exp <= now` compare fails here; the wrap-aware one does not");
  }


  // The log's wrap gap. Records are 8-aligned but the Entry header is 40 bytes,
  // so a wrap can leave 8/16/24/32 bytes -- too little for the pad header that
  // used to be written there, which overran the data region by up to 32 bytes
  // and made the tail walk read blockSize from outside it. The gap is implicit
  // now; both the allocator and the tail walk derive it from the same rule.
  {
    const uint64_t D = s.h->dataBytes;
    uint8_t* past = s.data + D;
    memset(past, 0xAB, 64);                       // canary just past the region
    std::vector<uint8_t> val(200, 'v');
    char key[48];
    uint64_t minRemain = D;
    for (uint32_t i = 0; i < 200000; i++) {
      int kl = snprintf(key, sizeof key, "k%u", i);
      int want = 1 + (int)(i % 33);
      for (int j = kl; j < want; j++) key[j] = 'p';
      if (kl < want) kl = want;
      storeSet(s, (const uint8_t*)key, (uint16_t)kl, val.data(),
               (uint32_t)(i % 180), (uint32_t)(i % 180), FLAG_STRING, 0, 0, 0);
      uint64_t remain = D - (s.h->logHead & (D - 1));
      if (remain < minRemain) minRemain = remain;
    }
    int dirty = 0;
    for (int i = 0; i < 64; i++) if (past[i] != 0xAB) dirty++;
    ok(minRemain < sizeof(Entry), "the sub-header wrap remainder is actually exercised");
    ok(dirty == 0, "nothing is written past the data region across 200k wrapping writes");

    storeSet(s, (const uint8_t*)"final", 5, (const uint8_t*)"ok", 2, 2, FLAG_STRING, 0, 0, 0);
    ReadResult rr; uint8_t buf[64];
    ok(storeGet(s, (const uint8_t*)"final", 5, buf, sizeof buf, &rr, 0),
       "the arena still serves reads after all those wraps");
  }

  // Header geometry validation. attachReadOnly used to check only magic and
  // layout, then bind() computed pointers and masks straight from fields it had
  // never validated -- indexSlots 0 gives a probe mask of 2^64-1. The window
  // where that mattered was masked by an accident (create() published magic
  // first, but the hints segment did not exist yet, so the attach was refused
  // for an unrelated reason). magic is now published LAST with a release store,
  // and the geometry is checked against the mapping we actually got. Testing the
  // predicate directly, because going through attachReadOnly conflates this with
  // whether the hints segment happens to exist.
  {
    alignas(64) unsigned char raw[sizeof(Header)];
    memcpy(raw, s.base, sizeof(Header));            // a known-good header
    Header *g0 = (Header *)raw;
    const uint64_t mapBytes = s.mapBytes;
    ok(Store::geometryOk(g0, mapBytes), "a real header passes validation");

    struct C { const char *name; void (*bend)(Header *); };
    C cases[] = {
      {"indexSlots = 0",          [](Header *h){ h->indexSlots = 0; }},
      {"indexSlots not pow2",     [](Header *h){ h->indexSlots = 4095; }},
      {"dataBytes not pow2",      [](Header *h){ h->dataBytes = 12345; }},
      {"dataOff + dataBytes > T", [](Header *h){ h->dataBytes = h->totalBytes; }},
      {"indexOff inside header",  [](Header *h){ h->indexOff = 8; }},
      {"ringOff overlaps index",  [](Header *h){ h->ringOff = h->indexOff; }},
      {"hintsBytes < indexSlots", [](Header *h){ h->hintsBytes = 8; }},
      {"totalBytes > mapping",    [](Header *h){ h->totalBytes = h->totalBytes * 4; }},
      {"mode out of range",       [](Header *h){ h->mode = 9; }},
      {"all-zero geometry",       [](Header *h){ h->indexSlots = 0; h->dataBytes = 0; h->ringCap = 0;
                                                 h->indexOff = 0; h->dataOff = 0; h->ringOff = 0; }},
    };
    int refused = 0;
    for (auto &c : cases) {
      alignas(64) unsigned char bent[sizeof(Header)];
      memcpy(bent, raw, sizeof(Header));
      c.bend((Header *)bent);
      if (!Store::geometryOk((Header *)bent, mapBytes)) refused++;
      else printf("      accepted: %s\n", c.name);
    }
    ok(refused == (int)(sizeof(cases) / sizeof(cases[0])), "every corrupted geometry is refused");
  }

  s.destroy(); shmUnlink(NM);
  printf(fails ? "\n%d FAILED\n" : "\nall passed\n", fails);
  return fails ? 1 : 0;
}
