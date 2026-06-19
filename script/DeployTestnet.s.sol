// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BulgarianToto} from "../src/BulgarianToto.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";

/// @notice Deploy MockUSDC + BulgarianToto to Sepolia for testing.
///         Mints 1,000,000 test USDC to the deployer.
contract DeployTestnet is Script {
    address constant VRF_COORDINATOR = 0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B;
    bytes32 constant KEY_HASH = 0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae;
    uint16  constant REQUEST_CONFIRMATIONS = 3;
    uint32  constant CALLBACK_GAS_LIMIT = 500_000;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 subId = vm.envUint("VRF_SUB_ID");
        address treasury = vm.envAddress("TREASURY");

        uint256 offset = vm.envOr("FIRST_DRAW_OFFSET", uint256(48 hours));
        uint64 firstDrawTime = uint64(block.timestamp + offset);

        vm.startBroadcast(deployerKey);

        // 1. Deploy mock USDC
        MockUSDC usdc = new MockUSDC();
        console.log("MockUSDC deployed at:", address(usdc));

        // 2. Mint 1,000,000 USDC to deployer
        address deployer = vm.addr(deployerKey);
        usdc.mint(deployer, 1_000_000 * 1e6);
        console.log("Minted 1,000,000 USDC to:", deployer);

        // 3. Deploy BulgarianToto with mock USDC
        BulgarianToto toto = new BulgarianToto(
            address(usdc),
            VRF_COORDINATOR,
            KEY_HASH,
            subId,
            REQUEST_CONFIRMATIONS,
            CALLBACK_GAS_LIMIT,
            firstDrawTime,
            treasury
        );
        console.log("BulgarianToto deployed at:", address(toto));
        console.log("First draw time:", firstDrawTime);

        vm.stopBroadcast();
    }
}
