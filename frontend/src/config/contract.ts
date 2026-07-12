export const CONTRACT_ADDRESS =
  import.meta.env.VITE_CONTRACT_ADDRESS ||
  '0x0000000000000000000000000000000000000000';

/// Optional override; if unset the frontend reads `usdc()` from the lottery
/// contract so the addresses can never drift.
export const USDC_ADDRESS_OVERRIDE: string | undefined =
  import.meta.env.VITE_USDC_ADDRESS;

/// Block the lottery contract was deployed at. Used to bound `eth_getLogs`
/// queries (e.g. the leaderboard) - scanning from genesis is rejected by
/// most public RPCs and is what made the "Top 5 wins" panel stay empty.
export const DEPLOY_BLOCK = Number(
  import.meta.env.VITE_DEPLOY_BLOCK ?? 10841966,
);

export const TOTO_ABI = [
  // ── read ──
  'function usdc() view returns (address)',
  'function currentRoundId() view returns (uint256)',
  'function cumulativePool() view returns (uint256)',
  'function treasury() view returns (address)',
  'function roundTicketCount(uint256 roundId) view returns (uint256)',
  'function roundTicketAt(uint256 roundId, uint256 idx) view returns (uint256)',
  'function ticketPrice(uint8 game, uint8 k) view returns (uint256)',
  'function previewClaim(uint256 ticketId) view returns (uint256)',
  'function isWinner(uint256 ticketId) view returns (bool)',
  'function getUserTickets(address user) view returns (uint256[])',
  'function getRoundInfo(uint256 roundId) view returns (tuple(uint64 drawTime, uint64 expiryTime, uint128 stake5, uint128 stake6, uint128 poolSnapshot, uint8 state, uint8[] drawn5, uint8[] drawn6, uint256 ticketCount))',
  'function getRoundTiers(uint256 roundId) view returns (tuple(uint256 totalHits, uint256 budget, uint256 remaining)[3], tuple(uint256 totalHits, uint256 budget, uint256 remaining)[4])',
  'function tickets(uint256) view returns (address owner, uint32 roundId, uint32 purchaseTime, uint8 game, uint8 k, uint128 pricePaid, bool claimed, bool refunded, uint64 picksMask)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function drawInterval() view returns (uint256)',
  'function pendingDrawInterval() view returns (uint256)',
  'function pendingIntervalActiveRound() view returns (uint256)',
  'function ownerDonations() view returns (uint256)',
  'function DEFAULT_DRAW_INTERVAL() view returns (uint256)',
  'function MIN_DRAW_INTERVAL() view returns (uint256)',
  'function MAX_DRAW_INTERVAL() view returns (uint256)',
  'function VRF_RETRY_TIMEOUT() view returns (uint256)',
  'function roundVrfRequest(uint256 roundId) view returns (uint256)',
  'function vrfRequestedAt(uint256 roundId) view returns (uint64)',

  // ── write ──
  'function buyTicket(uint8 game, uint8[] picks) returns (uint256)',
  'function donate(uint256 amount)',
  'function refund(uint256 ticketId)',
  'function transferTicket(uint256 ticketId, address to)',
  'function claim(uint256 ticketId) returns (uint256)',
  'function claimBatch(uint256[] ticketIds) returns (uint256)',
  'function requestDraw(uint256 roundId) returns (uint256)',
  'function tallyBatch(uint256 roundId, uint256 maxTickets) returns (bool)',
  'function sweepExpired(uint256 roundId)',
  'function catchUp(uint256 startRoundId, uint256 maxRoundsToScan, uint256 tallyBatchSize) returns (uint256)',
  'function retryDraw(uint256 roundId) returns (uint256)',
  'function pause()',
  'function unpause()',
  'function setTreasury(address _treasury)',
  'function setVrfConfig(bytes32 _keyHash, uint256 _subId, uint16 _confirmations, uint32 _callbackGasLimit)',
  'function setDrawInterval(uint256 newInterval)',
  'function reclaimOwnerDonation(uint256 amount)',

  // ── custom errors ──
  'error AlreadySettled()',
  'error AmountZero()',
  'error DuplicateNumber()',
  'error FirstDrawTooSoon()',
  'error InvalidGame()',
  'error InvalidNumber()',
  'error InvalidPickCount()',
  'error NotOwner()',
  'error NothingToClaim()',
  'error PoolUnderflow()',
  'error PurchaseWindowClosed()',
  'error RefundWindowClosed()',
  'error TooEarly()',
  'error WrongRound()',
  'error WrongRoundState()',
  'error ZeroAddress()',
  'error IntervalOutOfRange()',
  'error InsufficientOwnerDonations()',
  'error InvalidPrice()',
  'error CallbackGasLimitTooLow()',
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error OwnableUnauthorizedAccount(address account)',
  'error ReentrancyGuardReentrantCall()',

  // ── events ──
  'event TicketBought(uint256 indexed ticketId, uint256 indexed roundId, address indexed owner, uint8 game, uint8 k, uint64 picksMask, uint256 price)',
  'event Claimed(uint256 indexed ticketId, address indexed owner, uint256 amount)',
  'event DrawIntervalChangeQueued(uint256 newInterval, uint256 activeRoundId)',
  'event DrawIntervalActivated(uint256 indexed roundId, uint256 newInterval)',
  'event Donation(address indexed from, uint256 amount)',
  'event OwnerDonationReclaimed(uint256 amount, address indexed treasury, uint256 remaining)',
  'event DrawRetried(uint256 indexed roundId, uint256 oldRequestId, uint256 newRequestId)',
];

export const USDC_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
];
