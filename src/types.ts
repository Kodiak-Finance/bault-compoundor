import { Address } from "viem";

export type BaultOnChainData = {
    stakingToken: Address;
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