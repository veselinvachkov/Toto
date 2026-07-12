# BulgarianToto

A decentralized on-chain lottery inspired by the Bulgarian Toto, built with Solidity and Foundry. It supports two game formats (5/35 and 6/49) with base and +1/+2 ticket variants. Players buy tickets with USDC, winning numbers are drawn using Chainlink VRF for verifiable randomness, and prizes are paid from tiered pools with a rolling cumulative jackpot. A React + Vite frontend (wagmi / RainbowKit) lets users buy tickets, track results, and view round history.

**Stack:** Solidity, Foundry, Chainlink VRF, React, TypeScript, wagmi, viem — deployed on the Sepolia testnet.

---

## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

```shell
$ forge test
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```

