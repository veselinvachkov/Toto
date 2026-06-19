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
  'function availablePool() view returns (uint256)',
  'function treasury() view returns (address)',
  'function TREASURY_BPS() view returns (uint16)',
  'function MAX_PAYOUT_BPS() view returns (uint16)',
  'function DRAW_INTERVAL() view returns (uint256)',
  'function BUY_CUTOFF() view returns (uint256)',
  'function REFUND_WINDOW() view returns (uint256)',
  'function EXPIRY_PERIOD() view returns (uint256)',
  'function ticketCount() view returns (uint256)',
  'function roundTicketCount(uint256 roundId) view returns (uint256)',
  'function roundTicketAt(uint256 roundId, uint256 idx) view returns (uint256)',
  'function ticketPrice(uint8 game, uint8 k) view returns (uint256)',
  'function tierPct(uint8 game, uint8 tier) view returns (uint16)',
  'function previewClaim(uint256 ticketId) view returns (uint256)',
  'function isWinner(uint256 ticketId) view returns (bool)',
  'function drawnNumbers(uint256 roundId) view returns (uint8[] five35, uint8[] six49)',
  'function getUserTickets(address user) view returns (uint256[])',
  'function getRoundInfo(uint256 roundId) view returns (tuple(uint64 drawTime, uint64 expiryTime, uint128 snapshotPool, uint8 state, uint8[] drawn5, uint8[] drawn6, uint256 ticketCount))',
  'function getRoundTiers(uint256 roundId) view returns (tuple(uint256 totalHits, uint256 budget, uint256 remaining)[3], tuple(uint256 totalHits, uint256 budget, uint256 remaining)[4])',
  'function tickets(uint256) view returns (address owner, uint32 roundId, uint32 purchaseTime, uint8 game, uint8 k, bool claimed, bool refunded, uint64 picksMask, bool lpCreditedAtBuy)',
  'function owner() view returns (address)',
  'function paused() view returns (bool)',

  // ── LP read ──
  'function totalLpShares() view returns (uint256)',
  'function totalLpAssets() view returns (uint256)',
  'function unfinalizedRounds() view returns (uint64)',
  'function LP_LOCKUP_ROUNDS() view returns (uint64)',
  'function LP_VIRTUAL_SHARES() view returns (uint256)',
  'function LP_MIN_POOL() view returns (uint256)',
  'function lpSnapshot(uint256 roundId) view returns (uint128 assets, uint128 shares)',
  'function lpAssetsAtSnap(uint256 roundId) view returns (uint128)',
  'function previewLpDeposit(uint256 amount) view returns (uint128)',
  'function previewLpWithdraw(uint128 shares) view returns (uint256)',
  'function lpTrancheCount(address lp) view returns (uint256)',
  'function lpTrancheAt(address lp, uint256 idx) view returns (tuple(uint128 shares, uint64 unlockRoundId))',
  'function lpAssetsOf(address lp) view returns (uint256)',

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
  'function pause()',
  'function unpause()',
  'function setTreasury(address _treasury)',
  'function setVrfConfig(bytes32 _keyHash, uint256 _subId, uint16 _confirmations, uint32 _callbackGasLimit)',

  // ── LP write ──
  'function depositLp(uint256 amount) returns (uint128)',
  'function withdrawLp(uint256 trancheIndex, uint128 sharesToBurn) returns (uint256)',

  // ── custom errors ──
  'error AlreadySettled()',
  'error AmountZero()',
  'error DuplicateNumber()',
  'error FirstDrawTooSoon()',
  'error InsufficientLiquidity()',
  'error InsufficientShares()',
  'error InvalidGame()',
  'error InvalidNumber()',
  'error InvalidPickCount()',
  'error InvalidTranche()',
  'error LpAmountZero()',
  'error LpPoolBelowThreshold()',
  'error LpSharesZero()',
  'error NotOwner()',
  'error NothingToClaim()',
  'error PoolUnderflow()',
  'error PreviousRoundNotSettled()',
  'error PurchaseWindowClosed()',
  'error RefundWindowClosed()',
  'error TooEarly()',
  'error TrancheLocked()',
  'error WrongRound()',
  'error WrongRoundState()',
  'error ZeroAddress()',
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error OwnableUnauthorizedAccount(address account)',
  'error ReentrancyGuardReentrantCall()',

  // ── events ──
  'event TicketBought(uint256 indexed ticketId, uint256 indexed roundId, address indexed owner, uint8 game, uint8 k, uint64 picksMask, uint256 price)',
  'event Claimed(uint256 indexed ticketId, address indexed owner, uint256 amount)',
  'event TicketTransferred(uint256 indexed ticketId, address indexed from, address indexed to)',
  'event LpDeposited(address indexed lp, uint256 amount, uint128 shares, uint64 unlockRoundId)',
  'event LpWithdrawn(address indexed lp, uint256 indexed trancheIndex, uint128 shares, uint256 amount)',
  'event LpSnapshotTaken(uint256 indexed roundId, uint128 assets, uint128 shares)',
  'event LpSlashed(uint256 indexed roundId, uint256 lpLoss)',
  'event LpCredited(uint256 indexed roundId, uint256 lpCredit)',
];

export const USDC_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
