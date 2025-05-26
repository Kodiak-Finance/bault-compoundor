import { PublicClient, Address, parseAbi, getContract, getAddress, formatUnits, parseEther } from "viem";
import { CHAIN_ID, COMPOUND_SLIPPAGE_BPS, YBGT, LBGT, iBGT, BOUNTY_HELPER_ADDRESS, KODIAK_STAGING_BAULTS_API_URL, MIN_EARNINGS_BGT } from "./configuration";
import { getEnsoQuote } from "./EnsoQuoter";
import { BaultOnChainData, BaultFromKodiakBackend } from "./types";

export const BAULT_ABI = parseAbi([
  "function bounty() external view returns (uint256)",
  "function asset() external view returns (address)", // ERC4626 standard for underlying token
  "function earned() external view returns (uint256)",
  "function previewClaimBgtWrapper(address bgtWrapper) external view returns (uint256)",
]);

async function getBaultsFromKodiakBackend(): Promise<BaultFromKodiakBackend[]> {
  const response = await fetch(KODIAK_STAGING_BAULTS_API_URL);
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

// --- Utils to get the best wrapper for a bault ---
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
// -------------------------------------------------

/**
 * Fetches on-chain data for all baults with optimized parallel execution
 * @param publicClient Client to use for on-chain calls
 * @returns Array of bault data with on-chain information
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
        const [bounty, earnedBgt] = await Promise.all([
          baultContract.read.bounty(),
          baultContract.read.earned(),
        ]);

        return {
          stakingToken,
          bault,
          symbol,
          bounty,
          earnedBgt,
        };
      } catch (error) {
        return {
          stakingToken,
          bault,
          symbol,
          bounty: 0n,
          earnedBgt: 0n,
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

  // Then, fetch all best wrappers in parallel for valid baults
  const wrapperPromises = validBaults.map(({ bault, stakingToken }) =>
    findBestWrapper(bault, stakingToken, publicClient)
  );

  const bestWrappers = await Promise.all(wrapperPromises);

  // Combine valid baults with wrapper data
  const validBaultsWithWrappers = validBaults.map((baultData, index) => {
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

  // Combine all baults (failed ones and valid ones with wrapper data)
  const results = allBaults.map((baultData) => {
    if (baultData.error) {
      // Return failed bault with placeholder wrapper data
      return {
        ...baultData,
        wrapper: "0x0000000000000000000000000000000000000000" as Address,
        wrapperMintAmount: 0n,
        wrapperValueInStakingToken: 0n,
      };
    }
    // Find corresponding valid bault with wrapper data
    return validBaultsWithWrappers.find((validBault) => validBault.bault === baultData.bault)!;
  });

  return results as BaultOnChainData[];
}


// Better formatting function for readable decimal display
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

export function calculateBountyPercentage(rewardValue: bigint, bounty: bigint): string {
  if (bounty === 0n) return "0%";
  const percentage = (Number(rewardValue) / Number(bounty)) * 100;
  return percentage.toFixed(2) + "%";
}