// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";

import {BulgarianTotoStorage} from "./BulgarianTotoStorage.sol";
import {BulgarianTotoLottery} from "./BulgarianTotoLottery.sol";

/// @title  BulgarianToto - on-chain Bulgarian "Toto" lottery (5/35 and 6/49)
/// @notice Tickets settle in USDC. Randomness comes from Chainlink VRF v2.5.
/// @dev    Players may pick more numbers than the game requires (system tickets):
///         5/35 accepts K in {5,6,7}, 6/49 accepts K in {6,7,8}.
///
///         The contract is split across three files for readability - all flatten
///         into one deployed contract via inheritance:
///           BulgarianToto              (this file: constructor + admin)
///             └── BulgarianTotoLottery (buy / draw / tally / claim / refund / sweep)
///                   └── VRFConsumerBaseV2Plus, ReentrancyGuard, Pausable, BulgarianTotoStorage
contract BulgarianToto is BulgarianTotoLottery {
    /// @param _usdc                The USDC token contract address.
    /// @param _vrfCoordinator       Chainlink VRF v2.5 coordinator address.
    /// @param _keyHash              VRF key hash for the gas lane to use.
    /// @param _subId                VRF subscription ID (must be funded with LINK).
    /// @param _requestConfirmations Block confirmations before VRF responds.
    /// @param _callbackGasLimit     Gas limit for the VRF callback.
    /// @param _firstDrawTime        Timestamp of the first draw (must be > now + BUY_CUTOFF).
    /// @param _treasury             Address that receives the per-draw treasury fee.
    constructor(
        address _usdc,
        address _vrfCoordinator,
        bytes32 _keyHash,
        uint256 _subId,
        uint16 _requestConfirmations,
        uint32 _callbackGasLimit,
        uint64 _firstDrawTime,
        address _treasury
    ) VRFConsumerBaseV2Plus(_vrfCoordinator) BulgarianTotoStorage(_usdc) {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
        keyHash = _keyHash;
        subId = _subId;
        requestConfirmations = _requestConfirmations;
        callbackGasLimit = _callbackGasLimit;

        if (_firstDrawTime <= block.timestamp + BUY_CUTOFF) revert FirstDrawTooSoon();

        // Draws run every 2 days by default; the admin may change this via setDrawInterval().
        drawInterval = DEFAULT_DRAW_INTERVAL;

        // Seed the mutable ticket prices from the defaults; the admin may change any of
        // them later via setTicketPrice().
        price535_k5 = DEFAULT_PRICE_5_35_BASE;
        price535_k6 = DEFAULT_PRICE_5_35_PLUS1;
        price535_k7 = DEFAULT_PRICE_5_35_PLUS2;
        price649_k6 = DEFAULT_PRICE_6_49_BASE;
        price649_k7 = DEFAULT_PRICE_6_49_PLUS1;
        price649_k8 = DEFAULT_PRICE_6_49_PLUS2;

        Round storage r0 = rounds[0];
        r0.drawTime = _firstDrawTime;
        r0.expiryTime = _firstDrawTime + uint64(EXPIRY_PERIOD);
        r0.state = uint8(RoundState.Open);
        currentRoundId = 0;
        emit RoundOpened(0, _firstDrawTime);
    }

    // ============================================================
    // ADMIN
    // ============================================================

    /// @notice Pause ticket purchases. Refunds, claims, and draws remain available.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume ticket purchases after a pause.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Update the treasury address that receives the per-draw fee.
    /// @param _treasury The new treasury address (must not be zero).
    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        emit TreasuryChanged(treasury, _treasury);
        treasury = _treasury;
    }

    /// @notice Queue a change to the interval between draws. To protect players from a
    ///         sudden schedule shift, the new interval does NOT apply immediately: it
    ///         activates after 2 draws (at round `currentRoundId + 2`). The next two draws
    ///         keep the current interval; the round opened at the second draw onward uses
    ///         the new spacing. Calling again before activation replaces the queued value
    ///         and resets the 2-draw delay relative to the current round.
    /// @param newInterval The new interval in seconds; must be within
    ///         [MIN_DRAW_INTERVAL, MAX_DRAW_INTERVAL].
    function setDrawInterval(uint256 newInterval) external onlyOwner {
        if (newInterval < MIN_DRAW_INTERVAL || newInterval > MAX_DRAW_INTERVAL) {
            revert IntervalOutOfRange();
        }
        uint256 activeRound = currentRoundId + 2;
        pendingDrawInterval = newInterval;
        pendingIntervalActiveRound = activeRound;
        emit DrawIntervalChangeQueued(newInterval, activeRound);
    }

    /// @notice Change the USDC price (the fee a player pays) for a specific ticket type.
    /// @dev    The new price takes effect immediately for all subsequent purchases. Tickets
    ///         already bought in the current open round keep their original paid price for
    ///         refund purposes, because refund() recomputes the price from the same source;
    ///         to avoid changing a refund amount out from under a buyer, only change prices
    ///         while no refundable purchases are outstanding, or accept that in-window buyers
    ///         refund at the new price. The price is bounded to type(uint128).max so it can
    ///         never silently truncate when accumulated into the uint128 per-game round stake.
    /// @param game     The game id: GAME_5_35 (0) or GAME_6_49 (1).
    /// @param k        The pick count (5/35: 5,6,7 - 6/49: 6,7,8).
    /// @param newPrice The new price in USDC base units (6 decimals); must be in (0, uint128.max].
    function setTicketPrice(uint8 game, uint8 k, uint256 newPrice) external onlyOwner {
        if (newPrice == 0 || newPrice > type(uint128).max) revert InvalidPrice();

        // Reverts InvalidPickCount for any unsupported (game, k) pair, so only valid
        // combinations reach the writes below. Also gives us the old price for the event.
        uint256 oldPrice = _ticketPrice(game, k);

        if (game == GAME_5_35) {
            if (k == 5) price535_k5 = newPrice;
            else if (k == 6) price535_k6 = newPrice;
            else price535_k7 = newPrice;
        } else {
            if (k == 6) price649_k6 = newPrice;
            else if (k == 7) price649_k7 = newPrice;
            else price649_k8 = newPrice;
        }

        emit TicketPriceChanged(game, k, oldPrice, newPrice);
    }

    /// @notice Update Chainlink VRF parameters.
    /// @param _keyHash          The VRF key hash.
    /// @param _subId            The VRF subscription ID.
    /// @param _confirmations    Number of block confirmations before VRF responds.
    /// @param _callbackGasLimit Gas limit for the VRF callback.
    function setVrfConfig(
        bytes32 _keyHash,
        uint256 _subId,
        uint16 _confirmations,
        uint32 _callbackGasLimit
    ) external onlyOwner {
        keyHash = _keyHash;
        subId = _subId;
        requestConfirmations = _confirmations;
        callbackGasLimit = _callbackGasLimit;
    }
}
