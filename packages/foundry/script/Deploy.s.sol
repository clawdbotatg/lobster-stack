//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";
import { DeployLobsterStack } from "./DeployLobsterStack.s.sol";

contract DeployScript is ScaffoldETHDeploy {
    function run() external {
        DeployLobsterStack deployLobsterStack = new DeployLobsterStack();
        deployLobsterStack.run();
    }
}
