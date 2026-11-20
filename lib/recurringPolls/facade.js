/**
 * Internal facade registry so sub-modules call overridable methods
 * (e.g. detectManualPlayerBookings, checkAndExecuteAdvanceBookings)
 * through module.exports of lib/recurringPolls/index.js when tests monkey-patch them.
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
