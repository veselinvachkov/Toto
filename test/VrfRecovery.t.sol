// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BulgarianToto} from "../src/BulgarianToto.sol";
import {BulgarianTotoStorage} from "../src/BulgarianTotoStorage.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockVRFCoordinator} from "./mocks/MockVRFCoordinator.sol";

/// @notice Tests for the stuck-VRF recovery path: retryDraw, the stale-request
///         guard in fulfillRandomWords, and the callbackGasLimit floor.
contract VrfRecoveryTest is Test {
    BulgarianToto internal toto;
    MockUSDC internal usdc;
    MockVRFCoordinator internal vrf;

    address internal alice = makeAddr("alice");
    address internal treasuryAddr = makeAddr("treasury");

    bytes32 constant KEY_HASH = bytes32(uint256(0xDEAD));
    uint256 constant SUB_ID = 1;
    uint16 constant CONFIRMATIONS = 3;
    uint32 constant CALLBACK_GAS = 1_000_000;

    uint64 internal firstDrawTime;

    function setUp() public {
        usdc = new MockUSDC();
        vrf = new MockVRFCoordinator();
        firstDrawTime = uint64(block.timestamp + 48 hours);
        toto = new BulgarianToto(
            address(usdc), address(vrf), KEY_HASH, SUB_ID, CONFIRMATIONS, CALLBACK_GAS, firstDrawTime, treasuryAddr
        );
        usdc.mint(alice, 1_000_000 * 1e6);
        vm.prank(alice);
        usdc.approve(address(toto), type(uint256).max);
    }

    function _buyAndRequestDraw() internal returns (uint256 reqId) {
        uint8[] memory picks = new uint8[](6);
        for (uint8 i = 0; i < 6; i++) picks[i] = i + 1;
        vm.prank(alice);
        toto.buyTicket(1, picks);
        vm.warp(firstDrawTime);
        reqId = toto.requestDraw(0);
    }

    function _fulfill(uint256 reqId) internal {
        uint256[] memory words = new uint256[](2);
        words[0] = 111;
        words[1] = 222;
        vrf.fulfill(reqId, words);
    }

    // ============================================================
    // retryDraw
    // ============================================================

    function test_RetryDraw_Reverts_BeforeTimeout() public {
        _buyAndRequestDraw();
        vm.warp(block.timestamp + toto.VRF_RETRY_TIMEOUT() - 1);
        vm.expectRevert(BulgarianTotoStorage.TooEarly.selector);
        toto.retryDraw(0);
    }

    function test_RetryDraw_Reverts_WrongState_Open() public {
        vm.expectRevert(BulgarianTotoStorage.WrongRoundState.selector);
        toto.retryDraw(0);
    }

    function test_RetryDraw_Reverts_WrongState_AfterFulfill() public {
        uint256 reqId = _buyAndRequestDraw();
        _fulfill(reqId);
        vm.warp(block.timestamp + toto.VRF_RETRY_TIMEOUT());
        vm.expectRevert(BulgarianTotoStorage.WrongRoundState.selector);
        toto.retryDraw(0);
    }

    function test_RetryDraw_ReissuesRequest_AfterTimeout() public {
        uint256 oldReq = _buyAndRequestDraw();
        vm.warp(block.timestamp + toto.VRF_RETRY_TIMEOUT());

        vm.expectEmit(true, false, false, true);
        emit BulgarianTotoStorage.DrawRetried(0, oldReq, oldReq + 1);
        uint256 newReq = toto.retryDraw(0);

        assertTrue(newReq != oldReq);
        assertEq(toto.roundVrfRequest(0), newReq);
        assertEq(toto.vrfRequestToRound(newReq), 0);
        assertEq(toto.vrfRequestToRound(oldReq), 0); // old mapping cleared
        // Round is still awaiting VRF - retry does not touch prize accounting.
        assertEq(uint8(toto.getRoundInfo(0).state), uint8(BulgarianTotoStorage.RoundState.AwaitingVRF));
    }

    function test_RetryDraw_RepeatedRetry_NeedsFreshTimeout() public {
        _buyAndRequestDraw();
        vm.warp(block.timestamp + toto.VRF_RETRY_TIMEOUT());
        toto.retryDraw(0);

        // Immediately retrying again must fail: the clock restarts per request.
        vm.expectRevert(BulgarianTotoStorage.TooEarly.selector);
        toto.retryDraw(0);

        vm.warp(block.timestamp + toto.VRF_RETRY_TIMEOUT());
        toto.retryDraw(0);
    }

    function test_StaleFulfillment_Ignored_NewRequestCompletes() public {
        uint256 oldReq = _buyAndRequestDraw();
        vm.warp(block.timestamp + toto.VRF_RETRY_TIMEOUT());
        uint256 newReq = toto.retryDraw(0);

        // The ORIGINAL request fulfills late - it must be ignored entirely.
        _fulfill(oldReq);
        assertEq(uint8(toto.getRoundInfo(0).state), uint8(BulgarianTotoStorage.RoundState.AwaitingVRF));
        assertEq(toto.getRoundInfo(0).drawn6.length, 0);

        // The retry request fulfills normally and the round progresses.
        _fulfill(newReq);
        assertEq(uint8(toto.getRoundInfo(0).state), uint8(BulgarianTotoStorage.RoundState.Tallying));
    }

    function test_RetryDraw_UsesUpdatedVrfConfig() public {
        _buyAndRequestDraw();
        vm.warp(block.timestamp + toto.VRF_RETRY_TIMEOUT());

        // Owner fixes the config (e.g. new subscription) before the retry.
        toto.setVrfConfig(KEY_HASH, 42, CONFIRMATIONS, 600_000);
        uint256 newReq = toto.retryDraw(0);
        _fulfill(newReq);
        assertEq(uint8(toto.getRoundInfo(0).state), uint8(BulgarianTotoStorage.RoundState.Tallying));
    }

    // ============================================================
    // catchUp integration
    // ============================================================

    function test_CatchUp_RetriesStuckDraw() public {
        uint256 oldReq = _buyAndRequestDraw();
        vm.warp(block.timestamp + toto.VRF_RETRY_TIMEOUT());

        uint256 actions = toto.catchUp(0, 10, 100);
        assertEq(actions, 1);
        assertTrue(toto.roundVrfRequest(0) != oldReq);
    }

    function test_CatchUp_SkipsAwaitingVrf_BeforeTimeout() public {
        uint256 oldReq = _buyAndRequestDraw();
        vm.warp(block.timestamp + toto.VRF_RETRY_TIMEOUT() - 1);

        uint256 actions = toto.catchUp(0, 10, 100);
        assertEq(actions, 0);
        assertEq(toto.roundVrfRequest(0), oldReq);
    }

    // ============================================================
    // callbackGasLimit floor
    // ============================================================

    function test_Constructor_Reverts_LowCallbackGas() public {
        uint32 tooLow = toto.MIN_CALLBACK_GAS_LIMIT() - 1;
        vm.expectRevert(BulgarianTotoStorage.CallbackGasLimitTooLow.selector);
        new BulgarianToto(
            address(usdc), address(vrf), KEY_HASH, SUB_ID, CONFIRMATIONS, tooLow, firstDrawTime, treasuryAddr
        );
    }

    function test_SetVrfConfig_Reverts_LowCallbackGas() public {
        uint32 tooLow = toto.MIN_CALLBACK_GAS_LIMIT() - 1;
        vm.expectRevert(BulgarianTotoStorage.CallbackGasLimitTooLow.selector);
        toto.setVrfConfig(KEY_HASH, SUB_ID, CONFIRMATIONS, tooLow);
    }

    function test_SetVrfConfig_AcceptsFloor() public {
        uint32 floor = toto.MIN_CALLBACK_GAS_LIMIT();
        toto.setVrfConfig(KEY_HASH, SUB_ID, CONFIRMATIONS, floor);
        assertEq(toto.callbackGasLimit(), floor);
    }

    /// @dev The floor must actually cover the most expensive callback path: a
    ///      zero-ticket round, where fulfillRandomWords also runs _finalizeRound.
    function test_MinCallbackGas_CoversZeroTicketFulfillment() public {
        // No tickets bought; round 0 draws empty.
        vm.warp(firstDrawTime);
        uint256 reqId = toto.requestDraw(0);

        uint256[] memory words = new uint256[](2);
        words[0] = 111;
        words[1] = 222;

        // Measure the callback under the exact floor budget.
        uint256 gasBefore = gasleft();
        vrf.fulfill(reqId, words);
        uint256 used = gasBefore - gasleft();

        assertLt(used, toto.MIN_CALLBACK_GAS_LIMIT());
        // Zero-ticket rounds finalize inside the callback.
        assertEq(uint8(toto.getRoundInfo(0).state), uint8(BulgarianTotoStorage.RoundState.Claimable));
    }
}
