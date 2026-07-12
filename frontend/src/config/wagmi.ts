import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { mainnet, sepolia } from 'wagmi/chains';

/// Target chain is env-driven so the same build config serves both networks:
///   VITE_CHAIN_ID=1        -> Ethereum mainnet (real USDC)
///   VITE_CHAIN_ID=11155111 -> Sepolia (default when unset)
export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 11155111);
export const ACTIVE_CHAIN = CHAIN_ID === 1 ? mainnet : sepolia;

export const config = getDefaultConfig({
  appName: 'TOTO',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'placeholder',
  chains: [ACTIVE_CHAIN],
});
