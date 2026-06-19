// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BulgarianToto} from "../src/BulgarianToto.sol";

/// @notice Redeploys ONLY BulgarianToto, reusing an existing MockUSDC.
///         Required env: PRIVATE_KEY, VRF_SUB_ID, TREASURY, MOCK_USDC_ADDRESS.
///         Optional env: FIRST_DRAW_OFFSET (default 48h).
contract RedeployToto is Script {
    address constant VRF_COORDINATOR = 0x9DdfaCa8183c41ad55329BdeeD9F6A8d53168B1B;
    bytes32 constant KEY_HASH = 0x787d74caea10b2b357790d5b5247c2f63d1d91572a9846f780606e4d953677ae;
    uint16  constant REQUEST_CONFIRMATIONS = 3;
    uint32  constant CALLBACK_GAS_LIMIT = 500_000;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        uint256 subId = vm.envUint("VRF_SUB_ID");
        address treasury = vm.envAddress("TREASURY");
        address usdc = vm.envAddress("MOCK_USDC_ADDRESS");

        uint256 offset = vm.envOr("FIRST_DRAW_OFFSET", uint256(48 hours));
        uint64 firstDrawTime = uint64(block.timestamp + offset);

        vm.startBroadcast(deployerKey);

        BulgarianToto toto = new BulgarianToto(
            usdc,
            VRF_COORDINATOR,
            KEY_HASH,
            subId,
            REQUEST_CONFIRMATIONS,
            CALLBACK_GAS_LIMIT,
            firstDrawTime,
            treasury
        );

        vm.stopBroadcast();

        console.log("=== Redeploy complete ===");
        console.log("Reused MockUSDC at:", usdc);
        console.log("New BulgarianToto at:", address(toto));
        console.log("First draw time (unix):", firstDrawTime);
        console.log("VRF Subscription ID:", subId);
        console.log("Treasury:", treasury);
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Update frontend/.env: VITE_CONTRACT_ADDRESS=", address(toto));
        console.log("2. Add contract as VRF consumer at https://vrf.chain.link/sepolia");
        console.log("3. Restart `npm run dev`");
    }
}
