import {
  Address,
  Hex,
  getContract,
  parseGwei,
} from "viem";
import { getEnsoQuote } from "./EnsoQuoter";
import { berachain } from "viem/chains";
import {
  getBaultsWithCompleteData,
  calculateBountyPercentage,
  formatReadableAmount,
} from "./compoundingUtils";
import { getAccount, getPublicClient, getWalletClient, logRpcStats, resetRpcStats } from "./rpcUtils";
import { BOUNTY_HELPER_ABI } from "./abis/BountyHelperABI";
import { ERC20_ABI } from "./abis/ERC20";
import {
  BOUNTY_HELPER_ADDRESS,
  BENEFICIARY_ADDRESS,
  CHAIN_ID,
  COMPOUND_SLIPPAGE_BPS,
  SLIPPAGE_INCREMENT_PER_RETRY,
  MAX_RETRIES,
  RETRY_INTERVAL,
  LOOP_INTERVAL,
} from "./configuration";
import { BaultCompleteData, CompoundResult, RetryInfo } from "./types";
import { BAULT_ABI } from "./abis/Bault";

/** Result tracking for individual bault processing operations */
interface BaultProcessingResult {
  bault: BaultCompleteData;
  status: "success" | "failed" | "skipped";
  txHash?: string;
  error?: string;
  retryCount: number;
  excessTokensReceived?: bigint;
}

/** Berascan explorer URL for transaction links */
const EXPLORER_URL = "https://berascan.com/tx";

// Initialize blockchain clients
const publicClient = getPublicClient();
const walletClient = getWalletClient();
const account = getAccount();

/** Track retry attempts and original earned amounts to detect external compounds */
const retryMap: Record<string, RetryInfo> = {};

/**
 * Attempts to compound a single bault with retry logic and slippage management
 * Handles transaction simulation, execution, and result tracking
 * @param baultData - Complete on-chain data for the bault to compound
 * @param retries - Current retry attempt number
 * @param quote - Enso quote for the transaction (optional, will fetch if not provided)
 * @returns Result of the compound attempt with status and transaction details
 */
async function tryCompound(
  {
    stakingToken,
    bault,
    bounty,
    earnedRewardAmount,
    wrapper,
    wrapperMintAmount,
    wrapperValueInStakingToken,
  }: BaultCompleteData,
  retries: number,
  quote: any,
  gasParams: { maxFee: bigint; priorityFee: bigint } | null,
  beneficiaryBalanceBefore: bigint | undefined,
  beneficiaryAddress: Address,
): Promise<CompoundResult> {
  // If retrying, check if someone else already compounded
  if (retries > 0) {
    try {
      // Get the current earned reward amount
      const baultContract = getContract({
        address: bault,
        abi: BAULT_ABI,
        client: publicClient,
      });
      const currentEarnedRewardAmount = await baultContract.read.earned();

      // If current earned is less than original, someone else compounded
      if (currentEarnedRewardAmount < retryMap[bault]?.originalEarnedRewardAmount) {
        return { status: "skipped", tx: null, error: "Already compounded" };
      }
    } catch (e) {
      console.error(`Error checking bault ${bault} earned:`, e);
    }
  }
  if (beneficiaryBalanceBefore === undefined) {
    return {
      status: "fail",
      tx: null,
      error: "Failed to read beneficiary balance",
    };
  }

  if (!walletClient || !account || !BOUNTY_HELPER_ADDRESS)
    return {
      status: "fail",
      tx: null,
      error: "Wallet or Bounty Helper not configured",
    };

  if (!gasParams) {
    return {
      status: "fail",
      tx: null,
      error: "Failed to get gas fee data",
    };
  }

  const { maxFee, priorityFee } = gasParams;

  // Simulate the transaction
  let simulationResult;
  try {
    simulationResult = await publicClient.simulateContract({
      address: BOUNTY_HELPER_ADDRESS,
      abi: BOUNTY_HELPER_ABI,
      functionName: "claimBgtWrapper",
      args: [
        bault,
        wrapper,
        quote.tx.to as Address,
        quote.tx.data as Hex,
        wrapperMintAmount,
        beneficiaryAddress,
      ],
      account,
      chain: berachain,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priorityFee,
      gas: 10_000_000n,
      nonce: await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      }),
    });
  } catch (e: any) {
    return {
      status: "fail",
      tx: null,
      error: `Compound Simulation failed: ${e?.message || "Unknown error"}`,
    };
  }

  if (!simulationResult || !simulationResult.request)
    return { status: "fail", tx: null, error: "Simulation failed" };

  // Send the transaction
  try {
    const txHash = await walletClient.writeContract(simulationResult.request);
    console.debug(`Transaction Hash: ${txHash}`);

    // Store original earned amount in retry map
    if (!retryMap[bault]) {
      retryMap[bault] = { count: 0, originalEarnedRewardAmount: earnedRewardAmount };
    }

    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: 10 * 1000,
    });
    console.debug(`Transaction Receipt: ${receipt.status}`);

    if (receipt.status === "success") {
      // Reset retry counter on success
      retryMap[bault] = { count: 0, originalEarnedRewardAmount: 0n };
      // Get reward leak percentage
      const beneficiaryBalanceAfter = await publicClient.readContract({
        address: stakingToken,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [beneficiaryAddress],
      });
      const excessTokensReceived =
        beneficiaryBalanceAfter - beneficiaryBalanceBefore;
      return { status: "success", tx: txHash, excessTokensReceived };
    }

    return { status: "fail", tx: txHash, error: "Transaction reverted" };
  } catch (e: any) {
    const message = e?.shortMessage || e?.message || "";
    if (
      message.includes("nonce") ||
      message.includes("already known") ||
      message.includes("replacement transaction underpriced")
    ) {
      console.warn(`Nonce-related issue, skipping bault ${bault}: ${message}`);
      return { status: "skipped", tx: null, error: `Nonce issue: ${message}` };
    }
    return {
      status: "fail",
      tx: null,
      error: `Transaction failed: ${message}`,
    };
  }
}

/**
 * Fetches gas fee parameters once per loop iteration, shared across all baults processed that run.
 */
async function getGasFeeParams(): Promise<{
  maxFee: bigint;
  priorityFee: bigint;
} | null> {
  try {
    const gasFeeData = await publicClient.getFeeHistory({
      blockCount: 1,
      rewardPercentiles: [50],
    });
    const baseFee = gasFeeData.baseFeePerGas[0];
    const priorityFee = parseGwei("0.1");
    const maxFee = baseFee * 10n + priorityFee;

    return { maxFee, priorityFee };
  } catch (e) {
    console.error(`Error getting fee history:`, e);
    return null;
  }
}

/**
 * Reads beneficiary staking-token balances for eligible baults using a single multicall.
 */
async function getBeneficiaryBalancesBefore(
  baults: BaultCompleteData[],
  beneficiaryAddress: Address,
): Promise<Record<string, bigint | undefined>> {
  const balances: Record<string, bigint | undefined> = {};
  if (baults.length === 0) return balances;

  try {
    const results = await publicClient.multicall({
      contracts: baults.map((b) => ({
        address: b.stakingToken,
        abi: ERC20_ABI,
        functionName: "balanceOf" as const,
        args: [beneficiaryAddress] as const,
      })),
      allowFailure: true,
    });

    baults.forEach((b, index) => {
      const result = results[index];
      balances[b.bault] =
        result.status === "success" ? (result.result as bigint) : undefined;
    });
  } catch (e) {
    console.error("Error in getBeneficiaryBalancesBefore multicall:", e);
  }

  return balances;
}

/**
 * Main processing loop for the bault compoundoor service
 * Fetches bault data, filters eligible baults, processes compounds, and reports results
 * Handles parallel data fetching and sequential transaction processing for nonce management
 */
async function mainLoop() {
  const startTime = Date.now();
  const currentTime = new Date().toLocaleString();
  let blockNumber = 0n;
  resetRpcStats();
  try {
    blockNumber = await publicClient.getBlockNumber();
  } catch {}

  // Fetch bault data
  const baultFetchStart = Date.now();
  const baults = await getBaultsWithCompleteData(publicClient);
  const baultFetchTime = Date.now() - baultFetchStart;

  // Filter almost eligible baults based on BERA-priced reward value greater than 99% of bounty value
  const almostEligible = baults.filter(
    (b) =>
      !b.error &&
      b.wrapperValueInStakingToken >= (b.bounty * 99n) / 100n &&
      b.wrapperMintAmount > 0n,
  );
  const ineligible = baults.filter(
    (b) =>
      b.error ||
      b.wrapperValueInStakingToken < b.bounty ||
      b.wrapperMintAmount === 0n,
  );
  const eligible: BaultCompleteData[] = [];

  for (const b of almostEligible) {
    try {
      const quote = await getEnsoQuote(
        CHAIN_ID,
        b.wrapper,
        b.stakingToken,
        b.wrapperMintAmount.toString(),
        BOUNTY_HELPER_ADDRESS,
        BOUNTY_HELPER_ADDRESS,
        BOUNTY_HELPER_ADDRESS,
        COMPOUND_SLIPPAGE_BPS,
        false,
      );

      if (!quote?.amountOut) {
        b.error = "No valid Enso quote";
        ineligible.push(b);
        continue;
      }

      const amountOut = BigInt(quote.amountOut);
      b.wrapperValueInStakingToken = amountOut; // actual value now known

      if (amountOut >= b.bounty) {
        (b as any).quote = quote;
        eligible.push(b);
      } else {
        ineligible.push(b);
      }
    } catch (e) {
      b.error = `Enso quote failed: ${e instanceof Error ? e.message : String(e)}`;
      ineligible.push(b);
    }
  }

  const ineligibleDetails = ineligible.map((b) => {
    if (b.error) {
      const earnedStr = formatReadableAmount(b.earnedRewardAmount);
      return `- ${b.symbol} (${b.bault}): WBERA=${earnedStr}. Error: ${b.error}`;
    }
    const rewardStr = formatReadableAmount(b.wrapperValueInStakingToken);
    const bountyStr = formatReadableAmount(b.bounty);
    const earnedStr = formatReadableAmount(b.earnedRewardAmount);
    const bountyPercentage = calculateBountyPercentage(
      b.wrapperValueInStakingToken,
      b.bounty,
    );
    return `- ${b.symbol} (${b.bault}): Reward=${rewardStr}, Bounty=${bountyStr} (${bountyPercentage}), WBERA=${earnedStr}`;
  });

  const eligibleDetails = eligible.map((b) => {
    const rewardStr = formatReadableAmount(b.wrapperValueInStakingToken);
    const bountyStr = formatReadableAmount(b.bounty);
    const earnedStr = formatReadableAmount(b.earnedRewardAmount);
    const bountyPercentage = calculateBountyPercentage(
      b.wrapperValueInStakingToken,
      b.bounty,
    );
    return `- ${b.symbol} (${b.bault}): Reward=${rewardStr}, Bounty=${bountyStr} (${bountyPercentage}), WBERA=${earnedStr}`;
  });

  let beneficiaryAddress = BENEFICIARY_ADDRESS;
  if (beneficiaryAddress === ("" as Address)) {
    // TO safe guard from bad config
    if (!account) {
      throw new Error("No account found, please set PRIVATE_KEY in .env");
    }
    beneficiaryAddress = account.address;
  }
  const gasParams = eligible.length > 0 ? await getGasFeeParams() : null;
  const beneficiaryBalancesBefore = await getBeneficiaryBalancesBefore(
    eligible,
    beneficiaryAddress,
  );

  const processingResults: BaultProcessingResult[] = [];
  const txStart = Date.now();

  // Process baults sequentially for easy nonce management
  for (const b of eligible) {
    // Get retry info
    const retryInfo = retryMap[b.bault] || {
      count: 0,
      originalEarnedRewardAmount: b.earnedRewardAmount,
    };
    let retries = retryInfo.count;
    let finalResult: BaultProcessingResult;

    // Try to compound with retries
    while (retries <= MAX_RETRIES) {
      let quote;
      if (retries === 0) {
        quote = (b as any).quote; // Use initial quote for first attempt
      } else {
        // Adjust slippage based on retry count
        const slippage =
          COMPOUND_SLIPPAGE_BPS + SLIPPAGE_INCREMENT_PER_RETRY * retries;
        try {
          quote = await getEnsoQuote(
            CHAIN_ID,
            b.wrapper,
            b.stakingToken,
            b.wrapperMintAmount.toString(),
            BOUNTY_HELPER_ADDRESS,
            BOUNTY_HELPER_ADDRESS,
            BOUNTY_HELPER_ADDRESS,
            slippage,
            false,
          );
        } catch (e) {
          finalResult = {
            bault: b,
            status: "failed",
            error: `Enso quote failed: ${e instanceof Error ? e.message : String(e)}`,
            retryCount: retries,
          };
          break;
        }
      }
      if (!quote?.amountOut || BigInt(quote.amountOut) < b.bounty) {
        finalResult = {
          bault: b,
          status: "skipped",
          error: `Quote too low (${quote?.amountOut}) < bounty (${b.bounty})`,
          retryCount: retries,
        };
        break;
      }

      const result = await tryCompound(
        b,
        retries,
        quote,
        gasParams,
        beneficiaryBalancesBefore[b.bault],
        beneficiaryAddress,
      );

      if (result.status === "success") {
        finalResult = {
          bault: b,
          status: "success",
          txHash: result.tx!,
          retryCount: retries,
          excessTokensReceived: result.excessTokensReceived,
        };
        retryMap[b.bault] = { count: 0, originalEarnedRewardAmount: 0n };
        break;
      } else if (result.status === "skipped") {
        finalResult = {
          bault: b,
          status: "skipped",
          error: result.error,
          retryCount: retries,
        };
        retryMap[b.bault] = { count: 0, originalEarnedRewardAmount: 0n };
        break;
      } else {
        retries++;
        if (retries > MAX_RETRIES) {
          finalResult = {
            bault: b,
            status: "failed",
            error: result.error,
            retryCount: retries - 1,
          };
          retryMap[b.bault] = { count: 0, originalEarnedRewardAmount: 0n };
          break;
        } else {
          retryMap[b.bault] = {
            count: retries,
            originalEarnedRewardAmount: retryInfo.originalEarnedRewardAmount,
          };
          console.log(
            `Retrying ${b.bault} (attempt ${retries}): ${result.error}`,
          );
          await new Promise((res) => setTimeout(res, RETRY_INTERVAL));
        }
      }
    }

    processingResults.push(finalResult!);
  }

  const txTime = Date.now() - txStart;
  const totalTime = Date.now() - startTime;

  // Build final message after all processing is complete to log to console
  let logMsg = `Ran at ${currentTime}\n
     Block: ${blockNumber}\n
     --------------------------------\n
     Baults not ready to compound: ${ineligible.length}\n${ineligibleDetails.join("\n")}\n
     --------------------------------\n
     Baults ready to compound: ${eligible.length}\n${eligibleDetails.join("\n")}`;

  // Add processing results
  const successCount = processingResults.filter(
    (r) => r.status === "success",
  ).length;
  const skippedCount = processingResults.filter(
    (r) => r.status === "skipped",
  ).length;
  const failedCount = processingResults.filter(
    (r) => r.status === "failed",
  ).length;

  for (const result of processingResults) {
    if (result.status === "success") {
      const txLink = `${EXPLORER_URL}/${result.txHash}`;
      const retryText =
        result.retryCount > 0 ? ` (after ${result.retryCount} retries)` : "";
      const excessStr =
        result.excessTokensReceived !== undefined
          ? `, Excess=${formatReadableAmount(result.excessTokensReceived)}`
          : "";
      logMsg += `\n✅ ${result.bault.symbol} - ${txLink} - success${retryText}${excessStr}`;
    } else if (result.status === "skipped") {
      logMsg += `\n✅ ${result.bault.symbol} - skipped`;
    } else {
      const retryText =
        result.retryCount > 0 ? ` after ${result.retryCount} retries` : "";
      logMsg += `\n❌ ${result.bault.symbol} - failed${retryText}. Status: ${result.status}. Error: ${result.error}. Island: ${result.bault.stakingToken}`;
    }
  }

  // Add performance metrics
  logMsg += `\n\n⏱️ Performance:\n`;
  logMsg += `- Fetching baults data for compound in parallel: ${baultFetchTime / 1000} seconds\n`;
  logMsg += `- Processing all transactions: ${txTime / 1000}s (${successCount} successful, ${skippedCount} skipped, ${failedCount} failed)\n`;
  logMsg += `- Total execution: ${totalTime}ms\n`;
  // Log to console the final report
  console.log(logMsg);
  logRpcStats();
}

/**
 * Starts the bault compoundoor service
 * Runs the main processing loop continuously with configured intervals
 * Handles errors gracefully and continues operation
 */
async function start() {
  console.log(`** CONFIGURATION **`);
  console.log(`- Loop Interval: ${LOOP_INTERVAL}ms`);
  console.log(`- Retry Interval: ${RETRY_INTERVAL}ms`);
  console.log(`- Max Retries: ${MAX_RETRIES}`);

  console.log(`Service started.`);
  let running = true;
  while (running) {
    try {
      await mainLoop();
    } catch (e) {
      console.error(`Error in main loop:`, e);
    }
    await new Promise((res) => setTimeout(res, LOOP_INTERVAL));
  }
}

// Start the service if this file is run directly
if (require.main === module) start();
