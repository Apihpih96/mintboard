// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MintBoardBadge
/// @notice Daily check-in badges, streak badges, quest badges, and referral
/// badges for Agent ID holders, plus an on-chain board of curated free mints.
/// Free mints only: this contract never accepts funds, moves no user assets,
/// and takes no token approvals.
/// @dev Agent ID eligibility is read live from the SPACE ID Agent ID registry
/// (ERC-721): balanceOf(account) > 0 means the account holds an Agent ID.
/// The registry address is immutable, set once at deployment. Quests verify
/// holdings by reading balanceOf on curator-added ERC-721 contracts.
/// Owner powers (disclosed): manage board listings, manage quests, and set
/// the metadata base URI. No pause, no freeze, no burning others' tokens,
/// no minting to others, no withdrawals, no fees, no upgradeability.
/// All mint/claim functions carry a reentrancy guard: quest completion
/// calls balanceOf on curator-added contracts, and a malicious target
/// must not be able to reenter and mint twice.
interface IBalanceOf {
    function balanceOf(address owner) external view returns (uint256);
}

contract MintBoardBadge is ERC721, Ownable, ReentrancyGuard {
    enum Kind {
        Daily,
        Quest,
        Referral,
        Streak
    }

    error NotAgentIDHolder();
    error AlreadyClaimedToday();
    error PaymentNotAccepted();
    error ListingNotFound();
    error QuestNotFound();
    error QuestRequirementNotMet();
    error QuestAlreadyCompleted();
    error InvalidReferrer();
    error InvalidTier();
    error TierAlreadyClaimed();
    error StreakTooShort();
    error ReferralsTooFew();
    error InvalidRegistry();
    error InvalidTarget();

    struct Listing {
        string title;
        string url;
        address mintContract;
        uint64 startTime;
        bool active;
    }

    struct Quest {
        string title;
        address targetContract;
        uint256 minBalance;
        bool active;
    }

    IBalanceOf public immutable agentIDRegistry;
    string public baseTokenURI;

    uint256 private _nextTokenId = 1;
    mapping(address => uint256) public lastClaimDay;
    mapping(address => uint256) public streak;
    mapping(address => address) public referredBy;
    mapping(address => uint256) public referralCount;
    mapping(uint256 => Kind) public tokenKind;
    mapping(address => mapping(uint256 => bool)) public questCompleted;
    mapping(address => mapping(uint256 => bool)) public streakBadgeClaimed;
    mapping(address => mapping(uint256 => bool)) public referralBadgeClaimed;

    Listing[] private _listings;
    Quest[] private _quests;

    uint256[] public streakTiers = [3, 7, 14, 30];
    uint256[] public referralTiers = [1, 5, 10, 25];

    event BadgeMinted(address indexed to, uint256 indexed tokenId, uint256 indexed day);
    event ReferralRecorded(address indexed referrer, address indexed referee);
    event ListingAdded(uint256 indexed id, string title, address indexed mintContract);
    event ListingUpdated(uint256 indexed id, bool active);
    event QuestAdded(uint256 indexed id, string title, address indexed targetContract);
    event QuestUpdated(uint256 indexed id, bool active);
    event QuestCompleted(address indexed account, uint256 indexed questId, uint256 indexed tokenId);
    event StreakBadgeClaimed(address indexed account, uint256 days_, uint256 indexed tokenId);
    event ReferralBadgeClaimed(address indexed account, uint256 count, uint256 indexed tokenId);
    event BaseURISet(string baseURI);

    constructor(
        address registry_,
        string memory baseURI_
    ) ERC721("MintBoard Badge", "MBOARD") Ownable(msg.sender) {
        if (registry_.code.length == 0) revert InvalidRegistry();
        agentIDRegistry = IBalanceOf(registry_);
        baseTokenURI = baseURI_;
    }

    /// @notice Current UTC day number (seconds since epoch / 86400).
    function currentDay() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    /// @notice Whether `account` holds an Agent ID and has not claimed today.
    function canClaim(address account) public view returns (bool) {
        return agentIDRegistry.balanceOf(account) > 0 && lastClaimDay[account] != currentDay();
    }

    /// @notice Mint today's badge. Free (value must be 0), one per address
    /// per UTC day, Agent ID holders only. `referrer` is recorded only on
    /// the caller's first-ever mint (must hold an Agent ID, must not be the
    /// caller); on later mints it is ignored. Consecutive-day mints build
    /// the caller's streak; a missed day resets it to 1.
    function mintDailyBadge(address referrer) external payable nonReentrant {
        if (msg.value != 0) revert PaymentNotAccepted();
        if (agentIDRegistry.balanceOf(msg.sender) == 0) revert NotAgentIDHolder();
        uint256 day = currentDay();
        if (lastClaimDay[msg.sender] == day) revert AlreadyClaimedToday();
        if (lastClaimDay[msg.sender] == 0 && referrer != address(0)) {
            if (referrer == msg.sender) revert InvalidReferrer();
            if (agentIDRegistry.balanceOf(referrer) == 0) revert InvalidReferrer();
            referredBy[msg.sender] = referrer;
            referralCount[referrer] += 1;
            emit ReferralRecorded(referrer, msg.sender);
        }
        if (lastClaimDay[msg.sender] == day - 1) {
            streak[msg.sender] += 1;
        } else {
            streak[msg.sender] = 1;
        }
        lastClaimDay[msg.sender] = day;
        uint256 tokenId = _mintBadge(msg.sender, Kind.Daily);
        emit BadgeMinted(msg.sender, tokenId, day);
    }

    /// @notice Complete a quest: the caller must hold at least `minBalance`
    /// of the quest's target ERC-721. Mints a quest badge, once per quest
    /// per address. Free, Agent ID holders only.
    function completeQuest(uint256 questId) external payable nonReentrant {
        if (msg.value != 0) revert PaymentNotAccepted();
        if (agentIDRegistry.balanceOf(msg.sender) == 0) revert NotAgentIDHolder();
        if (questId >= _quests.length) revert QuestNotFound();
        Quest storage quest = _quests[questId];
        if (!quest.active) revert QuestNotFound();
        if (questCompleted[msg.sender][questId]) revert QuestAlreadyCompleted();
        if (IBalanceOf(quest.targetContract).balanceOf(msg.sender) < quest.minBalance) {
            revert QuestRequirementNotMet();
        }
        questCompleted[msg.sender][questId] = true;
        uint256 tokenId = _mintBadge(msg.sender, Kind.Quest);
        emit QuestCompleted(msg.sender, questId, tokenId);
    }

    /// @notice Claim a streak badge for one of the streak tiers (3/7/14/30
    /// consecutive days). One claim per tier per address. Free, Agent ID
    /// holders only.
    function claimStreakBadge(uint256 days_) external payable nonReentrant {
        if (msg.value != 0) revert PaymentNotAccepted();
        if (agentIDRegistry.balanceOf(msg.sender) == 0) revert NotAgentIDHolder();
        if (!_isTier(streakTiers, days_)) revert InvalidTier();
        if (streak[msg.sender] < days_) revert StreakTooShort();
        if (streakBadgeClaimed[msg.sender][days_]) revert TierAlreadyClaimed();
        streakBadgeClaimed[msg.sender][days_] = true;
        uint256 tokenId = _mintBadge(msg.sender, Kind.Streak);
        emit StreakBadgeClaimed(msg.sender, days_, tokenId);
    }

    /// @notice Claim a referral badge for one of the referral tiers (1/5/10/
    /// 25 referred first-time minters). One claim per tier per address.
    /// Free, Agent ID holders only.
    function claimReferralBadge(uint256 count) external payable nonReentrant {
        if (msg.value != 0) revert PaymentNotAccepted();
        if (agentIDRegistry.balanceOf(msg.sender) == 0) revert NotAgentIDHolder();
        if (!_isTier(referralTiers, count)) revert InvalidTier();
        if (referralCount[msg.sender] < count) revert ReferralsTooFew();
        if (referralBadgeClaimed[msg.sender][count]) revert TierAlreadyClaimed();
        referralBadgeClaimed[msg.sender][count] = true;
        uint256 tokenId = _mintBadge(msg.sender, Kind.Referral);
        emit ReferralBadgeClaimed(msg.sender, count, tokenId);
    }

    /// @notice Add a free-mint listing to the board (curator only).
    function addListing(
        string calldata title,
        string calldata url,
        address mintContract,
        uint64 startTime
    ) external onlyOwner {
        _listings.push(Listing(title, url, mintContract, startTime, true));
        emit ListingAdded(_listings.length - 1, title, mintContract);
    }

    /// @notice Activate/deactivate a listing (curator only).
    function setListingActive(uint256 id, bool active) external onlyOwner {
        if (id >= _listings.length) revert ListingNotFound();
        _listings[id].active = active;
        emit ListingUpdated(id, active);
    }

    function listingCount() external view returns (uint256) {
        return _listings.length;
    }

    function getListing(uint256 id) external view returns (Listing memory) {
        if (id >= _listings.length) revert ListingNotFound();
        return _listings[id];
    }

    /// @notice Add a quest (curator only). `targetContract` must be an
    /// ERC-721 whose balanceOf the quest verifies.
    function addQuest(
        string calldata title,
        address targetContract,
        uint256 minBalance
    ) external onlyOwner {
        if (targetContract == address(0)) revert InvalidTarget();
        _quests.push(Quest(title, targetContract, minBalance, true));
        emit QuestAdded(_quests.length - 1, title, targetContract);
    }

    /// @notice Activate/deactivate a quest (curator only).
    function setQuestActive(uint256 id, bool active) external onlyOwner {
        if (id >= _quests.length) revert QuestNotFound();
        _quests[id].active = active;
        emit QuestUpdated(id, active);
    }

    function questCount() external view returns (uint256) {
        return _quests.length;
    }

    function getQuest(uint256 id) external view returns (Quest memory) {
        if (id >= _quests.length) revert QuestNotFound();
        return _quests[id];
    }

    /// @notice Set the metadata base URI (curator only).
    function setBaseURI(string calldata baseURI_) external onlyOwner {
        baseTokenURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    /// @notice Metadata is shared per badge kind (one JSON per kind), so the
    /// site can be fully static: base + "<kind>.json".
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_baseURI(), _kindName(tokenKind[tokenId]), ".json");
    }

    function _baseURI() internal view override returns (string memory) {
        return baseTokenURI;
    }

    function _kindName(Kind kind) internal pure returns (string memory) {
        if (kind == Kind.Daily) return "daily";
        if (kind == Kind.Quest) return "quest";
        if (kind == Kind.Referral) return "referral";
        return "streak";
    }

    function _isTier(uint256[] storage tiers, uint256 value) internal view returns (bool) {
        for (uint256 i = 0; i < tiers.length; i++) {
            if (tiers[i] == value) return true;
        }
        return false;
    }

    function _mintBadge(address to, Kind kind) internal returns (uint256 tokenId) {
        tokenId = _nextTokenId++;
        tokenKind[tokenId] = kind;
        _safeMint(to, tokenId);
    }

    /// @notice Reject accidental plain transfers: this contract holds no funds.
    receive() external payable {
        revert PaymentNotAccepted();
    }
}
