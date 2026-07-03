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

// Several Sepolia endpoints behind a FallbackProvider (quorum 1): each request
// goes to the highest-priority endpoint and transparently fails over to the
// next on error/stall, so one throttled node never blanks the page.
// `staticNetwork` also drops the per-request eth_chainId round-trip.
//
// SCALE: public RPCs rate-limit hard (HTTP 429) and will not survive tens of
// thousands of concurrent readers. Point `VITE_RPC_URLS` (comma-separated) at a
// dedicated provider (Alchemy/Infura/QuickNode) or your own proxy in
// production. The public list below is only a development / fallback default.
const PUBLIC_RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://sepolia.drpc.org',
  'https://1rpc.io/sepolia',
  'https://rpc.sepolia.org',
];

const RPC_URLS = (() => {
  const fromEnv = (import.meta.env.VITE_RPC_URLS as string | undefined)
    ?.split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  return fromEnv && fromEnv.length > 0 ? fromEnv : PUBLIC_RPC_URLS;
})();

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
