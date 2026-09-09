# LZ4 is OPTIONAL and off by default. Compression was measured to be a bad
# trade for this cache (2-10x slower reads, 5-27x slower writes, for ~2x
# density that a slightly larger arena buys for free), so the default build
# takes no external dependency at all and is buildable anywhere.
#
#   node-gyp configure build                      # no LZ4, no dependency
#   node-gyp configure build --turbocache_lz4=1   # link system LZ4
{
  "variables": { "turbocache_lz4%": "0" },
  "targets": [{
    "target_name": "l2",
    "sources": ["binding.cc"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
    "cflags_cc": ["-std=c++17", "-O3"],
    "xcode_settings": { "CLANG_CXX_LANGUAGE_STANDARD": "c++17", "OTHER_CFLAGS": ["-O3"] },
    "conditions": [
      ["turbocache_lz4==1", {
        "defines": ["TURBOCACHE_LZ4"],
        "include_dirs": ["<!(node find_lz4.js | cut -d'|' -f1)"],
        "libraries": ["-L<!(node find_lz4.js | cut -d'|' -f2)", "-llz4"]
      }]
    ]
  }]
}
