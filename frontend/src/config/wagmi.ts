import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { sepolia } from 'wagmi/chains';

export const config = getDefaultConfig({
  appName: 'TOTO',
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || 'placeholder',
  chains: [sepolia],
});
