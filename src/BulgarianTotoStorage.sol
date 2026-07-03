// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title  BulgarianTotoStorage
/// @notice Pure data layer: types, constants, state, events, errors.
/// @dev    Abstract base shared by every concrete part of the BulgarianToto contract.
///         All state lives here so the storage layout is fixed in one place.
///
/// PRIZE MODEL (per draw / round):
///   The stakes collected for a round are split per game:
///     - 2% of total stakes  -> treasury fee
///     - 50% of each game's stakes -> that game's LOWER prize tiers (3/4 for 5/35,
///                                    3/4/5 for 6/49), distributed by fixed shares
///     - the remainder (48%) -> the common, cumulative jackpot pool
///   The JACKPOT for each game is a percentage of the cumulative pool snapshot taken
///   at draw time (6/49 jackpot = 50% of pool, 5/35 jackpot = 10% of pool). If a
///   jackpot has no winner it stays in the pool and rolls over. If a lower tier has
///   no winner, its budget is moved into the cumulative pool as well.
abstract contract BulgarianTotoStorage {
    // ============================================================
    // ENUMS / STRUCTS
    // ============================================================

    enum RoundState {
        Open,
        AwaitingVRF,
        Tallying,
        Claimable,
        Expired
    }

    struct Round {
        // slot 1
        uint64 drawTime;        // earliest moment a draw can be requested
        uint64 expiryTime;      // earliest moment leftover prizes can be swept
        uint64 drawnMask5;      // bitmask of 5/35 drawn numbers
        uint64 drawnMask6;      // bitmask of 6/49 drawn numbers
        // slot 2
        uint128 stake5;         // total USDC staked on 5/35 this round (net of refunds)
        uint128 stake6;         // total USDC staked on 6/49 this round (net of refunds)
        // slot 3
        uint128 poolSnapshot;   // cumulative pool captured at requestDraw (sizes the jackpots)
        uint128 jackpotEarmark; // max jackpot reserved out of the pool at requestDraw
        // slot 4
        uint64 tallyCursor;     // next ticket index to tally
        uint8 state;            // RoundState
    }

    struct Ticket {
        // slot 1
        address owner;          // 20
        uint32 roundId;         // 4
        uint32 purchaseTime;    // 4
        uint8 game;             // 1
        uint8 k;                // 1
        uint128 pricePaid;     
        bool claimed;           // 1
        bool refunded;          // 1
        // slot 2
        uint64 picksMask;       // 8 (bit n set => number n picked)
    }

    struct TierState {
        uint256 totalHits;      // sum of sub-ticket hits at this tier (set during tally)
        uint256 budget;         // USDC budget for this tier (frozen at finalize)
        uint256 remaining;      // budget remaining after claims; swept on expiry
    }

    /// @notice Aggregated round data returned by getRoundInfo().
    struct RoundInfo {
        uint64 drawTime;
        uint64 expiryTime;
        uint128 stake5;
        uint128 stake6;
        uint128 poolSnapshot;
        RoundState state;
        uint8[] drawn5;
        uint8[] drawn6;
        uint256 ticketCount;
    }

    // ============================================================
    // CONSTANTS
    // ============================================================

    uint8 public constant GAME_5_35 = 0;
    uint8 public constant GAME_6_49 = 1;

    uint8 public constant MAX_NUM_5_35 = 35;
    uint8 public constant MAX_NUM_6_49 = 49;

    uint8 public constant DRAW_COUNT_5_35 = 5; // R for 5/35
    uint8 public constant DRAW_COUNT_6_49 = 6; // R for 6/49

    uint8 public constant MIN_K_5_35 = 5;
    uint8 public constant MAX_K_5_35 = 7;
    uint8 public constant MIN_K_6_49 = 6;
    uint8 public constant MAX_K_6_49 = 8;

    uint8 public constant MIN_TIER = 3;

    // Default ticket prices in USDC base units (USDC has 6 decimals). These seed the
    // mutable price state variables (see STATE section) at deployment; afterwards the
    // admin may change any of them via setTicketPrice().
    // 5/35: 5 balls = 1.5, 6 balls = 6, 7 balls = 17 USDC
    uint256 public constant DEFAULT_PRICE_5_35_BASE = 1_500_000;  // 1.5 USDC (K=5)
    uint256 public constant DEFAULT_PRICE_5_35_PLUS1 = 6 * 1e6;   // 6 USDC   (K=6)
    uint256 public constant DEFAULT_PRICE_5_35_PLUS2 = 17 * 1e6;  // 17 USDC  (K=7)
    // 6/49: 6 balls = 2.5, 7 balls = 8, 8 balls = 21 USDC
    uint256 public constant DEFAULT_PRICE_6_49_BASE = 2_500_000;  // 2.5 USDC (K=6)
    uint256 public constant DEFAULT_PRICE_6_49_PLUS1 = 8 * 1e6;   // 8 USDC   (K=7)
    uint256 public constant DEFAULT_PRICE_6_49_PLUS2 = 21 * 1e6;  // 21 USDC  (K=8)

    uint16 public constant BPS_DENOM = 10000;

    // --- LOWER-TIER distribution (basis points of THAT GAME'S round stake) ---
    // Each game routes 50% (LOWER_FUND_BPS) of its own stakes to its lower tiers.
    // The shares below sum to 5000 bps (= 50%) within each game.
    //
    // 5/35 lower tiers: 4 numbers and 3 numbers (5 numbers is the jackpot tier).
    uint16 public constant LBPS_5_35_TIER4 = 1950; // 19.5% of stake (= 39% of the 50% fund)
    uint16 public constant LBPS_5_35_TIER3 = 3050; // 30.5% of stake (= 61% of the 50% fund)
    // 6/49 lower tiers: 5, 4 and 3 numbers (6 numbers is the jackpot tier).
    uint16 public constant LBPS_6_49_TIER5 = 1125; // 11.25% of stake (= 22.5% of the 50% fund)
    uint16 public constant LBPS_6_49_TIER4 = 1250; // 12.5%  of stake (= 25%   of the 50% fund)
    uint16 public constant LBPS_6_49_TIER3 = 2625; // 26.25% of stake (= 52.5% of the 50% fund)

    // Whole-game lower fund (5000 bps = 50% of that game's stake). Treasury is taken
    // from total stakes; the rest after lower funds goes to the cumulative pool.
    uint16 public constant LOWER_FUND_BPS = 5000;

    // --- JACKPOT distribution (basis points of the cumulative POOL snapshot) ---
    uint16 public constant JACKPOT_BPS_5_35 = 1000; // 10% of pool (5 numbers)
    uint16 public constant JACKPOT_BPS_6_49 = 6000; // 60% of pool (6 numbers)
    // Maximum that can be paid out of the pool in a single draw (both jackpots hit).
    uint16 public constant MAX_JACKPOT_BPS = JACKPOT_BPS_5_35 + JACKPOT_BPS_6_49; // 7000

    /// @notice Default interval between consecutive draws set at deployment.
    /// @dev    The active interval is mutable (see `drawInterval`); the admin may queue a
    ///         change via setDrawInterval() that only takes effect after 2 draws.
    uint256 public constant DEFAULT_DRAW_INTERVAL = 2 days;
    /// @notice Bounds for an admin-set draw interval. The minimum stays comfortably above
    ///         BUY_CUTOFF + REFUND_WINDOW so the purchase/refund windows remain usable.
    uint256 public constant MIN_DRAW_INTERVAL = 6 hours;
    uint256 public constant MAX_DRAW_INTERVAL = 30 days;
    uint256 public constant BUY_CUTOFF = 1 hours;
    uint256 public constant REFUND_WINDOW = 1 hours;
    uint256 public constant EXPIRY_PERIOD = 365 days;

    uint16 public constant TREASURY_BPS = 1000; // 10.0% of round stakes

    // ============================================================
    // STATE
    // ============================================================
    // NOTE: order is load-bearing for storage layout. Do not reorder.

    IERC20 public immutable usdc;

    bytes32 public keyHash;
    uint256 public subId;
    uint16 public requestConfirmations;
    uint32 public callbackGasLimit;

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => uint256[]) internal _roundTickets;
    Ticket[] public tickets;
    // Money reserved for a round at requestDraw (lower funds + jackpot earmark), held
    // outside the cumulative pool. At finalize it is reduced to the amount actually
    // owed to winners; unused reservation flows into the cumulative pool.
    mapping(uint256 => uint256) public earmarkedForRound;
    mapping(uint256 => mapping(uint8 => mapping(uint8 => TierState))) public tierState;
    mapping(uint256 => uint256) public vrfRequestToRound;

    uint256 public currentRoundId;

    // The common, cumulative jackpot pool ("всички събрани пари до сега"). Grows by the
    // non-lower, non-fee remainder of every round's stakes plus donations, no-winner
    // lower funds, unwon jackpot earmark and expired/unclaimed prizes. Jackpots are paid
    // out of it; if not won they roll over.
    uint256 public cumulativePool;

    address public treasury;

    mapping(address => uint256[]) internal _userTickets;

    // --- Draw interval (mutable, with delayed activation) ---
    // The active interval governs the spacing of the NEXT round opened at draw time.
    // A queued change does not apply immediately: it activates only once the round being
    // opened reaches `pendingIntervalActiveRound` (= currentRoundId + 2 at queue time),
    // i.e. after 2 draws. A `pendingDrawInterval` of 0 means no change is queued.
    uint256 public drawInterval;               // currently active interval between draws
    uint256 public pendingDrawInterval;        // queued interval (0 = none pending)
    uint256 public pendingIntervalActiveRound; // round id at which the queued interval activates

    // --- Owner donation tracking (reclaimable to treasury) ---
    // Net USDC the contract owner has donated via donate() and NOT yet reclaimed. Only the
    // owner's own donations accrue here; funds donated by any other address are never counted.
    // This is the hard cap for reclaimOwnerDonation(), so the owner can never pull back another
    // user's donation, a player's stake, or any earmarked prize money.
    uint256 public ownerDonations;

    // --- Mutable ticket prices (admin-settable via setTicketPrice) ---
    // Seeded at deployment from the DEFAULT_PRICE_* constants above. Each is the USDC
    // (6-decimal) price for one (game, pick-count) pair. Prices are bounded to type(uint128).max
    // so they never silently truncate when accumulated into the uint128 per-game round stakes.
    uint256 public price535_k5; // 5/35, K=5
    uint256 public price535_k6; // 5/35, K=6
    uint256 public price535_k7; // 5/35, K=7
    uint256 public price649_k6; // 6/49, K=6
    uint256 public price649_k7; // 6/49, K=7
    uint256 public price649_k8; // 6/49, K=8

    // ============================================================
    // EVENTS
    // ============================================================

    event RoundOpened(uint256 indexed roundId, uint64 drawTime);
    event TicketBought(
        uint256 indexed ticketId,
        uint256 indexed roundId,
        address indexed owner,
        uint8 game,
        uint8 k,
        uint64 picksMask,
        uint256 price
    );
    event TicketRefunded(uint256 indexed ticketId, address indexed owner, uint256 amount);
    event Donation(address indexed from, uint256 amount);
    /// @notice Emitted when the owner reclaims part of their own donations to the treasury.
    event OwnerDonationReclaimed(uint256 amount, address indexed treasury, uint256 remaining);
    event DrawRequested(uint256 indexed roundId, uint256 vrfRequestId, uint256 poolSnapshot);
    event DrawFulfilled(uint256 indexed roundId, uint64 mask5, uint64 mask6);
    event TallyAdvanced(uint256 indexed roundId, uint64 cursor, uint64 totalTickets);
    event RoundFinalized(uint256 indexed roundId, uint256 totalPrizeBudget, uint256 movedToPool);
    event Claimed(uint256 indexed ticketId, address indexed owner, uint256 amount);
    event RoundExpired(uint256 indexed roundId, uint256 leftover);
    event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury);
    /// @notice Emitted when the admin queues a draw-interval change (effective after 2 draws).
    event DrawIntervalChangeQueued(uint256 newInterval, uint256 activeRoundId);
    /// @notice Emitted when a queued draw-interval change becomes active for a round.
    event DrawIntervalActivated(uint256 indexed roundId, uint256 newInterval);
    event TreasuryFee(uint256 indexed roundId, uint256 amount);
    /// @notice Emitted when the admin changes the price of a (game, pick-count) ticket.
    event TicketPriceChanged(uint8 indexed game, uint8 indexed k, uint256 oldPrice, uint256 newPrice);
    event TicketTransferred(uint256 indexed ticketId, address indexed from, address indexed to);
    event CatchUpExecuted(
        address indexed caller,
        uint256 fromRoundId,
        uint256 toRoundId,
        uint256 actionsExecuted
    );

    // ============================================================
    // ERRORS
    // ============================================================

    error InvalidGame();
    error InvalidPickCount();
    error InvalidNumber();
    error DuplicateNumber();
    error WrongRoundState();
    error PurchaseWindowClosed();
    error RefundWindowClosed();
    error TooEarly();
    error NotOwner();
    error AlreadySettled();
    error NothingToClaim();
    error WrongRound();
    error AmountZero();
    error PoolUnderflow();
    error FirstDrawTooSoon();
    error IntervalOutOfRange();
    error InsufficientOwnerDonations();
    error InvalidPrice();

    /// @dev Constructor only sets the immutable `usdc`. All other state is initialized
    ///      by the concrete child's constructor.
    constructor(address _usdc) {
        usdc = IERC20(_usdc);
    }
}
