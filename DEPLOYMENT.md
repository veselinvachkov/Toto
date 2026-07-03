# Deployment & Security Checklist

Pre-launch steps to keep keys discreet and the protocol's critical surfaces out
of users' reach. Work top to bottom.

## 0. Mental model (read once)

- **The frontend is fully public.** Every byte shipped to the browser — JS, env
  vars prefixed `VITE_`, the admin page — is readable by anyone. Hiding the
  admin route is cosmetic. The *only* real protection is the contract's
  `onlyOwner` checks, which are in place.
- **Secrets live server-side only.** Private keys and RPC keys belong in the
  root `.env` (used by `forge`) or behind a proxy — never in the frontend.

## 1. Secrets hygiene

- [ ] `.env` is git-ignored (it is) and was **never** committed. After
      `git init`, verify: `git log --all --full-history -- .env` returns nothing.
- [ ] Only `.env.example` files are tracked (no real values in them).
- [ ] `broadcast/`, `out/`, `cache/`, `node_modules/`, `frontend/dist/` stay
      git-ignored (they are).
- [ ] Rotate the testnet `PRIVATE_KEY` if it was ever pasted/shared. Treat it as
      burned for anything with value.

## 2. Deploy with a key that never touches disk (production)

Do **not** put the production deployer key in `.env`. Import it once into an
encrypted keystore (or use a hardware wallet), then sign per deploy:

```bash
cast wallet import totoDeployer --interactive      # one-time, prompts for key + password

forge script script/Deploy.s.sol:DeployBulgarianToto \
    --rpc-url "$SEPOLIA_RPC_URL" --account totoDeployer --broadcast --verify
```

Hardware wallet: replace `--account totoDeployer` with `--ledger` (or `--trezor`).

> The scripts auto-detect: if `PRIVATE_KEY` is set they use it (testnet
> convenience); if it is empty they use the `--account`/`--ledger` signer.

## 3. Hand control to a multisig (production)

A single hot key owning `pause` / `setTreasury` / `setVrfConfig` is a single
point of failure. After deploy, move ownership to a Gnosis Safe:

```bash
NEW_OWNER=<your_safe_address> TOTO_ADDRESS=<deployed_contract> \
forge script script/TransferOwnership.s.sol:TransferOwnership \
    --rpc-url "$SEPOLIA_RPC_URL" --account totoDeployer --broadcast
```

This is two-step (Chainlink `ConfirmedOwnerWithProposal`):
- [ ] Step 1 — run the script above (proposes the new owner).
- [ ] Step 2 — from the Safe, call `acceptOwnership()` on the contract.
      Ownership is **not** transferred until this executes.
- [ ] Set `TREASURY` to the multisig too (or a dedicated cold address).

## 4. Frontend RPC (do before serving real traffic)

Public RPCs rate-limit and will blank the app under load.

- [ ] Use a domain-restricted Alchemy/Infura key **or** a small server-side
      proxy that holds the key. Point `VITE_RPC_URLS` at the proxy/restricted
      key — never a raw unrestricted key (it is extractable from the bundle).
- [ ] Confirm the WalletConnect project id is the public client id (it is).

## 5. Build & verify what ships to the domain

```bash
cd frontend && npm run build
# Sanity: dist must contain NO secrets and NO sourcemaps
grep -rEl "PRIVATE_KEY|mnemonic|0x[a-fA-F0-9]{64}" dist/assets 2>/dev/null   # expect: no OUR keys
find dist -name "*.map"                                                       # expect: empty
```

- [ ] Upload only `frontend/dist/` to the domain. Never upload `.env`,
      `broadcast/`, `script/`, `out/`, or `src/` contracts source if you want
      them private (the deployed bytecode is public regardless; source is your
      choice to publish/verify).

## 6. Post-deploy on-chain checklist

- [ ] `owner()` is the multisig (after step 3 accept).
- [ ] `treasury()` is the intended address.
- [ ] Contract added as a consumer on the VRF subscription, subscription funded.
- [ ] `paused()` is the state you want at launch.
