// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Hostile quest target for the reentrancy test only. Its
/// balanceOf writes storage and tries to reenter completeQuest. Because
/// the badge calls balanceOf through the view-declared IBalanceOf
/// interface (STATICCALL), the target's state change fails the call and
/// completeQuest reverts with no badge minted.
contract ReentrantTarget {
    address public victim;
    uint256 public calls;

    constructor(address victim_) {
        victim = victim_;
    }

    function balanceOf(address) external returns (uint256) {
        calls += 1;
        if (calls == 1) {
            (bool ok, ) = victim.call(abi.encodeWithSignature("completeQuest(uint256)", 1));
            ok;
        }
        return 1;
    }
}
