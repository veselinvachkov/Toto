// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VRFConsumerBaseV2Plus} from "@chainlink/contracts/src/v0.8/vrf/dev/VRFConsumerBaseV2Plus.sol";
import {VRFV2PlusClient} from "@chainlink/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {BulgarianTotoStorage} from "./BulgarianTotoStorage.sol";

/// @title  BulgarianTotoLottery
/// @notice Lottery layer: ticket purchase, draw, tally, claim, refund, sweep.
/// @dev    Prize model (see BulgarianTotoStorage header): each game's lower tiers are
///         funded by 50% of that game's round stakes; the top tier (jackpot) is a
///         percentage of the common cumulative pool snapshot taken at draw time. A 10%
///         treasury fee is skimmed from total round stakes; the rest feeds the pool.
///         Unwon prizes (lower tiers and jackpots) roll into the cumulative pool.
abstract contract BulgarianTotoLottery is
    VRFConsumerBaseV2Plus,
    ReentrancyGuard,
    Pausable,
    BulgarianTotoStorage
{
    using SafeERC20 for IERC20;

    // ============================================================
    // BUY / DONATE / REFUND
    // ============================================================

    /// @notice Buy a ticket for the current open round.
    /// @param game  0 = 5/35, 1 = 6/49.
    /// @param picks K numbers in [1, maxNum]. K determines whether the ticket
    ///              is base, +1 or +2 (for 5/35: K=5/6/7; for 6/49: K=6/7/8).
    /// @return ticketId The newly created ticket's ID.
    function buyTicket(uint8 game, uint8[] calldata picks)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 ticketId)
    {
        if (game > 1) revert InvalidGame();

        uint8 k = uint8(picks.length);
        _validatePickCount(game, k);

        uint256 roundId = currentRoundId;
        Round storage r = rounds[roundId];
        if (r.state != uint8(RoundState.Open)) revert WrongRoundState();
        if (block.timestamp + BUY_CUTOFF > r.drawTime) revert PurchaseWindowClosed();

        uint64 picksMask = _picksToMask(game, picks);
        uint256 price = _ticketPrice(game, k);

        usdc.safeTransferFrom(msg.sender, address(this), price);


        // Track per-game stakes for this round; they drive both the lower-tier funds
        // (50% of the game's stakes) and the treasury fee at requestDraw.
        if (game == GAME_5_35) {
            r.stake5 += uint128(price);
        } else {
            r.stake6 += uint128(price);
        }

        ticketId = tickets.length;
        tickets.push(
            Ticket({
                owner: msg.sender,
                roundId: uint32(roundId),
                purchaseTime: uint32(block.timestamp),
                game: game,
                k: k,
                pricePaid: uint128(price),
                claimed: false,
                refunded: false,
                picksMask: picksMask
            })
        );
        _roundTickets[roundId].push(ticketId);
        _userTickets[msg.sender].push(ticketId);

        emit TicketBought(ticketId, roundId, msg.sender, game, k, picksMask, price);
    }

    /// @notice Add USDC directly to the cumulative jackpot pool (anyone can donate).
    /// @param amount The USDC amount to donate (must be > 0).
    function donate(uint256 amount) external nonReentrant {
        if (amount == 0) revert AmountZero();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        cumulativePool += amount;
        // Track the owner's own donations so they (and only they) can later be reclaimed to
        // the treasury. Donations from any other address are never counted here, so the
        // reclaim path can never reach another user's funds.
        if (msg.sender == owner()) {
            ownerDonations += amount;
        }
        emit Donation(msg.sender, amount);
    }

    /// @notice Reclaim a portion of the OWNER's own donations from the cumulative pool and
    ///         send it to the treasury. The owner chooses the exact `amount`.
    /// @dev    The amount is capped twice, and both caps are required:
    ///           1. `ownerDonations` — the owner can never reclaim more than they personally
    ///              donated and have not already reclaimed. This guarantees no other donor's
    ///              contribution, no player's stake, and no won prize can be touched.
    ///           2. `cumulativePool` — only the unencumbered pool is reachable. Earmarked
    ///              jackpots, frozen lower-tier budgets and refundable stakes are held in
    ///              separate accounting (`earmarkedForRound`, `tierState`) and are untouched.
    ///              If earlier jackpots already paid out the donated funds, this cap limits
    ///              the reclaim to whatever actually remains in the pool.
    ///         Funds go to `treasury`, never to the caller. CEI ordering + nonReentrant.
    /// @param amount USDC amount (6 decimals) to move from the pool to the treasury.
    function reclaimOwnerDonation(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert AmountZero();
        if (amount > ownerDonations) revert InsufficientOwnerDonations();
        if (amount > cumulativePool) revert PoolUnderflow();

        ownerDonations -= amount;
        cumulativePool -= amount;
        usdc.safeTransfer(treasury, amount);

        emit OwnerDonationReclaimed(amount, treasury, ownerDonations);
    }

    /// @notice Refund a ticket within REFUND_WINDOW of purchase, but only while
    ///         the purchase window for that round is still open.
    /// @dev    Refunds are intentionally allowed even when the contract is paused
    ///         so that buyers cannot be locked into a paused round.
    /// @param ticketId The ticket to refund. Caller must be the ticket owner.
    function refund(uint256 ticketId) external nonReentrant {
        Ticket storage t = tickets[ticketId];
        if (t.owner != msg.sender) revert NotOwner();
        if (t.claimed || t.refunded) revert AlreadySettled();

        uint256 roundId = t.roundId;
        Round storage r = rounds[roundId];
        if (r.state != uint8(RoundState.Open)) revert WrongRoundState();
        if (block.timestamp + BUY_CUTOFF > r.drawTime) revert RefundWindowClosed();
        if (block.timestamp > uint256(t.purchaseTime) + REFUND_WINDOW) revert RefundWindowClosed();

        uint128 price = t.pricePaid; // refund exactly what was paid
        t.refunded = true;

        // Reverse the per-game stake credited at buy time.
        if (t.game == GAME_5_35) {
            if (r.stake5 < price) revert PoolUnderflow();
            r.stake5 -= uint128(price);
        } else {
            if (r.stake6 < price) revert PoolUnderflow();
            r.stake6 -= uint128(price);
        }

        usdc.safeTransfer(msg.sender, price);
        emit TicketRefunded(ticketId, msg.sender, price);
    }

    /// @notice Transfer ownership of a ticket to another address.
    /// @dev    Allowed at any time before the ticket is claimed or refunded.
    ///         Works even when the contract is paused (same rationale as refund).
    /// @param ticketId The ticket to transfer.
    /// @param to       The new owner. Must not be the zero address.
    function transferTicket(uint256 ticketId, address to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        Ticket storage t = tickets[ticketId];
        if (t.owner != msg.sender) revert NotOwner();
        if (t.claimed || t.refunded) revert AlreadySettled();

        address from = t.owner;
        t.owner = to;
        _userTickets[to].push(ticketId);

        emit TicketTransferred(ticketId, from, to);
    }

    // ============================================================
    // DRAW / TALLY / CLAIM
    // ============================================================

    /// @notice Permissionless: anyone can request the VRF draw once drawTime has passed.
    /// @dev    Skims the treasury fee, routes 50% of each game's stakes to that game's
    ///         lower-tier reserve, adds the remainder to the cumulative pool, snapshots
    ///         the pool, earmarks the maximum possible jackpot, and opens the next round.
    /// @param roundId The round to draw (must equal currentRoundId).
    /// @return reqId  The Chainlink VRF request ID.
    function requestDraw(uint256 roundId) external nonReentrant returns (uint256 reqId) {
        if (roundId != currentRoundId) revert WrongRound();
        Round storage r = rounds[roundId];
        if (r.state != uint8(RoundState.Open)) revert WrongRoundState();
        if (block.timestamp < r.drawTime) revert TooEarly();

        uint256 stake5 = uint256(r.stake5);
        uint256 stake6 = uint256(r.stake6);
        uint256 total = stake5 + stake6;

        // 10% treasury fee on the total round stakes.
        uint256 treasuryFee = total * TREASURY_BPS / BPS_DENOM;
        if (treasuryFee > 0) {
            usdc.safeTransfer(treasury, treasuryFee);
            emit TreasuryFee(roundId, treasuryFee);
        }

        // 50% of each game's stakes is reserved for that game's lower tiers. Computed
        // per game so the reservation exactly bounds the per-tier budgets at finalize.
        uint256 lowerReserve =
            stake5 * LOWER_FUND_BPS / BPS_DENOM + stake6 * LOWER_FUND_BPS / BPS_DENOM;

        // Everything that is neither fee nor lower reserve flows into the cumulative pool.
        uint256 poolAdd = total - treasuryFee - lowerReserve;
        cumulativePool += poolAdd;

        // Snapshot the pool (now including this round's contribution) - it sizes the jackpots.
        uint256 snap = cumulativePool;
        r.poolSnapshot = uint128(snap);

        // Earmark the maximum possible jackpot (both games hit) out of the pool so a later
        // round's snapshot cannot double-count money already committed to this round.
        uint256 jackpotEarmark = snap * MAX_JACKPOT_BPS / BPS_DENOM;
        cumulativePool -= jackpotEarmark;
        r.jackpotEarmark = uint128(jackpotEarmark);

        earmarkedForRound[roundId] = lowerReserve + jackpotEarmark;

        r.state = uint8(RoundState.AwaitingVRF);

        VRFV2PlusClient.RandomWordsRequest memory req = VRFV2PlusClient.RandomWordsRequest({
            keyHash: keyHash,
            subId: subId,
            requestConfirmations: requestConfirmations,
            callbackGasLimit: callbackGasLimit,
            numWords: 2,
            extraArgs: VRFV2PlusClient._argsToBytes(VRFV2PlusClient.ExtraArgsV1({nativePayment: false}))
        });
        reqId = s_vrfCoordinator.requestRandomWords(req);
        vrfRequestToRound[reqId] = roundId;

        // Open the next round at the same instant so buyers are never locked out.
        uint256 nextId = roundId + 1;

        // Activate a queued interval change once we reach its activation round. A change
        // queued at round X activates at round X+2, so the two draws after the admin's
        // call keep the prior interval and the new spacing only applies thereafter.
        if (pendingDrawInterval != 0 && nextId >= pendingIntervalActiveRound) {
            drawInterval = pendingDrawInterval;
            emit DrawIntervalActivated(nextId, pendingDrawInterval);
            pendingDrawInterval = 0;
            pendingIntervalActiveRound = 0;
        }

        Round storage nr = rounds[nextId];
        nr.drawTime = r.drawTime + uint64(drawInterval);
        nr.expiryTime = nr.drawTime + uint64(EXPIRY_PERIOD);
        nr.state = uint8(RoundState.Open);
        currentRoundId = nextId;

        emit DrawRequested(roundId, reqId, snap);
        emit RoundOpened(nextId, nr.drawTime);
    }

    /// @notice Chainlink VRF callback - stores drawn numbers and moves to Tallying.
    /// @dev    If a round has zero tickets, finalization happens immediately.
    function fulfillRandomWords(uint256 requestId, uint256[] calldata randomWords)
        internal
        override
    {
        uint256 roundId = vrfRequestToRound[requestId];
        Round storage r = rounds[roundId];
        if (r.state != uint8(RoundState.AwaitingVRF)) {
            return; // defensive: ignore stale / unknown
        }
        delete vrfRequestToRound[requestId];

        uint64 mask5 = _drawNumbersToMask(randomWords[0], MAX_NUM_5_35, DRAW_COUNT_5_35);
        uint64 mask6 = _drawNumbersToMask(randomWords[1], MAX_NUM_6_49, DRAW_COUNT_6_49);
        r.drawnMask5 = mask5;
        r.drawnMask6 = mask6;
        r.state = uint8(RoundState.Tallying);
        emit DrawFulfilled(roundId, mask5, mask6);

        if (_roundTickets[roundId].length == 0) {
            _finalizeRound(roundId);
        }
    }

    /// @notice Process up to maxTickets entries in the round to count tier hits.
    /// @dev    Permissionless. Repeat calls until done == true. When the last ticket
    ///         is tallied the round is finalized automatically.
    function tallyBatch(uint256 roundId, uint256 maxTickets)
        external
        nonReentrant
        returns (bool done)
    {
        Round storage r = rounds[roundId];
        if (r.state != uint8(RoundState.Tallying)) revert WrongRoundState();

        uint256 cursor = r.tallyCursor;
        uint256 total = _roundTickets[roundId].length;
        uint256 end = cursor + maxTickets;
        if (end > total) end = total;

        uint64 mask5 = r.drawnMask5;
        uint64 mask6 = r.drawnMask6;

        for (uint256 i = cursor; i < end; i++) {
            _tallyOne(roundId, _roundTickets[roundId][i], mask5, mask6);
        }

        r.tallyCursor = uint64(end);
        emit TallyAdvanced(roundId, uint64(end), uint64(total));

        if (end == total) {
            _finalizeRound(roundId);
            done = true;
        }
    }

    function _tallyOne(uint256 roundId, uint256 ticketId, uint64 mask5, uint64 mask6) internal {
        Ticket storage t = tickets[ticketId];
        if (t.refunded) return;

        uint8 game = t.game;
        uint64 drawnMask = game == GAME_5_35 ? mask5 : mask6;
        uint8 R = game == GAME_5_35 ? DRAW_COUNT_5_35 : DRAW_COUNT_6_49;
        uint8 K = t.k;
        uint8 m = uint8(_popcount(uint256(t.picksMask & drawnMask)));

        for (uint8 j = MIN_TIER; j <= R; j++) {
            uint256 hits = _binom(m, j) * _binom(K - m, R - j);
            if (hits > 0) {
                tierState[roundId][game][j].totalHits += hits;
            }
        }
    }

    function _finalizeRound(uint256 roundId) internal {
        Round storage r = rounds[roundId];
        uint256 snap = uint256(r.poolSnapshot);

        uint256 used = _finalizeGame(roundId, GAME_5_35, DRAW_COUNT_5_35, uint256(r.stake5), snap)
            + _finalizeGame(roundId, GAME_6_49, DRAW_COUNT_6_49, uint256(r.stake6), snap);

        // Anything reserved but not owed to a winner (no-winner tiers, unwon jackpots,
        // rounding dust) rolls into the cumulative pool.
        uint256 reserved = earmarkedForRound[roundId];
        uint256 movedToPool = reserved > used ? reserved - used : 0;
        if (movedToPool > 0) {
            cumulativePool += movedToPool;
        }
        earmarkedForRound[roundId] = used;

        r.state = uint8(RoundState.Claimable);
        emit RoundFinalized(roundId, used, movedToPool);
    }

    /// @dev Assign per-tier prize budgets for one game. Lower tiers (j < R) are funded by
    ///      a fixed share of the game's round stake; the jackpot tier (j == R) is a share
    ///      of the cumulative pool snapshot. Tiers with no winner are skipped (their funds
    ///      roll into the pool via the reserved-minus-used delta in _finalizeRound).
    /// @return used Total budget assigned to tiers that actually have winners.
    function _finalizeGame(uint256 roundId, uint8 game, uint8 R, uint256 stake, uint256 snap)
        internal
        returns (uint256 used)
    {
        for (uint8 j = MIN_TIER; j <= R; j++) {
            uint256 budget = j == R
                ? snap * uint256(_jackpotBps(game)) / BPS_DENOM
                : stake * uint256(_lowerBps(game, j)) / BPS_DENOM;
            if (budget == 0) continue;

            TierState storage ts = tierState[roundId][game][j];
            if (ts.totalHits == 0) continue; // no winner -> stays in pool

            ts.budget = budget;
            ts.remaining = budget;
            used += budget;
        }
    }

    /// @notice Claim a single winning ticket. Pays out to the ticket owner.
    function claim(uint256 ticketId) external nonReentrant returns (uint256 payout) {
        payout = _claimSingle(ticketId);
        if (payout == 0) revert NothingToClaim();
        usdc.safeTransfer(msg.sender, payout);
    }

    /// @notice Claim multiple winning tickets in a single transaction.
    /// @dev    Non-winning tickets in the array are silently skipped (no revert).
    ///         Reverts only if the total payout across all tickets is zero.
    function claimBatch(uint256[] calldata ticketIds) external nonReentrant returns (uint256 totalPayout) {
        for (uint256 i = 0; i < ticketIds.length; i++) {
            totalPayout += _claimSingle(ticketIds[i]);
        }
        if (totalPayout == 0) revert NothingToClaim();
        usdc.safeTransfer(msg.sender, totalPayout);
    }

    /// @dev Shared claim logic for claim() and claimBatch(). Marks the ticket as
    ///      claimed and emits {Claimed}, but does NOT transfer USDC (caller does).
    ///      Returns 0 for non-winning tickets without reverting.
    function _claimSingle(uint256 ticketId) internal returns (uint256 payout) {
        Ticket storage t = tickets[ticketId];
        if (t.owner != msg.sender) revert NotOwner();
        if (t.claimed || t.refunded) revert AlreadySettled();

        uint256 roundId = t.roundId;
        Round storage r = rounds[roundId];
        if (r.state != uint8(RoundState.Claimable)) revert WrongRoundState();

        uint8 game = t.game;
        uint8 R = game == GAME_5_35 ? DRAW_COUNT_5_35 : DRAW_COUNT_6_49;
        uint8 K = t.k;
        uint64 drawnMask = game == GAME_5_35 ? r.drawnMask5 : r.drawnMask6;
        uint8 m = uint8(_popcount(uint256(t.picksMask & drawnMask)));

        for (uint8 j = MIN_TIER; j <= R; j++) {
            uint256 hits = _binom(m, j) * _binom(K - m, R - j);
            if (hits == 0) continue;
            TierState storage ts = tierState[roundId][game][j];
            uint256 totalHits = ts.totalHits;
            if (totalHits == 0) continue;
            uint256 share = ts.budget * hits / totalHits;
            if (share > ts.remaining) share = ts.remaining; // rounding-dust safety
            ts.remaining -= share;
            payout += share;
        }

        t.claimed = true;
        if (payout > 0) {
            emit Claimed(ticketId, t.owner, payout);
        }
    }

    /// @notice After EXPIRY_PERIOD, return any unclaimed prize budget to the cumulative pool.
    /// @dev    Sets the round state to Expired so that subsequent claim() calls revert.
    function sweepExpired(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.state != uint8(RoundState.Claimable)) revert WrongRoundState();
        if (block.timestamp < r.expiryTime) revert TooEarly();

        uint256 leftover = 0;
        for (uint8 j = MIN_TIER; j <= DRAW_COUNT_5_35; j++) {
            TierState storage ts = tierState[roundId][GAME_5_35][j];
            if (ts.remaining > 0) {
                leftover += ts.remaining;
                ts.remaining = 0;
            }
        }
        for (uint8 j = MIN_TIER; j <= DRAW_COUNT_6_49; j++) {
            TierState storage ts = tierState[roundId][GAME_6_49][j];
            if (ts.remaining > 0) {
                leftover += ts.remaining;
                ts.remaining = 0;
            }
        }

        cumulativePool += leftover;
        if (earmarkedForRound[roundId] >= leftover) {
            earmarkedForRound[roundId] -= leftover;
        } else {
            earmarkedForRound[roundId] = 0;
        }

        r.state = uint8(RoundState.Expired);
        emit RoundExpired(roundId, leftover);
    }

    // ============================================================
    // PERMISSIONLESS CATCH-UP
    // ============================================================

    /// @notice Single-call permissionless catch-up. Walks the round range
    ///         [startRoundId .. min(startRoundId + maxRoundsToScan - 1, currentRoundId)]
    ///         and advances each round through the state machine as far as possible
    ///         without external dependencies. Skips rounds that are AwaitingVRF
    ///         (Chainlink callback required) or already in a final state.
    /// @dev    Uses external self-calls with try/catch so a single failing transition
    ///         does NOT abort the rest of the batch. Idempotent on up-to-date rounds.
    ///
    ///         Per-round actions:
    ///           Open + drawTime reached     -> requestDraw  -> AwaitingVRF
    ///           Tallying                    -> tallyBatch   -> Tallying or Claimable
    ///           Claimable + expiryTime past -> sweepExpired -> Expired
    ///
    /// @param startRoundId    First round to consider (use 0 to scan from genesis).
    /// @param maxRoundsToScan Cap on rounds touched in this call (gas safety).
    /// @param tallyBatchSize  Iterations per inner tallyBatch call (gas safety).
    /// @return actionsExecuted Number of state transitions performed.
    function catchUp(
        uint256 startRoundId,
        uint256 maxRoundsToScan,
        uint256 tallyBatchSize
    ) external returns (uint256 actionsExecuted) {
        if (maxRoundsToScan == 0) return 0;

        uint256 cur = currentRoundId;
        if (startRoundId > cur) return 0;

        uint256 end = startRoundId + maxRoundsToScan;
        if (end > cur + 1) end = cur + 1;

        for (uint256 i = startRoundId; i < end; i++) {
            Round storage r = rounds[i];
            uint8 s = r.state;

            if (s == uint8(RoundState.Open)) {
                // Only the current round is ever Open. Trigger AT MOST ONE requestDraw
                // per catchUp call; caller re-invokes after Chainlink VRF fulfills.
                if (i == cur && block.timestamp >= r.drawTime) {
                    try this.requestDraw(i) returns (uint256) {
                        actionsExecuted++;
                        break;
                    } catch {
                        // VRF subscription empty, paused, etc. - leave for next time.
                    }
                }
            } else if (s == uint8(RoundState.Tallying)) {
                try this.tallyBatch(i, tallyBatchSize) returns (bool) {
                    actionsExecuted++;
                } catch {
                    // Should not normally fail; defensive.
                }
            } else if (
                s == uint8(RoundState.Claimable) && block.timestamp >= r.expiryTime
            ) {
                try this.sweepExpired(i) {
                    actionsExecuted++;
                } catch {
                    // Defensive.
                }
            }
            // AwaitingVRF, Expired, or Claimable-not-yet-expired -> silent skip.
        }

        emit CatchUpExecuted(msg.sender, startRoundId, end == 0 ? 0 : end - 1, actionsExecuted);
    }

    // ============================================================
    // VIEWS
    // ============================================================

    /// @notice Total number of tickets ever created (including refunded).
    function ticketCount() external view returns (uint256) {
        return tickets.length;
    }

    /// @notice Number of tickets sold in a specific round.
    function roundTicketCount(uint256 roundId) external view returns (uint256) {
        return _roundTickets[roundId].length;
    }

    /// @notice Ticket ID at a given index within a round.
    function roundTicketAt(uint256 roundId, uint256 idx) external view returns (uint256) {
        return _roundTickets[roundId][idx];
    }

    /// @notice Look up the current price for a given game and pick count.
    function ticketPrice(uint8 game, uint8 k) external view returns (uint256) {
        return _ticketPrice(game, k);
    }

    /// @notice Lower-tier share in BPS of that game's round stake (0 for the jackpot tier).
    function lowerTierBps(uint8 game, uint8 tier) external pure returns (uint16) {
        return _lowerBps(game, tier);
    }

    /// @notice Jackpot share in BPS of the cumulative pool snapshot for a game.
    function jackpotBps(uint8 game) external pure returns (uint16) {
        return _jackpotBps(game);
    }

    /// @notice Compute the payout a ticket would receive if claim() were called now.
    function previewClaim(uint256 ticketId) external view returns (uint256 payout) {
        Ticket memory t = tickets[ticketId];
        if (t.claimed || t.refunded) return 0;
        Round memory r = rounds[t.roundId];
        if (r.state != uint8(RoundState.Claimable)) return 0;

        uint8 R = t.game == GAME_5_35 ? DRAW_COUNT_5_35 : DRAW_COUNT_6_49;
        uint64 drawnMask = t.game == GAME_5_35 ? r.drawnMask5 : r.drawnMask6;
        uint8 m = uint8(_popcount(uint256(t.picksMask & drawnMask)));

        for (uint8 j = MIN_TIER; j <= R; j++) {
            uint256 hits = _binom(m, j) * _binom(t.k - m, R - j);
            if (hits == 0) continue;
            TierState memory ts = tierState[t.roundId][t.game][j];
            if (ts.totalHits == 0) continue;
            payout += ts.budget * hits / ts.totalHits;
        }
    }

    /// @notice Decode the drawn numbers for a finalized round into uint8 arrays.
    function drawnNumbers(uint256 roundId)
        external
        view
        returns (uint8[] memory five35, uint8[] memory six49)
    {
        Round memory r = rounds[roundId];
        five35 = _maskToNumbers(r.drawnMask5, MAX_NUM_5_35);
        six49 = _maskToNumbers(r.drawnMask6, MAX_NUM_6_49);
    }

    // ============================================================
    // FRONTEND HELPERS
    // ============================================================

    /// @notice Return all round data in a single call (avoids multiple RPC round-trips).
    /// @dev    `ticketCount` reflects ACTIVE tickets - refunded tickets are excluded so the
    ///         number matches what the frontend should show users.
    function getRoundInfo(uint256 roundId) external view returns (RoundInfo memory info) {
        Round memory r = rounds[roundId];
        info.drawTime = r.drawTime;
        info.expiryTime = r.expiryTime;
        info.stake5 = r.stake5;
        info.stake6 = r.stake6;
        info.poolSnapshot = r.poolSnapshot;
        info.state = RoundState(r.state);
        info.drawn5 = _maskToNumbers(r.drawnMask5, MAX_NUM_5_35);
        info.drawn6 = _maskToNumbers(r.drawnMask6, MAX_NUM_6_49);

        uint256[] storage list = _roundTickets[roundId];
        uint256 len = list.length;
        uint256 active;
        for (uint256 i = 0; i < len; i++) {
            if (!tickets[list[i]].refunded) {
                unchecked { ++active; }
            }
        }
        info.ticketCount = active;
    }

    /// @notice Return tier-level prize data for both games in a round.
    /// @dev    Arrays are indexed 0 = tier 3, 1 = tier 4, etc. The last element of each
    ///         array is the jackpot tier (tier 5 for 5/35, tier 6 for 6/49).
    function getRoundTiers(uint256 roundId)
        external
        view
        returns (TierState[3] memory tiers5, TierState[4] memory tiers6)
    {
        for (uint8 j = 0; j < 3; j++) {
            tiers5[j] = tierState[roundId][GAME_5_35][j + MIN_TIER];
        }
        for (uint8 j = 0; j < 4; j++) {
            tiers6[j] = tierState[roundId][GAME_6_49][j + MIN_TIER];
        }
    }

    /// @notice Return every ticket ID that a user has ever bought or received.
    function getUserTickets(address user) external view returns (uint256[] memory ids) {
        return _userTickets[user];
    }

    /// @notice Check whether a ticket is a winner in its round's draw.
    function isWinner(uint256 ticketId) external view returns (bool) {
        Ticket memory t = tickets[ticketId];
        if (t.claimed || t.refunded) return false;
        Round memory r = rounds[t.roundId];
        if (r.state != uint8(RoundState.Claimable)) return false;

        uint64 drawnMask = t.game == GAME_5_35 ? r.drawnMask5 : r.drawnMask6;
        uint8 m = uint8(_popcount(uint256(t.picksMask & drawnMask)));
        return m >= MIN_TIER;
    }

    // ============================================================
    // INTERNAL HELPERS
    // ============================================================

    /// @dev Revert if k is outside the allowed range for the given game.
    function _validatePickCount(uint8 game, uint8 k) internal pure {
        if (game == GAME_5_35) {
            if (k < MIN_K_5_35 || k > MAX_K_5_35) revert InvalidPickCount();
        } else {
            if (k < MIN_K_6_49 || k > MAX_K_6_49) revert InvalidPickCount();
        }
    }

    /// @dev Convert an array of picked numbers into a bitmask. Validates range and uniqueness.
    function _picksToMask(uint8 game, uint8[] calldata picks) internal pure returns (uint64 mask) {
        uint8 maxNum = game == GAME_5_35 ? MAX_NUM_5_35 : MAX_NUM_6_49;
        for (uint256 i = 0; i < picks.length; i++) {
            uint8 n = picks[i];
            if (n == 0 || n > maxNum) revert InvalidNumber();
            uint64 bit = uint64(1) << n;
            if ((mask & bit) != 0) revert DuplicateNumber();
            mask |= bit;
        }
    }

    /// @dev Deterministically draw `count` unique numbers in [1, maxNum] from a VRF word.
    ///      Uses a partial Fisher-Yates shuffle with keccak256 expansion for independence.
    function _drawNumbersToMask(uint256 randomWord, uint8 maxNum, uint8 count)
        internal
        pure
        returns (uint64 mask)
    {
        uint8[] memory pool = new uint8[](maxNum);
        for (uint8 i = 0; i < maxNum; i++) {
            pool[i] = i + 1;
        }
        for (uint8 i = 0; i < count; i++) {
            uint256 rand = uint256(keccak256(abi.encode(randomWord, i)));
            uint8 j = i + uint8(rand % uint256(uint8(maxNum - i)));
            (pool[i], pool[j]) = (pool[j], pool[i]);
            mask |= (uint64(1) << pool[i]);
        }
    }

    /// @dev Convert a bitmask back into a sorted array of numbers.
    function _maskToNumbers(uint64 mask, uint8 maxNum) internal pure returns (uint8[] memory out) {
        uint256 count;
        for (uint8 i = 1; i <= maxNum; i++) {
            if ((mask & (uint64(1) << i)) != 0) count++;
        }
        out = new uint8[](count);
        uint256 idx;
        for (uint8 i = 1; i <= maxNum; i++) {
            if ((mask & (uint64(1) << i)) != 0) {
                out[idx++] = i;
            }
        }
    }

    /// @dev Count the number of set bits (Brian Kernighan's algorithm).
    function _popcount(uint256 x) internal pure returns (uint256 c) {
        unchecked {
            while (x != 0) {
                x &= (x - 1);
                c++;
            }
        }
    }

    /// @dev C(n,k); n,k <= 8 so the iterative form is exact and cheap.
    function _binom(uint8 n, uint8 k) internal pure returns (uint256) {
        if (k > n) return 0;
        if (k == 0 || k == n) return 1;
        uint8 a = n - k;
        uint8 lo = k < a ? k : a;
        uint256 num = 1;
        uint256 den = 1;
        for (uint256 i = 1; i <= lo; i++) {
            num *= (uint256(n) - i + 1);
            den *= i;
        }
        return num / den;
    }

    /// @dev Return the current USDC price for a ticket with the given game and pick count.
    ///      Prices are admin-settable (see setTicketPrice); this reads the live values.
    function _ticketPrice(uint8 game, uint8 k) internal view returns (uint256) {
        if (game == GAME_5_35) {
            if (k == 5) return price535_k5;
            if (k == 6) return price535_k6;
            if (k == 7) return price535_k7;
        } else if (game == GAME_6_49) {
            if (k == 6) return price649_k6;
            if (k == 7) return price649_k7;
            if (k == 8) return price649_k8;
        }
        revert InvalidPickCount();
    }

    /// @dev Lower-tier BPS (of the game's round stake). Returns 0 for the jackpot tier
    ///      and any invalid tier.
    function _lowerBps(uint8 game, uint8 tier) internal pure returns (uint16) {
        if (game == GAME_5_35) {
            if (tier == 4) return LBPS_5_35_TIER4;
            if (tier == 3) return LBPS_5_35_TIER3;
            return 0;
        } else {
            if (tier == 5) return LBPS_6_49_TIER5;
            if (tier == 4) return LBPS_6_49_TIER4;
            if (tier == 3) return LBPS_6_49_TIER3;
            return 0;
        }
    }

    /// @dev Jackpot BPS (of the cumulative pool snapshot) for a game.
    function _jackpotBps(uint8 game) internal pure returns (uint16) {
        return game == GAME_5_35 ? JACKPOT_BPS_5_35 : JACKPOT_BPS_6_49;
    }
}
