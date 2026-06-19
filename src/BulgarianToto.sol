// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";

import {BulgarianTotoStorage} from "./BulgarianTotoStorage.sol";
import {BulgarianTotoLpVault} from "./BulgarianTotoLpVault.sol";

/// @title  BulgarianToto - on-chain Bulgarian "Toto" lottery (5/35 and 6/49)
/// @notice Tickets settle in USDC. Randomness comes from Chainlink VRF v2.5.
/// @dev    Players may pick more numbers than the game requires (system tickets):
///         5/35 accepts K in {5,6,7}, 6/49 accepts K in {6,7,8}.
///
///         The contract is split across four files for readability - all flatten
///         into one deployed contract via inheritance:
///           BulgarianToto              (this file: constructor + admin)
///             ├── BulgarianTotoLpVault (LP entry points)
///             │     └── BulgarianTotoLottery (buy / draw / tally / claim / refund / sweep)
///             │           └── VRFConsumerBaseV2Plus, ReentrancyGuard, Pausable, BulgarianTotoStorage
///             └── (storage layout is determined by the chain above)
contract BulgarianToto is BulgarianTotoLpVault {
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
