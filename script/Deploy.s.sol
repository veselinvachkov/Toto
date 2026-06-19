// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BulgarianToto} from "../src/BulgarianToto.sol";

/// @notice Deploy BulgarianToto to Sepolia.
///
/// Required environment variables (set in .env or export):
///   PRIVATE_KEY         – deployer's private key
///   VRF_SUB_ID          – Chainlink VRF v2.5 subscription ID
///   TREASURY            – address that receives the per-draw fee
///
/// Optional:
///   FIRST_DRAW_OFFSET   – seconds from now to the first draw (default 48 h)
///
/// Usage:
///   source .env
///   forge script script/Deploy.s.sol:DeployBulgarianToto \
///       --rpc-url sepolia --broadcast --verify
contract DeployBulgarianToto is Script {
    // ── Sepolia constants ────────────────────────────────────────
    address constant USDC_SEPOLIA = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
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

        BulgarianToto toto = new BulgarianToto(
            USDC_SEPOLIA,
            VRF_COORDINATOR,
            KEY_HASH,
            subId,
            REQUEST_CONFIRMATIONS,
            CALLBACK_GAS_LIMIT,
            firstDrawTime,
            treasury
        );

        vm.stopBroadcast();

        console.log("BulgarianToto deployed at:", address(toto));
        console.log("First draw time:", firstDrawTime);
        console.log("Treasury:", treasury);
    }
}
