// MintBoard site configuration.
//
// Deployment steps: set contractAddress to the deployed MintBoardBadge
// address and startBlock to the deployment block, then host this folder
// (e.g. GitHub Pages). Until contractAddress is set, the site runs as a
// landing page: it explains the project and disables on-chain actions.
//
// Test overrides via URL parameters (for local/dev checks only):
//   ?contract=0x...&chain=97&rpc=https://...&startBlock=123
const CONFIG = {
  chainId: 56,
  chainName: "BNB Smart Chain",
  rpcUrls: [
    "https://bsc-dataseed.binance.org",
    "https://bsc-dataseed1.defibit.io",
    "https://bsc.publicnode.com",
  ],
  // Fill in after deployment (see docs/DEPLOY.md).
  contractAddress: "",
  // SPACE ID Agent ID registry (ERC-721, non-transferable).
  agentIDRegistry: "0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F",
  // First block scanned for leaderboard events; set to the deploy block.
  startBlock: 0,
  bscscanBase: "https://bscscan.com",
};

(function applyUrlOverrides() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get("contract")) CONFIG.contractAddress = q.get("contract");
    if (q.get("chain")) CONFIG.chainId = Number(q.get("chain"));
    if (q.get("rpc")) CONFIG.rpcUrls = [q.get("rpc")];
    if (q.get("startBlock")) CONFIG.startBlock = Number(q.get("startBlock"));
    if (q.get("explorer")) CONFIG.bscscanBase = q.get("explorer");
  } catch (e) {
    /* URL parsing is best-effort; defaults stand. */
  }
})();
