import {
  PublicClient,
  Address,
  getAddress,
  formatUnits,
  parseEther,
  parseUnits,
  zeroAddress,
} from "viem";
import {
  WBERA,
  KODIAK_BAULTS_API_URL,
  MIN_EARNED_REWARD_AMOUNT,
  RESTRICT_STAKING_TOKENS,
  RESTRICT_BAULTS,
  ONLY_BAULT_ADDRESSES,
  ONLY_STAKING_TOKEN_ADDRESSES,
  WRAPPER_SLIPPAGE_BPS,
} from "./configuration";
import {
  BaultFromKodiakBackend,
  BaultCompleteData,
} from "./types";
import { BAULT_ABI } from "./abis/Bault";

const PRICE_SCALE_DECIMALS = 18;

function toScaledPrice(price: number): bigint {
  if (!Number.isFinite(price) || price <= 0) {
    return 0n;
  }

  return parseUnits(price.toFixed(PRICE_SCALE_DECIMALS), PRICE_SCALE_DECIMALS);
}

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

function getBeraValueInStakingToken(
  earnedRewardAmount: bigint,
  beraPrice: number,
  stakingTokenPrice: number,
): bigint {
  if (earnedRewardAmount === 0n || !beraPrice || !stakingTokenPrice) {
    return 0n;
  }

  const beraPriceScaled = toScaledPrice(beraPrice);
  const stakingTokenPriceScaled = toScaledPrice(stakingTokenPrice);
  if (beraPriceScaled === 0n || stakingTokenPriceScaled === 0n) {
    return 0n;
  }

  const valueInStakingToken =
    (earnedRewardAmount * beraPriceScaled) / stakingTokenPriceScaled;
  const valueInStakingTokenWithSlippage =
    (valueInStakingToken * BigInt(10000 - WRAPPER_SLIPPAGE_BPS)) / 10000n;

  return valueInStakingTokenWithSlippage;
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
          earnedRewardAmount: 0n,
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
        earnedRewardAmount: earnedResult.result as bigint,
        onlyAllowedBgtWrapper: wrapperResult.result as Address,
        stakingTokenPrice: tokenLp.price,
      };
    }
  );

  const prices = await getTokenPriceFromKodiakBackendWithFallback([
    WBERA as Address,
  ]);
  const beraPrice = prices[WBERA as Address];

  const results = baultsWithBasicData.map((baultData) => {
    const compoundData = {
      ...baultData,
      wrapper: WBERA as Address,
      wrapperMintAmount: baultData.error ? 0n : baultData.earnedRewardAmount,
      wrapperValueInStakingToken: 0n,
    };

    if (baultData.error) return compoundData;

    if (baultData.earnedRewardAmount <= parseEther(MIN_EARNED_REWARD_AMOUNT)) {
      return {
        ...compoundData,
        wrapperMintAmount: 0n,
        error: `Insufficient rewards earned (<=${MIN_EARNED_REWARD_AMOUNT})`,
      };
    }

    const supportsWberaWrapper =
      baultData.onlyAllowedBgtWrapper === zeroAddress ||
      baultData.onlyAllowedBgtWrapper.toLowerCase() === WBERA.toLowerCase();

    if (!supportsWberaWrapper) {
      return {
        ...compoundData,
        wrapperMintAmount: 0n,
        error: `Wrapper incompatibility: Bault ${baultData.symbol} requires ${baultData.onlyAllowedBgtWrapper}, but compoundor only supports ${WBERA}`,
      };
    }

    if (!baultData.stakingTokenPrice || baultData.stakingTokenPrice === 0) {
      return {
        ...compoundData,
        wrapperMintAmount: 0n,
        error: `No staking token price for ${baultData.stakingToken}`,
      };
    }

    if (!beraPrice) {
      return {
        ...compoundData,
        wrapperMintAmount: 0n,
        error: "No BERA price",
      };
    }

    return {
      ...compoundData,
      wrapperValueInStakingToken: getBeraValueInStakingToken(
        baultData.earnedRewardAmount,
        beraPrice,
        baultData.stakingTokenPrice,
      ),
    };
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
const SUBGRAPH_URL = "https://api.subgraph.ormilabs.com/api/public/d7eed6cc-ad4a-4862-8017-89893c4095d3/subgraphs/kodiak-v3/latest/gn";

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

export async function getTokenPriceFromKodiakBackendWithFallback(
  tokens: Address[],
): Promise<Record<Address, number>> {
  const pricesFromBackend = await getTokenPricesFromKodiakBackend(tokens);
  if (!pricesFromBackend || Object.keys(pricesFromBackend).length === 0) {
    console.warn("Falling back to subgraph for token prices");
    try {
      const pricesFromSubgraph = await getTokenPricesFromSubgraph(tokens);
      return pricesFromSubgraph;
    } catch (error) {
      console.error("Error fetching prices from subgraph fallback: ", error);
      return {};
    }
  }
  return pricesFromBackend;
}

export async function getTokenPricesFromKodiakBackend(
  tokens: Address[],
): Promise<Record<Address, number>> {
  try {
    const response = await fetch(
      `https://backend.kodiak.finance/tokens?addresses=${tokens.map(token => token.toLowerCase()).join(",")}`,
    );
    const responseData = await response.json();
    return responseData.reduce((acc: Record<Address, number>, priceData: any) => {
      acc[priceData.id] = priceData.price;
      return acc;
    }, {});
  } catch (error) {
    console.error("Error fetching prices from Kodiak backend: ", error);
    return {};
  }
}
