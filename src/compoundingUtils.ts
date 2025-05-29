import { PublicClient, Address, parseAbi, getContract, getAddress, formatUnits, parseEther, zeroAddress } from "viem";
import { CHAIN_ID, COMPOUND_SLIPPAGE_BPS, YBGT, LBGT, iBGT, BOUNTY_HELPER_ADDRESS, KODIAK_BAULTS_API_URL, MIN_EARNINGS_BGT, ONLY_ALLOW_DEFAULT_WRAPPER, DEFAULT_BGT_WRAPPER_ADDRESS } from "./configuration";
import { getEnsoQuote } from "./EnsoQuoter";
import { BaultOnChainData, BaultFromKodiakBackend } from "./types";

/** ABI for Bault contract interactions */
export const BAULT_ABI = parseAbi([
  "function bounty() external view returns (uint256)",
  "function asset() external view returns (address)",
  "function earned() external view returns (uint256)",
  "function previewClaimBgtWrapper(address bgtWrapper) external view returns (uint256)",
  "function onlyAllowedBgtWrapper() external view returns (address)",
]);

/**
 * Fetches bault data from Kodiak backend API
 * @returns Array of bault information from backend
 */
async function getBaultsFromKodiakBackend(): Promise<BaultFromKodiakBackend[]> {
  const response = await fetch(KODIAK_BAULTS_API_URL);
  const responseData = await response.json();
  return responseData.data.reduce((acc: BaultFromKodiakBackend[], island: any) => {
    if (island.provider === "kodiak" && island.id && island.baults.length > 0) {
      acc.push({
        stakingToken: getAddress(island.id),
        bault: getAddress(island.baults[0].id),
        symbol: island.tokenLp.symbol,
      });
    }
    return acc;
  }, []);
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
) {
  const sellAmount = inputAmount.toString();
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
}

/**
 * Finds the most profitable BGT wrapper for a given bault
 * Compares yBGT, lBGT, and iBGT to determine which provides the best value
 * @param baultAddress - Address of the bault contract
 * @param stakingToken - Address of the underlying staking token
 * @param publicClient - Viem public client for blockchain calls
 * @param wrappers - Array of wrapper addresses to compare (defaults to [YBGT, LBGT, iBGT])
 * @returns Best wrapper info or undefined if none found
 */
export async function findBestWrapper(
  baultAddress: Address,
  stakingToken: Address,
  publicClient: PublicClient,
  wrappers: Address[] = [YBGT, LBGT, iBGT],
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
    const currentBlock = await publicClient.getBlock();
    const wrapperMintAmounts = await Promise.all(
      wrappers.map(async (wrapper) =>
        baultContract.read.previewClaimBgtWrapper([wrapper], {
          blockNumber: currentBlock.number,
        }),
      ),
    );
    const wrapperValues = (
      await Promise.all(
        wrappers.map((wrapper, index) =>
          checkWrapperValueInStakingToken(
            wrapper,
            stakingToken,
            wrapperMintAmounts[index],
          ),
        ),
      )
    ).map((value) => BigInt(value));
    // Log wrapper mint amounts and values
    // for (let i = 0; i < wrappers.length; i++) {
    //     console.log(`[BaultCompoundPriorityKeeper] ${wrappers[i]}: ${wrapperMintAmounts[i]} -> ${wrapperValues[i]}`);
    // }
    if (wrapperValues.length === 0) return undefined;
    let maxValue = 0n;
    let indexOfBestWrapper = 2; //ibgt wrapper
    for (let i = 0; i < wrapperValues.length; i++) {
      if (wrapperValues[i] > maxValue) {
        maxValue = wrapperValues[i];
        indexOfBestWrapper = i;
      }
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
export async function getBaultsOnChainData(publicClient: PublicClient): Promise<BaultOnChainData[]> {
  // Fetch baults list
  const baults = await getBaultsFromKodiakBackend();

  // First, fetch all on-chain data in parallel
  const baultsWithBasicData = await Promise.all(
    baults.map(async ({ stakingToken, bault, symbol }) => {
      try {
        const baultContract = getContract({
          address: bault,
          abi: BAULT_ABI,
          client: publicClient,
        });
        const [bounty, earnedBgt, onlyAllowedBgtWrapper] = await Promise.all([
          baultContract.read.bounty(),
          baultContract.read.earned(),
          baultContract.read.onlyAllowedBgtWrapper()
        ]);

        return {
          stakingToken,
          bault,
          symbol,
          bounty,
          earnedBgt,
          onlyAllowedBgtWrapper
        };
      } catch (error) {
        return {
          stakingToken,
          bault,
          symbol,
          bounty: 0n,
          earnedBgt: 0n,
          onlyAllowedBgtWrapper: zeroAddress,
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
  const validBaults = allBaults.filter((baultData) => !baultData.error) as (Omit<BaultOnChainData, 'wrapper' | 'wrapperMintAmount' | 'wrapperValueInStakingToken' | 'error'>)[];
  // Filter baults based on wrapper compatibility when ONLY_ALLOW_DEFAULT_WRAPPER is true
  const compatibleBaults = validBaults.filter(({ onlyAllowedBgtWrapper }) => {
    if (!ONLY_ALLOW_DEFAULT_WRAPPER) {
      return true; // Allow all baults when not restricting to default wrapper
    }

    // When ONLY_ALLOW_DEFAULT_WRAPPER is true:
    // - Allow baults with no restriction (zeroAddress)
    // - Allow baults that specifically require our DEFAULT_BGT_WRAPPER_ADDRESS
    // - Skip baults that require a different wrapper
    return onlyAllowedBgtWrapper === zeroAddress ||
      onlyAllowedBgtWrapper.toLowerCase() === DEFAULT_BGT_WRAPPER_ADDRESS.toLowerCase();
  });

  // Then, fetch all best wrappers in parallel for compatible baults
  const wrapperPromises = compatibleBaults.map(({ bault, stakingToken, onlyAllowedBgtWrapper }) => {
    if (onlyAllowedBgtWrapper === zeroAddress) {
      if (ONLY_ALLOW_DEFAULT_WRAPPER) {
        return findBestWrapper(bault, stakingToken, publicClient, [DEFAULT_BGT_WRAPPER_ADDRESS]);
      }
      return findBestWrapper(bault, stakingToken, publicClient);
    } else {
      return findBestWrapper(bault, stakingToken, publicClient, [DEFAULT_BGT_WRAPPER_ADDRESS]);
    }
  });

  const bestWrappers = await Promise.all(wrapperPromises);

  // Combine compatible baults with wrapper data
  const compatibleBaultsWithWrappers = compatibleBaults.map((baultData, index) => {
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
  });

  // Mark incompatible baults as having wrapper incompatibility error
  const incompatibleBaults = validBaults
    .filter(({ onlyAllowedBgtWrapper }) => {
      if (!ONLY_ALLOW_DEFAULT_WRAPPER) return false;
      return onlyAllowedBgtWrapper !== zeroAddress &&
        onlyAllowedBgtWrapper.toLowerCase() !== DEFAULT_BGT_WRAPPER_ADDRESS.toLowerCase();
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
    if (baultData.error) { // failed in fetching onchain data itself.
      // Return failed bault with placeholder wrapper data
      return {
        ...baultData,
        wrapper: "0x0000000000000000000000000000000000000000" as Address,
        wrapperMintAmount: 0n,
        wrapperValueInStakingToken: 0n,
      };
    }
    // Check if this is an incompatible bault
    const incompatible = incompatibleBaults.find((incompatibleBault) => incompatibleBault.bault === baultData.bault);
    if (incompatible) {
      return incompatible;
    }

    // Find corresponding compatible bault with wrapper data
    return compatibleBaultsWithWrappers.find((compatibleBault) => compatibleBault.bault === baultData.bault)!;
  });

  return results as BaultOnChainData[];
}

/**
 * Formats token amounts into human-readable strings with appropriate units
 * Handles large numbers with K/M suffixes and small numbers with scientific notation
 * @param amount - Token amount as bigint
 * @param decimals - Token decimal places (default: 18)
 * @param smallNumberSignificantDigits - Significant digits for small numbers (default: 2)
 * @returns Formatted string representation
 */
export function formatReadableAmount(amount: bigint, decimals: number = 18, smallNumberSignificantDigits: number = 2): string {
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
export function calculateBountyPercentage(rewardValue: bigint, bounty: bigint): string {
  if (bounty === 0n) return "0%";
  const percentage = (Number(rewardValue) / Number(bounty)) * 100;
  return percentage.toFixed(2) + "%";
}