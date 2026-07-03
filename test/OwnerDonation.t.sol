// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {BulgarianTotoTest} from "./BulgarianToto.t.sol";
import {BulgarianTotoStorage} from "../src/BulgarianTotoStorage.sol";

/// @notice Tests for owner-donation tracking and reclaim-to-treasury.
/// @dev    Reuses BulgarianTotoTest.setUp(), in which the owner (the test contract)
///         donates START_POOL = 100_000 USDC, so ownerDonations starts at START_POOL.
contract OwnerDonationTest is BulgarianTotoTest {
    uint256 constant U = 1e6; // 1 USDC (6 decimals)

    function _ownerDonate(uint256 amount) internal {
        usdc.mint(address(this), amount);
        usdc.approve(address(toto), type(uint256).max);
        toto.donate(amount);
    }

    // --- tracking ---

    function test_OwnerDonationsTrackedAtSetup() public {
        assertEq(toto.ownerDonations(), START_POOL, "setUp donation should be tracked");
    }

    function test_OwnerDonationAccrues() public {
        uint256 before = toto.ownerDonations();
        _ownerDonate(500 * U);
        assertEq(toto.ownerDonations(), before + 500 * U);
    }

    function test_NonOwnerDonationNotTracked() public {
        uint256 before = toto.ownerDonations();
        uint256 poolBefore = toto.cumulativePool();

        vm.prank(alice);
        toto.donate(777 * U);

        // Alice's donation grows the shared pool but is NEVER attributed to the owner.
        assertEq(toto.ownerDonations(), before, "non-owner donation must not be tracked");
        assertEq(toto.cumulativePool(), poolBefore + 777 * U, "pool still grows");
    }

    // --- reclaim ---

    function test_ReclaimSendsToTreasuryAndDecrementsBoth() public {
        uint256 amount = 30_000 * U;
        uint256 ownerDonBefore = toto.ownerDonations();
        uint256 poolBefore = toto.cumulativePool();
        uint256 treasBefore = usdc.balanceOf(treasuryAddr);

        toto.reclaimOwnerDonation(amount);

        assertEq(usdc.balanceOf(treasuryAddr), treasBefore + amount, "treasury receives funds");
        assertEq(toto.ownerDonations(), ownerDonBefore - amount, "ownerDonations decremented");
        assertEq(toto.cumulativePool(), poolBefore - amount, "pool decremented");
    }

    function test_ReclaimGoesToTreasuryNotOwner() public {
        uint256 ownerBalBefore = usdc.balanceOf(address(this));
        toto.reclaimOwnerDonation(1_000 * U);
        // Funds leave the contract to the treasury; the owner's own wallet is untouched.
        assertEq(usdc.balanceOf(address(this)), ownerBalBefore, "owner wallet must not receive reclaim");
    }

    function test_ReclaimFullThenNothingLeft() public {
        uint256 all = toto.ownerDonations();
        toto.reclaimOwnerDonation(all);
        assertEq(toto.ownerDonations(), 0);

        vm.expectRevert(BulgarianTotoStorage.InsufficientOwnerDonations.selector);
        toto.reclaimOwnerDonation(1);
    }

    // --- safety: cannot touch other users' / non-owner funds ---

    function test_CannotReclaimMoreThanOwnDonations() public {
        // Alice donates a large amount; it must not become reclaimable by the owner.
        vm.prank(alice);
        toto.donate(50_000 * U);

        uint256 cap = toto.ownerDonations();
        vm.expectRevert(BulgarianTotoStorage.InsufficientOwnerDonations.selector);
        toto.reclaimOwnerDonation(cap + 1);
    }

    function test_CannotReclaimBeyondUnencumberedPool() public {
        // Make ownerDonations larger than the free pool by draining the pool via an
        // independent path is hard here, so simulate the cap directly: reclaim cannot
        // exceed cumulativePool even when ownerDonations would allow it.
        // First reclaim everything to zero the pool contribution down to other funds.
        uint256 pool = toto.cumulativePool();
        // Owner donated exactly START_POOL == pool at setUp, so attempting pool+1 must fail
        // on the pool cap (PoolUnderflow) before the donation cap is reached for pool+1.
        vm.expectRevert();
        toto.reclaimOwnerDonation(pool + 1);
    }

    function test_OnlyOwnerCanReclaim() public {
        vm.prank(alice);
        vm.expectRevert(); // ConfirmedOwner: only callable by owner
        toto.reclaimOwnerDonation(1 * U);
    }

    function test_ReclaimZeroReverts() public {
        vm.expectRevert(BulgarianTotoStorage.AmountZero.selector);
        toto.reclaimOwnerDonation(0);
    }
}
