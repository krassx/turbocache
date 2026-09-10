// ThreadSanitizer harness for the arena's lock-free read path.
//
// TSAN tracks happens-before WITHIN a process and cannot observe races between
// processes sharing an mmap, which is the real deployment. So the primary and
// the workers are modelled as threads over the same arena code: identical
// atomics, fences and seqlock, with only the isolation boundary changed.
#include "../store_ops.h"
#include <thread>
#include <atomic>
#include <vector>
#include <cstdio>
#include <cstring>
#include <cstdlib>

static Store g;
static std::atomic<bool> stop{false};
static std::atomic<long> reads{0}, writes{0}, corrupt{0}, misses{0};

static const int NKEYS = 400;
static const uint32_t MAXV = 900;

// value is fully determined by (key, version) so any reader can self-verify
static uint32_t makeVal(int k, uint32_t ver, uint8_t *buf) {
    uint32_t len = 40 + (ver * 137) % MAXV;
    int n = snprintf((char *)buf, len + 1, "%d#%u#", k, ver);
    for (uint32_t i = n; i < len; i++) buf[i] = 'a' + (ver % 26);
    return len;
}

static void writer() {
    uint8_t val[2048]; char key[32];
    uint32_t ver = 1;
    while (!stop.load(std::memory_order_relaxed)) {
        for (int r = 0; r < 500 && !stop.load(std::memory_order_relaxed); r++) {
            int k = rand() % NKEYS;
            int klen = snprintf(key, sizeof(key), "k%d", k);
            uint32_t len = makeVal(k, ver, val);
            storeSet(g, (const uint8_t *)key, (uint16_t)klen, val, len, len,
                     FLAG_STRING | FLAG_LATIN1, 0, 0);
            ver++; writes.fetch_add(1, std::memory_order_relaxed);
        }
    }
}

static void reader(int id) {
    uint8_t scratch[4096]; char key[32];
    unsigned seed = 1234 + id;
    while (!stop.load(std::memory_order_relaxed)) {
        for (int r = 0; r < 500 && !stop.load(std::memory_order_relaxed); r++) {
            int k = rand_r(&seed) % NKEYS;
            int klen = snprintf(key, sizeof(key), "k%d", k);
            ReadResult rr;
            if (!storeGet(g, (const uint8_t *)key, (uint16_t)klen, scratch, sizeof(scratch),
                          &rr, 0)) { misses.fetch_add(1, std::memory_order_relaxed); continue; }
            reads.fetch_add(1, std::memory_order_relaxed);
            // verify the bytes are internally consistent: "<key>#<ver>#" then
            // (len - header) copies of a character determined by ver
            char *p = (char *)rr.buf;
            char *h1 = (char *)memchr(p, '#', rr.rawLen);
            char *h2 = h1 ? (char *)memchr(h1 + 1, '#', rr.rawLen - (h1 - p) - 1) : nullptr;
            if (!h1 || !h2) { corrupt.fetch_add(1, std::memory_order_relaxed); continue; }
            uint32_t ver = (uint32_t)strtoul(h1 + 1, nullptr, 10);
            uint32_t want = 40 + (ver * 137) % MAXV;
            char fill = 'a' + (ver % 26);
            bool bad = (rr.rawLen != want);
            for (uint32_t i = (uint32_t)(h2 - p) + 1; !bad && i < rr.rawLen; i++)
                if (p[i] != fill) bad = true;
            if (bad) corrupt.fetch_add(1, std::memory_order_relaxed);
        }
    }
}

int main(int argc, char **argv) {
    int nreaders = argc > 1 ? atoi(argv[1]) : 4;
    int seconds  = argc > 2 ? atoi(argv[2]) : 5;
    int arenaKB  = argc > 3 ? atoi(argv[3]) : 4096;
    int slots    = argc > 4 ? atoi(argv[4]) : (1 << 14);
    char name[64]; snprintf(name, sizeof(name), "/tctsan%d", (int)getpid());
    if (!g.create(name, (uint64_t)arenaKB << 10, (uint64_t)slots, MODE_LOG2)) { printf("create failed\n"); return 1; }

    std::thread w(writer);
    std::vector<std::thread> rs;
    for (int i = 0; i < nreaders; i++) rs.emplace_back(reader, i);
    std::this_thread::sleep_for(std::chrono::seconds(seconds));
    stop.store(true);
    w.join(); for (auto &t : rs) t.join();

    // The deliberate race lives inside the arena's DATA region and nowhere
    // else. Publishing the range lets the analyser judge by address rather than
    // by function name, which inlining makes unreliable.
    printf("ARENA_DATA %p %p\n", (void *)g.data, (void *)(g.data + g.h->dataBytes));
    printf("  1 writer + %d readers, %ds: %ld writes, %ld reads, %ld misses, CORRUPT=%ld\n",
           nreaders, seconds, writes.load(), reads.load(), misses.load(), corrupt.load());
    g.destroy();
    return corrupt.load() ? 1 : 0;
}
