/**
 * Loads the ported Code.gs into a Node VM context with the Apps Script shim,
 * and lets the harness inject a schedule/leave cache snapshot directly
 * (bypassing the Sheet layer, which is not what's being verified here).
 */
const fs = require('fs');
const vm = require('vm');
const shim = require('./gas-shim.js');

const source = fs.readFileSync('/home/claude/gas/shift-board-google-workspace/Code.gs', 'utf8');

const sandbox = Object.assign({}, shim, {
  console,
  Date,
  Math,
  JSON,
  Intl,
  RegExp,
  String,
  Number,
  Object,
  Array,
  isNaN,
  parseInt,
  parseFloat
});
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'Code.gs' });

function setCache(adjustments, leaves, holidays) {
  sandbox.SCHEDULE_CACHE_SNAPSHOT = { adjustments, leaves, holidays: holidays || {} };
}

module.exports = { gas: sandbox, setCache };
