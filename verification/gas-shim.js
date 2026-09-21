/**
 * Minimal Apps Script runtime shim, so the ported Code.gs can be executed in
 * Node purely to verify its CLASSIFICATION LOGIC against the Node original.
 *
 * This shims only what the pure logic touches. Anything that talks to Sprout,
 * Sheets or triggers is stubbed to throw or no-op — those paths are NOT
 * verified here and still need a live Apps Script run.
 */

function pad(n) { return n < 10 ? '0' + n : String(n); }

const Utilities = {
  formatDate(date, timeZone, format) {
    // Only the two formats the ported code actually uses.
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const y = parts.find((p) => p.type === 'year').value;
    const mo = parts.find((p) => p.type === 'month').value;
    const d = parts.find((p) => p.type === 'day').value;
    if (format === 'yyyy-MM-dd') return `${y}-${mo}-${d}`;
    throw new Error('shim: unsupported format ' + format);
  },
  sleep() {},
  computeDigest() { throw new Error('shim: not needed for logic verification'); }
};

const _props = {};
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (k in _props ? _props[k] : null),
    setProperty: (k, v) => { _props[k] = v; },
    deleteProperty: (k) => { delete _props[k]; }
  })
};

const _cache = {};
const CacheService = {
  getScriptCache: () => ({
    get: (k) => (k in _cache ? _cache[k] : null),
    getAll: (keys) => { const o = {}; keys.forEach((k) => { if (k in _cache) o[k] = _cache[k]; }); return o; },
    put: (k, v) => { _cache[k] = v; },
    putAll: (map) => { Object.assign(_cache, map); },
    remove: (k) => { delete _cache[k]; }
  })
};
// Exposed so a test can inspect or clear cache state directly — the login
// throttle stores its counters here and the tests need to age them.
CacheService.__store = _cache;

const Logger = { log: (...a) => { if (process.env.VERBOSE) console.log('[Logger]', ...a); } };
const SpreadsheetApp = { create: () => { throw new Error('shim: Sheets not exercised'); }, openById: () => { throw new Error('shim: Sheets not exercised'); } };
const LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) };
const ScriptApp = { getProjectTriggers: () => [], newTrigger: () => { throw new Error('shim: triggers not exercised'); }, deleteTrigger: () => {} };
const ContentService = { createTextOutput: (s) => ({ setMimeType: () => s }), MimeType: { JSON: 'json' } };
const UrlFetchApp = { fetch: () => { throw new Error('shim: no live API calls in logic verification'); }, fetchAll: () => { throw new Error('shim: no live API calls'); } };

module.exports = { Utilities, PropertiesService, CacheService, Logger, SpreadsheetApp, LockService, ScriptApp, ContentService, UrlFetchApp };

// ---- additions for Auth.gs verification ----
const _crypto = require('crypto');
Utilities.computeHmacSha256Signature = function (value, key) {
  const buf = _crypto.createHmac('sha256', key).update(String(value)).digest();
  // Apps Script returns SIGNED bytes (-128..127) — reproduce that exactly,
  // so bytesToHex_'s sign handling is actually exercised.
  return Array.from(buf).map((b) => (b > 127 ? b - 256 : b));
};
let _uuidCounter = 0;
Utilities.getUuid = function () {
  _uuidCounter++;
  return _crypto.createHash('md5').update('uuid' + _uuidCounter).digest('hex')
    .replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
};
module.exports.Utilities = Utilities;
