// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal ownership + reentrancy guard, self-contained (no external deps).
///      Kept deliberately tiny: this repo vendors everything it relies on.
abstract contract Owned {
    address public owner;

    event OwnershipTransferred(address indexed from, address indexed to);

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    function transferOwnership(address to) external onlyOwner {
        require(to != address(0), "zero addr");
        emit OwnershipTransferred(owner, to);
        owner = to;
    }
}

abstract contract ReentrancyGuard {
    uint256 private _locked = 1;

    modifier nonReentrant() {
        require(_locked == 1, "reentrancy");
        _locked = 2;
        _;
        _locked = 1;
    }
}
