import {
  PublicClient,
  Address,
  getAddress,
  formatUnits,
  parseEther,
  zeroAddress,
  formatEther,
} from "viem";
import {
  CHAIN_ID,
  COMPOUND_SLIPPAGE_BPS,
  YBGT,
  LBGT,
  iBGT,
  mBGT,
  WBERA,
  BOUNTY_HELPER_ADDRESS,
  KODIAK_BAULTS_API_URL,
  MIN_EARNINGS_BGT,
  ONLY_ALLOW_DEFAULT_WRAPPER,
  DEFAULT_BGT_WRAPPER_ADDRESS,
  RESTRICT_STAKING_TOKENS,
  RESTRICT_BAULTS,
  ONLY_BAULT_ADDRESSES,
  ONLY_STAKING_TOKEN_ADDRESSES,
  WRAPPER_SLIPPAGE_BPS,
} from "./configuration";
import { getEnsoQuote } from "./EnsoQuoter";
import {
  BaultOnchainData,
  BaultFromKodiakBackend,
  BaultCompleteData,
  BatchWrapperPreviewInput,
  BatchWrapperPreviewOutput,
} from "./types";
import { BAULT_ABI } from "./abis/Bault";

/**
 * Fetches bault data from Kodiak backend API
 * @returns Array of bault information from backend
 */
export async function getBaultsFromKodiakBackend(): Promise<BaultFromKodiakBackend[]> {
  const response = await fetch(KODIAK_BAULTS_API_URL);
  if (!response.ok) {
    console.error(`Error fetching baults from Kodiak backend: ${response.status} ${response.statusText}`);
    return [];
  }
  const responseData = await response.json();
  return responseData.data.reduce(
    (acc: BaultFromKodiakBackend[], island: any) => {
      if (
        island.provider === "kodiak" &&
        island.id &&
        island.baults.length > 0
      ) {
        if (RESTRICT_BAULTS && !ONLY_BAULT_ADDRESSES.includes(island.baults[0].id.toLowerCase())) {
          return acc;
        }
        if (RESTRICT_STAKING_TOKENS && !ONLY_STAKING_TOKEN_ADDRESSES.includes(island.id)) {
          return acc;
        }
        acc.push({
          stakingToken: getAddress(island.id),
          bault: getAddress(island.baults[0].id),
          symbol: island.tokenLp.symbol,
          tokenLp: island.tokenLp,
        });
      }
      return acc;
    },
    [],
  );
}

/**
 * Calculates the value of a BGT wrapper token in terms of the staking token
 * Uses price data from subgraph for calculation
 * @param wrapper - BGT wrapper contract address
 * @param stakingToken - Target staking token address
 * @param inputAmount - Amount of wrapper tokens to value
 * @param wrapperPrices - Record of wrapper prices from subgraph
 * @param stakingTokenPrice - Price of staking token
 * @returns String representation of output amount in staking token
 */
export function checkWrapperValueInStakingToken(
  wrapper: `0x${string}`,
  inputAmount: bigint,
  wrapperPrices: Record<Address, number>,
  stakingTokenPrice?: number
) {
  if (inputAmount === 0n) {
    return "0";
  }
  const wrapperPrice = wrapperPrices[wrapper.toLowerCase() as Address];
  if (!wrapperPrice || !stakingTokenPrice || stakingTokenPrice === 0) {
    return "0";
  }
  if (wrapperPrice && stakingTokenPrice > 0) {
    // Calculate value: inputAmount * wrapperPrice / stakingTokenPrice
    const inputAmountInEther = Number(formatUnits(inputAmount, 18));
    const valueInStakingToken =
      (inputAmountInEther * wrapperPrice) / stakingTokenPrice;
    if (WRAPPER_SLIPPAGE_BPS > 10000) {
      throw new Error("WRAPPER_SLIPPAGE_BPS is greater than 10000");
    }
    const valueInStakingTokenWithSlippage = valueInStakingToken * (10000 - WRAPPER_SLIPPAGE_BPS) / 10000;
    // Convert back to bigint with 18 decimals
    const result = BigInt(Math.floor(valueInStakingTokenWithSlippage * 1e18)).toString();
    return result;
  }
}

// --- Batch RPC utilities for wrapper selection ---


/**
 * Batches all wrapper preview calls for multiple baults into a single multicall.
 * This reduces RPC calls from N (one per bault) to 1.
 *
 * Error handling:
 * - Uses allowFailure: true so one bault's failure doesn't affect others
 * - Each bault tracks its own failures via hasAnyFailure flag
 * - Failed wrapper calls return 0n for that specific wrapper
 * - Callers can check hasAnyFailure to decide how to handle partial failures
 */
export async function batchPreviewWrapperMints(
  inputs: BatchWrapperPreviewInput[],
  publicClient: PublicClient,
  blockNumber: bigint
): Promise<Map<Address, BatchWrapperPreviewOutput>> {
  if (inputs.length === 0) {
    return new Map();
  }

  // Build flat array of all contract calls, tracking structure for result parsing
  const contracts: Array<{
    address: Address;
    abi: typeof BAULT_ABI;
    functionName: string;
    args?: readonly unknown[];
  }> = [];

  for (const { baultAddress, wrappers } of inputs) {
    // Add ALL wrapper preview calls for this bault
    for (const wrapper of wrappers) {
      contracts.push({
        address: baultAddress,
        abi: BAULT_ABI,
        functionName: "previewClaimBgtWrapper",
        args: [wrapper],
      });
    }
    // Add earned call for this bault (used for WBERA comparison)
    contracts.push({
      address: baultAddress,
      abi: BAULT_ABI,
      functionName: "earned",
      args: [],
    });
  }

  // Execute single multicall for all baults
  // allowFailure: true ensures one bault's failure doesn't break others
  const results = await publicClient.multicall({
    contracts: contracts as any,
    blockNumber,
    allowFailure: true,
  });

  // Parse results back to map structure, tracking failures per bault
  const outputMap = new Map<Address, BatchWrapperPreviewOutput>();
  let resultIndex = 0;

  for (const { baultAddress, wrappers } of inputs) {
    const wrapperMintAmounts: bigint[] = [];
    let hasAnyFailure = false;

    // Parse ALL wrapper results for this bault
    for (let i = 0; i < wrappers.length; i++) {
      const result = results[resultIndex++];
      if (result.status === "success") {
        wrapperMintAmounts.push(result.result as bigint);
      } else {
        wrapperMintAmounts.push(0n);
        hasAnyFailure = true;
        console.warn(
          `Wrapper preview failed for bault ${baultAddress}, wrapper ${wrappers[i]}`
        );
      }
    }

    // Parse earned result
    const earnedResult = results[resultIndex++];
    let earned = 0n;
    if (earnedResult.status === "success") {
      earned = earnedResult.result as bigint;
    } else {
      hasAnyFailure = true;
      console.warn(`Earned call failed for bault ${baultAddress}`);
    }

    outputMap.set(baultAddress, { wrapperMintAmounts, earned, hasAnyFailure });
  }

  return outputMap;
}

/**
 * Selects the best wrapper for a bault given pre-fetched mint amounts.
 * This separates the selection logic from RPC calls for better batching.
 *
 * @param baultAddress - The bault address
 * @param stakingToken - The staking token address
 * @param wrappers - Array of wrapper addresses that were checked
 * @param wrapperMintAmounts - Pre-fetched mint amounts (same order as wrappers)
 * @param earned - Pre-fetched earned BGT amount
 * @param wrapperPrices - Wrapper prices from subgraph
 * @param beraPrice - BERA price from subgraph
 * @param stakingTokenPrice - Staking token price (optional, triggers Enso fallback if missing)
 * @param earnedBgt - Original earned BGT for validation
 */
async function selectBestWrapperFromData(
  baultAddress: Address,
  stakingToken: Address,
  wrappers: Address[],
  wrapperMintAmounts: bigint[],
  earned: bigint,
  wrapperPrices: Record<Address, number>,
  beraPrice: number,
  stakingTokenPrice: number | undefined,
  earnedBgt: bigint | undefined
): Promise<
  | {
    wrapper: Address;
    wrapperMintAmount: bigint;
    wrapperValueInStakingToken: bigint;
  }
  | undefined
> {
  // FALLBACK PATH: If no staking token price or wrapper prices, use Enso
  if (!stakingTokenPrice || !wrapperPrices) {
    const wrapperValues = (
      await Promise.all(
        wrappers.map(async (wrapper, index) => {
          const sellAmount = wrapperMintAmounts[index].toString();
          if (sellAmount === "0") {
            return "0";
          }
          const quote = await getEnsoQuote(
            CHAIN_ID,
            wrapper,
            stakingToken,
            sellAmount,
            BOUNTY_HELPER_ADDRESS,
            BOUNTY_HELPER_ADDRESS,
            BOUNTY_HELPER_ADDRESS,
            COMPOUND_SLIPPAGE_BPS,
            false
          );
          return quote.amountOut;
        })
      )
    ).map((value) => BigInt(value));

    if (wrapperValues.length === 0) return undefined;

    let maxValue = 0n;
    let indexOfBestWrapper = 2; // default to iBGT
    for (let i = 0; i < wrapperValues.length; i++) {
      if (wrapperValues[i] > maxValue) {
        maxValue = wrapperValues[i];
        indexOfBestWrapper = i;
      }
    }

    return {
      wrapper: wrappers[indexOfBestWrapper],
      wrapperMintAmount: wrapperMintAmounts[indexOfBestWrapper],
      wrapperValueInStakingToken: wrapperValues[indexOfBestWrapper],
    };
  }

  // NORMAL PATH: Calculate values using prices
  const wrapperValues = wrappers.map((wrapper, index) =>
    BigInt(
      checkWrapperValueInStakingToken(
        wrapper,
        wrapperMintAmounts[index],
        wrapperPrices,
        stakingTokenPrice
      ) || 0
    )
  );

  // Check for BERA minting issue
  const beraMinted = earned || 0n;
  if (earnedBgt && earnedBgt > 0n && beraMinted === 0n) {
    console.error("Bera minted is 0 but earnedBgt is greater than 0");
    return undefined;
  }

  // Calculate BERA value for comparison
  const beraValueInStakingToken =
    (Number(formatEther(beraMinted)) * beraPrice) / stakingTokenPrice;
  const beraValueInStakingTokenBigInt = BigInt(
    Math.floor(beraValueInStakingToken * 1e18)
  );

  if (wrapperValues.length === 0) return undefined;

  // Find best wrapper among the provided wrappers
  let maxValue = 0n;
  let indexOfBestWrapper = 2; // default to iBGT
  for (let i = 0; i < wrapperValues.length; i++) {
    if (wrapperValues[i] > maxValue) {
      maxValue = wrapperValues[i];
      indexOfBestWrapper = i;
    }
  }

  // Compare with BERA
  if (beraValueInStakingTokenBigInt > maxValue) {
    return {
      wrapper: WBERA,
      wrapperMintAmount: beraMinted,
      wrapperValueInStakingToken: beraValueInStakingTokenBigInt,
    };
  }

  return {
    wrapper: wrappers[indexOfBestWrapper],
    wrapperMintAmount: wrapperMintAmounts[indexOfBestWrapper],
    wrapperValueInStakingToken: wrapperValues[indexOfBestWrapper],
  };
}

/**
 * Finds the most profitable BGT wrapper for a given bault
 * Compares yBGT, lBGT, mBGT, and iBGT to determine which provides the best value
 * @param baultAddress - Address of the bault contract
 * @param stakingToken - Address of the underlying staking token
 * @param publicClient - Viem public client for blockchain calls
 * @param wrappers - Array of wrapper addresses to compare (defaults to [YBGT, LBGT, mBGT, iBGT])
 * @param stakingTokenPrice - Optional price of staking token for enhanced calculation
 * @returns Best wrapper info or undefined if none found
 */
export async function findBestWrapper(
  baultAddress: Address,
  stakingToken: Address,
  publicClient: PublicClient,
  wrappers: Address[] = [YBGT, LBGT, iBGT, mBGT],
  stakingTokenPrice?: number,
  earnedBgt?: bigint,
  blockNumber?: bigint
): Promise<
  | {
    wrapper: Address;
    wrapperMintAmount: bigint;
    wrapperValueInStakingToken: bigint;
  }
  | undefined
> {
  try {
    // Get wrapper prices from Kodiak backend
    const wrapperPrices = await getTokenPricesFromSubgraph(wrappers);
    if (!blockNumber) {
      blockNumber = await publicClient.getBlockNumber();
    }
    const results = await publicClient.multicall({
      contracts: [
        ...wrappers.map((wrapper) => ({
          address: baultAddress,
          abi: BAULT_ABI,
          functionName: "previewClaimBgtWrapper" as const,
          args: [wrapper],
        })),
        {
          address: baultAddress,
          abi: BAULT_ABI,
          functionName: "earned" as const,
          args: [],
        },
      ],
      blockNumber,
      allowFailure: false, // All calls must succeed for best wrapper selection
    });

    // Extract wrapper mint amounts from multicall results
    const wrapperMintAmounts = wrappers.map((_, i) => results[i] as bigint);
    const beraMinted = earnedBgt || 0n;

    // If no staking token price provided, fallback to Enso quoting
    if (!stakingTokenPrice || !wrapperPrices) {
      const wrapperValues = (
        await Promise.all(
          wrappers.map(async (wrapper, index) => {
            const sellAmount = wrapperMintAmounts[index].toString();
            if (sellAmount === "0") {
              return "0";
            }
            const quote = await getEnsoQuote(
              CHAIN_ID,
              wrapper,
              stakingToken,
              sellAmount,
              BOUNTY_HELPER_ADDRESS,
              BOUNTY_HELPER_ADDRESS,
              BOUNTY_HELPER_ADDRESS,
              COMPOUND_SLIPPAGE_BPS,
              false
            );
            return quote.amountOut;
          })
        )
      ).map((value) => BigInt(value));

      if (wrapperValues.length === 0) return undefined;
      let maxValue = 0n;
      let indexOfBestWrapper = 2; //ibgt wrapper
      for (let i = 0; i < wrapperValues.length; i++) {
        if (wrapperValues[i] > maxValue) {
          maxValue = wrapperValues[i];
          indexOfBestWrapper = i;
        }
      }
      return {
        wrapper: wrappers[indexOfBestWrapper],
        wrapperMintAmount: wrapperMintAmounts[indexOfBestWrapper],
        wrapperValueInStakingToken: wrapperValues[indexOfBestWrapper],
      };
    }

    // Use SG price-based calculation
    const wrapperValues = wrappers.map((wrapper, index) =>
      BigInt(
        checkWrapperValueInStakingToken(
          wrapper,
          wrapperMintAmounts[index],
          wrapperPrices,
          stakingTokenPrice
        ) || 0
      )
    );
    const beraPrice = await getBeraPrice();
    const beraValueInStakingToken = Number(formatEther(beraMinted)) * beraPrice / stakingTokenPrice;
    // Convert back to bigint with 18 decimals
    const beraValueInStakingTokenBigInt = BigInt(Math.floor(beraValueInStakingToken * 1e18));

    if (wrapperValues.length === 0) return undefined;
    let maxValue = 0n;
    let indexOfBestWrapper = 2; //ibgt wrapper
    for (let i = 0; i < wrapperValues.length; i++) {
      if (wrapperValues[i] > maxValue) {
        maxValue = wrapperValues[i];
        indexOfBestWrapper = i;
      }
    }
    if (beraValueInStakingTokenBigInt > maxValue) {
      return {
        wrapper: WBERA,
        wrapperMintAmount: beraMinted,
        wrapperValueInStakingToken: beraValueInStakingTokenBigInt,
      };
    }
    // console.log(`[BaultCompoundPriorityKeeper] Best wrapper for ${baultAddress}: ${wrappers[indexOfBestWrapper]}`);
    return {
      wrapper: wrappers[indexOfBestWrapper],
      wrapperMintAmount: wrapperMintAmounts[indexOfBestWrapper],
      wrapperValueInStakingToken: wrapperValues[indexOfBestWrapper],
    };
  } catch (error) {
    console.error(`Error in findBestWrapper for Bault ${baultAddress}:`, error);
    return undefined;
  }
}
/**
 * Fetches comprehensive on-chain data for all baults with optimized parallel execution
 * Includes bounty amounts, earned BGT, and best wrapper analysis
 * @param publicClient - Viem public client for blockchain interactions
 * @returns Array of bault data with complete on-chain information
 */
export async function getBaultsWithOnchainData(
  publicClient: PublicClient,
): Promise<BaultOnchainData[]> {
  const baults = await getBaultsFromKodiakBackend();

  // Optimized: Batch ALL baults into a SINGLE multicall (3N RPC → 1 RPC for N baults)
  // Build flat array of all contract calls for all baults
  const allContracts = baults.flatMap(({ bault }) => [
    {
      address: bault,
      abi: BAULT_ABI,
      functionName: "bounty" as const,
    },
    {
      address: bault,
      abi: BAULT_ABI,
      functionName: "earned" as const,
    },
    {
      address: bault,
      abi: BAULT_ABI,
      functionName: "onlyAllowedBgtWrapper" as const,
    },
  ]);

  // Execute single multicall for all baults
  const allResults = await publicClient.multicall({
    contracts: allContracts,
    allowFailure: true, // Allow individual failures while getting data for other baults
  });

  // Map results back to individual baults (3 results per bault)
  const baultsWithOnChainData = baults.map(
    ({ stakingToken, bault, symbol, tokenLp }, index) => {
      const startIdx = index * 3;
      const bountyResult = allResults[startIdx];
      const earnedResult = allResults[startIdx + 1];
      const wrapperResult = allResults[startIdx + 2];

      // Check if any call failed for this bault
      if (
        bountyResult.status === "failure" ||
        earnedResult.status === "failure" ||
        wrapperResult.status === "failure"
      ) {
        return {
          stakingToken,
          bault,
          symbol,
          bounty: 0n,
          earnedBgt: 0n,
          onlyAllowedBgtWrapper: zeroAddress,
          stakingTokenPrice: undefined,
          error: "Error fetching onchain data",
        };
      }

      return {
        stakingToken,
        bault,
        symbol,
        bounty: bountyResult.result as bigint,
        earnedBgt: earnedResult.result as bigint,
        onlyAllowedBgtWrapper: wrapperResult.result as Address,
        stakingTokenPrice: tokenLp.price,
        error: undefined,
      };
    }
  );

  return baultsWithOnChainData as BaultOnchainData[];
}

/**
 * Fetches comprehensive bault data with complete pricing information
 * Enhanced version that includes price data for better wrapper selection
 * @param publicClient - Viem public client for blockchain interactions
 * @returns Array of bault data with complete information including prices
 */
export async function getBaultsWithCompleteData(
  publicClient: PublicClient,
): Promise<BaultCompleteData[]> {
  // Fetch baults list
  const baults = await getBaultsFromKodiakBackend();

  // Optimized: Batch ALL baults into a SINGLE multicall (3N RPC → 1 RPC for N baults)
  // Build flat array of all contract calls for all baults
  const allContracts = baults.flatMap(({ bault }) => [
    {
      address: bault,
      abi: BAULT_ABI,
      functionName: "bounty" as const,
    },
    {
      address: bault,
      abi: BAULT_ABI,
      functionName: "earned" as const,
    },
    {
      address: bault,
      abi: BAULT_ABI,
      functionName: "onlyAllowedBgtWrapper" as const,
    },
  ]);

  // Execute single multicall for all baults
  const allResults = await publicClient.multicall({
    contracts: allContracts,
    allowFailure: true, // Allow individual failures while getting data for other baults
  });

  // Map results back to individual baults (3 results per bault)
  const baultsWithBasicData = baults.map(
    ({ stakingToken, bault, symbol, tokenLp }, index) => {
      const startIdx = index * 3;
      const bountyResult = allResults[startIdx];
      const earnedResult = allResults[startIdx + 1];
      const wrapperResult = allResults[startIdx + 2];

      // Check if any call failed for this bault
      if (
        bountyResult.status === "failure" ||
        earnedResult.status === "failure" ||
        wrapperResult.status === "failure"
      ) {
        return {
          stakingToken,
          bault,
          symbol,
          bounty: 0n,
          earnedBgt: 0n,
          onlyAllowedBgtWrapper: zeroAddress,
          stakingTokenPrice: undefined,
          error: "Error fetching onchain data",
        };
      }

      return {
        stakingToken,
        bault,
        symbol,
        bounty: bountyResult.result as bigint,
        earnedBgt: earnedResult.result as bigint,
        onlyAllowedBgtWrapper: wrapperResult.result as Address,
        stakingTokenPrice: tokenLp.price,
      };
    }
  );

  // Mark baults with low BGT as having insufficient BGT error
  const allBaults = baultsWithBasicData.map((baultData) => {
    if (baultData.error) return baultData; // Already has an error
    if (baultData.earnedBgt <= parseEther(MIN_EARNINGS_BGT)) {
      return {
        ...baultData,
        error: `Insufficient BGT earned (≤${MIN_EARNINGS_BGT})`,
      };
    }
    return baultData;
  });

  // Separate valid baults (no errors) for wrapper processing
  const validBaults = allBaults.filter((baultData) => !baultData.error) as Omit<
    BaultCompleteData,
    "wrapper" | "wrapperMintAmount" | "wrapperValueInStakingToken" | "error"
  >[];

  // Filter baults based on wrapper compatibility when ONLY_ALLOW_DEFAULT_WRAPPER is true
  const compatibleBaults = validBaults.filter(({ onlyAllowedBgtWrapper }) => {
    if (!ONLY_ALLOW_DEFAULT_WRAPPER) {
      return true; // Allow all baults when not restricting to default wrapper
    }
    // When ONLY_ALLOW_DEFAULT_WRAPPER is true:
    // - Allow baults with no restriction (zeroAddress)
    // - Allow baults that specifically require our DEFAULT_BGT_WRAPPER_ADDRESS
    // - Skip baults that require a different wrapper
    return (
      onlyAllowedBgtWrapper === zeroAddress ||
      onlyAllowedBgtWrapper.toLowerCase() ===
      DEFAULT_BGT_WRAPPER_ADDRESS.toLowerCase()
    );
  });

  // --- OPTIMIZED: Batch all wrapper preview calls into a single multicall ---
  // Instead of N multicalls (one per findBestWrapper), we make 1 multicall for all baults

  const blockNumber = await publicClient.getBlockNumber();

  // Fetch prices from subgraph once for all baults (not per-bault)
  const allWrappers: Address[] = [YBGT, LBGT, iBGT, mBGT];
  const [wrapperPrices, beraPrice] = await Promise.all([
    getTokenPricesFromSubgraph(allWrappers),
    getBeraPrice(),
  ]);

  // Build list of bault/wrapper pairs for batch multicall
  // Preserve the exact same wrapper selection logic as before
  const baultWrapperInputs: Array<{
    baultAddress: Address;
    wrappers: Address[];
    stakingToken: Address;
    stakingTokenPrice?: number;
    earnedBgt: bigint;
  }> = compatibleBaults.map(
    ({
      bault,
      stakingToken,
      onlyAllowedBgtWrapper,
      stakingTokenPrice,
      earnedBgt,
    }) => {
      let wrappers: Address[];
      if (onlyAllowedBgtWrapper === zeroAddress) {
        wrappers = ONLY_ALLOW_DEFAULT_WRAPPER
          ? [DEFAULT_BGT_WRAPPER_ADDRESS]
          : allWrappers;
      } else {
        wrappers = [onlyAllowedBgtWrapper];
      }
      return {
        baultAddress: bault,
        wrappers,
        stakingToken,
        stakingTokenPrice,
        earnedBgt,
      };
    }
  );

  // Single multicall for ALL baults' wrapper previews (reduces N RPC calls to 1)
  const batchPreviewResults = await batchPreviewWrapperMints(
    baultWrapperInputs.map(({ baultAddress, wrappers }) => ({
      baultAddress,
      wrappers,
    })),
    publicClient,
    blockNumber
  );

  // Process each bault's results using the selection logic
  const bestWrappers = await Promise.all(
    baultWrapperInputs.map(async (input) => {
      const previewResult = batchPreviewResults.get(input.baultAddress);

      // If batch fetch failed completely for this bault, skip it
      if (!previewResult) {
        console.error(`No preview result for bault ${input.baultAddress}`);
        return undefined;
      }

      // If any wrapper call failed for this bault, skip it to maintain original behavior
      // (original findBestWrapper used allowFailure: false)
      if (previewResult.hasAnyFailure) {
        console.error(
          `Some wrapper preview calls failed for bault ${input.baultAddress}`
        );
        return undefined;
      }

      // Use shared selection logic (same as findBestWrapper)
      return selectBestWrapperFromData(
        input.baultAddress,
        input.stakingToken,
        input.wrappers,
        previewResult.wrapperMintAmounts,
        previewResult.earned,
        wrapperPrices,
        beraPrice,
        input.stakingTokenPrice,
        input.earnedBgt
      );
    })
  );

  // Combine compatible baults with wrapper data
  const compatibleBaultsWithWrappers = compatibleBaults.map(
    (baultData, index) => {
      const wrapper = bestWrappers[index];
      if (!wrapper) {
        return {
          ...baultData,
          wrapper: "0x0000000000000000000000000000000000000000" as Address,
          wrapperMintAmount: 0n,
          wrapperValueInStakingToken: 0n,
          error: "Enso quote error",
        };
      }

      return {
        ...baultData,
        wrapper: wrapper.wrapper,
        wrapperMintAmount: wrapper.wrapperMintAmount,
        wrapperValueInStakingToken: wrapper.wrapperValueInStakingToken,
      };
    },
  );

  // Mark incompatible baults as having wrapper incompatibility error
  const incompatibleBaults = validBaults
    .filter(({ onlyAllowedBgtWrapper }) => {
      if (!ONLY_ALLOW_DEFAULT_WRAPPER) return false;
      return (
        onlyAllowedBgtWrapper !== zeroAddress &&
        onlyAllowedBgtWrapper.toLowerCase() !==
        DEFAULT_BGT_WRAPPER_ADDRESS.toLowerCase()
      );
    })
    .map((baultData) => ({
      ...baultData,
      wrapper: "0x0000000000000000000000000000000000000000" as Address,
      wrapperMintAmount: 0n,
      wrapperValueInStakingToken: 0n,
      error: `Wrapper incompatibility: Bault ${baultData.symbol} requires ${baultData.onlyAllowedBgtWrapper}, but compoundor only allows ${DEFAULT_BGT_WRAPPER_ADDRESS}`,
    }));

  // Combine all baults (failed ones, incompatible ones, and compatible ones with wrapper data)
  const results = allBaults.map((baultData) => {
    if (baultData.error) {
      // failed in fetching onchain data itself.
      // Return failed bault with placeholder wrapper data
      return {
        ...baultData,
        wrapper: "0x0000000000000000000000000000000000000000" as Address,
        wrapperMintAmount: 0n,
        wrapperValueInStakingToken: 0n,
      };
    }
    // Check if this is an incompatible bault
    const incompatible = incompatibleBaults.find(
      (incompatibleBault) => incompatibleBault.bault === baultData.bault,
    );
    if (incompatible) {
      return incompatible;
    }

    // Find corresponding compatible bault with wrapper data
    return compatibleBaultsWithWrappers.find(
      (compatibleBault) => compatibleBault.bault === baultData.bault,
    )!;
  });

  return results as BaultCompleteData[];
}


/**
 * Formats token amounts into human-readable strings with appropriate units
 * Handles large numbers with K/M suffixes and small numbers with scientific notation
 * @param amount - Token amount as bigint
 * @param decimals - Token decimal places (default: 18)
 * @param smallNumberSignificantDigits - Significant digits for small numbers (default: 2)
 * @returns Formatted string representation
 */
export function formatReadableAmount(
  amount: bigint,
  decimals: number = 18,
  smallNumberSignificantDigits: number = 2,
): string {
  const value = Number(formatUnits(amount, decimals));

  if (value === 0) return "0";

  // Handle K and M suffixes
  if (Math.abs(value) >= 1_000_000) {
    return (value / 1_000_000).toFixed(2) + "M";
  }
  if (Math.abs(value) >= 1_000) {
    return (value / 1_000).toFixed(2) + "K";
  }

  // Handle numbers >= 1 and < 1000
  if (Math.abs(value) >= 1) {
    // Max 4 decimal places, remove trailing zeros
    return parseFloat(value.toFixed(4)).toString();
  }

  // Handle numbers 0.01 <= abs(value) < 1 using toPrecision
  if (Math.abs(value) >= 0.01) {
    const precisionFormatted = value.toPrecision(smallNumberSignificantDigits);
    return parseFloat(precisionFormatted).toString();
  }

  // For very small numbers (abs(value) < 0.01), use scientific notation
  return value.toExponential(2);
}

/**
 * Calculates the percentage of bounty that the reward represents
 * @param rewardValue - Value of the reward in wei
 * @param bounty - Required bounty amount in wei
 * @returns Formatted percentage string
 */
export function calculateBountyPercentage(
  rewardValue: bigint,
  bounty: bigint,
): string {
  if (bounty === 0n) return "0%";
  const percentage = (Number(rewardValue) / Number(bounty)) * 100;
  return percentage.toFixed(2) + "%";
}

/** Subgraph URL for token price fetching */
const SUBGRAPH_URL = "https://api.goldsky.com/api/public/project_clpx84oel0al201r78jsl0r3i/subgraphs/kodiak-v3-berachain-mainnet/latest/gn"

// Fetch BERA price in USD from bundle
export async function getBeraPrice(): Promise<number> {
  const query = `
    {
      bundle(id: "1") {
        ethPriceUSD
      }
    }
  `;

  const response = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  const data = await response.json();
  const price = data?.data?.bundle?.ethPriceUSD;
  if (!price) throw new Error("Failed to fetch BERA price from bundle");

  return parseFloat(price);
}

/**
 * Fetches token prices from the subgraph using BERA as the base currency
 * @param tokens - Array of token addresses to get prices for
 * @returns Record mapping token addresses to USD prices
 */
export async function getTokenPricesFromSubgraph(
  tokens: Address[],
): Promise<Record<Address, number>> {
  const beraPrice = await getBeraPrice();

  const tokenQuery = `
    query {
      ${tokens
      .map(
        (address, i) => `
        token_${i}: token(id: "${address.toLowerCase()}") {
          id
          derivedETH
        }
      `,
      )
      .join("\n")}
    }
  `;

  const response = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: tokenQuery }),
  });

  const data = await response.json();
  const prices: Record<Address, number> = {};

  tokens.forEach((address, i) => {
    const tokenData = data?.data?.[`token_${i}`];
    if (tokenData?.derivedETH) {
      prices[address.toLowerCase() as Address] =
        parseFloat(tokenData.derivedETH) * beraPrice;
    }
  });

  return prices;
}


if (require.main === module) {
  getTokenPricesFromSubgraph([YBGT, LBGT, mBGT, iBGT]).then((prices) => {
    console.log("prices", prices);
  });
}
