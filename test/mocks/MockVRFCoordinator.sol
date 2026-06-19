// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVRFCoordinatorV2Plus} from
    "@chainlink/contracts/src/v0.8/vrf/dev/interfaces/IVRFCoordinatorV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";

interface IVRFConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @notice Minimal in-memory VRF coordinator stub for unit tests.
/// @dev    Only requestRandomWords + fulfill flow is implemented; the rest of
///         IVRFSubscriptionV2Plus is stubbed because the contract under test
///         never calls those methods.
contract MockVRFCoordinator is IVRFCoordinatorV2Plus {
    uint256 public nextRequestId = 1;
    mapping(uint256 => address) public requestConsumer;
    mapping(uint256 => uint32) public requestNumWords;

    function requestRandomWords(VRFV2PlusClient.RandomWordsRequest calldata req)
        external
        returns (uint256 requestId)
    {
        requestId = nextRequestId++;
        requestConsumer[requestId] = msg.sender;
        requestNumWords[requestId] = req.numWords;
    }

    /// @notice Test-only: deliver fixed random words to the consumer.
    function fulfill(uint256 requestId, uint256[] calldata randomWords) external {
        address consumer = requestConsumer[requestId];
        require(consumer != address(0), "unknown request");
        require(randomWords.length == requestNumWords[requestId], "bad numWords");
        delete requestConsumer[requestId];
        delete requestNumWords[requestId];
        IVRFConsumer(consumer).rawFulfillRandomWords(requestId, randomWords);
    }

    // ---------- IVRFSubscriptionV2Plus stubs (not exercised) ----------
    function addConsumer(uint256, address) external pure {}
    function removeConsumer(uint256, address) external pure {}
    function cancelSubscription(uint256, address) external pure {}
    function acceptSubscriptionOwnerTransfer(uint256) external pure {}
    function requestSubscriptionOwnerTransfer(uint256, address) external pure {}
    function createSubscription() external pure returns (uint256) {
        return 1;
    }

    function getSubscription(uint256)
        external
        pure
        returns (uint96, uint96, uint64, address, address[] memory consumers)
    {
        consumers = new address[](0);
        return (0, 0, 0, address(0), consumers);
    }

    function pendingRequestExists(uint256) external pure returns (bool) {
        return false;
    }

    function getActiveSubscriptionIds(uint256, uint256)
        external
        pure
        returns (uint256[] memory ids)
    {
        ids = new uint256[](0);
    }

    function fundSubscriptionWithNative(uint256) external payable {}
}
