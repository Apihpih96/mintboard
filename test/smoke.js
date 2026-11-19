// Local smoke test: deploys MockAgentID (registry + quest target) and
// MintBoardBadge on an in-process ganache chain and checks every behavior
// in the spec. No real chain, no real funds.
// Usage: node test/smoke.js (run `node compile.js` first).
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const ganache = require("ganache");
const { ethers } = require("ethers");

const root = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed += 1;
    console.log("PASS", name);
  } else {
    failed += 1;
    console.log("FAIL", name, extra || "");
  }
}

// Revert checks run through staticCall (eth_call): ganache behind the
// EIP-1193 provider drops revert data on the estimateGas path, so a plain
// send shows "missing revert data" even when the contract reverted with the
// expected custom error. eth_call returns the data and ethers decodes it
// against the contract ABI, so the error NAME is verified here.
async function expectRevert(name, promise, errorName) {
  try {
    await promise;
    check(name, false, "(call succeeded, expected revert)");
  } catch (e) {
    const revertName = e && e.revert && e.revert.name;
    const msg = (e && e.message) || "";
    const matched = !errorName || revertName === errorName || msg.includes(errorName);
    check(name, matched, matched ? "" : "(reverted as " + (revertName || msg.slice(0, 100)) + ", expected " + errorName + ")");
  }
}

// Sends use an explicit gas limit: on this ganache/ethers path estimateGas
// spuriously reports a revert after time travel while eth_call proves the
// call succeeds.
async function send(promise) {
  const tx = await promise;
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error("tx failed: " + tx.hash);
  return rc;
}

// Test mocks compile with evmVersion shanghai: ganache 7.9.2 has no Cancun,
// and solc's default (Osaka) codegen can emit opcodes it rejects.
function compileSingle(file, name) {
  const input = {
    language: "Solidity",
    sources: {
      [file]: {
        content: fs.readFileSync(path.join(root, "test", file), "utf8"),
      },
    },
    settings: { evmVersion: "shanghai", outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  return out.contracts[file][name];
}

async function main() {
  // In-process ganache provider: ganache's HTTP server cannot bind on this
  // Node 24 build (no uWS prebuild; the JS fallback never resolves listen),
  // but the EIP-1193 provider works via ethers BrowserProvider.
  const gp = ganache.provider({ chain: { hardfork: "shanghai" }, logging: { quiet: true } });
  const provider = new ethers.BrowserProvider(gp);
  try {
    const [deployer, holder, stranger, referrer, referee, freshC, freshD] = await Promise.all(
      [0, 1, 2, 3, 4, 5, 6].map((i) => provider.getSigner(i)));
    const deployerAddr = await deployer.getAddress();
    const holderAddr = await holder.getAddress();
    const strangerAddr = await stranger.getAddress();
    const referrerAddr = await referrer.getAddress();
    const refereeAddr = await referee.getAddress();
    const freshCAddr = await freshC.getAddress();
    const freshDAddr = await freshD.getAddress();

    const mockCompiled = compileSingle("MockAgentID.sol", "MockAgentID");
    const mockFactory = new ethers.ContractFactory(
      mockCompiled.abi, mockCompiled.evm.bytecode.object, deployer);
    const mock = await mockFactory.deploy();
    await mock.waitForDeployment();
    const target = await mockFactory.deploy(); // quest target NFT stand-in
    await target.waitForDeployment();

    const badgeAbi = JSON.parse(
      fs.readFileSync(path.join(root, "build", "MintBoardBadge.abi.json"), "utf8"));
    const badgeBytecode =
      "0x" + fs.readFileSync(path.join(root, "build", "MintBoardBadge.bytecode.txt"), "utf8").trim();
    const badgeFactory = new ethers.ContractFactory(badgeAbi, badgeBytecode, deployer);
    const badge = await badgeFactory.deploy(await mock.getAddress(), "https://mintboard.example/meta/");
    await badge.waitForDeployment();
    check("deploys", true);

    // Registry wiring + metadata + tiers
    check("registry address stored",
      (await badge.agentIDRegistry()).toLowerCase() === (await mock.getAddress()).toLowerCase());
    check("name/symbol", (await badge.name()) === "MintBoard Badge" && (await badge.symbol()) === "MBOARD");
    check("owner is deployer", (await badge.owner()).toLowerCase() === deployerAddr.toLowerCase());

    // Constructor rejects a registry address with no code
    await expectRevert("constructor with EOA registry reverts",
      (async () => { const c = await badgeFactory.deploy(ethers.ZeroAddress, "https://x/"); await c.waitForDeployment(); })(), null);
    check("streak tiers", (await badge.streakTiers(0)) === 3n && (await badge.streakTiers(3)) === 30n);
    check("referral tiers", (await badge.referralTiers(0)) === 1n && (await badge.referralTiers(3)) === 25n);

    // Grant Agent IDs to everyone except the stranger
    for (const a of [holderAddr, referrerAddr, refereeAddr, freshCAddr, freshDAddr]) {
      await send(mock.setBalance(a, 1));
    }

    // Non-holder cannot mint
    await expectRevert("non-holder mint reverts NotAgentIDHolder",
      badge.connect(stranger).mintDailyBadge.staticCall(ethers.ZeroAddress), "NotAgentIDHolder");
    check("canClaim false for non-holder", (await badge.canClaim(strangerAddr)) === false);

    // Day 0: holder mints (no referrer) -> token 1, streak 1, kind Daily
    check("canClaim true for holder", (await badge.canClaim(holderAddr)) === true);
    await send(badge.connect(holder).mintDailyBadge(ethers.ZeroAddress, { gasLimit: 300000 }));
    check("token 1 owned by holder", (await badge.ownerOf(1)).toLowerCase() === holderAddr.toLowerCase());
    check("token 1 kind Daily", (await badge.tokenKind(1)) === 0n);
    check("balance 1", (await badge.balanceOf(holderAddr)) === 1n);
    check("streak 1", (await badge.streak(holderAddr)) === 1n);
    check("tokenURI daily shape",
      (await badge.tokenURI(1)) === "https://mintboard.example/meta/daily.json");
    check("canClaim false after mint", (await badge.canClaim(holderAddr)) === false);

    // Day 0: referee mints with referrer -> token 2, referral recorded
    await send(badge.connect(referee).mintDailyBadge(referrerAddr, { gasLimit: 300000 }));
    check("token 2 owned by referee", (await badge.ownerOf(2)).toLowerCase() === refereeAddr.toLowerCase());
    check("referredBy recorded", (await badge.referredBy(refereeAddr)).toLowerCase() === referrerAddr.toLowerCase());
    check("referralCount 1", (await badge.referralCount(referrerAddr)) === 1n);
    check("referee streak 1", (await badge.streak(refereeAddr)) === 1n);

    // Referral validation: self-referral and non-holder referrer revert
    await expectRevert("self-referral reverts InvalidReferrer",
      badge.connect(freshC).mintDailyBadge.staticCall(freshCAddr), "InvalidReferrer");
    await expectRevert("non-holder referrer reverts InvalidReferrer",
      badge.connect(freshD).mintDailyBadge.staticCall(strangerAddr), "InvalidReferrer");

    // Second mint same day reverts; mint with value reverts; plain transfer reverts
    await expectRevert("second same-day mint reverts AlreadyClaimedToday",
      badge.connect(holder).mintDailyBadge.staticCall(ethers.ZeroAddress), "AlreadyClaimedToday");
    await expectRevert("mint with value reverts PaymentNotAccepted",
      badge.connect(holder).mintDailyBadge.staticCall(ethers.ZeroAddress, { value: 1n }), "PaymentNotAccepted");
    await expectRevert("plain transfer reverts PaymentNotAccepted",
      provider.call({ to: await badge.getAddress(), from: holderAddr, value: 1n }), null);

    // Day 1: referrer arg is ignored after the first mint; streaks grow
    await provider.send("evm_increaseTime", [86400]);
    await provider.send("evm_mine", []);
    await send(badge.connect(holder).mintDailyBadge(holderAddr, { gasLimit: 300000 }));
    check("token 3 owned by holder", (await badge.ownerOf(3)).toLowerCase() === holderAddr.toLowerCase());
    check("streak 2", (await badge.streak(holderAddr)) === 2n);
    check("self-referrer ignored later", (await badge.referredBy(holderAddr)) === ethers.ZeroAddress);
    check("no referral counted later", (await badge.referralCount(holderAddr)) === 0n);
    await send(badge.connect(referee).mintDailyBadge(holderAddr, { gasLimit: 300000 }));
    check("referee streak 2", (await badge.streak(refereeAddr)) === 2n);
    check("original referrer kept", (await badge.referredBy(refereeAddr)).toLowerCase() === referrerAddr.toLowerCase());
    check("referralCount unchanged", (await badge.referralCount(referrerAddr)) === 1n);

    // Day 2: streak 3, streak badge tier 3 claimable
    await provider.send("evm_increaseTime", [86400]);
    await provider.send("evm_mine", []);
    await send(badge.connect(holder).mintDailyBadge(ethers.ZeroAddress, { gasLimit: 300000 }));
    check("streak 3", (await badge.streak(holderAddr)) === 3n);
    await send(badge.connect(holder).claimStreakBadge(3, { gasLimit: 300000 }));
    check("token 6 kind Streak", (await badge.tokenKind(6)) === 3n);
    check("tokenURI streak shape",
      (await badge.tokenURI(6)) === "https://mintboard.example/meta/streak.json");
    check("streak badge claimed flag", (await badge.streakBadgeClaimed(holderAddr, 3)) === true);
    await expectRevert("streak badge re-claim reverts TierAlreadyClaimed",
      badge.connect(holder).claimStreakBadge.staticCall(3), "TierAlreadyClaimed");
    await expectRevert("streak badge tier 7 too early reverts StreakTooShort",
      badge.connect(holder).claimStreakBadge.staticCall(7), "StreakTooShort");
    await expectRevert("streak badge bad tier reverts InvalidTier",
      badge.connect(holder).claimStreakBadge.staticCall(5), "InvalidTier");
    await expectRevert("streak badge with value reverts PaymentNotAccepted",
      badge.connect(holder).claimStreakBadge.staticCall(7, { value: 1n }), "PaymentNotAccepted");

    // Skip a day: streak resets to 1
    await provider.send("evm_increaseTime", [2 * 86400]);
    await provider.send("evm_mine", []);
    await send(badge.connect(holder).mintDailyBadge(ethers.ZeroAddress, { gasLimit: 300000 }));
    check("streak reset to 1 after missed day", (await badge.streak(holderAddr)) === 1n);

    // Quests: owner adds, holder completes by holding the target NFT
    await send(badge.addQuest("Hold a Meow Card", await target.getAddress(), 1, { gasLimit: 200000 }));
    check("questCount 1", (await badge.questCount()) === 1n);
    const quest = await badge.getQuest(0);
    check("quest fields", quest.title === "Hold a Meow Card" && quest.active === true && quest.minBalance === 1n);
    await expectRevert("addQuest with zero target reverts InvalidTarget",
      badge.addQuest.staticCall("bad", ethers.ZeroAddress, 1), "InvalidTarget");
    await expectRevert("non-owner addQuest reverts",
      badge.connect(holder).addQuest.staticCall("x", ethers.ZeroAddress, 1), "OwnableUnauthorizedAccount");
    await expectRevert("quest without holding reverts QuestRequirementNotMet",
      badge.connect(holder).completeQuest.staticCall(0), "QuestRequirementNotMet");
    await expectRevert("quest with value reverts PaymentNotAccepted",
      badge.connect(holder).completeQuest.staticCall(0, { value: 1n }), "PaymentNotAccepted");
    await send(target.setBalance(holderAddr, 1));
    await send(badge.connect(holder).completeQuest(0, { gasLimit: 300000 }));
    check("token 8 kind Quest", (await badge.tokenKind(8)) === 1n);
    check("tokenURI quest shape",
      (await badge.tokenURI(8)) === "https://mintboard.example/meta/quest.json");
    check("quest completed flag", (await badge.questCompleted(holderAddr, 0)) === true);
    await expectRevert("quest re-complete reverts QuestAlreadyCompleted",
      badge.connect(holder).completeQuest.staticCall(0), "QuestAlreadyCompleted");
    await expectRevert("quest out of range reverts QuestNotFound",
      badge.connect(holder).completeQuest.staticCall(99), "QuestNotFound");
    await send(badge.setQuestActive(0, false, { gasLimit: 200000 }));
    await expectRevert("inactive quest reverts QuestNotFound",
      badge.connect(referee).completeQuest.staticCall(0), "QuestNotFound");
    await send(badge.setQuestActive(0, true, { gasLimit: 200000 }));
    await expectRevert("getQuest out of range reverts QuestNotFound",
      badge.getQuest.staticCall(99), "QuestNotFound");

    // Hostile quest target: its balanceOf writes storage and tries to
    // reenter completeQuest. The call goes through the view-declared
    // IBalanceOf interface, so Solidity compiles it as STATICCALL: any
    // state change inside the target fails the call, completeQuest
    // reverts, and no badge is minted (reentry via balanceOf is
    // impossible by construction).
    const evilCompiled = compileSingle("ReentrantTarget.sol", "ReentrantTarget");
    const evil = await new ethers.ContractFactory(
      evilCompiled.abi, evilCompiled.evm.bytecode.object, deployer).deploy(await badge.getAddress(), { gasLimit: 500000 });
    await evil.waitForDeployment();
    await send(badge.addQuest("Evil quest", await evil.getAddress(), 1, { gasLimit: 200000 }));
    const balBeforeEvil = await badge.balanceOf(holderAddr);
    await expectRevert("hostile quest target reverts completeQuest",
      badge.connect(holder).completeQuest.staticCall(1), null);
    check("hostile quest mints nothing", (await badge.balanceOf(holderAddr)) === balBeforeEvil);
    check("hostile quest not marked completed", (await badge.questCompleted(holderAddr, 1)) === false);

    // Reentrant receiver: a contract whose onERC721Received tries to
    // reenter mintDailyBadge from the _safeMint callback. The guard +
    // checks-effects-interactions ordering mean exactly one badge.
    const recvCompiled = compileSingle("ReentrantReceiver.sol", "ReentrantReceiver");
    const receiver = await new ethers.ContractFactory(
      recvCompiled.abi, recvCompiled.evm.bytecode.object, deployer).deploy(await badge.getAddress(), { gasLimit: 500000 });
    await receiver.waitForDeployment();
    const receiverAddr = await receiver.getAddress();
    await send(mock.setBalance(receiverAddr, 1, { gasLimit: 200000 }));
    await send(receiver.attack({ gasLimit: 400000 }));
    check("reentrant receiver gets exactly one badge", (await badge.balanceOf(receiverAddr)) === 1n);
    check("receiver callback ran once", (await receiver.reentries()) === 1n);
    check("receiver streak 1", (await badge.streak(receiverAddr)) === 1n);

    // Referral badges: referrer has 1 referral, tier 1 claimable
    await send(badge.connect(referrer).claimReferralBadge(1, { gasLimit: 300000 }));
    check("token 10 kind Referral", (await badge.tokenKind(10)) === 2n);
    check("tokenURI referral shape",
      (await badge.tokenURI(10)) === "https://mintboard.example/meta/referral.json");
    await expectRevert("referral badge re-claim reverts TierAlreadyClaimed",
      badge.connect(referrer).claimReferralBadge.staticCall(1), "TierAlreadyClaimed");
    await expectRevert("referral badge tier 5 too early reverts ReferralsTooFew",
      badge.connect(referrer).claimReferralBadge.staticCall(5), "ReferralsTooFew");
    await expectRevert("referral badge bad tier reverts InvalidTier",
      badge.connect(referrer).claimReferralBadge.staticCall(2), "InvalidTier");
    await expectRevert("no referrals reverts ReferralsTooFew",
      badge.connect(holder).claimReferralBadge.staticCall(1), "ReferralsTooFew");
    await expectRevert("referral badge with value reverts PaymentNotAccepted",
      badge.connect(referrer).claimReferralBadge.staticCall(5, { value: 1n }), "PaymentNotAccepted");

    // Listings: owner adds, anyone reads, non-owner cannot add
    await send(badge.addListing("Meow Cards", "https://example.test/meow",
      "0x0000000000000000000000000000000000000001", 1795000000, { gasLimit: 200000 }));
    check("listingCount 1", (await badge.listingCount()) === 1n);
    const listing = await badge.getListing(0);
    check("listing fields", listing.title === "Meow Cards" && listing.active === true &&
      listing.mintContract.toLowerCase() === "0x0000000000000000000000000000000000000001");
    await send(badge.setListingActive(0, false, { gasLimit: 200000 }));
    check("listing deactivated", (await badge.getListing(0)).active === false);
    await expectRevert("non-owner addListing reverts",
      badge.connect(holder).addListing.staticCall("x", "https://x", ethers.ZeroAddress, 0), "OwnableUnauthorizedAccount");
    await expectRevert("getListing out of range reverts ListingNotFound",
      badge.getListing.staticCall(99), "ListingNotFound");

    // Base URI: owner sets, tokenURI follows (kind path preserved)
    await send(badge.setBaseURI("https://cdn.example/b/", { gasLimit: 200000 }));
    check("tokenURI follows new base", (await badge.tokenURI(1)) === "https://cdn.example/b/daily.json");
  } finally {
    await gp.disconnect();
  }
  console.log("%d/%d passed", passed, passed + failed);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("SMOKE TEST CRASH:", e);
  process.exit(2);
});
