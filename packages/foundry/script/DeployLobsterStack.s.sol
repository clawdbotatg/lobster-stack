//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import { LobsterStack } from "../contracts/LobsterStack.sol";
import { MockCLAWD } from "../contracts/MockCLAWD.sol";

contract DeployLobsterStack is ScaffoldETHDeploy {
    address constant BASE_CLAWD = 0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07;
    address constant TREASURY = 0x11ce532845cE0eAcdA41f72FDc1C88c335981442;

    uint256 constant ENTRY_COST = 500_000 * 1e18; // 500K CLAWD
    uint256 constant PARTICIPANT_BPS = 6000;       // 60%
    uint256 constant BURN_BPS = 2000;              // 20%
    uint256 constant TREASURY_BPS = 1500;          // 15%
    // Remaining 500 BPS (5%) = reward pool

    function run() external ScaffoldEthDeployerRunner {
        if (block.chainid == 31337) {
            // Local fork: deploy mock token
            MockCLAWD mockClawd = new MockCLAWD();
            console.log("MockCLAWD deployed at:", address(mockClawd));

            LobsterStack stack = new LobsterStack(
                address(mockClawd),
                TREASURY,
                ENTRY_COST,
                PARTICIPANT_BPS,
                BURN_BPS,
                TREASURY_BPS
            );
            console.log("LobsterStack deployed at:", address(stack));

            // Mint 1 billion CLAWD to deployer for testing
            mockClawd.mint(deployer, 1_000_000_000 * 1e18);
            console.log("Minted 1B CLAWD to deployer:", deployer);

            // Export contracts
            deployments.push(Deployment("MockCLAWD", address(mockClawd)));
            deployments.push(Deployment("LobsterStack", address(stack)));
        } else if (block.chainid == 8453) {
            // Base mainnet: use real CLAWD
            LobsterStack stack = new LobsterStack(
                BASE_CLAWD,
                TREASURY,
                ENTRY_COST,
                PARTICIPANT_BPS,
                BURN_BPS,
                TREASURY_BPS
            );
            console.log("LobsterStack deployed at:", address(stack));

            deployments.push(Deployment("LobsterStack", address(stack)));
        } else {
            revert("Unsupported chain");
        }
    }
}
