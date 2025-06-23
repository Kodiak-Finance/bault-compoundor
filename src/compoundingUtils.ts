import {
  PublicClient,
  Address,
  getContract,
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
} from "./configuration";
import { getEnsoQuote } from "./EnsoQuoter";
import {
  BaultOnchainData,
  BaultFromKodiakBackend,
  BaultCompleteData,
} from "./types";
import { BAULT_ABI } from "./abis/Bault";

/**
 * Fetches bault data from Kodiak backend API
 * @returns Array of bault information from backend
 */
export async function getBaultsFromKodiakBackend(): Promise<BaultFromKodiakBackend[]> {
  const response = await fetch(KODIAK_BAULTS_API_URL);
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
 * Uses Enso DEX aggregator to get swap quotes
 * @param wrapper - BGT wrapper contract address
 * @param stakingToken - Target staking token address
 * @param inputAmount - Amount of wrapper tokens to value
 * @returns String representation of output amount in staking token
 */
export async function checkWrapperValueInStakingToken(
  wrapper: `0x${string}`,
  stakingToken: `0x${string}`,
  inputAmount: bigint,
  wrapperPrices: Record<Address, number>,
  stakingTokenPrice?: number,
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

    // Convert back to bigint with 18 decimals
    const result = BigInt(Math.floor(valueInStakingToken * 1e18)).toString();
    return result;
  }
}

/**
 * Finds the most profitable BGT wrapper for a given bault
 * Compares yBGT, lBGT, and iBGT to determine which provides the best value
 * @param baultAddress - Address of the bault contract
 * @param stakingToken - Address of the underlying staking token
 * @param publicClient - Viem public client for blockchain calls
 * @param wrappers - Array of wrapper addresses to compare (defaults to [YBGT, LBGT, iBGT])
 * @param stakingTokenPrice - Optional price of staking token for enhanced calculation
 * @returns Best wrapper info or undefined if none found
 */
export async function findBestWrapper(
  baultAddress: Address,
  stakingToken: Address,
  publicClient: PublicClient,
  wrappers: Address[] = [YBGT, LBGT, iBGT],
  stakingTokenPrice?: number,
  earnedBgt?: bigint,
): Promise<
  | {
    wrapper: Address;
    wrapperMintAmount: bigint;
    wrapperValueInStakingToken: bigint;
  }
  | undefined
> {
  const baultContract = getContract({
    address: baultAddress as Address,
    abi: BAULT_ABI,
    client: publicClient,
  });
  try {
    // Get wrapper prices from Kodiak backend
    const wrapperPrices = await getTokenPricesFromSubgraph(wrappers);
    const currentBlock = await publicClient.getBlock();
    const wrapperMintAmounts = await Promise.all(
      wrappers.map(async (wrapper) =>
        baultContract.read.previewClaimBgtWrapper([wrapper], {
          blockNumber: currentBlock.number,
        }),
      ),
    );
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
              false,
            );
            return quote.amountOut;
          }),
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
    const wrapperValues = (
      await Promise.all(
        wrappers.map((wrapper, index) =>
          checkWrapperValueInStakingToken(
            wrapper,
            stakingToken,
            wrapperMintAmounts[index],
            wrapperPrices,
            stakingTokenPrice,
          ),
        ),
      )
    ).map((value) => BigInt(value));
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
      console.log(`[BaultCompoundPriorityKeeper] Best wrapper for ${baultAddress}: WBERA`);
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
  const baultsWithOnChainData = await Promise.all(
    baults.map(async ({ stakingToken, bault, symbol, tokenLp }) => {
      try {
        const baultContract = getContract({
          address: bault,
          abi: BAULT_ABI,
          client: publicClient,
        });
        const [bounty, earnedBgt, onlyAllowedBgtWrapper] = await Promise.all([
          baultContract.read.bounty(),
          baultContract.read.earned(),
          baultContract.read.onlyAllowedBgtWrapper(),
        ]);

        return {
          stakingToken,
          bault,
          symbol,
          bounty,
          earnedBgt,
          onlyAllowedBgtWrapper,
          stakingTokenPrice: tokenLp.price,
          error: undefined,
        };
      } catch (error) {
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
    }),
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

  // First, fetch all on-chain data in parallel
  const baultsWithBasicData = await Promise.all(
    baults.map(async ({ stakingToken, bault, symbol, tokenLp }) => {
      try {
        const baultContract = getContract({
          address: bault,
          abi: BAULT_ABI,
          client: publicClient,
        });
        const [bounty, earnedBgt, onlyAllowedBgtWrapper] = await Promise.all([
          baultContract.read.bounty(),
          baultContract.read.earned(),
          baultContract.read.onlyAllowedBgtWrapper(),
        ]);

        return {
          stakingToken,
          bault,
          symbol,
          bounty,
          earnedBgt,
          onlyAllowedBgtWrapper,
          stakingTokenPrice: tokenLp.price,
        };
      } catch (error) {
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
    }),
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

  // Then, fetch all best wrappers in parallel for compatible baults
  const wrapperPromises = compatibleBaults.map(
    ({ bault, stakingToken, onlyAllowedBgtWrapper, stakingTokenPrice, earnedBgt }) => {
      if (onlyAllowedBgtWrapper === zeroAddress) {
        if (ONLY_ALLOW_DEFAULT_WRAPPER) {
          return findBestWrapper(
            bault,
            stakingToken,
            publicClient,
            [DEFAULT_BGT_WRAPPER_ADDRESS],
            stakingTokenPrice,
            earnedBgt,
          );
        }
        return findBestWrapper(
          bault,
          stakingToken,
          publicClient,
          undefined,
          stakingTokenPrice,
          earnedBgt,
        );
      } else {
        return findBestWrapper(
          bault,
          stakingToken,
          publicClient,
          [onlyAllowedBgtWrapper],
          stakingTokenPrice,
          earnedBgt,
        );
      }
    },
  );

  const bestWrappers = await Promise.all(wrapperPromises);

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
  getTokenPricesFromSubgraph([YBGT, LBGT, iBGT]).then((prices) => {
    console.log("prices", prices);
  });
}
