# MintBoard — deployment guide

Launch order: host the site first (so the metadata URL exists), then deploy
the contract, then verify it, then wire the site to the contract.

## 0. What you need

- A wallet with a little BNB for gas. Top up ~0.05 BNB to be safe; the
  deploy plus listing/quest setup should cost well under that.
- The wallet you deploy from becomes the contract owner (curator). Use the
  wallet you want tied to the project.
- A GitHub account (Apihpih96) for the public repo + GitHub Pages hosting.

## 1. Publish the repo + host the site

1. Create a public repo (e.g. `mintboard`) and push this project.
2. Enable GitHub Pages on the repo, serving the `frontend/` folder
   (or the repo root via a `docs/` move — Pages needs one servable folder;
   simplest: set Pages source to the branch + `/frontend` is NOT a Pages
   option, so either publish from a `gh-pages` branch containing the
   `frontend/` contents, or use a static host such as Cloudflare Pages /
   Netlify pointed at `frontend/`).
3. Note the hosted base URL, e.g. `https://apihpih96.github.io/mintboard/`.

## 2. Set the metadata URL

The badge metadata JSONs live in `frontend/meta/`. Their `image` fields
contain the placeholder `__META_BASE_URL__`. Replace it with the hosted
`meta/` URL (no trailing slash):

```sh
cd frontend/meta
sed -i 's#__META_BASE_URL__#https://apihpih96.github.io/mintboard/meta#g' *.json
```

Commit + redeploy the site, then check one JSON loads in a browser, e.g.
`https://apihpih96.github.io/mintboard/meta/daily.json`.

The contract's base URI (constructor argument below) is that same URL WITH
a trailing slash: `https://apihpih96.github.io/mintboard/meta/`.

## 3. Deploy the contract (Remix, from your own wallet)

1. Open https://remix.ethereum.org.
2. Create `MintBoardBadge.sol` and paste `contracts/MintBoardBadge.sol`.
3. Compile with Solidity **0.8.30**, optimizer **enabled, 200 runs**,
   EVM version **shanghai**. (Remix resolves the `@openzeppelin/`
   imports itself; use OpenZeppelin Contracts 5.4.0.)
4. In Deploy & Run: environment **Injected Provider** (MetaMask / Binance
   Wallet extension), network **BNB Smart Chain Mainnet (56)**.
5. Constructor arguments, in order:
   - Registry: `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`
   - Base URI: `https://apihpih96.github.io/mintboard/meta/` (your URL!)
6. Deploy, confirm in your wallet, and save the contract address + the
   deployment block number.

## 4. Verify the source on BscScan

1. On BscScan, open the contract → Contract → Verify and Publish.
2. Compiler type: Solidity (Single file) or Standard JSON Input.
   Compiler **0.8.30**, optimizer **Yes, 200 runs**, EVM version
   **shanghai**, licence **MIT**.
3. Paste the source (single-file route needs the OpenZeppelin imports
   flattened — Remix's "Flatten" via the Flattener plugin — or use the
   Standard JSON route with the exact settings from `compile.js`).
4. Constructor arguments: the ABI-encoded registry + base URI (BscScan
   can auto-detect them from the deployment transaction; if it asks,
   encode with `cast abi-encode` or Remix's deployment log).
5. Confirm the verified badge + "Read/Write Contract" tabs appear.

## 5. Wire the site to the contract

Edit `frontend/config.js`:

- `contractAddress`: the deployed address.
- `startBlock`: the deployment block number (leaderboard event scan starts
  here — keeps the scan small and fast).

Commit + redeploy the site. The "not live yet" banner disappears and the
board/badges/quests/leaderboard go live.

## 6. Add listings + quests (owner wallet)

Use BscScan → Write Contract (connected as the owner), or Remix with the
deployed contract:

- `addListing(title, url, mintContract, startTime)` for each verified-free
  mint. `startTime` is a Unix timestamp (0 = already live). Re-verify each
  mint is still free before listing it.
- `addQuest(title, targetContract, minBalance)` for each quest. Targets
  must be ERC-721 contracts (the quest checks `balanceOf`).

Starter quests from verified-free mints (re-check before use):
Meow Cards `0xb8164afefc53910d7a74cece15a60a9e0c86089e`,
AGENT COSMOS `0x3Aeda314ec05BC22E3c26a543E16Df2B8cC8fe69`,
First-Dollar Grove `0x56466afBcC2FDB847ed2cf5Bf78Ec1B213253611`,
PXIO Miner `0x58e8f1b34B60687B36BCdc78e02a2fd443De71Ab`.

## 7. Submit + promote

1. Submit the project materials during the submission period (before
   Dec 9, 2026 08:00 UTC): project name, website URL, contract address(es),
   and the Agent ID usage description (see `docs/SPEC.md`).
2. Promote: post the site + your referral link on X and in the communities
   where Agent ID holders gather. The Innovation Award needs at least 30
   Agent ID addresses interacting with the contract during the period.
3. Keep the board fresh: add new verified-free mints as they appear; each
   one is a reason to post again.

## Troubleshooting

- Site shows "not live yet": `contractAddress` in `config.js` is empty.
- Badge images missing in wallets: the `__META_BASE_URL__` placeholder was
  not replaced, or the base URI lacks its trailing slash.
- Leaderboard empty/slow: `startBlock` should be the deployment block; a
  huge scan range times out on public RPCs.
- "Wrong network" on connect: the wallet must be on BNB Smart Chain (56).
