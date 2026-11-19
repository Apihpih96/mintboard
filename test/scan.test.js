// Tests for frontend/scan.js: chunked + cached event scanning.
// Run: node test/scan.test.js  (no dependencies)
"use strict";

const assert = require("assert");

// localStorage stub: exercises the real storage path in scan.js.
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const scan = require("../frontend/scan.js");

function makeEvents(count, maxBlock) {
  const evs = [];
  for (let i = 0; i < count; i++) {
    evs.push({
      args: { to: "0x" + String(i % 500).padStart(40, "0"), day: BigInt(19000 + (i % 30)) },
      blockNumber: 1 + Math.floor((i * maxBlock) / count),
    });
  }
  return evs;
}

// Fake contract: queryFilter over an in-memory list, with a node-style
// block-range limit that throws when a single request spans too much.
function fakeContract(events, rangeLimit) {
  let calls = 0;
  return {
    calls: () => calls,
    async queryFilter(_filter, from, to) {
      calls++;
      if (to - from + 1 > rangeLimit) throw new Error("range too large");
      return events.filter((e) => e.blockNumber >= from && e.blockNumber <= to);
    },
  };
}

async function main() {
  // 1. Chunk math.
  assert.deepStrictEqual(scan.chunkRanges(100, 250, 100), [[100, 199], [200, 250]]);
  assert.deepStrictEqual(scan.chunkRanges(5, 4, 100), []);
  console.log("PASS 1: chunkRanges");

  // 2. Full scan over 3.5M blocks with a 10k node limit: 350 chunk calls,
  //    every event returned exactly once, ascending.
  store.clear();
  const big = makeEvents(25000, 3500000);
  const c2 = fakeContract(big, 10000);
  const r2 = await scan.fetchAllCached(c2, {}, 1, 3500000, { key: "t2", argNames: ["to", "day"] });
  assert.strictEqual(r2.events.length, 25000);
  assert.strictEqual(r2.dropped, 0);
  assert.strictEqual(c2.calls(), 350);
  for (let i = 1; i < r2.events.length; i++) {
    assert.ok(r2.events[i].blockNumber >= r2.events[i - 1].blockNumber, "ascending");
  }
  console.log("PASS 2: full 3.5M-block scan, 350 chunk calls, all 25,000 events");

  // 3. Split-on-error: node limit 2k vs 10k chunks still completes.
  store.clear();
  const c3 = fakeContract(makeEvents(5000, 1000000), 2000);
  const r3 = await scan.fetchAllCached(c3, {}, 1, 1000000, { key: "t3", argNames: ["to", "day"] });
  assert.strictEqual(r3.events.length, 5000);
  assert.ok(c3.calls() > 100, "splits happened, calls=" + c3.calls());
  console.log("PASS 3: split-on-error completes (" + c3.calls() + " calls)");

  // 4. Incremental cache: second scan only fetches new blocks.
  store.clear();
  const evs4 = makeEvents(10000, 1000000);
  const c4a = fakeContract(evs4, 10000);
  const r4a = await scan.fetchAllCached(c4a, {}, 1, 1000000, { key: "t4", argNames: ["to", "day"] });
  assert.strictEqual(r4a.events.length, 10000);
  const fresh = [];
  for (let i = 0; i < 50; i++) {
    fresh.push({ args: { to: "0x" + String(i).padStart(40, "0"), day: BigInt(19030) }, blockNumber: 1000001 + i * 100 });
  }
  const c4b = fakeContract(evs4.concat(fresh), 10000);
  const r4b = await scan.fetchAllCached(c4b, {}, 1, 1010000, { key: "t4", argNames: ["to", "day"] });
  assert.strictEqual(r4b.events.length, 10050);
  assert.strictEqual(c4b.calls(), 1, "only the new 10k chunk is fetched");
  console.log("PASS 4: repeat visit fetches only new blocks (1 call vs 100)");

  // 5. Backward scan: newest 8 with a single chunk when history is dense.
  const c5 = fakeContract(big, 10000);
  const r5 = await scan.fetchRecent(c5, {}, 1, 3500000, 8, {});
  assert.strictEqual(r5.length, 8);
  assert.strictEqual(c5.calls(), 1);
  for (let i = 1; i < r5.length; i++) {
    assert.ok(r5[i].blockNumber <= r5[i - 1].blockNumber, "newest-first");
  }
  assert.strictEqual(r5[0].blockNumber, big[big.length - 1].blockNumber);
  console.log("PASS 5: activity feed reads 1 chunk, newest-first");

  // 6. Cap: trimming keeps totals right via `dropped`.
  store.clear();
  const c6a = fakeContract(makeEvents(1000, 100000), 10000);
  const r6a = await scan.fetchAllCached(c6a, {}, 1, 100000, { key: "t6", argNames: ["to", "day"], maxEvents: 100 });
  assert.strictEqual(r6a.events.length, 1000, "first call returns complete data");
  assert.strictEqual(r6a.dropped, 0);
  const c6b = fakeContract(makeEvents(1000, 100000), 10000);
  const r6b = await scan.fetchAllCached(c6b, {}, 1, 100000, { key: "t6", argNames: ["to", "day"], maxEvents: 100 });
  assert.strictEqual(r6b.events.length, 100);
  assert.strictEqual(r6b.dropped, 900);
  assert.strictEqual(r6b.dropped + r6b.events.length, 1000, "totals stay right");
  assert.strictEqual(c6b.calls(), 0, "fully cached, no RPC calls");
  console.log("PASS 6: cap trims cache, dropped keeps totals right, 0 calls on repeat");

  // 7. Stale cache version triggers a full rescan.
  store.set("t7", JSON.stringify({ v: 999, events: [], scannedTo: 100000, dropped: 0 }));
  const c7 = fakeContract(makeEvents(100, 100000), 10000);
  const r7 = await scan.fetchAllCached(c7, {}, 1, 100000, { key: "t7", argNames: ["to", "day"] });
  assert.strictEqual(r7.events.length, 100);
  assert.strictEqual(c7.calls(), 10);
  console.log("PASS 7: stale cache version rescans fully");

  // 8. No localStorage: memory fallback, no throw.
  const saved = global.localStorage;
  delete global.localStorage;
  const c8 = fakeContract(makeEvents(50, 10000), 10000);
  const r8 = await scan.fetchAllCached(c8, {}, 1, 10000, { key: "t8", argNames: ["to", "day"] });
  assert.strictEqual(r8.events.length, 50);
  global.localStorage = saved;
  console.log("PASS 8: storage unavailable falls back to memory");

  // 9. Empty range: no calls.
  const c9 = fakeContract([], 10000);
  const r9 = await scan.fetchAllCached(c9, {}, 500, 100, { key: "t9", argNames: ["to", "day"] });
  assert.deepStrictEqual(r9, { events: [], dropped: 0 });
  assert.strictEqual(c9.calls(), 0);
  console.log("PASS 9: empty range costs 0 calls");

  console.log("\nAll scan tests pass.");
  console.log("Load story: first visit over 3.5M blocks = 350 small calls once;");
  console.log("repeat visits = ~1 call for new blocks; activity feed = 1 call;");
  console.log("fully cached repeat = 0 event calls.");
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
