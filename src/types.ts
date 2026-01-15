import { Address } from "viem";

export type BaultOnchainData = {
    stakingToken: Address;
    bault: Address;
    symbol: string;
    bounty: bigint;
    stakingTokenPrice: number | undefined;
    earnedBgt: bigint;
    onlyAllowedBgtWrapper: Address;
    error?: string;
};

export type BaultCompleteData = {
    stakingToken: Address;
    stakingTokenPrice: number | undefined;
    bault: Address;
    symbol: string;
    bounty: bigint;
    earnedBgt: bigint;
    onlyAllowedBgtWrapper: Address;
    wrapper: Address;
    wrapperMintAmount: bigint;
    wrapperValueInStakingToken: bigint;
    error?: string;
};

export type BaultFromKodiakBackend = {
    bault: Address;
    stakingToken: Address;
    symbol: string;
    tokenLp: any;
}

export type CompoundResult = {
    status: 'success' | 'fail' | 'skipped';
    tx: `0x${string}` | null;
    error?: string;
    excessTokensReceived?: bigint;
};

export type RetryInfo = {
    count: number;
    originalEarnedBgt: bigint;
};

/**
 * Input for batch wrapper preview
 */
export interface BatchWrapperPreviewInput {
    baultAddress: Address;
    wrappers: Address[];
}

/**
 * Output from batch wrapper preview
 */
export interface BatchWrapperPreviewOutput {
    wrapperMintAmounts: bigint[];
    earned: bigint;
    hasAnyFailure: boolean; // Track if any call failed for this bault
}