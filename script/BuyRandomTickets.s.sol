// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {BulgarianToto} from "../src/BulgarianToto.sol";

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Buy random 6/49 (K=8) and 5/35 (K=7) tickets.
///         Counts default to 100 each but can be overridden so a partially
///         completed run can be topped up:
///           N_649      number of 6/49 K=8 tickets   (default 100)
///           N_535      number of 5/35 K=7 tickets   (default 100)
///           SALT_NONCE extra entropy so re-runs pick fresh numbers (default 0)
///         Required env: PRIVATE_KEY, TOTO_ADDRESS, USDC_ADDRESS
contract BuyRandomTickets is Script {
    uint8 constant GAME_5_35 = 0;
    uint8 constant GAME_6_49 = 1;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address totoAddr = vm.envAddress("TOTO_ADDRESS");
        address usdcAddr = vm.envAddress("USDC_ADDRESS");

        uint256 n649 = vm.envOr("N_649", uint256(100));
        uint256 n535 = vm.envOr("N_535", uint256(100));
        uint256 saltNonce = vm.envOr("SALT_NONCE", uint256(0));

        BulgarianToto toto = BulgarianToto(totoAddr);
        IERC20Min usdc = IERC20Min(usdcAddr);
        address me = vm.addr(pk);

        // Cost: n649 * 9 USDC + n535 * 7 USDC (6 decimals).
        uint256 needed = (n649 * 9 + n535 * 7) * 1e6;
        uint256 currentAllowance = usdc.allowance(me, totoAddr);

        vm.startBroadcast(pk);

        if (currentAllowance < needed) {
            usdc.approve(totoAddr, type(uint256).max);
        }

        // n649 tickets 6/49 with K=8
        for (uint256 i = 0; i < n649; i++) {
            uint8[] memory picks = _pickRandom(49, 8, i, 0xBEEF + saltNonce);
            toto.buyTicket(GAME_6_49, picks);
        }

        // n535 tickets 5/35 with K=7
        for (uint256 i = 0; i < n535; i++) {
            uint8[] memory picks = _pickRandom(35, 7, i, 0xCAFE + saltNonce);
            toto.buyTicket(GAME_5_35, picks);
        }

        vm.stopBroadcast();

        console.log("Done. Bought 6/49:", n649);
        console.log("Done. Bought 5/35:", n535);
    }

    /// @dev Fisher-Yates partial shuffle to pick `k` unique numbers from 1..maxNum.
    function _pickRandom(uint8 maxNum, uint8 k, uint256 idx, uint256 salt)
        internal
        view
        returns (uint8[] memory out)
    {
        uint8[] memory pool = new uint8[](maxNum);
        for (uint8 i = 0; i < maxNum; i++) pool[i] = i + 1;

        out = new uint8[](k);
        for (uint256 j = 0; j < k; j++) {
            uint256 r = uint256(
                keccak256(abi.encodePacked(block.timestamp, block.prevrandao, idx, salt, j))
            ) % (maxNum - j);
            out[j] = pool[r];
            // swap picked with last available
            pool[r] = pool[maxNum - 1 - j];
        }
    }
}
