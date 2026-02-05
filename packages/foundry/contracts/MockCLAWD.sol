// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockCLAWD
 * @notice Simple ERC20 with public mint for local testing
 */
contract MockCLAWD is ERC20 {
    constructor() ERC20("CLAWD", "CLAWD") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
