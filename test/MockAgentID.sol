// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal stand-in for the SPACE ID Agent ID registry, for local
/// tests only. The real registry is an ERC-721; MintBoardBadge only reads
/// balanceOf, so this mock is behaviorally sufficient.
contract MockAgentID {
    mapping(address => uint256) private _balances;

    function balanceOf(address owner) external view returns (uint256) {
        return _balances[owner];
    }

    function setBalance(address owner, uint256 amount) external {
        _balances[owner] = amount;
    }
}
