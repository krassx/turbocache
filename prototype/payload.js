// Realistic-entropy cache payloads: JSON-ish records with random field values.
// Compresses ~40-65%, unlike 'x'.repeat(n) which compresses to nothing.
let seed = 12345;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
const WORDS = ['alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliet',
  'kilo','lima','mike','november','oscar','papa','quebec','romeo','sierra','tango'];
function tok() { return WORDS[(rnd()*WORDS.length)|0] + ((rnd()*100000)|0); }
function makePayload(targetBytes) {
  let s = '{"id":"' + tok() + '","ts":' + Date.now() + ',"items":[';
  const parts = [];
  while (s.length + parts.join(',').length < targetBytes - 40)
    parts.push(`{"k":"${tok()}","v":${(rnd()*1e6)|0},"tag":"${tok()}"}`);
  s += parts.join(',') + ']}';
  return s.slice(0, targetBytes).padEnd(targetBytes, ' ');
}
module.exports = { makePayload, rnd };
