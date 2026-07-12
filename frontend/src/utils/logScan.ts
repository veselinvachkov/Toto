import { JsonRpcProvider, Network } from 'ethers';
import type { Contract, ContractEventName, EventLog, Log } from 'ethers';
import { CHAIN_ID } from '../config/wagmi';
import { RPC_URLS } from '../hooks/useEthers';

// Historical `eth_getLogs` scans (leaderboard, claimed-payout history) cannot
// go through the shared FallbackProvider: with quorum 1 the FIRST response
// wins even when it is an error, and publicnode now answers getLogs instantly
// with "archive requests require a personal token" - so the working endpoints
// further down the list were never consulted and every scan window failed.
// This module fails over EXPLICITLY: try each endpoint in turn, return the
// first successful result, and remember which endpoint worked so subsequent
// windows go straight to it instead of re-paying the broken ones' latency.
const NETWORK = Network.from(CHAIN_ID);

// Extra endpoints known to serve multi-thousand-block getLogs ranges. Only
// appended to the defaults - a VITE_RPC_URLS override (dedicated provider)
// is used as-is plus these as a last resort.
const EXTRA_SCAN_URLS =
  CHAIN_ID === 1
    ? [
        'https://mainnet.gateway.tenderly.co',
        'https://eth.merkle.io',
      ]
    : [
        'https://sepolia.gateway.tenderly.co',
        'https://eth-sepolia.api.onfinality.io/public',
      ];

const SCAN_URLS = [...new Set([...RPC_URLS, ...EXTRA_SCAN_URLS])];

const scanProviders = SCAN_URLS.map(
  (url) => new JsonRpcProvider(url, NETWORK, { staticNetwork: NETWORK }),
);

// Sticky index of the endpoint that most recently served a scan window, so a
// 30-window history scan pays the broken-endpoint probe once, not 30 times.
let preferred = 0;

// A stalled endpoint must not hang a scan window for minutes - cut the attempt
// and move to the next endpoint. The orphaned request is simply ignored.
const ATTEMPT_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('log scan attempt timed out')),
      ms,
    );
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * `contract.queryFilter(filter, fromBlock, toBlock)` with explicit per-endpoint
 * failover. Throws only if EVERY endpoint failed for this window.
 */
export async function queryFilterFailover(
  contract: Contract,
  filter: ContractEventName,
  fromBlock: number,
  toBlock: number,
): Promise<Array<EventLog | Log>> {
  let lastError: unknown;
  for (let n = 0; n < scanProviders.length; n++) {
    const i = (preferred + n) % scanProviders.length;
    try {
      const bound = contract.connect(scanProviders[i]) as Contract;
      const logs = await withTimeout(
        bound.queryFilter(filter, fromBlock, toBlock),
        ATTEMPT_TIMEOUT_MS,
      );
      preferred = i;
      return logs;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
