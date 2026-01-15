# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **Bault Compoundor Bot** for Berachain that automatically compounds BGT (Berachain Governance Token) rewards from Kodiak Finance baults when profitable. The bot operates autonomously, claiming rewards as BGT wrappers (yBGT, lBGT, iBGT, mBGT) or BERA, swapping them via Enso protocol, and compounding them back into baults.

**Key Concept**: The bot uses the BountyHelper contract which allows zero-capital compounding by borrowing the bounty upfront. The bot's profit comes from excess tokens after returning the borrowed bounty.

## Development Commands

### Prerequisites
Install dependencies:
```bash
bun install
# or
npm install
```

### Running the Bot
```bash
# Development (with Bun - recommended)
bun src/simpleCompoundor.ts

# Development (with Node)
npx ts-node src/simpleCompoundor.ts

# Using npm scripts
npm run compound              # Runs simpleCompoundor with Bun
npm run bgt-compound          # Runs bgtCompoundor with Bun
npm run compound:node         # Builds and runs with Node
```

### Production Deployment (PM2)
```bash
# Install PM2
npm install -g pm2

# Start the bot
pm2 start src/simpleCompoundor.ts --interpreter bun --name bault-bot

# Monitor logs
pm2 logs bault-bot

# Other PM2 commands
pm2 stop bault-bot
pm2 restart bault-bot
pm2 delete bault-bot
```

### Build Commands
```bash
npm run build     # Compiles TypeScript to dist/
npm run clean     # Removes dist/ directory
```

## Architecture Overview

### Core Execution Flow (mainLoop)

1. **Data Fetching** (`getBaultsWithCompleteData`)
   - Fetches bault list from Kodiak backend API
   - Executes batched multicall for all baults to get: bounty amounts, earned BGT, wrapper restrictions
   - Filters by MIN_EARNINGS_BGT threshold
   - Uses batched wrapper preview calls to find best wrapper for each bault

2. **Profitability Check**
   - Uses subgraph prices for preliminary filtering (wrapper value >= 99% of bounty)
   - Gets Enso quote for accurate swap pricing
   - Only eligible if quote amountOut >= bounty (ensures profitability)

3. **Transaction Execution** (`tryCompound`)
   - Simulates transaction before execution
   - Calls BountyHelper.claimBgtWrapper with Enso route data
   - Tracks excess tokens sent to BENEFICIARY_ADDRESS
   - Implements retry logic with increasing slippage

4. **Result Reporting**
   - Logs eligible/ineligible baults with reward/bounty comparisons
   - Reports transaction success/failure with Berascan links
   - Shows performance metrics (RPC stats, timing)

### Key Architectural Patterns

#### RPC Call Optimization
The codebase heavily optimizes RPC calls using multicall batching:

- **Before optimization**: N separate RPC calls for N baults
- **After optimization**: 1 batched multicall for N baults

Key optimization locations:
- `getBaultsWithCompleteData`: Batches bounty/earned/wrapper calls (3N → 1 RPC)
- `batchPreviewWrapperMints`: Batches wrapper preview calls across all baults
- RPC stats tracking in `rpcUtils.ts` measures multicall vs non-multicall requests

#### Wrapper Selection Logic
Located in `compoundingUtils.ts`:

1. **Config-driven**: `ONLY_ALLOW_DEFAULT_WRAPPER` flag controls strategy
   - `true`: Only use `DEFAULT_BGT_WRAPPER_ADDRESS`
   - `false`: Compare all wrappers (YBGT, LBGT, iBGT, mBGT) + BERA

2. **Bault restrictions**: Respects `onlyAllowedBgtWrapper` from bault contract
   - If bault specifies a wrapper, only that wrapper can be used
   - If zero address, bot can choose any wrapper

3. **Price-based selection** (`findBestWrapper`, `selectBestWrapperFromData`)
   - Fetches wrapper prices from Kodiak subgraph
   - Calculates wrapper value in staking token terms
   - Compares with BERA value (considers burn tax vs LST premium)
   - Falls back to Enso quotes if subgraph prices unavailable

#### Retry and Slippage Management

The bot implements sophisticated retry logic:

```typescript
// Initial slippage: COMPOUND_SLIPPAGE_BPS (default 20 = 0.2%)
// Per retry: adds SLIPPAGE_INCREMENT_PER_RETRY (15 = 0.15%)
// Max slippage cap: MAX_COMPOUND_SLIPPAGE_BPS (100 = 1%)
```

Retry behavior:
- Checks if another bot already compounded (compares current vs original earnedBgt)
- Refetches Enso quote with higher slippage on retry
- Tracks retry state in `retryMap` to detect external compounds
- Configurable via `MAX_RETRIES` (default: 0)

### File Structure

```
src/
├── simpleCompoundor.ts       # Main entry point with mainLoop and tryCompound
├── bgtCompoundor.ts          # Alternative BGT-focused compounding strategy
├── compoundingUtils.ts       # Core logic: data fetching, wrapper selection, price calculation
├── EnsoQuoter.ts             # Enso API integration for swap quotes
├── rpcUtils.ts               # RPC client setup with call tracking
├── configuration.ts          # All environment variables and constants
├── types.ts                  # TypeScript type definitions
├── abis/
│   ├── Bault.ts              # Bault contract ABI
│   ├── BountyHelperABI.ts    # BountyHelper contract ABI
│   └── ERC20.ts              # ERC20 token ABI
└── types/
    └── bun.d.ts              # Bun-specific type declarations
```

### Critical Configuration (`src/configuration.ts`)

**Required Environment Variables** (in `.env`):
- `RPC_URL`: Berachain RPC endpoint
- `ENSO_API_KEY`: API key from https://shortcuts.enso.finance/developers
- `PRIVATE_KEY`: Bot wallet private key (must have gas for txs)

**Filtering Options**:
- `RESTRICT_BAULTS` + `ONLY_BAULT_ADDRESSES`: Whitelist specific bault addresses
- `RESTRICT_STAKING_TOKENS` + `ONLY_STAKING_TOKEN_ADDRESSES`: Whitelist by underlying asset

**Wrapper Strategy**:
- `ONLY_ALLOW_DEFAULT_WRAPPER`: If true, only uses DEFAULT_BGT_WRAPPER_ADDRESS
- `DEFAULT_BGT_WRAPPER_ADDRESS`: Fallback wrapper (default: iBGT)

**Contract Addresses**:
- `BOUNTY_HELPER_ADDRESS`: Zero-capital compounding contract
- `BENEFICIARY_ADDRESS`: Receives excess tokens (defaults to signer if empty)

### External Dependencies

1. **Kodiak Backend API** (`KODIAK_BAULTS_API_URL`)
   - Fetches list of all baults with metadata
   - Provides staking token prices from subgraph

2. **Kodiak Subgraph** (Goldsky)
   - Token prices via `getTokenPricesFromSubgraph`
   - BERA price via `getBeraPrice`

3. **Enso Protocol**
   - Swap routing and execution
   - Called via `getEnsoQuote` with slippage tolerance

4. **Berachain RPC**
   - All on-chain interactions via viem
   - Uses multicall3 for batched calls

### Data Types

```typescript
// Complete bault data with wrapper selection
BaultCompleteData {
  stakingToken: Address;       // Underlying asset (LP token)
  bault: Address;              // Bault contract address
  symbol: string;              // Human-readable identifier
  bounty: bigint;              // Required bounty to borrow
  earnedBgt: bigint;           // BGT earned by bault
  wrapper: Address;            // Selected wrapper (yBGT/lBGT/iBGT/mBGT/WBERA)
  wrapperMintAmount: bigint;   // Amount of wrapper to claim
  wrapperValueInStakingToken: bigint;  // Expected output from swap
  error?: string;              // Error message if processing failed
}

// Transaction result tracking
CompoundResult {
  status: 'success' | 'fail' | 'skipped';
  tx: Hash | null;
  error?: string;
  excessTokensReceived?: bigint;  // Bot's profit
}
```

## Development Notes

### Cross-Runtime Compatibility
The bot supports both Bun and Node.js runtimes. The `getEnvVar` utility in `configuration.ts` handles environment variable access across both runtimes.

### Error Handling Philosophy
- Multicall uses `allowFailure: true` for batch operations to prevent one failure from blocking others
- Individual bault failures are tracked via the `error` field in data structures
- Nonce-related errors trigger skipping (prevents stuck transactions)
- Failed baults continue in retry map until max retries exhausted

### Gas Management
- Fetches current baseFee and uses 10x multiplier for maxFeePerGas
- Fixed priorityFee: 0.1 Gwei
- Gas limit: 10M for compound transactions

### Logging and Monitoring
- Logs RPC stats after each loop (multicall vs normal calls)
- Performance metrics: bault fetch time, transaction time, total execution time
- Reports success/failure/skipped counts with Berascan transaction links
- Shows bounty percentage for ineligible baults

## Testing Strategy

Since this is a production bot without formal tests, verify changes by:

1. **Dry-run validation**: Check logs for correct eligibility filtering
2. **RPC efficiency**: Monitor RPC stats to ensure batching works
3. **Simulation testing**: Ensure `tryCompound` simulations pass before execution
4. **Small-scale deployment**: Test with `RESTRICT_BAULTS` filtering to limit scope

## Security Considerations

- Private key stored in `.env` (never commit)
- Bot wallet only needs gas funds (no upfront bounty capital needed)
- BountyHelper contract enforces minimum bounty return
- Beneficiary address configurable to separate bot operator from profit receiver
- Slippage caps prevent excessive loss on volatile markets
