// MintBoard points: every badge earns points, computed client-side from
// on-chain events. The contract never stores points — the site derives
// them from the badge events it already scans, so the scoring rules can
// change without redeploying the contract.
//
// Rules (points per badge):
//   Daily badge ......... 10
//   Quest badge ......... 50
//   Streak badge ........ 10 x tier days (3 -> 30, 7 -> 70, 14 -> 140, 30 -> 300)
//   Referral badge ...... 25 x tier count (1 -> 25, 5 -> 125, 10 -> 250, 25 -> 625)
// A ReferralRecorded event earns nothing on its own: the referrer's
// points land when they claim the referral badge, so no action is ever
// counted twice.
//
// No build step: loaded as a plain <script> before app.js, and loadable
// from Node for tests (see test/points.test.js).
(function (root) {
  "use strict";

  var RULES = {
    daily: 10,
    quest: 50,
    streakPerDay: 10,
    referralPerCount: 25,
  };

  function num(v) {
    var n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // Points for one badge. kind is "daily", "quest", "streak" or
  // "referral"; value is the tier (days for a streak badge, referral
  // count for a referral badge) and is ignored for daily/quest.
  function pointsFor(kind, value) {
    if (kind === "daily") return RULES.daily;
    if (kind === "quest") return RULES.quest;
    if (kind === "streak") return RULES.streakPerDay * num(value);
    if (kind === "referral") return RULES.referralPerCount * num(value);
    return 0;
  }

  function addTo(table, addr, kind, value) {
    var a = String(addr || "").toLowerCase();
    if (!a) return;
    var row = table[a];
    if (!row) row = table[a] = { points: 0, daily: 0, quests: 0, streaks: 0, referrals: 0, badges: 0 };
    var p = pointsFor(kind, value);
    row.points += p;
    row.badges += 1;
    if (kind === "daily") row.daily += 1;
    else if (kind === "quest") row.quests += 1;
    else if (kind === "streak") row.streaks += 1;
    else if (kind === "referral") row.referrals += 1;
  }

  // events: { mints, quests, streaks, referrals } — each a list of
  // ethers-style events ({ args: {...} }) or cached serializations
  // ({ args: {...} }) with string/number/bigint values. Returns a table
  // keyed by lowercase address: { points, daily, quests, streaks,
  // referrals, badges }.
  function compute(events) {
    var table = {};
    (events.mints || []).forEach(function (ev) {
      addTo(table, ev.args && ev.args.to, "daily");
    });
    (events.quests || []).forEach(function (ev) {
      addTo(table, ev.args && ev.args.account, "quest");
    });
    (events.streaks || []).forEach(function (ev) {
      var a = ev.args || {};
      addTo(table, a.account, "streak", a.days_ !== undefined ? a.days_ : a.days);
    });
    (events.referrals || []).forEach(function (ev) {
      var b = ev.args || {};
      addTo(table, b.account, "referral", b.count);
    });
    return table;
  }

  // Top `limit` addresses by points, then by badge count, then by
  // address (deterministic). Each row: { addr, points, daily, quests,
  // streaks, referrals, badges }.
  function rank(table, limit) {
    var rows = Object.keys(table).map(function (addr) {
      var r = table[addr];
      return {
        addr: addr,
        points: r.points,
        daily: r.daily,
        quests: r.quests,
        streaks: r.streaks,
        referrals: r.referrals,
        badges: r.badges,
      };
    });
    rows.sort(function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      if (b.badges !== a.badges) return b.badges - a.badges;
      return a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0;
    });
    return rows.slice(0, limit || 10);
  }

  // Total points awarded across all addresses.
  function total(table) {
    var sum = 0;
    Object.keys(table).forEach(function (addr) { sum += table[addr].points; });
    return sum;
  }

  var api = {
    RULES: RULES,
    pointsFor: pointsFor,
    compute: compute,
    rank: rank,
    total: total,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MintBoardPoints = api;
})(typeof window !== "undefined" ? window : globalThis);
