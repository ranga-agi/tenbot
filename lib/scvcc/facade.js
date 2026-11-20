/**
 * Internal facade registry so sub-modules call overridable methods
 * (e.g. authFetch, checkCourtAvailability, detectPrebookedCourt)
 * through module.exports of lib/scvcc/index.js when tests monkey-patch them.
 */

let target = {};

function bindTarget(obj) {
  target = obj || {};
}

function call(name, fallback) {
  return typeof target[name] === 'function' ? target[name] : fallback;
}

module.exports = {
  bindTarget,
  call
};
