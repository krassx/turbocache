// Compact rapidhash (v1) implementation for prototyping.
// TODO(real impl): replace with the upstream rapidhash.h rather than this transcription.
#pragma once
#include <stdint.h>
#include <string.h>

static const uint64_t rapid_secret[3] = {
    0x2d358dccaa6c78a5ull, 0x8bb84b93962eacc9ull, 0x4b33a62ed433d4a3ull};

static inline void rapid_mum(uint64_t *A, uint64_t *B) {
  __uint128_t r = *A;
  r *= *B;
  *A = (uint64_t)r;
  *B = (uint64_t)(r >> 64);
}
static inline uint64_t rapid_mix(uint64_t A, uint64_t B) {
  rapid_mum(&A, &B);
  return A ^ B;
}
static inline uint64_t rapid_read64(const uint8_t *p) { uint64_t v; memcpy(&v, p, 8); return v; }
static inline uint64_t rapid_read32(const uint8_t *p) { uint32_t v; memcpy(&v, p, 4); return v; }
static inline uint64_t rapid_readSmall(const uint8_t *p, size_t k) {
  return ((uint64_t)p[0] << 56) | ((uint64_t)p[k >> 1] << 32) | p[k - 1];
}

static inline uint64_t rapidhash(const void *key, size_t len, uint64_t seed) {
  const uint8_t *p = (const uint8_t *)key;
  seed ^= rapid_mix(seed ^ rapid_secret[0], rapid_secret[1]) ^ len;
  uint64_t a = 0, b = 0;
  if (len <= 16) {
    if (len >= 4) {
      const uint8_t *plast = p + len - 4;
      a = (rapid_read32(p) << 32) | rapid_read32(plast);
      const uint64_t delta = ((len & 24) >> (len >> 3));
      b = ((rapid_read32(p + delta) << 32) | rapid_read32(plast - delta));
    } else if (len > 0) {
      a = rapid_readSmall(p, len);
    }
  } else {
    size_t i = len;
    if (i > 48) {
      uint64_t see1 = seed, see2 = seed;
      do {
        seed = rapid_mix(rapid_read64(p) ^ rapid_secret[0], rapid_read64(p + 8) ^ seed);
        see1 = rapid_mix(rapid_read64(p + 16) ^ rapid_secret[1], rapid_read64(p + 24) ^ see1);
        see2 = rapid_mix(rapid_read64(p + 32) ^ rapid_secret[2], rapid_read64(p + 40) ^ see2);
        p += 48; i -= 48;
      } while (i >= 48);
      seed ^= see1 ^ see2;
    }
    if (i > 16) {
      seed = rapid_mix(rapid_read64(p) ^ rapid_secret[2], rapid_read64(p + 8) ^ seed ^ rapid_secret[1]);
      if (i > 32) seed = rapid_mix(rapid_read64(p + 16) ^ rapid_secret[2], rapid_read64(p + 24) ^ seed);
    }
    a = rapid_read64(p + i - 16);
    b = rapid_read64(p + i - 8);
  }
  a ^= rapid_secret[1];
  b ^= seed;
  rapid_mum(&a, &b);
  return rapid_mix(a ^ rapid_secret[0] ^ len, b ^ rapid_secret[1]);
}
