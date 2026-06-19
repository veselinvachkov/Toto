import { useEffect, useMemo, useState } from 'react';
import { Contract } from 'ethers';
import { useEthersSigner, readProvider } from './useEthers';
import {
  CONTRACT_ADDRESS,
  TOTO_ABI,
  USDC_ABI,
  USDC_ADDRESS_OVERRIDE,
} from '../config/contract';

/** Read-only contract instance (always available via public RPC). */
export function useTotoRead(): Contract {
  return useMemo(
    () => new Contract(CONTRACT_ADDRESS, TOTO_ABI, readProvider),
    [],
  );
}

/** Writable contract instance (null if no wallet connected). */
export function useTotoWrite(): Contract | null {
  const signer = useEthersSigner();
  return useMemo(
    () => (signer ? new Contract(CONTRACT_ADDRESS, TOTO_ABI, signer) : null),
    [signer],
  );
}

/// Cache of the resolved USDC address so we resolve once per page load.
let cachedUsdcAddress: string | null = USDC_ADDRESS_OVERRIDE ?? null;
let inflightUsdc: Promise<string> | null = null;

async function resolveUsdcAddress(): Promise<string> {
  if (cachedUsdcAddress) return cachedUsdcAddress;
  if (inflightUsdc) return inflightUsdc;
  const toto = new Contract(CONTRACT_ADDRESS, TOTO_ABI, readProvider);
  inflightUsdc = toto.usdc().then((addr: string) => {
    cachedUsdcAddress = addr;
    inflightUsdc = null;
    return addr;
  });
  return inflightUsdc;
}

/** Returns the resolved USDC address (undefined while loading). */
export function useUsdcAddress(): string | undefined {
  const [addr, setAddr] = useState<string | undefined>(
    cachedUsdcAddress ?? undefined,
  );
  useEffect(() => {
    if (cachedUsdcAddress) return;
    let cancelled = false;
    resolveUsdcAddress()
      .then((a) => { if (!cancelled) setAddr(a); })
      .catch(() => { /* contract not deployed; leave undefined */ });
    return () => { cancelled = true; };
  }, []);
  return addr;
}

/** USDC read instance - null until the address is resolved from chain. */
export function useUsdcRead(): Contract | null {
  const usdcAddr = useUsdcAddress();
  return useMemo(
    () => (usdcAddr ? new Contract(usdcAddr, USDC_ABI, readProvider) : null),
    [usdcAddr],
  );
}

/** USDC write instance - null without wallet or before address resolves. */
export function useUsdcWrite(): Contract | null {
  const signer = useEthersSigner();
  const usdcAddr = useUsdcAddress();
  return useMemo(
    () => (signer && usdcAddr ? new Contract(usdcAddr, USDC_ABI, signer) : null),
    [signer, usdcAddr],
  );
}
