# MintBoard

A board of verified-free mints on BNB Smart Chain, built for the
Binance Agent ID Hackathon. Agent ID holders mint one free badge a day,
build streaks, complete quests, and earn referral badges.

- **Board** — free mints verified on-chain (gas only, no payment, no token
  approval) before they are listed. Listings live on-chain and anyone can
  read them.
- **Daily badges** — one free ERC-721 badge per Agent ID holder per UTC day.
- **Streaks** — consecutive-day minting unlocks streak badges (3/7/14/30 days).
- **Quests** — the contract verifies you hold a featured free-mint NFT and
  awards a quest badge. No forms, no screenshots.
- **Referrals** — invite links by wallet address; referrers earn badges at
  1/5/10/25 referred first-time minters.
- **Leaderboard** — longest streaks and top referrers, computed from
  on-chain events.

## How Agent ID is used

Eligibility is read live from the SPACE ID Agent ID registry
(`0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`): `balanceOf(account) > 0`
means the account holds an Agent ID. Every badge action — daily mint,
quest completion, streak and referral claims — requires an Agent ID, and
referrers must hold one too. The registry address is immutable in the
contract. The site checks only the connected wallet's own holdings; it is
not a lookup tool.

## Contract permissions (disclosed)

`MintBoardBadge` is the only contract. The owner (curator) can manage board
listings, manage quests, and set the metadata base URI. There is no pause,
no freeze, no burning of others' tokens, no minting to others, no
withdrawals, no fees, and no upgradeability. The contract never accepts
funds: every mint function requires `msg.value == 0` and plain transfers
revert. See `docs/SPEC.md` and the NatSpec in
`contracts/MintBoardBadge.sol`.

## Safety

- No QR-code login, no pairing codes, no stored sessions. The site uses the
  visitor's own injected wallet (MetaMask / Binance Wallet extension).
- The user reviews and confirms every transaction in their own wallet. The
  site never asks to bypass confirmations.
- No credential collection of any kind. No promised returns anywhere.
- Badges are free collectibles. Minting costs gas only.

## Repository layout

```
contracts/          MintBoardBadge.sol (OpenZeppelin ERC-721)
test/               MockAgentID.sol + smoke.js (local ganache tests)
frontend/           Static site: index.html, app.js, styles.css, config.js
frontend/meta/      Badge metadata JSONs + SVG art (one per badge kind)
frontend/vendor/    Vendored ethers UMD build (no CDN dependency)
docs/               SPEC.md (design), DEPLOY.md (launch steps)
compile.js          solc-js build (writes build/ ABI + bytecode)
```

## Develop

```sh
npm install
node compile.js          # writes build/MintBoardBadge.abi.json + .bytecode.txt
node test/smoke.js       # 65 behavior checks on a local ganache chain
```

Compiler: solc 0.8.30, optimizer enabled (200 runs), EVM version `shanghai`.

## Launch

Follow `docs/DEPLOY.md`: host the site, set the metadata URL, deploy the
contract from your own wallet, verify the source on BscScan, add listings
and quests, then submit the project to the hackathon.

## Licence

MIT. Badge art and metadata are part of the project under the same licence.
