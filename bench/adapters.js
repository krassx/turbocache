'use strict';
// json-fastpath-lint: allow
// One definition of "how each implementation is driven", shared by the
// single-process and cluster harnesses so they measure the same thing.
//
// The workload is objects. Who encodes them differs by mode, and that is the
// point: `bytes` has no codec, so the APPLICATION encodes - and that cost is
// charged to it, not hidden.
const v8 = require('v8');
const JSONC = { encode: JSON.stringify, decode: JSON.parse };
const V8C = { encode: v => v8.serialize(v).toString('latin1'),
              decode: s => v8.deserialize(Buffer.from(s, 'latin1')) };

const TURBO_MODES = ['bytes', 'direct', 'safe'];

function turboOpts(mode, l1MaxBytes) {
    if (mode === 'bytes') return { storage: 'bytes', l1MaxBytes };
    return { storage: mode, l1MaxBytes };
}

// `bytes` cannot take an object, so the app stringifies on the way in and parses
// on the way out. `direct` and `safe` own their codec.
function turboAdapter(mode, c) {
    if (mode !== 'bytes') return { sync: true, get: k => c.get(k), set: (k, v) => c.set(k, v) };
    return {
        sync: true,
        get: k => { const s = c.get(k); return s === undefined ? undefined : JSON.parse(s); },
        set: (k, v) => c.set(k, JSON.stringify(v))
    };
}

const bugseeAdapter = c => ({ sync: false, get: k => c.get(k), set: (k, v) => c.set(k, v) });

module.exports = { JSONC, V8C, TURBO_MODES, turboOpts, turboAdapter, bugseeAdapter };
