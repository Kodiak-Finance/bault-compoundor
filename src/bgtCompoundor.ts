import {
  Address,
  createPublicClient,
  createWalletClient,
  http,
  Hex,
  getContract,
  parseGwei,
  parseEther,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getEnsoQuote } from "./EnsoQuoter";
import { berachain } from "viem/chains";
import {
  formatReadableAmount,
  getBeraPrice,
  getBaultsFromKodiakBackend,
  getTokenPricesFromSubgraph
} from "./compoundingUtils";
import { BOUNTY_HELPER_ABI } from "./abis/BountyHelperABI";
import { BaultFromKodiakBackend } from "./types";
import { RPC_URL, PRIVATE_KEY, ENSO_API_KEY, CHAIN_ID, BOUNTY_HELPER_ADDRESS, WBERA } from "./configuration";
import { BAULT_ABI } from "./abis/Bault";

// Bot configuration
const BERA_PER_BGT_MULTIPLIER = 1.2; // Willing to pay up to 1.2 BERA per BGT
const COMPOUND_SLIPPAGE_BPS = 50; // 0.5% slippage
const LOOP_INTERVAL = 30 * 1000; // 30 seconds
const MAX_FAILURES_THRESHOLD = 5; // Exit after 5 consecutive failures
const BERA_BUFFER_PERCENTAGE = 20; // Add 20% buffer to BERA amount needed
const MIN_BERA_BALANCE = parseEther("0.1"); // Minimum BERA balance to keep
let execute = false;

// Berascan explorer URL for transaction links
const EXPLORER_URL = "https://berascan.com/tx";

// Initialize blockchain clients
const publicClient = createPublicClient({
  chain: berachain,
  transport: http(RPC_URL),
});

const walletClient = PRIVATE_KEY
  ? createWalletClient({
    account: privateKeyToAccount(PRIVATE_KEY),
    chain: berachain,
    transport: http(RPC_URL),
  })
  : null;

const account = PRIVATE_KEY ? privateKeyToAccount(PRIVATE_KEY) : null;

interface BaultDataForBgtCompound {
  bault: Address;
  stakingToken: Address;
  symbol: string;
  bounty: bigint;
  earnedBgt: bigint;
  stakingTokenPrice: number;
  beraNeededBN: bigint;
  beraNeededFormatted: number;
  profitInBera: number;
}

interface CompoundResult {
  status: "success" | "failed" | "skipped";
  txHash?: string;
  error?: string;
  beraSpent?: bigint;
}

let consecutiveFailures = 0;
let verbose = false;

/**
 * Fetch bault data and determine eligibility for BGT compounding
 */
async function getEligibleBaultsForBgtCompound(): Promise<BaultDataForBgtCompound[]> {
  const baultsFromBackend = await getBaultsFromKodiakBackend();
  const beraPrice = await getBeraPrice();

  if (!beraPrice) {
    throw new Error("Could not fetch BERA price");
  }

  const almostEligibleBaults: BaultDataForBgtCompound[] = [];
  const eligibleBaults: BaultDataForBgtCompound[] = [];

  for (const baultInfo of baultsFromBackend) {
    try {
      const baultContract = getContract({
        address: baultInfo.bault,
        abi: BAULT_ABI,
        client: publicClient,
      });

      // Get on-chain data
      const [bounty, earnedBgt] = await Promise.all([
        baultContract.read.bounty(),
        baultContract.read.earned(),
      ]);

      // Skip if no BGT earned
      if (earnedBgt === 0n) continue;

      const stakingTokenPrice = baultInfo.tokenLp.price;
      if (!stakingTokenPrice) {
        console.log(`No price data for ${baultInfo.symbol}, skipping`);
        continue;
      }

      // spend is bera (bounty value in bera) allowedSpend = bountyValueBera
      // earned is bgt (bera) * BERA_PER_BGT_MULTIPLIER


      // Calculate bounty value in USD
      const bountyValueUsd = Number(formatEther(bounty)) * stakingTokenPrice; //bera amount in usd

      const bountyInBera = bountyValueUsd / beraPrice;

      const earnedInbera = Number(formatEther(earnedBgt)) * BERA_PER_BGT_MULTIPLIER;
      const profitInBera = earnedInbera - bountyInBera;
      const profitPercentage = profitInBera * 100 / bountyInBera;
      console.log(`[BgtCompoundor] ${baultInfo.symbol} earned ${earnedInbera} bera, bounty ${bountyInBera} bera, profitInBera ${profitInBera} bera, profitPercentage ${profitPercentage} %`);
      if (profitInBera < 0) {
        if (verbose) {
          console.log(`[BgtCompoundor] ${baultInfo.symbol} earned ${earnedInbera} bera, bounty ${bountyInBera} bera, profitPercentage ${profitPercentage} %`);
        }
        continue;
      }

      // Only proceed if profitable
      if (profitInBera > 0) {
        almostEligibleBaults.push({
          bault: baultInfo.bault,
          stakingToken: baultInfo.stakingToken,
          symbol: baultInfo.symbol,
          bounty,
          earnedBgt,
          stakingTokenPrice,
          beraNeededBN: parseEther(bountyInBera.toString()),
          beraNeededFormatted: bountyInBera,
          profitInBera,
        });
      }
    } catch (error) {
      console.error(`Error processing bault ${baultInfo.symbol}:`, error);
    }
  }
  if (verbose) {
    console.log(`** Eligible baults **`);
    for (const bault of almostEligibleBaults) {
      console.log(`${bault.symbol}: ${bault.profitInBera} BERA, bounty ${formatEther(bault.bounty)} BERA, earned ${formatEther(bault.earnedBgt)} BGT`);
    }
  }
  return almostEligibleBaults;
  // Sort by profitability (highest profit first)
  // return eligibleBaults.sort((a, b) => b.profitInBera - a.profitInBera);
}

/**
 * Attempt to compound a single bault using BGT method
 */
async function tryCompoundWithBgt(baultData: BaultDataForBgtCompound): Promise<CompoundResult> {
  if (!walletClient || !account) {
    return { status: "failed", error: "Wallet not configured" };
  }

  const { bault, stakingToken, symbol, bounty, earnedBgt, beraNeededBN } = baultData;

  try {
    // Get Enso quote for WBERA -> staking token swap
    const quote = await getEnsoQuote(
      CHAIN_ID,
      WBERA,
      stakingToken,
      beraNeededBN.toString(),
      BOUNTY_HELPER_ADDRESS,
      BOUNTY_HELPER_ADDRESS, // staking token recipient
      BOUNTY_HELPER_ADDRESS, // spender
      COMPOUND_SLIPPAGE_BPS,
      false
    );

    if (!quote?.amountOut || BigInt(quote.amountOut) < bounty) {
      return {
        status: "failed",
        error: `Insufficient quote: ${quote?.amountOut} < ${bounty} required`,
      };
    }

    // Set up gas parameters
    const gasFeeData = await publicClient.getFeeHistory({
      blockCount: 1,
      rewardPercentiles: [50],
    });
    const baseFee = gasFeeData.baseFeePerGas[0];
    const priorityFee = parseGwei("0.1");
    const maxFee = baseFee * 10n + priorityFee;

    // Calculate minimum BGT to receive (accounting for slippage)
    const minBgtOut = (earnedBgt * 95n) / 100n; // 5% slippage tolerance

    // Simulate the transaction
    const simulationResult = await publicClient.simulateContract({
      address: BOUNTY_HELPER_ADDRESS,
      abi: BOUNTY_HELPER_ABI,
      functionName: "claimBgt",
      args: [
        bault,
        quote.tx.to as Address,
        quote.tx.data as Hex,
        minBgtOut,
        account.address, // BGT recipient
        account.address, // excess recipient
      ],
      account,
      value: beraNeededBN,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      gas: 10_000_000n,
    });

    // Execute the transaction
    let txHash;
    if (execute) {
      txHash = await walletClient.writeContract(simulationResult.request);

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash,
        timeout: 60_000, // 60 seconds timeout
      });

      if (receipt.status === "success") {
        return {
          status: "success",
          txHash,
          beraSpent: beraNeededBN,
        };
      } else {
        return {
          status: "failed",
          error: "Transaction reverted",
          txHash,
        };
      }
    }
    return { status: "skipped", error: "Execute mode disabled" };

  } catch (error: any) {
    const errorMessage = error?.shortMessage || error?.message || "Unknown error";
    return {
      status: "failed",
      error: `Compound failed: ${errorMessage}`,
    };
  }
}

/**
 * Main processing loop
 */
async function mainLoop() {
  const startTime = Date.now();
  const currentTime = new Date().toLocaleString();

  try {
    console.log(`\n🔄 BGT Compoundor running at ${currentTime}`);

    // Get eligible baults
    const almostEligible = await getEligibleBaultsForBgtCompound();
    console.log(`\n📊 Found ${almostEligible.length} eligible baults for BGT compounding:`);

    if (almostEligible.length === 0) {
      console.log("No profitable baults found");
      consecutiveFailures = 0; // Reset failure counter when no work to do
      return;
    }

    // Display eligible baults
    for (const bault of almostEligible) {
      const earnedStr = formatReadableAmount(bault.earnedBgt);
      const bountyStr = formatReadableAmount(bault.bounty);
      console.log(`  - ${bault.symbol}: BGT=${earnedStr}, Bounty=${bountyStr}, BERA needed=${bault.beraNeededFormatted}, Profit=${bault.profitInBera.toFixed(4)} BERA`);
    }

    let successCount = 0;
    let totalBeraSpent = 0n;

    for (const baultData of almostEligible) {
      // Check if we still have enough BERA
      const currentBalance = await publicClient.getBalance({ address: account!.address });
      if (currentBalance < baultData.beraNeededBN + MIN_BERA_BALANCE) {
        console.log(`⚠️ Insufficient BERA for ${baultData.symbol}, skipping remaining baults`);
        break;
      }

      console.log(`\n🔨 Processing ${baultData.symbol}...`);
      const result = await tryCompoundWithBgt(baultData);

      if (result.status === "success") {
        successCount++;
        totalBeraSpent += result.beraSpent || 0n;
        const txLink = `${EXPLORER_URL}/${result.txHash}`;
        console.log(`✅ ${baultData.symbol} - Success! TX: ${txLink}, BERA spent: ${formatEther(result.beraSpent || 0n)}`);
      } else {
        console.log(`❌ ${baultData.symbol} - Failed: ${result.error}`);
      }
    }

    const totalTime = Date.now() - startTime;
    console.log(`\n📈 Summary: ${successCount}/${almostEligible.length} successful, Total BERA spent: ${formatEther(totalBeraSpent)}, Time: ${totalTime}ms`);

    // Reset consecutive failures on any success
    if (successCount > 0) {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
    }

  } catch (error) {
    console.error(`❌ Error in main loop:`, error);
    consecutiveFailures++;
  }

  // Check failure threshold
  if (consecutiveFailures >= MAX_FAILURES_THRESHOLD) {
    console.error(`🛑 Too many consecutive failures (${consecutiveFailures}), exiting...`);
    process.exit(1);
  }
}

/**
 * Start the BGT compoundor service
 */
async function start() {
  if (!PRIVATE_KEY) {
    console.error("❌ PRIVATE_KEY environment variable is required");
    process.exit(1);
  }

  if (!ENSO_API_KEY) {
    console.error("❌ ENSO_API_KEY environment variable is required");
    process.exit(1);
  }

  console.log(`🚀 BGT Compoundor starting...`);
  console.log(`📍 Using BountyHelper at: ${BOUNTY_HELPER_ADDRESS}`);
  console.log(`💼 Wallet address: ${account?.address}`);
  console.log(`⚙️ Config: BERA/BGT ratio=${BERA_PER_BGT_MULTIPLIER}, Slippage=${COMPOUND_SLIPPAGE_BPS}bps, Loop=${LOOP_INTERVAL / 1000}s`);

  let running = true;
  while (running) {
    try {
      await mainLoop();
    } catch (error) {
      console.error(`💥 Unexpected error:`, error);
      consecutiveFailures++;

      if (consecutiveFailures >= MAX_FAILURES_THRESHOLD) {
        console.error(`🛑 Too many consecutive failures, exiting...`);
        break;
      }
    }

    // Wait before next iteration
    await new Promise((resolve) => setTimeout(resolve, LOOP_INTERVAL));
  }
}

/**
 * Usage Instructions:
 *
 * 1. Set up environment variables:
 *    - RPC_URL: Berachain RPC endpoint
 *    - PRIVATE_KEY: Your wallet private key (0x prefixed)
 *    - ENSO_API_KEY: Enso API key for swap quotes
 *
 * 2. Ensure your wallet has sufficient BERA balance for:
 *    - Gas fees for transactions
 *    - BERA to pay for bounties (calculated dynamically)
 *    - Minimum balance buffer (0.1 BERA)
 *
 * 3. Run the bot:
 *    bun run bgtCompoundor.ts
 *
 * 4. Bot Configuration (modify constants above):
 *    - BERA_PER_BGT_MULTIPLIER: Max BERA willing to pay per BGT (default: 1.2)
 *    - COMPOUND_SLIPPAGE_BPS: Slippage tolerance in basis points (default: 50 = 0.5%)
 *    - LOOP_INTERVAL: Time between checks in milliseconds (default: 30s)
 *    - MAX_FAILURES_THRESHOLD: Exit after this many consecutive failures (default: 5)
 *    - BERA_BUFFER_PERCENTAGE: Extra BERA buffer for price fluctuations (default: 20%)
 *
 * 5. How it works:
 *    - Fetches all baults and their BGT earnings
 *    - Calculates profitability: BGT_value > (bounty_cost / BERA_PER_BGT_MULTIPLIER)
 *    - For profitable baults, pays BERA to swap for staking tokens
 *    - Uses BountyHelper.claimBgt() to get BGT rewards
 *    - Keeps excess tokens as profit
 */

// Start the service if this file is run directly
if (require.main === module) {
  const args = process.argv.slice(2);
  verbose = args.includes('--verbose') || args.includes('--v');
  const noExecute = args.includes('--no-execute') || args.includes('--no-exec');

  if (noExecute) {
    execute = false;
    console.log('** Execute mode disabled **');
  } else {
    console.log('** Execute mode enabled **');
  }

  start().catch(console.error);
}