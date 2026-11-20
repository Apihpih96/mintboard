// Tests for frontend/points.js: badge -> points scoring.
// Run: node test/points.test.js  (no dependencies)
"use strict";

const assert = require("assert");
const points = require("../frontend/points.js");

function ev(args) {
  return { args: args, blockNumber: 1 };
}

// --- pointsFor: one badge ---
assert.strictEqual(points.pointsFor("daily"), 10);
assert.strictEqual(points.pointsFor("quest"), 50);
assert.strictEqual(points.pointsFor("streak", 3), 30);
assert.strictEqual(points.pointsFor("streak", 7), 70);
assert.strictEqual(points.pointsFor("streak", 14), 140);
assert.strictEqual(points.pointsFor("streak", 30), 300);
assert.strictEqual(points.pointsFor("referral", 1), 25);
assert.strictEqual(points.pointsFor("referral", 5), 125);
assert.strictEqual(points.pointsFor("referral", 10), 250);
assert.strictEqual(points.pointsFor("referral", 25), 625);
assert.strictEqual(points.pointsFor("streak", "7"), 70, "string tier works");
assert.strictEqual(points.pointsFor("streak", 7n), 70, "bigint tier works");
assert.strictEqual(points.pointsFor("nope"), 0);
assert.strictEqual(points.pointsFor("streak", -3), 0);
assert.strictEqual(points.pointsFor("streak", undefined), 0);

// --- compute: mixed events, addresses normalized to lowercase ---
const A = "0xAbC0000000000000000000000000000000000001";
const B = "0xdef0000000000000000000000000000000000002";
const table = points.compute({
  mints: [ev({ to: A }), ev({ to: A }), ev({ to: B })],
  quests: [ev({ account: A })],
  streaks: [ev({ account: A, days_: 7 }), ev({ account: B, days: 3 })],
  referrals: [ev({ account: B, count: 5 })],
});
assert.strictEqual(table[A.toLowerCase()].points, 10 + 10 + 50 + 70);
assert.strictEqual(table[A.toLowerCase()].daily, 2);
assert.strictEqual(table[A.toLowerCase()].quests, 1);
assert.strictEqual(table[A.toLowerCase()].streaks, 1);
assert.strictEqual(table[A.toLowerCase()].badges, 4);
assert.strictEqual(table[B.toLowerCase()].points, 10 + 30 + 125);
assert.strictEqual(table[B.toLowerCase()].referrals, 1);
assert.strictEqual(table[B.toLowerCase()].badges, 3);
assert.strictEqual(Object.keys(table).length, 2, "no extra addresses");

// Empty input -> empty table; missing groups tolerated.
assert.deepStrictEqual(points.compute({}), {});
assert.deepStrictEqual(points.compute({ mints: [] }), {});

// A ReferralRecorded-style event is not a badge event: compute() takes
// only the four badge lists, so passing refs in as mints would be a
// caller bug — verify the referral list is the only referral input.
const refsOnly = points.compute({
  referrals: [ev({ account: A, count: 1 }), ev({ account: A, count: 1 })],
});
assert.strictEqual(refsOnly[A.toLowerCase()].points, 25 + 25);
assert.strictEqual(refsOnly[A.toLowerCase()].badges, 2);

// --- rank: points desc, then badges desc, then address asc ---
const ranked = points.rank(table, 10);
assert.strictEqual(ranked.length, 2);
assert.strictEqual(ranked[0].addr, B.toLowerCase(), "B has more points");
assert.strictEqual(ranked[0].points, 165);
assert.strictEqual(ranked[1].addr, A.toLowerCase());
assert.strictEqual(ranked[1].points, 140);
assert.strictEqual(points.rank(table, 1).length, 1, "limit respected");

const tied = points.compute({
  mints: [ev({ to: B }), ev({ to: A }), ev({ to: A })],
});
const tiedRank = points.rank(tied, 10);
assert.strictEqual(tiedRank[0].addr, A.toLowerCase(), "tie: more badges first");
assert.strictEqual(tiedRank[0].points, 20);

const exactTie = points.compute({ mints: [ev({ to: B }), ev({ to: A })] });
assert.strictEqual(points.rank(exactTie, 10)[0].addr, A.toLowerCase(), "exact tie: address asc");

// --- total ---
assert.strictEqual(points.total(table), 140 + 165);
assert.strictEqual(points.total({}), 0);

console.log("points.test.js: all assertions passed");
