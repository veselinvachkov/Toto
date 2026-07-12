// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {BulgarianToto} from "../src/BulgarianToto.sol";
import {BulgarianTotoStorage} from "../src/BulgarianTotoStorage.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockVRFCoordinator} from "./mocks/MockVRFCoordinator.sol";

contract BulgarianTotoTest is Test {
    BulgarianToto internal toto;
    MockUSDC internal usdc;
    MockVRFCoordinator internal vrf;

    address internal owner = address(this); // deployer
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal dave = makeAddr("dave");
    address internal treasuryAddr = makeAddr("treasury");

    bytes32 constant KEY_HASH = bytes32(uint256(0xDEAD));
    uint256 constant SUB_ID = 1;
    uint16 constant CONFIRMATIONS = 3;
    uint32 constant CALLBACK_GAS = 1_000_000;

    uint64 internal firstDrawTime;

    uint8 constant GAME_5_35 = 0;
    uint8 constant GAME_6_49 = 1;

    uint256 constant START_POOL = 100_000 * 1e6;

    function setUp() public virtual {
        usdc = new MockUSDC();
        vrf = new MockVRFCoordinator();
        firstDrawTime = uint64(block.timestamp + 48 hours);
        toto = new BulgarianToto(
            address(usdc), address(vrf), KEY_HASH, SUB_ID, CONFIRMATIONS, CALLBACK_GAS, firstDrawTime, treasuryAddr
        );

        // Fund users
        address[4] memory users = [alice, bob, carol, dave];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 1_000_000 * 1e6);
            vm.prank(users[i]);
            usdc.approve(address(toto), type(uint256).max);
        }
        // Donate a starting cumulative pool to make jackpot tests non-zero.
        usdc.mint(address(this), START_POOL);
        usdc.approve(address(toto), type(uint256).max);
        toto.donate(START_POOL);
    }

    // ============================================================
    // HELPERS
    // ============================================================

    /// @dev Mirrors BulgarianToto._drawNumbersToMask so the test can craft
    ///      tickets that match the deterministic VRF output.
    function _expectedDraw(uint256 randomWord, uint8 maxNum, uint8 count)
        internal
        pure
        returns (uint64 mask, uint8[] memory drawn)
    {
        uint8[] memory pool = new uint8[](maxNum);
        for (uint8 i = 0; i < maxNum; i++) {
            pool[i] = i + 1;
        }
        drawn = new uint8[](count);
        for (uint8 i = 0; i < count; i++) {
            uint256 rand = uint256(keccak256(abi.encode(randomWord, i)));
            uint8 j = i + uint8(rand % uint256(uint8(maxNum - i)));
            (pool[i], pool[j]) = (pool[j], pool[i]);
            drawn[i] = pool[i];
            mask |= (uint64(1) << pool[i]);
        }
    }

    function _picks5_35Base(uint8 a, uint8 b, uint8 c, uint8 d, uint8 e)
        internal
        pure
        returns (uint8[] memory p)
    {
        p = new uint8[](5);
        p[0] = a;
        p[1] = b;
        p[2] = c;
        p[3] = d;
        p[4] = e;
    }

    function _picks6_49Base(uint8 a, uint8 b, uint8 c, uint8 d, uint8 e, uint8 f)
        internal
        pure
        returns (uint8[] memory p)
    {
        p = new uint8[](6);
        p[0] = a;
        p[1] = b;
        p[2] = c;
        p[3] = d;
        p[4] = e;
        p[5] = f;
    }

    function _runDraw(uint256 seed5, uint256 seed6) internal returns (uint256 reqId) {
        vm.warp(firstDrawTime);
        reqId = toto.requestDraw(0);
        uint256[] memory words = new uint256[](2);
        words[0] = seed5;
        words[1] = seed6;
        vrf.fulfill(reqId, words);
    }

    /// @dev Draw + fulfill whatever round is currently open, warping to its drawTime first.
    function _drawCurrent(uint256 seed5, uint256 seed6) internal {
        uint256 roundId = toto.currentRoundId();
        vm.warp(toto.getRoundInfo(roundId).drawTime);
        uint256 reqId = toto.requestDraw(roundId);
        uint256[] memory words = new uint256[](2);
        words[0] = seed5;
        words[1] = seed6;
        vrf.fulfill(reqId, words);
    }

    /// @dev Cumulative-pool snapshot captured for a round at requestDraw.
    function _poolSnap(uint256 roundId) internal view returns (uint256) {
        return uint256(toto.getRoundInfo(roundId).poolSnapshot);
    }

    function _findNonWinningNumber5_35(uint64 drawnMask) internal pure returns (uint8) {
        for (uint8 i = 1; i <= 35; i++) {
            if ((drawnMask & (uint64(1) << i)) == 0) return i;
        }
        revert("no free");
    }

    function _findNonWinningNumber6_49(uint64 drawnMask) internal pure returns (uint8) {
        for (uint8 i = 1; i <= 49; i++) {
            if ((drawnMask & (uint64(1) << i)) == 0) return i;
        }
        revert("no free");
    }

    function _maskOf(uint8[] memory nums) internal pure returns (uint64 mask) {
        for (uint256 i = 0; i < nums.length; i++) {
            mask |= (uint64(1) << nums[i]);
        }
    }

    // ============================================================
    // BUY / VALIDATION TESTS
    // ============================================================

    function test_BuyTicket_5of35_Base() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        assertEq(id, 0);
        // Buying does not touch the cumulative pool; it accrues to the round's game stake.
        assertEq(toto.cumulativePool(), START_POOL);
        assertEq(uint256(toto.getRoundInfo(0).stake5), 1_500_000);
        assertEq(toto.roundTicketCount(0), 1);
    }

    function test_BuyTicket_6of49_Plus2() public {
        uint8[] memory picks = new uint8[](8);
        for (uint8 i = 0; i < 8; i++) {
            picks[i] = i + 1;
        }
        vm.prank(bob);
        toto.buyTicket(GAME_6_49, picks);
        assertEq(toto.cumulativePool(), START_POOL);
        assertEq(uint256(toto.getRoundInfo(0).stake6), 21 * 1e6);
    }

    function test_BuyTicket_Reverts_OnInvalidGame() public {
        vm.expectRevert(BulgarianTotoStorage.InvalidGame.selector);
        vm.prank(alice);
        toto.buyTicket(2, _picks5_35Base(1, 2, 3, 4, 5));
    }

    function test_BuyTicket_Reverts_OnInvalidPickCount() public {
        uint8[] memory picks = new uint8[](4);
        for (uint8 i = 0; i < 4; i++) {
            picks[i] = i + 1;
        }
        vm.expectRevert(BulgarianTotoStorage.InvalidPickCount.selector);
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, picks);
    }

    function test_BuyTicket_Reverts_OnDuplicateNumbers() public {
        uint8[] memory picks = _picks5_35Base(1, 2, 2, 4, 5);
        vm.expectRevert(BulgarianTotoStorage.DuplicateNumber.selector);
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, picks);
    }

    function test_BuyTicket_Reverts_OnOutOfRangeNumber() public {
        uint8[] memory picks = _picks5_35Base(1, 2, 3, 4, 36);
        vm.expectRevert(BulgarianTotoStorage.InvalidNumber.selector);
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, picks);
    }

    function test_BuyTicket_Reverts_OnZeroNumber() public {
        uint8[] memory picks = _picks5_35Base(0, 2, 3, 4, 5);
        vm.expectRevert(BulgarianTotoStorage.InvalidNumber.selector);
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, picks);
    }

    function test_BuyTicket_Reverts_AfterPurchaseCutoff() public {
        vm.warp(firstDrawTime - 30 minutes); // inside the 1h cutoff
        vm.expectRevert(BulgarianTotoStorage.PurchaseWindowClosed.selector);
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
    }

    function test_BuyTicket_Reverts_WhenPaused() public {
        toto.pause();
        vm.expectRevert();
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
    }

    // ============================================================
    // PAUSE TESTS
    // ============================================================

    function test_Pause_OnlyOwner() public {
        vm.expectRevert();
        vm.prank(alice);
        toto.pause();
    }

    function test_Donate_Works_WhenPaused() public {
        toto.pause();
        vm.prank(alice);
        toto.donate(1e6);
    }

    function test_Refund_WorksWhilePaused() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        uint256 balBefore = usdc.balanceOf(alice);
        toto.pause();
        vm.prank(alice);
        toto.refund(id);
        assertEq(usdc.balanceOf(alice), balBefore + 1_500_000);
    }

    // ============================================================
    // REFUND TESTS
    // ============================================================

    function test_Refund_Within1Hour_Succeeds() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        uint256 balBefore = usdc.balanceOf(alice);
        vm.warp(block.timestamp + 30 minutes);
        vm.prank(alice);
        toto.refund(id);
        assertEq(usdc.balanceOf(alice), balBefore + 1_500_000);
        // Refund reverses the round stake; pool untouched.
        assertEq(uint256(toto.getRoundInfo(0).stake5), 0);
        assertEq(toto.cumulativePool(), START_POOL);
    }

    function test_Refund_AfterWindow_Reverts() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        vm.warp(block.timestamp + 1 hours + 1);
        vm.expectRevert(BulgarianTotoStorage.RefundWindowClosed.selector);
        vm.prank(alice);
        toto.refund(id);
    }

    function test_Refund_AfterPurchaseWindowClosed_Reverts() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        vm.warp(firstDrawTime - 30 minutes); // within 1h-of-purchase yet outside buy window
        vm.expectRevert(BulgarianTotoStorage.RefundWindowClosed.selector);
        vm.prank(alice);
        toto.refund(id);
    }

    function test_Refund_NonOwner_Reverts() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        vm.expectRevert(BulgarianTotoStorage.NotOwner.selector);
        vm.prank(bob);
        toto.refund(id);
    }

    function test_Refund_DoubleRefund_Reverts() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        vm.prank(alice);
        toto.refund(id);
        vm.expectRevert(BulgarianTotoStorage.AlreadySettled.selector);
        vm.prank(alice);
        toto.refund(id);
    }

    // ============================================================
    // DONATE
    // ============================================================

    function test_Donate_GrowsPool() public {
        uint256 before = toto.cumulativePool();
        vm.prank(alice);
        toto.donate(50 * 1e6);
        assertEq(toto.cumulativePool(), before + 50 * 1e6);
    }

    function test_Donate_RevertsOnZero() public {
        vm.expectRevert(BulgarianTotoStorage.AmountZero.selector);
        vm.prank(alice);
        toto.donate(0);
    }

    // ============================================================
    // DRAW + VRF FLOW
    // ============================================================

    function test_RequestDraw_TooEarly_Reverts() public {
        vm.expectRevert(BulgarianTotoStorage.TooEarly.selector);
        toto.requestDraw(0);
    }

    function test_RequestDraw_SplitsFundsAndEarmarks() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5)); // stake5 = 3e6

        vm.warp(firstDrawTime);
        uint256 poolBefore = toto.cumulativePool(); // START_POOL donation
        uint256 treasuryBefore = usdc.balanceOf(treasuryAddr);
        toto.requestDraw(0);

        assertEq(toto.currentRoundId(), 1);

        uint256 stake = 1_500_000;
        uint256 total = stake;
        uint256 fee = total * toto.TREASURY_BPS() / 10000;            // 2%
        uint256 lowerReserve = stake * toto.LOWER_FUND_BPS() / 10000; // 50% of 5/35 stake
        uint256 poolAdd = total - fee - lowerReserve;                 // 48% to pool
        uint256 snap = poolBefore + poolAdd;
        uint256 jackEarmark = snap * toto.MAX_JACKPOT_BPS() / 10000;  // 60% of snapshot

        assertEq(usdc.balanceOf(treasuryAddr) - treasuryBefore, fee);
        assertEq(_poolSnap(0), snap);
        assertEq(toto.earmarkedForRound(0), lowerReserve + jackEarmark);
        assertEq(toto.cumulativePool(), snap - jackEarmark);
    }

    function test_AnyoneCanRequestDraw() public {
        vm.warp(firstDrawTime);
        vm.prank(alice);
        toto.requestDraw(0);
        assertEq(toto.currentRoundId(), 1);
    }

    function test_NextRoundDrawTimeIsPlusDefaultInterval() public {
        vm.warp(firstDrawTime);
        toto.requestDraw(0);
        // Default cadence is 2 days.
        assertEq(toto.drawInterval(), 2 days);
        assertEq(toto.getRoundInfo(1).drawTime, firstDrawTime + 2 days);
    }

    // ============================================================
    // ADMIN: DRAW INTERVAL (default 2 days, change effective after 2 draws)
    // ============================================================

    function test_DefaultDrawIntervalIs2Days() public view {
        assertEq(toto.drawInterval(), 2 days);
        assertEq(toto.DEFAULT_DRAW_INTERVAL(), 2 days);
    }

    function test_SetDrawInterval_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        toto.setDrawInterval(5 days);
    }

    // ============================================================
    // SET TICKET PRICE TESTS
    // ============================================================

    event TicketPriceChanged(uint8 indexed game, uint8 indexed k, uint256 oldPrice, uint256 newPrice);

    function test_SetTicketPrice_OnlyOwner() public {
        vm.prank(alice);
        vm.expectRevert();
        toto.setTicketPrice(GAME_5_35, 5, 2_000_000);
    }

    function test_SetTicketPrice_UpdatesPriceAndEmits() public {
        assertEq(toto.ticketPrice(GAME_5_35, 5), 1_500_000);

        vm.expectEmit(true, true, false, true);
        emit TicketPriceChanged(GAME_5_35, 5, 1_500_000, 3_000_000);
        toto.setTicketPrice(GAME_5_35, 5, 3_000_000);

        assertEq(toto.ticketPrice(GAME_5_35, 5), 3_000_000);
        // Other prices are untouched.
        assertEq(toto.ticketPrice(GAME_6_49, 8), 21 * 1e6);
    }

    function test_SetTicketPrice_NewPriceUsedOnBuy() public {
        toto.setTicketPrice(GAME_5_35, 5, 4_000_000);

        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        // The round stake reflects the NEW price, not the old default.
        assertEq(uint256(toto.getRoundInfo(0).stake5), 4_000_000);
    }

    function test_SetTicketPrice_Rejects_Zero() public {
        vm.expectRevert(BulgarianTotoStorage.InvalidPrice.selector);
        toto.setTicketPrice(GAME_5_35, 5, 0);
    }

    function test_SetTicketPrice_Rejects_AboveUint128Max() public {
        vm.expectRevert(BulgarianTotoStorage.InvalidPrice.selector);
        toto.setTicketPrice(GAME_5_35, 5, uint256(type(uint128).max) + 1);
    }

    function test_SetTicketPrice_Rejects_InvalidPickCount() public {
        // K=8 is not valid for the 5/35 game.
        vm.expectRevert(BulgarianTotoStorage.InvalidPickCount.selector);
        toto.setTicketPrice(GAME_5_35, 8, 2_000_000);
    }

    function test_SetDrawInterval_RejectsOutOfRange() public {
        uint256 minI = toto.MIN_DRAW_INTERVAL();
        uint256 maxI = toto.MAX_DRAW_INTERVAL();

        vm.expectRevert(BulgarianTotoStorage.IntervalOutOfRange.selector);
        toto.setDrawInterval(minI - 1);

        vm.expectRevert(BulgarianTotoStorage.IntervalOutOfRange.selector);
        toto.setDrawInterval(maxI + 1);
    }

    function test_SetDrawInterval_QueuesAndDoesNotApplyImmediately() public {
        toto.setDrawInterval(5 days);
        // Queued, but the active interval is unchanged until activation.
        assertEq(toto.drawInterval(), 2 days);
        assertEq(toto.pendingDrawInterval(), 5 days);
        assertEq(toto.pendingIntervalActiveRound(), 2); // currentRoundId(0) + 2
    }

    function test_SetDrawInterval_TakesEffectAfterTwoDraws() public {
        // currentRound = 0. Queue a change to 5 days.
        toto.setDrawInterval(5 days);

        // Draw 0 -> opens round 1. nextId(1) < activeRound(2): still the old 2-day spacing.
        uint64 t0 = toto.getRoundInfo(0).drawTime;
        _drawCurrent(0xA, 0xB);
        assertEq(toto.drawInterval(), 2 days, "interval must not change on first draw");
        assertEq(toto.getRoundInfo(1).drawTime, t0 + 2 days);

        // Draw 1 -> opens round 2. nextId(2) >= activeRound(2): new 5-day spacing activates.
        uint64 t1 = toto.getRoundInfo(1).drawTime;
        _drawCurrent(0xC, 0xD);
        assertEq(toto.drawInterval(), 5 days, "interval must activate on second draw");
        assertEq(toto.pendingDrawInterval(), 0, "pending must be cleared after activation");
        assertEq(toto.getRoundInfo(2).drawTime, t1 + 5 days);

        // Draw 2 -> opens round 3: continues at the new 5-day spacing.
        uint64 t2 = toto.getRoundInfo(2).drawTime;
        _drawCurrent(0xE, 0xF);
        assertEq(toto.getRoundInfo(3).drawTime, t2 + 5 days);
    }

    // ============================================================
    // FULL FLOW: 5/35 JACKPOT (5 numbers = % of cumulative pool)
    // ============================================================

    function test_HappyPath_5of35_Jackpot() public {
        uint256 seed5 = 0xAAAA;
        uint256 seed6 = 0xBBBB;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);

        vm.prank(alice);
        uint256 ticketId = toto.buyTicket(GAME_5_35, drawn5);

        _runDraw(seed5, seed6);
        uint256 snap = _poolSnap(0);

        toto.tallyBatch(0, 100);

        uint256 expected = snap * toto.JACKPOT_BPS_5_35() / 10000; // 10% of pool snapshot
        assertEq(toto.previewClaim(ticketId), expected);

        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        toto.claim(ticketId);
        assertEq(usdc.balanceOf(alice) - balBefore, expected);
    }

    // ============================================================
    // FULL FLOW: 6/49 JACKPOT (6 numbers = % of cumulative pool)
    // ============================================================

    function test_HappyPath_6of49_Jackpot() public {
        uint256 seed5 = 0xCAFE;
        uint256 seed6 = 0xBEEF;
        (, uint8[] memory drawn6) = _expectedDraw(seed6, 49, 6);

        vm.prank(bob);
        uint256 ticketId = toto.buyTicket(GAME_6_49, drawn6);

        _runDraw(seed5, seed6);
        uint256 snap = _poolSnap(0);
        toto.tallyBatch(0, 100);

        uint256 expected = snap * toto.JACKPOT_BPS_6_49() / 10000; // 50% of pool snapshot
        uint256 balBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        toto.claim(ticketId);
        assertEq(usdc.balanceOf(bob) - balBefore, expected);
    }

    // ============================================================
    // LOWER TIER: 6/49 four-number prize = % of 6/49 round stake
    // ============================================================

    function test_LowerTier_6of49_FourNumbers_FromGameStake() public {
        uint256 seed5 = 0x1234;
        uint256 seed6 = 0x5678;
        (uint64 mask6, uint8[] memory drawn6) = _expectedDraw(seed6, 49, 6);

        // Build a base 6/49 ticket matching exactly 4 drawn numbers (tier 4).
        uint8 miss1 = _findNonWinningNumber6_49(mask6);
        uint8 miss2 = miss1 + 1;
        while ((mask6 & (uint64(1) << miss2)) != 0 || miss2 > 49) {
            miss2++;
        }
        uint8[] memory picks = _picks6_49Base(drawn6[0], drawn6[1], drawn6[2], drawn6[3], miss1, miss2);

        // A second whale 6/49 ticket so the round stake (and thus the tier-4 budget) is sizeable.
        uint8[] memory whale = new uint8[](8);
        for (uint8 i = 0; i < 8; i++) {
            whale[i] = 30 + i; // arbitrary high numbers, not all drawn
        }

        vm.prank(alice);
        uint256 ticketId = toto.buyTicket(GAME_6_49, picks); // 4 USDC base
        vm.prank(bob);
        toto.buyTicket(GAME_6_49, whale); // 9 USDC +2

        _runDraw(seed5, seed6);
        uint256 stake6 = uint256(toto.getRoundInfo(0).stake6);
        toto.tallyBatch(0, 100);

        // Tier-4 budget = stake6 * LBPS_6_49_TIER4. Alice is the only tier-4 winner here
        // (her 4 matches; the whale's high numbers don't form a 4-of-6 hit on this draw).
        // The assertion below is robust regardless: she gets budget * herHits / totalHits.
        uint256 tier4Budget = stake6 * toto.LBPS_6_49_TIER4() / 10000;
        assertTrue(tier4Budget > 0);

        uint256 preview = toto.previewClaim(ticketId);
        assertTrue(preview > 0, "alice should win the 4-number tier");
        assertTrue(preview <= tier4Budget, "payout cannot exceed the tier budget");
    }

    // ============================================================
    // PRO-RATA SPLIT (two 5/35 jackpot winners)
    // ============================================================

    function test_ProRata_TwoJackpotWinners_5of35() public {
        uint256 seed5 = 0x1111;
        uint256 seed6 = 0x2222;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);

        vm.prank(alice);
        uint256 idA = toto.buyTicket(GAME_5_35, drawn5);
        vm.prank(bob);
        uint256 idB = toto.buyTicket(GAME_5_35, drawn5);

        _runDraw(seed5, seed6);
        uint256 snap = _poolSnap(0);
        toto.tallyBatch(0, 100);

        uint256 totalPrize = snap * toto.JACKPOT_BPS_5_35() / 10000;
        uint256 perWinner = totalPrize / 2;

        vm.prank(alice);
        toto.claim(idA);
        vm.prank(bob);
        toto.claim(idB);

        assertEq(usdc.balanceOf(alice), 1_000_000 * 1e6 - 1_500_000 + perWinner);
        assertEq(usdc.balanceOf(bob), 1_000_000 * 1e6 - 1_500_000 + perWinner);
    }

    // ============================================================
    // SYSTEM TICKET (+2): sub-ticket math across jackpot + lower tiers
    // ============================================================

    function test_SystemTicket_5of35_Plus2_AllFiveDrawnInside() public {
        uint256 seed5 = 0x9999;
        uint256 seed6 = 0x8888;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);

        // Build a 7-pick ticket: all 5 drawn numbers + 2 non-drawn extras.
        uint8[] memory picks = new uint8[](7);
        for (uint8 i = 0; i < 5; i++) {
            picks[i] = drawn5[i];
        }
        uint8 extra1 = _findNonWinningNumber5_35(_maskOf(drawn5));
        uint8 extra2 = extra1 + 1;
        while ((_maskOf(drawn5) & (uint64(1) << extra2)) != 0 || extra2 > 35) {
            extra2++;
        }
        picks[5] = extra1;
        picks[6] = extra2;

        vm.prank(alice);
        uint256 ticketId = toto.buyTicket(GAME_5_35, picks);

        _runDraw(seed5, seed6);
        uint256 snap = _poolSnap(0);
        uint256 stake5 = uint256(toto.getRoundInfo(0).stake5); // 7 USDC (the only ticket)
        toto.tallyBatch(0, 100);

        // m = 5 hits across 7 picks -> sub-ticket distribution:
        //   tier 5 (jackpot) hits: C(5,5)*C(2,0) = 1   -> budget = snap  * JACKPOT_BPS_5_35
        //   tier 4 (lower)   hits: C(5,4)*C(2,1) = 10   -> budget = stake5 * LBPS_5_35_TIER4
        //   tier 3 (lower)   hits: C(5,3)*C(2,2) = 10   -> budget = stake5 * LBPS_5_35_TIER3
        // Alice is the only ticket in each tier -> she takes each tier budget in full.
        uint256 expected =
            snap * toto.JACKPOT_BPS_5_35() / 10000
                + stake5 * toto.LBPS_5_35_TIER4() / 10000
                + stake5 * toto.LBPS_5_35_TIER3() / 10000;
        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        toto.claim(ticketId);
        assertEq(usdc.balanceOf(alice) - balBefore, expected);
    }

    // ============================================================
    // ROLLOVER: unwon jackpot stays in the pool
    // ============================================================

    function test_Rollover_NoJackpotWinner_PoolGrows() public {
        // Buy only losing tickets so neither jackpot is hit; the pool should retain its
        // earmarked jackpot (rollover) plus the 48% contribution from the round stakes.
        uint256 seed5 = 0x4242;
        uint256 seed6 = 0x4343;
        (uint64 mask5,) = _expectedDraw(seed5, 35, 5);

        // 5 numbers that are NOT drawn -> 0 matches.
        uint8[] memory picks = new uint8[](5);
        uint256 placed = 0;
        for (uint8 i = 1; i <= 35 && placed < 5; i++) {
            if ((mask5 & (uint64(1) << i)) == 0) picks[placed++] = i;
        }
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, picks);

        uint256 poolBeforeDraw = toto.cumulativePool();
        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);

        // No winners at all -> all reserved funds roll back into the pool.
        // Final pool = poolBeforeDraw + 48% of stake (treasury took 2%, lower funds had
        // no winners so they also rolled in, jackpot unwon so its earmark rolled back).
        uint256 stake = 1_500_000;
        uint256 fee = stake * toto.TREASURY_BPS() / 10000;
        assertEq(toto.cumulativePool(), poolBeforeDraw + stake - fee);
        assertEq(toto.earmarkedForRound(0), 0);
    }

    // ============================================================
    // CLAIM ERROR PATHS
    // ============================================================

    function test_Claim_NonWinner_Reverts() public {
        uint256 seed5 = 0x4242;
        uint256 seed6 = 0x4343;
        (uint64 mask5,) = _expectedDraw(seed5, 35, 5);

        uint8[] memory picks = new uint8[](5);
        uint256 placed = 0;
        for (uint8 i = 1; i <= 35 && placed < 5; i++) {
            if ((mask5 & (uint64(1) << i)) == 0) {
                picks[placed++] = i;
            }
        }
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, picks);

        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);

        vm.expectRevert(BulgarianTotoStorage.NothingToClaim.selector);
        vm.prank(alice);
        toto.claim(id);
    }

    function test_Claim_BeforeFinalize_Reverts() public {
        uint256 seed5 = 0x7;
        uint256 seed6 = 0x8;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, drawn5);
        _runDraw(seed5, seed6);
        // tally NOT called -> still Tallying, not Claimable
        vm.expectRevert(BulgarianTotoStorage.WrongRoundState.selector);
        vm.prank(alice);
        toto.claim(id);
    }

    // ============================================================
    // SWEEP EXPIRED
    // ============================================================

    function test_Sweep_ReturnsLeftoverToPool() public {
        uint256 seed5 = 0x77;
        uint256 seed6 = 0x88;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, drawn5);

        _runDraw(seed5, seed6);
        uint256 snap = _poolSnap(0);
        toto.tallyBatch(0, 100);

        uint256 prize = snap * toto.JACKPOT_BPS_5_35() / 10000;
        uint256 poolAfterFinalize = toto.cumulativePool();

        // Alice never claims. Warp past expiry.
        vm.warp(uint256(firstDrawTime) + 365 days);
        toto.sweepExpired(0);

        assertEq(toto.cumulativePool(), poolAfterFinalize + prize);

        // After sweep, claim must revert.
        vm.expectRevert(BulgarianTotoStorage.WrongRoundState.selector);
        vm.prank(alice);
        toto.claim(id);
    }

    function test_Sweep_TooEarly_Reverts() public {
        uint256 seed5 = 0x55;
        uint256 seed6 = 0x66;
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);
        vm.expectRevert(BulgarianTotoStorage.TooEarly.selector);
        toto.sweepExpired(0);
    }

    // ============================================================
    // POOL ACCOUNTING INVARIANT
    // ============================================================

    function test_PoolPlusEarmarks_EqualsContractBalance() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        vm.prank(bob);
        toto.buyTicket(GAME_6_49, _picks6_49Base(1, 2, 3, 4, 5, 6));
        vm.prank(carol);
        toto.donate(123 * 1e6);

        _runDraw(0xABC, 0xDEF);
        toto.tallyBatch(0, 100);

        // Right after finalize (before any claim): contract balance is exactly the
        // cumulative pool plus whatever is still earmarked for the finalized round.
        uint256 sum = toto.cumulativePool() + toto.earmarkedForRound(0);
        assertEq(usdc.balanceOf(address(toto)), sum);
    }

    // ============================================================
    // TICKET TRANSFER
    // ============================================================

    function test_TransferTicket_UpdatesOwner() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));

        vm.prank(alice);
        toto.transferTicket(id, bob);

        (address newOwner,,,,,,,,) = toto.tickets(id);
        assertEq(newOwner, bob);
    }

    function test_TransferTicket_NewOwnerCanClaim() public {
        uint256 seed5 = 0xAAAA;
        uint256 seed6 = 0xBBBB;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);

        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, drawn5);

        vm.prank(alice);
        toto.transferTicket(id, bob);

        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);

        uint256 balBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        toto.claim(id);
        assertTrue(usdc.balanceOf(bob) > balBefore);
    }

    function test_TransferTicket_OldOwnerCannotClaim() public {
        uint256 seed5 = 0xAAAA;
        uint256 seed6 = 0xBBBB;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);

        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, drawn5);
        vm.prank(alice);
        toto.transferTicket(id, bob);

        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);

        vm.expectRevert(BulgarianTotoStorage.NotOwner.selector);
        vm.prank(alice);
        toto.claim(id);
    }

    function test_TransferTicket_Reverts_NonOwner() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));

        vm.expectRevert(BulgarianTotoStorage.NotOwner.selector);
        vm.prank(bob);
        toto.transferTicket(id, carol);
    }

    function test_TransferTicket_Reverts_ZeroAddress() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));

        vm.expectRevert();
        vm.prank(alice);
        toto.transferTicket(id, address(0));
    }

    function test_TransferTicket_Reverts_AlreadyClaimed() public {
        uint256 seed5 = 0xAAAA;
        uint256 seed6 = 0xBBBB;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);

        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, drawn5);
        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);

        vm.prank(alice);
        toto.claim(id);

        vm.expectRevert(BulgarianTotoStorage.AlreadySettled.selector);
        vm.prank(alice);
        toto.transferTicket(id, bob);
    }

    function test_TransferTicket_Reverts_AlreadyRefunded() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));

        vm.prank(alice);
        toto.refund(id);

        vm.expectRevert(BulgarianTotoStorage.AlreadySettled.selector);
        vm.prank(alice);
        toto.transferTicket(id, bob);
    }

    // ============================================================
    // BATCH CLAIM
    // ============================================================

    function test_ClaimBatch_MultipleWinners() public {
        uint256 seed5 = 0x1111;
        uint256 seed6 = 0x2222;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);

        vm.prank(alice);
        uint256 idA = toto.buyTicket(GAME_5_35, drawn5);
        vm.prank(alice);
        uint256 idB = toto.buyTicket(GAME_5_35, drawn5);

        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);

        uint256[] memory ids = new uint256[](2);
        ids[0] = idA;
        ids[1] = idB;

        uint256 balBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 total = toto.claimBatch(ids);
        assertEq(usdc.balanceOf(alice) - balBefore, total);
        assertTrue(total > 0);
    }

    function test_ClaimBatch_Reverts_AllZeroPayout() public {
        uint256 seed5 = 0x4242;
        uint256 seed6 = 0x4343;
        (uint64 mask5,) = _expectedDraw(seed5, 35, 5);

        uint8[] memory picks = new uint8[](5);
        uint256 placed = 0;
        for (uint8 i = 1; i <= 35 && placed < 5; i++) {
            if ((mask5 & (uint64(1) << i)) == 0) {
                picks[placed++] = i;
            }
        }

        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, picks);
        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);

        uint256[] memory ids = new uint256[](1);
        ids[0] = id;

        vm.expectRevert(BulgarianTotoStorage.NothingToClaim.selector);
        vm.prank(alice);
        toto.claimBatch(ids);
    }

    // ============================================================
    // FRONTEND HELPERS
    // ============================================================

    function test_GetRoundInfo() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        vm.prank(bob);
        toto.buyTicket(GAME_6_49, _picks6_49Base(1, 2, 3, 4, 5, 6));

        BulgarianTotoStorage.RoundInfo memory info = toto.getRoundInfo(0);
        assertEq(info.drawTime, firstDrawTime);
        assertEq(uint8(info.state), uint8(BulgarianTotoStorage.RoundState.Open));
        assertEq(info.ticketCount, 2);
        assertEq(uint256(info.stake5), 1_500_000);
        assertEq(uint256(info.stake6), 2_500_000);
    }

    function test_GetRoundTiers_AfterFinalize() public {
        uint256 seed5 = 0xAAAA;
        uint256 seed6 = 0xBBBB;
        (, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);

        vm.prank(alice);
        toto.buyTicket(GAME_5_35, drawn5);
        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);

        (BulgarianTotoStorage.TierState[3] memory t5,) = toto.getRoundTiers(0);
        // Tier 5 (index 2) is the jackpot tier; alice hit it.
        assertTrue(t5[2].budget > 0);
        assertEq(t5[2].totalHits, 1);
    }

    function test_GetUserTickets() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        vm.prank(alice);
        toto.buyTicket(GAME_6_49, _picks6_49Base(1, 2, 3, 4, 5, 6));

        uint256[] memory ids = toto.getUserTickets(alice);
        assertEq(ids.length, 2);
    }

    function test_GetUserTickets_IncludesTransferred() public {
        vm.prank(alice);
        uint256 id = toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        vm.prank(alice);
        toto.transferTicket(id, bob);

        uint256[] memory bobIds = toto.getUserTickets(bob);
        assertEq(bobIds.length, 1);
        assertEq(bobIds[0], id);
    }

    function test_IsWinner() public {
        uint256 seed5 = 0xAAAA;
        uint256 seed6 = 0xBBBB;
        (uint64 mask5, uint8[] memory drawn5) = _expectedDraw(seed5, 35, 5);

        vm.prank(alice);
        uint256 winId = toto.buyTicket(GAME_5_35, drawn5);

        uint8[] memory losingPicks = new uint8[](5);
        uint256 placed = 0;
        for (uint8 i = 1; i <= 35 && placed < 5; i++) {
            if ((mask5 & (uint64(1) << i)) == 0) {
                losingPicks[placed++] = i;
            }
        }
        vm.prank(bob);
        uint256 loseId = toto.buyTicket(GAME_5_35, losingPicks);

        _runDraw(seed5, seed6);
        toto.tallyBatch(0, 100);

        assertTrue(toto.isWinner(winId));
        assertFalse(toto.isWinner(loseId));
    }

    // ============================================================
    // CATCH-UP
    // ============================================================

    function test_CatchUp_OpenWithPassedDrawTime_TriggersRequestDraw() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));

        vm.warp(firstDrawTime + 30 days);

        uint256 cur = toto.currentRoundId();
        uint256 actions = toto.catchUp(0, 50, 500);

        assertEq(actions, 1, "exactly one requestDraw per catchUp call");
        BulgarianTotoStorage.RoundInfo memory r0 = toto.getRoundInfo(0);
        assertEq(uint8(r0.state), uint8(BulgarianTotoStorage.RoundState.AwaitingVRF));
        assertEq(toto.currentRoundId(), cur + 1);
    }

    function test_CatchUp_TallyingRound_FinalizesIt() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));

        _runDraw(0xAAAA, 0xBBBB);

        BulgarianTotoStorage.RoundInfo memory rBefore = toto.getRoundInfo(0);
        assertEq(uint8(rBefore.state), uint8(BulgarianTotoStorage.RoundState.Tallying));

        uint256 actions = toto.catchUp(0, 10, 500);
        assertEq(actions, 1, "should have done 1 action: tallyBatch");

        BulgarianTotoStorage.RoundInfo memory rAfter = toto.getRoundInfo(0);
        assertEq(uint8(rAfter.state), uint8(BulgarianTotoStorage.RoundState.Claimable));
    }

    function test_CatchUp_ExpiredClaimable_TriggersSweep() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        _runDraw(0xAAAA, 0xBBBB);
        toto.tallyBatch(0, 500);

        BulgarianTotoStorage.RoundInfo memory r = toto.getRoundInfo(0);
        vm.warp(r.expiryTime + 1);

        uint256 actions = toto.catchUp(0, 1, 500);
        assertEq(actions, 1, "should have done 1 action: sweepExpired");

        BulgarianTotoStorage.RoundInfo memory rAfter = toto.getRoundInfo(0);
        assertEq(uint8(rAfter.state), uint8(BulgarianTotoStorage.RoundState.Expired));
    }

    function test_CatchUp_AwaitingVRF_SkipsSilently() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));

        vm.warp(firstDrawTime);
        toto.requestDraw(0);

        BulgarianTotoStorage.RoundInfo memory r0 = toto.getRoundInfo(0);
        assertEq(uint8(r0.state), uint8(BulgarianTotoStorage.RoundState.AwaitingVRF));

        uint256 actions = toto.catchUp(0, 10, 500);
        assertEq(actions, 0, "AwaitingVRF must be skipped");

        BulgarianTotoStorage.RoundInfo memory r0After = toto.getRoundInfo(0);
        assertEq(uint8(r0After.state), uint8(BulgarianTotoStorage.RoundState.AwaitingVRF));
    }

    function test_CatchUp_Idempotent() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        _runDraw(0xAAAA, 0xBBBB);
        toto.tallyBatch(0, 500);

        uint256 actions = toto.catchUp(0, 10, 500);
        assertEq(actions, 0, "settled state should not produce actions");
    }

    function test_CatchUp_HandlesMultipleStatesInOneCall() public {
        vm.prank(alice);
        toto.buyTicket(GAME_5_35, _picks5_35Base(1, 2, 3, 4, 5));
        _runDraw(0xAAAA, 0xBBBB);

        BulgarianTotoStorage.RoundInfo memory r1 = toto.getRoundInfo(1);
        vm.warp(r1.drawTime + 1);

        uint256 actions = toto.catchUp(0, 50, 500);
        assertEq(actions, 2, "should have tallied round 0 AND requested draw on round 1");

        BulgarianTotoStorage.RoundInfo memory r0After = toto.getRoundInfo(0);
        BulgarianTotoStorage.RoundInfo memory r1After = toto.getRoundInfo(1);
        assertEq(uint8(r0After.state), uint8(BulgarianTotoStorage.RoundState.Claimable));
        assertEq(uint8(r1After.state), uint8(BulgarianTotoStorage.RoundState.AwaitingVRF));
    }
}
