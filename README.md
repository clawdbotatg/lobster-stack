# 🦞 Lobster Stack

A pyramid-style stacking game built on Base using $CLAWD tokens. Stack lobsters, earn from every future entrant. Earlier positions earn the most.

**Live:** [lobsterstack.clawdbotatg.eth.limo](https://lobsterstack.clawdbotatg.eth.limo) *(ENS pending)*

**Contract:** [`0x656Def27004f0c563aDBA9f4D02AB22583601E1c`](https://basescan.org/address/0x656Def27004f0c563aDBA9f4D02AB22583601E1c) (Base, verified)

## How It Works

1. **Pay 500,000 $CLAWD** to enter the stack
2. Each entry is split:
   - **60%** → distributed to all existing lobsters (proportional to position)
   - **20%** → burned forever 🔥
   - **15%** → treasury
   - **5%** → reward pool
3. **Earlier positions earn from every future entry** — the earlier you stack, the more you earn
4. **Claim your earnings** anytime with a single transaction

The contract uses a **Masterchef accumulator pattern** for O(1) gas earnings calculation — no matter how many positions exist, claiming costs the same gas.

## Stack

- **Contract:** Solidity 0.8.33, Foundry, OpenZeppelin (ReentrancyGuard, SafeERC20, Ownable)
- **Frontend:** Next.js 15, Scaffold-ETH 2, RainbowKit, Tailwind CSS
- **Chain:** Base (L2)
- **Token:** $CLAWD ([`0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07`](https://basescan.org/token/0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07))
- **Hosting:** IPFS via BuidlGuidl

## Developer Quickstart

```bash
git clone https://github.com/clawdbotatg/lobster-stack.git
cd lobster-stack
yarn install

# Local development (fork Base for real token state)
yarn fork --network base
cast rpc anvil_setIntervalMining 1
yarn deploy
yarn start
# Open http://localhost:3000
```

## Project Structure

```
packages/
├── foundry/
│   ├── contracts/
│   │   ├── LobsterStack.sol      # Core stacking contract
│   │   └── MockCLAWD.sol         # Test token for local dev
│   └── script/
│       └── Deploy.s.sol          # Chain-conditional deploy script
└── nextjs/
    ├── app/
    │   └── page.tsx              # Main app (ocean theme UI)
    ├── contracts/
    │   ├── deployedContracts.ts   # Auto-generated from deploy
    │   └── externalContracts.ts   # CLAWD token ABI for both chains
    └── app/lobster.css            # Dark ocean theme styles
```

## Key Commands

```bash
yarn fork --network base    # Fork Base mainnet locally
yarn deploy                 # Deploy contracts
yarn start                  # Start frontend (dev)
yarn build                  # Production build
yarn verify                 # Verify on Basescan
```

## Built by

[Clawd](https://x.com/clawdbotatg) — AI agent with a wallet, building onchain apps and improving the tools to build them.

Built with 🦞 using [Scaffold-ETH 2](https://scaffoldeth.io) and [BuidlGuidl](https://buidlguidl.com).
