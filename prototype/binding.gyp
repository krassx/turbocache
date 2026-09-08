{ "targets": [{
    "target_name": "l2",
    "sources": ["binding.cc"],
    "include_dirs": ["/opt/homebrew/include"],
    "libraries": ["-L/opt/homebrew/lib", "-llz4"],
    "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
    "cflags_cc": ["-std=c++17", "-O3"],
    "xcode_settings": { "CLANG_CXX_LANGUAGE_STANDARD": "c++17", "OTHER_CFLAGS": ["-O3"] }
}]}
