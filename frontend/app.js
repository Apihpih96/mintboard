// MintBoard frontend logic. No build step, no tracking, no backend.
// Reads use public BSC RPCs; writes go through the user's own injected
// wallet, and the user confirms every transaction themselves.
(function () {
  "use strict";

  var BADGE_ABI = [
    "function mintDailyBadge(address referrer)",
    "function completeQuest(uint256 questId)",
    "function claimStreakBadge(uint256 days_)",
    "function claimReferralBadge(uint256 count)",
    "function canClaim(address account) view returns (bool)",
    "function currentDay() view returns (uint256)",
    "function lastClaimDay(address) view returns (uint256)",
    "function streak(address) view returns (uint256)",
    "function referredBy(address) view returns (address)",
    "function referralCount(address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function questCompleted(address,uint256) view returns (bool)",
    "function streakBadgeClaimed(address,uint256) view returns (bool)",
    "function referralBadgeClaimed(address,uint256) view returns (bool)",
    "function streakTiers(uint256) view returns (uint256)",
    "function referralTiers(uint256) view returns (uint256)",
    "function listingCount() view returns (uint256)",
    "function getListing(uint256) view returns (string title, string url, address mintContract, uint64 startTime, bool active)",
    "function questCount() view returns (uint256)",
    "function getQuest(uint256) view returns (string title, address targetContract, uint256 minBalance, bool active)",
    "function agentIDRegistry() view returns (address)",
    "function owner() view returns (address)",
    "event BadgeMinted(address indexed to, uint256 indexed tokenId, uint256 indexed day)",
    "event ReferralRecorded(address indexed referrer, address indexed referee)",
  ];
  var REGISTRY_ABI = ["function balanceOf(address) view returns (uint256)"];
  var ZERO = "0x0000000000000000000000000000000000000000";

  var readProvider = null;
  var readContract = null;
  var registry = null;
  var signer = null;
  var writeContract = null;
  var account = null;
  var chainOk = false;
  var suppressChainReload = false;
  var streakTierList = [3, 7, 14, 30];
  var referralTierList = [1, 5, 10, 25];
  var mintsPromise = null;
  var refsPromise = null;
  var latestBlockPromise = null;

  function $(id) { return document.getElementById(id); }
  function short(addr) { return addr ? addr.slice(0, 6) + "…" + addr.slice(-4) : ""; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function setStatus(msg, kind) {
    var el = $("statusLine");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
  }
  function bscscan(addr) {
    return CONFIG.bscscanBase + "/address/" + addr;
  }
  function safeHttpUrl(u) { return /^https?:\/\//i.test(u || "") ? u : null; }
  // Tiny TTL cache for slow-changing reads (board, quests, tiers). Account
  // reads stay live: they change with the user's own transactions.
  function cacheGet(key) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || Date.now() - o.t > o.ttl) return null;
      return o.v;
    } catch (e) { return null; }
  }
  function cacheSet(key, ttlMs, value) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), ttl: ttlMs, v: value })); } catch (e) { /* ignore */ }
  }
  function readCacheKey(name) {
    return "mb_read_" + CONFIG.chainId + "_" + (CONFIG.contractAddress || "").slice(2, 10).toLowerCase() + "_" + name;
  }
  async function mapBatched(list, fn, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) {
      var res = await Promise.all(list.slice(i, i + size).map(function (x) {
        return fn(x).catch(function () { return null; });
      }));
      out.push.apply(out, res);
    }
    return out;
  }
  function refParam() {
    try {
      var r = new URLSearchParams(location.search).get("ref");
      if (r && window.ethers && ethers.isAddress(r)) return ethers.getAddress(r);
    } catch (e) { /* ignore */ }
    return null;
  }

  function friendlyError(e) {
    var msg = (e && e.message) || String(e);
    if (e && (e.code === 4001 || e.code === "ACTION_REJECTED") || /user rejected|user denied/i.test(msg)) {
      return "Transaction declined in your wallet. Nothing was sent.";
    }
    var map = {
      NotAgentIDHolder: "This wallet does not hold an Agent ID, so it cannot mint badges.",
      AlreadyClaimedToday: "You already minted today. Come back tomorrow (UTC) for the next one.",
      PaymentNotAccepted: "Badges are free — this contract refuses payments.",
      QuestRequirementNotMet: "You do not hold the NFT this quest requires yet.",
      QuestAlreadyCompleted: "You already completed this quest.",
      QuestNotFound: "That quest is not available.",
      InvalidReferrer: "That referrer is not valid (referrers must hold an Agent ID and cannot be yourself).",
      InvalidTier: "That badge tier does not exist.",
      TierAlreadyClaimed: "You already claimed this badge.",
      StreakTooShort: "Your streak is not long enough for this badge yet.",
      ReferralsTooFew: "You do not have enough referrals for this badge yet.",
    };
    for (var k in map) {
      if (msg.indexOf(k) !== -1) return map[k];
    }
    if (/insufficient funds/i.test(msg)) return "Not enough BNB for gas.";
    if (/network|timeout|fetch|failed/i.test(msg)) return "Network problem talking to BNB Smart Chain. Please try again.";
    return "Something went wrong: " + msg.slice(0, 160);
  }

  async function makeReadProvider() {
    // Remember the working RPC for the session so repeat loads skip the
    // probe chain; a dead remembered URL just falls through to the list.
    var urls = CONFIG.rpcUrls.slice();
    try {
      var remembered = sessionStorage.getItem("mb_rpc");
      if (remembered && urls.indexOf(remembered) !== -1) {
        urls.splice(urls.indexOf(remembered), 1);
        urls.unshift(remembered);
      }
    } catch (e) { /* storage unavailable */ }
    for (var i = 0; i < urls.length; i++) {
      try {
        var p = new ethers.JsonRpcProvider(urls[i], CONFIG.chainId);
        await p.getBlockNumber();
        try { sessionStorage.setItem("mb_rpc", urls[i]); } catch (e) { /* ignore */ }
        return p;
      } catch (e) { /* try the next RPC */ }
    }
    throw new Error("Could not reach a BNB Smart Chain node.");
  }

  function renderListingsEmpty(msg) {
    $("listings").innerHTML = '<p class="muted">' + esc(msg) + "</p>";
  }

  async function loadBoard() {
    if (!readContract) {
      renderListingsEmpty("Listings appear here after launch.");
      return;
    }
    var key = readCacheKey("board");
    var items = cacheGet(key);
    if (!items) {
      try {
        var count = Number(await readContract.listingCount());
        var idx = [];
        for (var i = 0; i < count && i < 100; i++) idx.push(i);
        var raw = await mapBatched(idx, function (n) { return readContract.getListing(n); }, 8);
        items = raw.filter(function (l) { return l && l.active; }).map(function (l) {
          return { title: l.title, url: l.url, mintContract: l.mintContract, startTime: l.startTime.toString() };
        });
        cacheSet(key, 60000, items);
      } catch (e) {
        renderListingsEmpty("Could not load listings. Please refresh and try again.");
        return;
      }
    }
    if (!items.length) {
      renderListingsEmpty("No listings yet — check back soon.");
      return;
    }
    var html = "";
    items.forEach(function (l) {
      var starts = Number(l.startTime) * 1000;
      var tag = starts > Date.now()
        ? '<span class="tag soon">Starts ' + esc(new Date(starts).toLocaleString()) + "</span>"
        : '<span class="tag live">Live</span>';
      var target = safeHttpUrl(l.url);
      var visit = target
        ? '<a href="' + esc(target) + '" target="_blank" rel="noopener">Visit the mint</a>'
        : esc(l.url);
      html += '<div class="card">'
        + '<p class="title">' + esc(l.title) + "</p>"
        + "<p>" + tag + '<span class="tag">Verified free</span></p>'
        + "<p>" + visit
        + ' &middot; <a href="' + esc(bscscan(l.mintContract)) + '" target="_blank" rel="noopener">Contract</a></p>'
        + "</div>";
    });
    $("listings").innerHTML = html;
  }

  async function loadQuests() {
    var box = $("quests");
    if (!readContract) {
      box.innerHTML = '<p class="muted">Quests appear here after launch.</p>';
      return;
    }
    var key = readCacheKey("quests");
    var items = cacheGet(key);
    if (!items) {
      try {
        var count = Number(await readContract.questCount());
        var idx = [];
        for (var i = 0; i < count; i++) idx.push(i);
        var raw = await mapBatched(idx, function (n) { return readContract.getQuest(n); }, 8);
        items = [];
        raw.forEach(function (q, n) {
          if (q && q.active) items.push({ id: n, title: q.title, targetContract: q.targetContract, minBalance: q.minBalance.toString() });
        });
        cacheSet(key, 60000, items);
      } catch (e) {
        box.innerHTML = '<p class="muted">Could not load quests. Please refresh and try again.</p>';
        return;
      }
    }
    if (!items.length) {
      box.innerHTML = '<p class="muted">No active quests right now.</p>';
      return;
    }
    var done = {};
    if (account) {
      var flags = await mapBatched(items, function (q) { return readContract.questCompleted(account, q.id); }, 8);
      items.forEach(function (q, n) { done[q.id] = !!flags[n]; });
    }
    var html = "";
    items.forEach(function (q) {
      html += '<div class="card">'
        + '<p class="title">' + esc(q.title) + "</p>"
        + "<p>Hold at least " + esc(q.minBalance) + ' of <a href="' + esc(bscscan(q.targetContract))
        + '" target="_blank" rel="noopener">' + esc(short(q.targetContract)) + "</a> to complete this quest.</p>"
        + (done[q.id]
          ? '<p><span class="tag live">Completed</span></p>'
          : '<button class="btn small" data-quest="' + q.id + '" ' + (account && chainOk ? "" : "disabled") + ">"
            + (account ? "Complete quest" : "Connect wallet to complete") + "</button>")
        + "</div>";
    });
    box.innerHTML = html;
    box.querySelectorAll("[data-quest]").forEach(function (btn) {
      btn.addEventListener("click", function () { completeQuest(Number(btn.getAttribute("data-quest")), btn); });
    });
  }

  async function loadTiers() {
    // Tiers are fixed at deploy time, so an hour-long cache is safe.
    var cached = cacheGet(readCacheKey("tiers"));
    if (cached) {
      streakTierList = cached.s;
      referralTierList = cached.r;
      return;
    }
    try {
      var s = [];
      for (var i = 0; i < 4; i++) s.push(Number(await readContract.streakTiers(i)));
      streakTierList = s;
      var r = [];
      for (var j = 0; j < 4; j++) r.push(Number(await readContract.referralTiers(j)));
      referralTierList = r;
      cacheSet(readCacheKey("tiers"), 3600000, { s: s, r: r });
    } catch (e) { /* keep defaults */ }
  }

  async function loadAccount() {
    var card = $("accountCard");
    if (!account) {
      card.innerHTML = '<p class="muted">Connect your wallet to see your badges, streak, and referrals.</p>';
      $("mintBtn").disabled = true;
      $("mintBtn").textContent = "Connect wallet to mint";
      $("streakClaims").innerHTML = "";
      $("referralClaims").innerHTML = "";
      return;
    }
    if (!readContract) {
      var note = CONFIG.contractAddress
        ? "Could not reach BNB Smart Chain to load your account. Your wallet is connected ("
        : "The contract is not deployed yet. Your wallet is connected (";
      card.innerHTML = "<p class=\"muted\">" + note + esc(short(account)) + ").</p>";
      return;
    }
    try {
      var holds = (await registry.balanceOf(account)) > 0n;
      var can = await readContract.canClaim(account);
      var streak = await readContract.streak(account);
      var owned = await readContract.balanceOf(account);
      var refs = await readContract.referralCount(account);
      var by = await readContract.referredBy(account);
      card.innerHTML = '<p>Wallet <span class="addr">' + esc(short(account)) + "</span> — "
        + (holds ? "holds an Agent ID." : "does not hold an Agent ID.") + "</p>"
        + '<div class="kv">'
        + "<div><span class=\"label\">Badges owned</span><span class=\"value\">" + esc(owned.toString()) + "</span></div>"
        + "<div><span class=\"label\">Current streak</span><span class=\"value\">" + esc(streak.toString()) + " days</span></div>"
        + "<div><span class=\"label\">Referrals</span><span class=\"value\">" + esc(refs.toString()) + "</span></div>"
        + "<div><span class=\"label\">Referred by</span><span class=\"value\">" + (by === ZERO ? "—" : esc(short(by))) + "</span></div>"
        + "</div>";
      var mintBtn = $("mintBtn");
      if (!holds) {
        mintBtn.disabled = true;
        mintBtn.textContent = "Agent ID required";
        $("mintState").textContent = "Only wallets holding an Agent ID can mint badges.";
      } else if (!chainOk) {
        mintBtn.disabled = true;
        mintBtn.textContent = "Switch to BNB Smart Chain";
        $("mintState").textContent = "Your wallet is on the wrong network.";
      } else if (!can) {
        mintBtn.disabled = true;
        mintBtn.textContent = "Already minted today";
        $("mintState").textContent = "Come back tomorrow (UTC) to keep your streak going.";
      } else {
        mintBtn.disabled = false;
        mintBtn.textContent = "Mint today's badge (free + gas)";
        $("mintState").textContent = "Free badge. You confirm the transaction in your wallet; only gas is charged.";
      }
      // Referral link
      var link = location.origin + location.pathname + "?ref=" + account;
      $("refLink").value = link;
      $("copyRefBtn").disabled = false;
      var rp = refParam();
      $("refState").textContent = (rp && rp.toLowerCase() !== account.toLowerCase())
        ? "You arrived via " + short(rp) + " — they get referral credit when you mint your first badge."
        : "";
      // Claim buttons
      await renderClaims(holds);
    } catch (e) {
      card.innerHTML = '<p class="muted">Could not load your account. Please refresh and try again.</p>';
    }
  }

  async function renderClaims(holds) {
    var sBox = $("streakClaims");
    var rBox = $("referralClaims");
    sBox.innerHTML = "";
    rBox.innerHTML = "";
    if (!holds || !chainOk) {
      sBox.innerHTML = '<p class="muted small">Connect with an Agent ID wallet on BNB Smart Chain to claim.</p>';
      rBox.innerHTML = '<p class="muted small">Connect with an Agent ID wallet on BNB Smart Chain to claim.</p>';
      return;
    }
    for (var i = 0; i < streakTierList.length; i++) {
      (function (tier) {
        readContract.streakBadgeClaimed(account, tier).then(function (claimed) {
          var b = document.createElement("button");
          b.className = "btn small";
          b.textContent = claimed ? tier + "-day badge: claimed" : "Claim " + tier + "-day badge";
          b.disabled = claimed;
          b.addEventListener("click", function () { claimBadge("streak", tier, b); });
          sBox.appendChild(b);
        }).catch(function () { /* leave the button out on read failure */ });
      })(streakTierList[i]);
    }
    for (var j = 0; j < referralTierList.length; j++) {
      (function (tier) {
        readContract.referralBadgeClaimed(account, tier).then(function (claimed) {
          var b = document.createElement("button");
          b.className = "btn small";
          b.textContent = claimed ? tier + " referrals: claimed" : "Claim " + tier + "-referral badge";
          b.disabled = claimed;
          b.addEventListener("click", function () { claimBadge("referral", tier, b); });
          rBox.appendChild(b);
        }).catch(function () { /* leave the button out on read failure */ });
      })(referralTierList[j]);
    }
  }

  async function sendTx(label, fn, btn) {
    if (btn) btn.disabled = true;
    setStatus(label + " — confirm in your wallet…");
    var ok = false;
    try {
      var tx = await fn();
      setStatus("Transaction sent. Waiting for confirmation…");
      await tx.wait();
      setStatus(label + " confirmed.", "ok");
      ok = true;
    } catch (e) {
      setStatus(friendlyError(e), "error");
    }
    // Refresh from chain either way: on success this shows the new state,
    // on failure it restores every button to its correct enabled state.
    // Never blindly re-enable here: after a successful mint the button
    // must stay disabled until tomorrow.
    await loadAccount();
    await loadQuests();
    if (ok) {
      mintsPromise = null;
      refsPromise = null;
      latestBlockPromise = null;
      await loadStats();
      await loadActivity();
      await loadLeaderboard();
    }
  }

  function mintToday(btn) {
    var referrer = refParam();
    if (!referrer || referrer.toLowerCase() === account.toLowerCase()) referrer = ZERO;
    return sendTx("Minting today's badge", function () {
      return writeContract.mintDailyBadge(referrer);
    }, btn);
  }

  function completeQuest(id, btn) {
    return sendTx("Completing quest", function () {
      return writeContract.completeQuest(id);
    }, btn);
  }

  function claimBadge(kind, tier, btn) {
    return sendTx("Claiming badge", function () {
      return kind === "streak"
        ? writeContract.claimStreakBadge(tier)
        : writeContract.claimReferralBadge(tier);
    }, btn);
  }

  // Event history is read through MintBoardScan (scan.js): chunked,
  // resumable, incrementally cached. One giant eth_getLogs per visitor
  // would not survive real traffic once history grows. The in-memory
  // promises are invalidated after a successful transaction (see sendTx);
  // the on-disk cache stays and only new blocks are fetched.
  function fetchLatestBlock() {
    if (!latestBlockPromise) {
      latestBlockPromise = readProvider.getBlockNumber();
      latestBlockPromise.catch(function () { latestBlockPromise = null; });
    }
    return latestBlockPromise;
  }
  function eventCacheKey(name) {
    return "mb_ev_" + CONFIG.chainId + "_" + CONFIG.contractAddress.slice(2, 10).toLowerCase() + "_" + name;
  }
  function fetchMints() {
    if (!mintsPromise) {
      mintsPromise = fetchLatestBlock().then(function (latest) {
        return MintBoardScan.fetchAllCached(readContract, readContract.filters.BadgeMinted(), CONFIG.startBlock, latest, {
          key: eventCacheKey("mints"),
          argNames: ["to", "day"],
        });
      });
      mintsPromise.catch(function () { mintsPromise = null; });
    }
    return mintsPromise;
  }
  function fetchRefs() {
    if (!refsPromise) {
      refsPromise = fetchLatestBlock().then(function (latest) {
        return MintBoardScan.fetchAllCached(readContract, readContract.filters.ReferralRecorded(), CONFIG.startBlock, latest, {
          key: eventCacheKey("refs"),
          argNames: ["referrer", "referee"],
        });
      });
      refsPromise.catch(function () { refsPromise = null; });
    }
    return refsPromise;
  }

  async function loadStats() {
    if (!readContract || !CONFIG.startBlock) return; // placeholders stay
    try {
      var res = await fetchMints();
      var mints = res.events;
      var today = Number(await readContract.currentDay());
      var minters = {};
      var daysByAddr = {};
      mints.forEach(function (ev) {
        var a = ev.args.to.toLowerCase();
        minters[a] = true;
        (daysByAddr[a] = daysByAddr[a] || new Set()).add(Number(ev.args.day));
      });
      var best = 0;
      Object.keys(daysByAddr).forEach(function (a) {
        var days = daysByAddr[a];
        var d = days.has(today) ? today : today - 1;
        var s = 0;
        while (days.has(d)) { s++; d--; }
        if (s > best) best = s;
      });
      $("statBadges").textContent = res.dropped + mints.length;
      $("statMinters").textContent = Object.keys(minters).length;
      $("statStreak").textContent = best > 0 ? best + " days" : "—";
    } catch (e) { /* placeholders stay */ }
  }

  async function loadActivity() {
    var box = $("activityFeed");
    if (!readContract || !CONFIG.startBlock) return; // placeholder stays
    try {
      var latest = await fetchLatestBlock();
      var recent = await MintBoardScan.fetchRecent(readContract, readContract.filters.BadgeMinted(), CONFIG.startBlock, latest, 8, {});
      var today = Number(await readContract.currentDay());
      if (!recent.length) {
        box.innerHTML = '<li class="muted">No mints yet — be the first today.</li>';
        return;
      }
      box.innerHTML = recent.map(function (ev) {
        var d = Number(ev.args.day);
        var when = d === today ? "today" : (d === today - 1 ? "yesterday" : (today - d) + " days ago");
        return '<li><a class="addr" href="' + esc(bscscan(ev.args.to)) + '" target="_blank" rel="noopener">' + esc(short(ev.args.to)) + "</a> minted a daily badge — " + esc(when) + "</li>";
      }).join("");
    } catch (e) {
      box.innerHTML = '<li class="muted">Activity is unavailable right now.</li>';
    }
  }

  function startCountdown() {
    var el = $("statCountdown");
    function tick() {
      var now = Date.now();
      var next = (Math.floor(now / 86400000) + 1) * 86400000;
      var s = Math.max(0, Math.floor((next - now) / 1000));
      var h = Math.floor(s / 3600);
      var m = Math.floor((s % 3600) / 60);
      var sec = s % 60;
      el.textContent = (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;
    }
    tick();
    setInterval(tick, 1000);
  }

  async function loadLeaderboard() {
    var sBoard = $("streakBoard");
    var rBoard = $("referralBoard");
    if (!readContract || !CONFIG.startBlock) {
      sBoard.innerHTML = '<li class="muted">The leaderboard appears after launch.</li>';
      rBoard.innerHTML = '<li class="muted">The leaderboard appears after launch.</li>';
      return;
    }
    try {
      var today = Number(await readContract.currentDay());
      var mints = (await fetchMints()).events;
      var daysByAddr = {};
      mints.forEach(function (ev) {
        var a = ev.args.to.toLowerCase();
        var d = Number(ev.args.day);
        (daysByAddr[a] = daysByAddr[a] || new Set()).add(d);
      });
      var streaks = Object.keys(daysByAddr).map(function (a) {
        var days = daysByAddr[a];
        var streak = 0;
        var d = days.has(today) ? today : today - 1;
        while (days.has(d)) { streak++; d--; }
        return { addr: a, score: streak };
      }).filter(function (x) { return x.score > 0; })
        .sort(function (a, b) { return b.score - a.score; })
        .slice(0, 10);
      sBoard.innerHTML = streaks.length
        ? streaks.map(function (x) {
          return '<li><a class="addr" href="' + esc(bscscan(x.addr)) + '" target="_blank" rel="noopener">' + esc(short(x.addr)) + "</a> — <span class=\"score\">" + x.score + " days</span></li>";
        }).join("")
        : '<li class="muted">No streaks yet.</li>';
      var refs = (await fetchRefs()).events;
      var counts = {};
      refs.forEach(function (ev) {
        var a = ev.args.referrer.toLowerCase();
        counts[a] = (counts[a] || 0) + 1;
      });
      var top = Object.keys(counts).map(function (a) { return { addr: a, score: counts[a] }; })
        .sort(function (a, b) { return b.score - a.score; })
        .slice(0, 10);
      rBoard.innerHTML = top.length
        ? top.map(function (x) {
          return '<li><a class="addr" href="' + esc(bscscan(x.addr)) + '" target="_blank" rel="noopener">' + esc(short(x.addr)) + "</a> — <span class=\"score\">" + x.score + " referrals</span></li>";
        }).join("")
        : '<li class="muted">No referrals yet.</li>';
    } catch (e) {
      sBoard.innerHTML = '<li class="muted">Leaderboard is unavailable right now.</li>';
      rBoard.innerHTML = '<li class="muted">Leaderboard is unavailable right now.</li>';
    }
  }

  async function connect() {
    if (!window.ethereum) {
      setStatus("No wallet found. Install MetaMask or the Binance Wallet extension, then try again.", "error");
      return;
    }
    setStatus("Connecting…");
    try {
      var provider = new ethers.BrowserProvider(window.ethereum);
      var accounts = await provider.send("eth_requestAccounts", []);
      account = ethers.getAddress(accounts[0]);
      signer = await provider.getSigner();
      var net = await provider.getNetwork();
      chainOk = Number(net.chainId) === CONFIG.chainId;
      if (!chainOk && CONFIG.chainId === 56) {
        suppressChainReload = true;
        try {
          await window.ethereum.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: "0x38" }],
          });
        } catch (se) {
          if (se && se.code === 4902) {
            try {
              await window.ethereum.request({
                method: "wallet_addEthereumChain",
                params: [{
                  chainId: "0x38",
                  chainName: "BNB Smart Chain",
                  nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
                  rpcUrls: CONFIG.rpcUrls,
                  blockExplorerUrls: [CONFIG.bscscanBase],
                }],
              });
            } catch (ae) { /* user declined; chainOk stays false */ }
          }
        }
        // Fresh provider/signer: the old ones cache the previous network.
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        try {
          net = await provider.getNetwork();
          chainOk = Number(net.chainId) === CONFIG.chainId;
        } catch (e) { chainOk = false; }
        suppressChainReload = false;
      }
      // If the read provider failed at page load, retry now that the user
      // is here: reads are needed for eligibility and button states.
      if (!readContract && CONFIG.contractAddress && ethers.isAddress(CONFIG.contractAddress)) {
        try {
          readProvider = await makeReadProvider();
          readContract = new ethers.Contract(CONFIG.contractAddress, BADGE_ABI, readProvider);
          registry = new ethers.Contract(CONFIG.agentIDRegistry, REGISTRY_ABI, readProvider);
          await loadTiers();
        } catch (e) { /* reads stay unavailable; the account card explains */ }
      }
      if (readContract) writeContract = new ethers.Contract(CONFIG.contractAddress, BADGE_ABI, signer);
      $("accountBadge").textContent = short(account);
      $("accountBadge").classList.remove("hidden");
      $("networkBadge").textContent = chainOk ? CONFIG.chainName : "Wrong network";
      $("networkBadge").classList.remove("hidden");
      $("connectBtn").textContent = "Connected";
      $("connectBtn").disabled = true;
      setStatus(chainOk ? "Connected." : "Connected, but please switch your wallet to " + CONFIG.chainName + ".", chainOk ? "ok" : "error");
      await loadAccount();
      await loadQuests();
    } catch (e) {
      setStatus(friendlyError(e), "error");
    }
  }

  function showTab(name) {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".panel").forEach(function (p) { p.classList.add("hidden"); });
    $("tab-" + name).classList.remove("hidden");
  }

  function initTabs() {
    document.querySelectorAll(".tab").forEach(function (tab) {
      tab.addEventListener("click", function () { showTab(tab.getAttribute("data-tab")); });
    });
  }

  async function init() {
    startCountdown();
    initTabs();
    $("connectBtn").addEventListener("click", connect);
    $("heroMintBtn").addEventListener("click", function () {
      showTab("badges");
      $("tab-badges").scrollIntoView();
      if (!account) connect();
    });
    $("heroBoardBtn").addEventListener("click", function () {
      showTab("board");
      $("tab-board").scrollIntoView();
    });
    $("shareXBtn").addEventListener("click", function () {
      var url = account
        ? location.origin + location.pathname + "?ref=" + account
        : location.href.split("?")[0];
      var text = "Minting a free daily badge on MintBoard — verified-free mints, streaks, quests and referral badges for Agent ID holders. Come and get yours:";
      window.open("https://x.com/intent/tweet?text=" + encodeURIComponent(text) + "&url=" + encodeURIComponent(url), "_blank", "noopener");
    });
    $("mintBtn").addEventListener("click", function () { mintToday($("mintBtn")); });
    $("copyRefBtn").addEventListener("click", function () {
      var input = $("refLink");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(function () {
          setStatus("Referral link copied.", "ok");
        }).catch(function () { setStatus("Copy failed — select the link and copy it manually.", "error"); });
      } else {
        input.select();
        try { document.execCommand("copy"); setStatus("Referral link copied.", "ok"); }
        catch (e) { setStatus("Copy failed — select the link and copy it manually.", "error"); }
      }
    });
    if (window.ethereum) {
      // Reload on account change: the signer caches the selected account,
      // so anything less would sign from a stale account.
      window.ethereum.on("accountsChanged", function () { location.reload(); });
      window.ethereum.on("chainChanged", function () { if (!suppressChainReload) location.reload(); });
    }
    if (typeof window.ethers === "undefined") {
      $("deployBanner").textContent = "The wallet library failed to load. Check your connection and refresh.";
      $("deployBanner").classList.remove("hidden");
      return;
    }
    var notLiveMsg = null;
    if (!CONFIG.contractAddress) {
      notLiveMsg = "MintBoard is not live yet — the contract has not been deployed. The board, badges, quests, and leaderboard will appear here at launch.";
    } else if (!ethers.isAddress(CONFIG.contractAddress)) {
      notLiveMsg = "MintBoard is misconfigured — the contract address in config.js is not a valid address. Nothing on-chain will load until the site owner fixes it.";
    }
    if (notLiveMsg) {
      $("deployBanner").textContent = notLiveMsg;
      $("deployBanner").classList.remove("hidden");
      $("contractLink").textContent = "Contract: not deployed yet.";
      renderListingsEmpty("Listings appear here after launch.");
      $("quests").innerHTML = '<p class="muted">Quests appear here after launch.</p>';
      $("streakBoard").innerHTML = '<li class="muted">The leaderboard appears after launch.</li>';
      $("referralBoard").innerHTML = '<li class="muted">The leaderboard appears after launch.</li>';
      return;
    }
    try {
      readProvider = await makeReadProvider();
      readContract = new ethers.Contract(CONFIG.contractAddress, BADGE_ABI, readProvider);
      registry = new ethers.Contract(CONFIG.agentIDRegistry, REGISTRY_ABI, readProvider);
      var link = document.createElement("a");
      link.href = bscscan(CONFIG.contractAddress);
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Contract: " + short(CONFIG.contractAddress);
      $("contractLink").textContent = "";
      $("contractLink").appendChild(link);
      $("contractLink").appendChild(document.createTextNode("."));
      await loadTiers();
      await loadBoard();
      await loadQuests();
      await loadLeaderboard();
      await loadStats();
      await loadActivity();
    } catch (e) {
      setStatus("Could not reach BNB Smart Chain. The page will retry when you connect your wallet.", "error");
      renderListingsEmpty("Could not load listings. Please refresh and try again.");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
