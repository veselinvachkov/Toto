# Deploy commands — Sepolia, single keystore owner

Concrete, copy-paste sequence for the chosen setup:
- **Network:** Sepolia testnet
- **Owner:** a single encrypted keystore key (no multisig)

The deployer keystore address automatically becomes the contract `owner`
(the constructor sets `owner = msg.sender`). No `transferOwnership` step needed.

> Fill the four values in STEP 1 first. Everything else is copy-paste.
> `--account totoDeployer` means the key is read from the encrypted keystore at
> sign time — no plaintext key on disk, nothing in `.env`.

---

## STEP 0 — one-time: import the deployer key into a keystore

```bash
cast wallet import totoDeployer --interactive
# Paste the deployer private key + set a password. Note the ADDRESS it prints —
# that address becomes the contract owner. Fund it with Sepolia ETH for gas.
```

Confirm it's stored (no key shown, just the address):
```bash
cast wallet address --account totoDeployer
```

---

## STEP 1 — set the non-secret values (this shell session)

```bash
export SEPOLIA_RPC_URL="<your_sepolia_rpc_url>"      # e.g. Alchemy/Infura URL
export VRF_SUB_ID="<your_chainlink_vrf_v2.5_sub_id>"  # from vrf.chain.link/sepolia
export TREASURY="<address_that_receives_the_fee>"     # can be the owner address
export ETHERSCAN_API_KEY="<etherscan_api_key>"        # only needed for --verify
# Existing MockUSDC you already deployed (mint is permissionless):
export MOCK_USDC_ADDRESS="0xc5Ee50Fb5EEe489bb059603a4F3EE5e06229429E"  # confirm this is yours
```

> Make sure `PRIVATE_KEY` is NOT exported/set, so the script uses `--account`.
> `unset PRIVATE_KEY` if unsure.

---

## STEP 2 — deploy the lottery (reusing your MockUSDC)

```bash
forge script script/RedeployToto.s.sol:RedeployToto \
    --rpc-url "$SEPOLIA_RPC_URL" \
    --account totoDeployer \
    --broadcast --verify
```

The script prints `New BulgarianToto at: 0x...`. Copy that address.

> Brand-new USDC instead of reusing one? Use `script/Deploy.s.sol` (uses a fixed
> Sepolia USDC) the same way. `DeployTestnet.s.sol` mints a fresh MockUSDC but
> still needs a plaintext `PRIVATE_KEY`, so prefer the two keystore-ready scripts.

---

## STEP 3 — register the contract as a VRF consumer

At https://vrf.chain.link/sepolia → your subscription → **Add consumer** →
paste the new contract address. Make sure the subscription holds LINK.

---

## STEP 4 — point the frontend at the new contract

Edit `frontend/.env` (git-ignored — safe):
```bash
VITE_CONTRACT_ADDRESS=<new_contract_address_from_step_2>
VITE_WALLETCONNECT_PROJECT_ID=<your_walletconnect_id>
# VITE_RPC_URLS=<domain-restricted RPC or your proxy>   # before real traffic
```

Then build and ship only `dist/`:
```bash
cd frontend && npm run build
# upload ONLY frontend/dist/ to the domain
```

---

## STEP 5 — verify on-chain (sanity)

```bash
TOTO=<new_contract_address>
cast call $TOTO "owner()(address)"    --rpc-url "$SEPOLIA_RPC_URL"  # == your keystore address
cast call $TOTO "treasury()(address)" --rpc-url "$SEPOLIA_RPC_URL"  # == $TREASURY
cast call $TOTO "paused()(bool)"      --rpc-url "$SEPOLIA_RPC_URL"  # state you want at launch
```

---

## Optional — mint test USDC (permissionless mint)

```bash
cast send "$MOCK_USDC_ADDRESS" "mint(address,uint256)" \
    <recipient_address> 1000000000000 \
    --account totoDeployer --rpc-url "$SEPOLIA_RPC_URL"   # 1,000,000 USDC (6 decimals)
```

---

## Admin actions later (owner-only, signed by the keystore)

```bash
TOTO=<contract_address>
# Pause / unpause ticket sales
cast send $TOTO "pause()"   --account totoDeployer --rpc-url "$SEPOLIA_RPC_URL"
cast send $TOTO "unpause()" --account totoDeployer --rpc-url "$SEPOLIA_RPC_URL"
# Change treasury
cast send $TOTO "setTreasury(address)" <new_treasury> --account totoDeployer --rpc-url "$SEPOLIA_RPC_URL"
```

> If you later want to remove the single-key risk, create a Gnosis Safe and run
> `script/TransferOwnership.s.sol` (see DEPLOYMENT.md §3).
