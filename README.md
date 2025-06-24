# bault-compoundor

Automatically compounds bault rewards when profitable.

## How it works

The bot runs in a loop and:
1. Gets all baults from kodiak backend.
2. Checks all baults for earned BGT rewards (`mainLoop` function) and previewBGTWrapper
3. Gets the wrapper that is most Profitable and its value in staking token(bault asses/bounty)
4. When the claimable value is higher than bounty, marks the baults as profitable, and gets a swap quote from Enso (`getEnsoQuote` function) for sending into the compound transaction
3. Executes the compound transaction using BountyHelper contract(`tryCompound` function)
4. Sends any excess tokens as profit to the `BENEFICIARY_ADDRESS`

**Notes**
1. We use BountyHelper contract to compound baults. (A contract that allows anyone to compound with zero upfront capital)
2. The compoundoor does not need to be funded with bounty tokens as it uses the BountyHelper.
3. The earned bgt claimed as a wrapper needs to be swapped for bault assets to return to the BountyHelper.
4. The script uses Enso protocol to achieve this.
5. The compoundors profit is sent the configurable beneficiary in underlying asset tokens and bgtWrapper selected.

## Setup

1. Copy `.env.example` to `.env` and fill in:
   - `RPC_URL` - Your Berachain RPC
   - `ENSO_API_KEY` - Your Enso API key. Generate one here - https://shortcuts.enso.finance/developers
   - `PRIVATE_KEY` - Bot wallet private key

2. Install dependencies:
   ```bash
   bun install
   # or
   npm install
   ```
## Run

```bash
# With Bun
bun src/simpleCompoundor.ts

# With Node
npx ts-node src/simpleCompoundor.ts
```

## Run with PM2

1. Install PM2: `npm install -g pm2`
2. Start: `pm2 start src/simpleCompoundor.ts --interpreter bun --name bault-bot`
3. Monitor: `pm2 logs bault-bot`

## Config

Edit `src/configuration.ts` to change:
- `LOOP_INTERVAL` - How often to check (default: 30 seconds)
- `COMPOUND_SLIPPAGE_BPS` - Slippage tolerance (default: 20 = 0.2%)
- `MAX_RETRIES` - Retry failed transactions (default: 3)
- `BENEFICIARY_ADDRESS` - Where earned tokens go.
- `DEFAULT_BGT_WRAPPER_ADDRESS` - The wrapped BGT to default to in case the bot is not able to determine the best wrapper to claim dynamically.
- `ONLY_ALLOW_DEFAULT_WRAPPER` - Set this to true, in case you only want to allow claiming using the `DEFAULT_BGT_WRAPPER_ADDRESS` instead of finding the best.
- `RESTRICT_BAULTS` - Set this to true to filter baults with specific addresses, false to compound all
- `ONLY_BAULT_ADDRESSES` - List of bault addresses in lower caps to filter only these baults
- `RESTRICT_STAKING_TOKENS` - Set this to true to filter baults with specific staking token addresses(underlying asset), false to compound all
- `ONLY_STAKING_TOKEN_ADDRESSES` - List of staking token addresses in lower caps to filter only baults with these underlying assets