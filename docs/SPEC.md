# MintBoard — design spec

Free-mint board + daily badge for the Binance Agent ID Hackathon.
Working name: **MintBoard** (user can rename). No "Binance"/"BNB" in branding.

## Concept

A board listing verified-free mints on BNB Chain. Only Agent ID holders can
mint a daily check-in badge (ERC-721, free, one per address per UTC day).
The badge proves "I showed up" — the board is the habit, the badge is the
receipt. Agent ID is the gate for every action, not decoration.

v2 adds the mechanics that make it competitive: **streaks** (consecutive-day
badges), **quests** (the contract itself verifies you hold a featured
free-mint NFT, then awards a quest badge), and **referrals** (invite links
by wallet address; referrers earn referral badges). Referrals are the growth
engine toward the 30-interactor threshold; quests tie the board's listings
to real on-chain activity.

The board's edge is trust: listings are mints verified free on-chain
(value-0 function, no approvals) — the curator's actual expertise, with the
check method shown per listing.

## Agent ID integration (what the judges score)

- Eligibility is read live from the SPACE ID Agent ID contract
  (`0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`, ERC-721, non-transferable):
  `balanceOf(address) > 0` means the caller holds an Agent ID.
- Every badge action reverts for non-holders (`NotAgentIDHolder`):
  daily mint, quest completion, streak claims, referral claims.
- Referrers must hold an Agent ID too (`InvalidReferrer` otherwise).
- The registry address is set once in the constructor (immutable) so the
  integration cannot be swapped out later.

## Contract: MintBoardBadge (contracts/MintBoardBadge.sol)

- ERC-721 (OpenZeppelin), sequential token IDs, free mints only. Every mint
  function requires `msg.value == 0`; `receive()` reverts. The contract
  never holds funds, moves no user assets, takes no approvals.
- Badge kinds (`tokenKind`, `tokenURI` = base + kind + ".json" — one shared
  metadata file per kind, so the site stays fully static):
  `daily`, `quest`, `referral`, `streak`.
- `mintDailyBadge(referrer)`:
  - One mint per address per UTC day (`block.timestamp / 86400`); reverts
    `AlreadyClaimedToday` on a second attempt.
  - `referrer` is recorded only on the caller's first-ever mint (must hold
    an Agent ID, must not be the caller); on later mints it is ignored.
    Sets `referredBy`, increments `referralCount[referrer]`.
  - Streak: consecutive UTC days increment `streak`; a missed day resets
    it to 1.
  - Emits `BadgeMinted` (+ `ReferralRecorded` on first-mint referrals).
- `completeQuest(questId)`: requires the caller to hold at least
  `minBalance` of the quest's target ERC-721 (read live via `balanceOf`);
  one completion per quest per address; mints a quest badge. Inactive or
  missing quests revert `QuestNotFound`; unmet holdings revert
  `QuestRequirementNotMet`.
- `claimStreakBadge(days_)`: tiers 3/7/14/30 consecutive days; one claim
  per tier per address; mints a streak badge.
- `claimReferralBadge(count)`: tiers 1/5/10/25 referred first-time
  minters; one claim per tier per address; mints a referral badge.
- Board listings (curated by owner, readable by anyone):
  - `addListing(title, url, mintContract, startTime)` / `setListingActive(id, active)`.
  - `listingCount()`, `getListing(id)` — the frontend reads the board on-chain.
- Quests (curated by owner, readable by anyone):
  - `addQuest(title, targetContract, minBalance)` / `setQuestActive(id, active)`.
  - `questCount()`, `getQuest(id)`. Targets must be ERC-721 contracts.
- Metadata: `baseTokenURI` (owner-settable).
- Owner powers (disclosed, minimal): manage listings, manage quests, set
  base URI. Explicitly NO: pause, freeze, burn others' tokens, mint to
  others, withdrawals, fees, upgradeability. The contract holds no funds
- Reentrancy: all mint/claim functions carry OpenZeppelin's `nonReentrant`
  guard and follow checks-effects-interactions (state is set before
  `_safeMint`). Quest `balanceOf` reads go through the view-declared
  `IBalanceOf` interface, so Solidity compiles them as STATICCALL — a
  hostile quest target cannot mutate state or reenter from `balanceOf`;
  its call fails and the quest reverts with no badge minted (verified by
  tests with hostile mocks). The constructor rejects a registry address
  with no code, and `addQuest` rejects a zero-address target.
  by design.

## Frontend (frontend/ — static site)

- Connect via injected wallet only (MetaMask / Binance Wallet extension).
  No QR login, no session storage, no prompts that bypass confirmations:
  the user reads and confirms every transaction in their own wallet.
- Board tab: listings read from the contract + verification notes.
- Badge tab: "Mint today's badge" (passes `?ref=` address when present),
  streak display, streak/referral badge claims.
- Quests tab: quest list + "Complete quest" buttons.
- Leaderboard: top referrers + longest streaks, read from contract state.
- Referral links: site URL + `?ref=<wallet address>`.
- Engagement sections (added 2026-11-19): hero with live stats strip
  (badges minted, minters, best streak, countdown to the next UTC day),
  badge showcase with the four artworks, 3-step how-it-works, live
  activity feed from BadgeMinted events, Share-on-X button (prefills the
  referral link when connected), and an FAQ. Stats, activity and
  leaderboard share one cached BadgeMinted event fetch.
- Scaling (added 2026-11-19): page traffic is served by the CDN, so the
  bottleneck is chain reads, not the site. Event history goes through
  scan.js (10k-block chunks with split-on-error, incremental localStorage
  cache, backward scans for recent activity); board/quest/tier reads are
  TTL-cached; per-item reads run in parallel batches of 8; the working
  RPC is remembered per session. Proven by test/scan.test.js (9/9).
- Risk/compliance copy on the page: badges are free collectibles, no returns
  promised, minting costs gas only.

## Red-line compliance checklist

- [ ] No web QR-code login / pairing codes — injected wallet only.
- [ ] No prompts bypassing user confirmation — user confirms each tx.
- [ ] No unauthorized transfers — contract moves no funds, takes no approvals.
- [ ] Contracts open-source, owner permissions disclosed (this doc + NatSpec).
- [ ] No Binance/BNB brand impersonation in names, token, or domain.
- [ ] No credential collection of any kind.
- [ ] No promised returns ("passive income" etc.) anywhere in copy.
- [ ] No Agent ID "lookup other people's wallets" feature — eligibility
      checks only the connected wallet's own holdings; referrals use
      addresses the user shares themselves.

## Milestones

- M1 — Contract + local tests (mock registry + ganache). DONE (v2: 65/65
  smoke tests pass, 2026-11-18 night).
- M2 — Frontend (static site) + badge metadata/art + README/docs. DONE
  (2026-11-18 night; headless load test passed, pre-launch state verified).
- M3 — Deploy (USER signs from their own wallet; baw cannot deploy — it needs
  a `--to` address), verify source on BscScan, host the site, open-source repo.
- M4 — Submit project materials before Dec 9, 2026 08:00 UTC; promote to
      reach 30+ interacting Agent ID holders (Innovation Award threshold).

## User responsibilities

- Deploy signature + gas (agent wallet holds ~$0.31 — top-up needed).
- GitHub repo under Apihpih96 (public, open-source) + site hosting choice.
- Promotion: X + communities to reach 30 Agent ID interactors.
- Final submission of project materials (name, website, contracts, Agent ID
  usage description) during the submission period.

## Key facts

- Submission: 2026-11-18 08:00 UTC → 2026-12-09 08:00 UTC.
- Review: Dec 9–17 internal; Dec 17–20 public. Rewards within 14 business
  days after public review, to the address given at submission.
- Prizes: Growth top 10 (29,000 USDC) + Innovation top 10 (29,000 USDC) +
  2,000 USDC X promo. One award per project. Winners also get a two-digit
  Agent ID claim spot.
- Announcement: https://www.binance.com/en/support/announcement/detail/95f5dbe0ea674a48a739b59e046648bf
