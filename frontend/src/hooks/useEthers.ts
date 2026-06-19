import { useMemo } from 'react';
import {
  BrowserProvider,
  FallbackProvider,
  JsonRpcProvider,
  JsonRpcSigner,
  Network,
} from 'ethers';
import { useConnectorClient } from 'wagmi';

const SEPOLIA = Network.from(11155111);

// Several public Sepolia endpoints. A single public RPC rate-limits (HTTP 429)
// under the app's read bursts - when that happened every read threw and the UI
// silently fell back to defaults (0 USDC, empty history). A FallbackProvider
// with quorum 1 sends each request to the highest-priority endpoint and
// transparently fails over to the next on error/stall, so one node being
// throttled no longer blanks the page. `staticNetwork` also drops the
// per-request eth_chainId round-trip.
const RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
  'https://1rpc.io/sepolia',
  'https://rpc.sepolia.org',
];

/** Public read-only provider (no wallet required). */
export const readProvider = new FallbackProvider(
  RPC_URLS.map((url, i) => ({
    provider: new JsonRpcProvider(url, SEPOLIA, { staticNetwork: SEPOLIA }),
    priority: i + 1, // try publicnode first, fail over down the list
    stallTimeout: 2500,
    weight: 1,
  })),
  SEPOLIA,
  { quorum: 1 },
);

/** Convert a wagmi connector client into an ethers.js JsonRpcSigner. */
function clientToSigner(client: any): JsonRpcSigner {
  const { account, chain, transport } = client;
  const network = { chainId: chain.id, name: chain.name };
  const provider = new BrowserProvider(transport, network);
  return new JsonRpcSigner(provider, account.address);
}

/** Returns an ethers v6 signer for the connected wallet (undefined if disconnected). */
export function useEthersSigner(): JsonRpcSigner | undefined {
  const { data: client } = useConnectorClient();
  return useMemo(() => (client ? clientToSigner(client) : undefined), [client]);
}
