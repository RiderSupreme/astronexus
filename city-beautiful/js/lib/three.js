// three.js loader.
//
// The game has no build step, so the engine is pulled straight from a CDN as an
// ES module. Three mirrors are tried in order; the first that answers wins.
// Every other module imports THREE from here, so this is the only place the
// version lives.
const SOURCES = [
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.module.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js',
  'https://unpkg.com/three@0.160.0/build/three.module.min.js',
];

let mod = null;
let lastError = null;
for (const src of SOURCES) {
  try {
    mod = await import(src);
    break;
  } catch (err) {
    lastError = err;
  }
}
if (!mod) {
  throw new Error('The 3D engine could not be downloaded. Check your connection and reload. (' + (lastError && lastError.message) + ')');
}

export const THREE = mod;
export default mod;
