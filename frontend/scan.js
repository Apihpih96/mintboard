// MintBoard event scanning: chunked, resumable, cached.
//
// The problem: the leaderboard, stats and activity feed read BadgeMinted /
// ReferralRecorded events from the deploy block. As history grows, one
// giant eth_getLogs per visitor gets slow, hits public-node range limits,
// and hammers the shared RPCs — the page itself is static files on a CDN
// and is never the bottleneck. This module fixes the chain-read side:
//   1. Chunked scans (10k blocks) with split-on-error, so a range limit
//      never fails the whole scan.
//   2. Incremental cache: each chunk is saved as it lands, so a repeat
//      visit only fetches blocks newer than the last scan, and a reload
//      mid-scan resumes instead of restarting.
//   3. Backward scans for "recent" queries, which stop as soon as enough
//      events are found instead of reading all of history.
//
// No build step: loaded as a plain <script> before app.js, and loadable
// from Node for tests (see test/scan.test.js).
(function (root) {
  "use strict";

  var VERSION = 1;
  var DEFAULT_CHUNK = 10000;
  var DEFAULT_MAX_EVENTS = 50000;

  // Storage: localStorage when available, an in-memory object otherwise
  // (private mode, file://, Node). Never throws.
  var memStore = {};
  function storeGet(key) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) return localStorage.getItem(key);
    } catch (e) { /* fall through to memory */ }
    return Object.prototype.hasOwnProperty.call(memStore, key) ? memStore[key] : null;
  }
  function storeSet(key, value) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) { localStorage.setItem(key, value); return; }
    } catch (e) { /* fall through to memory */ }
    memStore[key] = value;
  }
  function storeRemove(key) {
    try {
      if (typeof localStorage !== "undefined" && localStorage) { localStorage.removeItem(key); return; }
    } catch (e) { /* fall through to memory */ }
    delete memStore[key];
  }

  function chunkRanges(from, to, size) {
    var out = [];
    var f = from;
    while (f <= to) {
      var t = Math.min(f + size - 1, to);
      out.push([f, t]);
      f = t + 1;
    }
    return out;
  }

  function toPlain(value) {
    if (typeof value === "bigint") return value.toString();
    return value;
  }

  function serializeEvent(ev, argNames) {
    var args = {};
    for (var i = 0; i < argNames.length; i++) args[argNames[i]] = toPlain(ev.args[argNames[i]]);
    return { args: args, blockNumber: ev.blockNumber };
  }

  function readCache(key) {
    try {
      var raw = storeGet(key);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || o.v !== VERSION || !Array.isArray(o.events) || typeof o.scannedTo !== "number") return null;
      return o;
    } catch (e) { return null; }
  }

  function writeCache(key, cache) {
    try { storeSet(key, JSON.stringify(cache)); } catch (e) { /* storage full: continue uncached */ }
  }

  // One range fetch, splitting in half on failure (public nodes reject
  // ranges that are too wide). Gives up after 5 splits or tiny ranges.
  async function scanRange(contract, filter, from, to, depth) {
    try {
      return await contract.queryFilter(filter, from, to);
    } catch (e) {
      if (depth >= 5 || to - from <= 200) throw e;
      var mid = Math.floor((from + to) / 2);
      var a = await scanRange(contract, filter, from, mid, depth + 1);
      var b = await scanRange(contract, filter, mid + 1, to, depth + 1);
      return a.concat(b);
    }
  }

  // Full history, chunked + incrementally cached. Returns
  // { events, dropped }: events in ascending block order, dropped = events
  // from older loads that were trimmed by the cap (totals = dropped +
  // events.length). opts: { key, argNames, chunkSize, maxEvents }.
  async function fetchAllCached(contract, filter, startBlock, latestBlock, opts) {
    opts = opts || {};
    var key = opts.key || null;
    var argNames = opts.argNames || [];
    var chunk = opts.chunkSize || DEFAULT_CHUNK;
    var maxEvents = opts.maxEvents || DEFAULT_MAX_EVENTS;
    var cache = key ? readCache(key) : null;
    var persisted = [];
    var persistedDropped = 0;
    var scannedFrom = startBlock;
    if (cache && cache.scannedTo >= startBlock - 1) {
      persisted = cache.events;
      persistedDropped = cache.dropped || 0;
      scannedFrom = Math.max(startBlock, cache.scannedTo + 1);
    }
    var returnedDropped = persistedDropped;
    var all = persisted.map(function (s) { return { args: s.args, blockNumber: s.blockNumber }; });
    var ranges = chunkRanges(scannedFrom, latestBlock, chunk);
    for (var i = 0; i < ranges.length; i++) {
      var evs = await scanRange(contract, filter, ranges[i][0], ranges[i][1], 0);
      for (var j = 0; j < evs.length; j++) all.push(evs[j]);
      if (key) {
        for (var k = 0; k < evs.length; k++) persisted.push(serializeEvent(evs[k], argNames));
        if (persisted.length > maxEvents) {
          persistedDropped += persisted.length - maxEvents;
          persisted = persisted.slice(persisted.length - maxEvents);
        }
        // Persist every 10th chunk and on the last one: each write
        // re-serializes the whole list, so writing per chunk is O(n^2).
        if (i % 10 === 9 || i === ranges.length - 1) {
          writeCache(key, { v: VERSION, events: persisted, scannedTo: ranges[i][1], dropped: persistedDropped });
        }
      }
    }
    return { events: all, dropped: returnedDropped };
  }

  // Newest `limit` events, scanning backward from latestBlock and stopping
  // as soon as enough are found. Returns newest-first. No cache: it is
  // cheap (usually one chunk) and must always be fresh.
  async function fetchRecent(contract, filter, startBlock, latestBlock, limit, opts) {
    opts = opts || {};
    var chunk = opts.chunkSize || DEFAULT_CHUNK;
    var out = [];
    var to = latestBlock;
    while (to >= startBlock && out.length < limit) {
      var from = Math.max(startBlock, to - chunk + 1);
      var evs = await scanRange(contract, filter, from, to, 0);
      for (var i = evs.length - 1; i >= 0 && out.length < limit; i--) out.push(evs[i]);
      to = from - 1;
    }
    return out;
  }

  var api = {
    fetchAllCached: fetchAllCached,
    fetchRecent: fetchRecent,
    chunkRanges: chunkRanges,
    clearCache: function (key) { storeRemove(key); },
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MintBoardScan = api;
})(typeof window !== "undefined" ? window : globalThis);
