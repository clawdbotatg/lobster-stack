//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import { LobsterTower } from "../contracts/LobsterTower.sol";
import { MockCLAWD } from "../contracts/MockCLAWD.sol";

contract DeployLobsterTower is ScaffoldETHDeploy {
    address constant BASE_CLAWD = 0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07;

    uint256 constant ENTRY_COST = 100 * 1e18;       // 100 CLAWD
    uint256 constant PARTICIPANT_BPS = 8000;          // 80%
    uint256 constant BURN_BPS = 1000;                 // 10%
    // Remaining 1000 BPS (10%) = topple pot

    function run() external ScaffoldEthDeployerRunner {
        if (block.chainid == 31337) {
            // Local fork: deploy mock token
            MockCLAWD mockClawd = new MockCLAWD();
            console.log("MockCLAWD deployed at:", address(mockClawd));

            LobsterTower tower = new LobsterTower(
                address(mockClawd),
                ENTRY_COST,
                PARTICIPANT_BPS,
                BURN_BPS
            );
            console.log("LobsterTower deployed at:", address(tower));

            // Mint 1 billion CLAWD to deployer for testing
            mockClawd.mint(deployer, 1_000_000_000 * 1e18);

            deployments.push(Deployment("MockCLAWD", address(mockClawd)));
            deployments.push(Deployment("LobsterTower", address(tower)));
        } else if (block.chainid == 8453) {
            // Base mainnet
            LobsterTower tower = new LobsterTower(
                BASE_CLAWD,
                ENTRY_COST,
                PARTICIPANT_BPS,
                BURN_BPS
            );
            console.log("LobsterTower deployed at:", address(tower));

            deployments.push(Deployment("LobsterTower", address(tower)));
        } else {
            revert("Unsupported chain");
        }
    }
}
