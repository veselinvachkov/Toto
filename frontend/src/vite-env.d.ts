/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTRACT_ADDRESS: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID: string;
  readonly VITE_USDC_ADDRESS?: string;
  readonly VITE_DEPLOY_BLOCK?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
