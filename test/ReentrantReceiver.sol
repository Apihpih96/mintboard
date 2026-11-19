// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

/// @notice Hostile badge recipient for the reentrancy test only. Its
/// onERC721Received tries to reenter mintDailyBadge from the _safeMint
/// callback; the guard must block it so exactly one badge is minted.
contract ReentrantReceiver is IERC721Receiver {
    address public victim;
    uint256 public reentries;

    constructor(address victim_) {
        victim = victim_;
    }

    function attack() external {
        (bool ok, ) = victim.call(abi.encodeWithSignature("mintDailyBadge(address)", address(0)));
        require(ok, "attack mint failed");
    }

    function onERC721Received(address, address, uint256, bytes calldata) external override returns (bytes4) {
        reentries += 1;
        (bool ok, ) = victim.call(abi.encodeWithSignature("mintDailyBadge(address)", address(0)));
        ok;
        return IERC721Receiver.onERC721Received.selector;
    }
}
