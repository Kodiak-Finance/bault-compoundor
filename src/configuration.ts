import { Hex, Address } from "viem";

/**
 * Cross-runtime environment variable access utility
 * Supports both Bun and Node.js environments
 * @param key - Environment variable name
 * @returns Environment variable value or undefined
 */
const getEnvVar = (key: string): string | undefined => {
  // Bun uses Bun.env, Node.js uses process.env
  if (typeof Bun !== "undefined" && Bun.env) {
    return Bun.env[key];
  }
  return process.env[key];
};

// API Configuration
/** Kodiak backend API endpoint for fetching bault data */
export const KODIAK_BAULTS_API_URL =
  "https://backend.kodiak.finance/vaults?withBaults=true";

// Network Configuration
export const CHAIN_ID = 80094;

// Environment Variables (Required)
export const RPC_URL = getEnvVar("RPC_URL");
export const ENSO_API_KEY = getEnvVar("ENSO_API_KEY");
export const PRIVATE_KEY = getEnvVar("PRIVATE_KEY") as Hex | undefined;

// BGT Wrapper Contract Addresses
export const YBGT = "0x7e768f47dfDD5DAe874Aac233f1Bc5817137E453";
export const LBGT = "0xBaadCC2962417C01Af99fb2B7C75706B9bd6Babe";
export const iBGT = "0xac03CABA51e17c86c921E1f6CBFBdC91F8BB2E6b";
export const mBGT = "0x927439eEf2e2520aFa78D8742cAe7Be3e3e90B11";
export const WBERA = "0x6969696969696969696969696969696969696969";

export const ONLY_ALLOW_DEFAULT_WRAPPER = false;  // will find the best wrapper for the bault if set to false, otherwise will only use the default wrapper.
export const DEFAULT_BGT_WRAPPER_ADDRESS = iBGT as Address; // The default wrapper address to use if ONLY_ALLOW_DEFAULT_WRAPPER is true

// Contract Addresses for Compounding
/** BountyHelper contract for executing compound transactions */
export const BOUNTY_HELPER_ADDRESS = "0x4a19d3107F81aAa55202264f2c246aA75734eDb6" as Address;
export const BOUNTY_FUNDER_ADDRESS = "0x6a17477B5C394cf3720dBe97b3Ea34a2B64af3f4" as Address;
/** Address that receives excess tokens from compound operations (leave empty to use signer address) */
export const BENEFICIARY_ADDRESS = "" as Address;

// Slippage Configuration
/** Default slippage tolerance for compounding in basis points (0.2%) */
export const COMPOUND_SLIPPAGE_BPS = 20;
/** Maximum slippage tolerance for final retry attempts (1%) */
export const MAX_COMPOUND_SLIPPAGE_BPS = 100;
/** Additional slippage added per retry attempt (0.15%) */
export const SLIPPAGE_INCREMENT_PER_RETRY = 15;

// Bot Operation Configuration
/** Minimum BGT earnings required to attempt compounding */
export const MIN_EARNINGS_BGT = "1";
/** Interval between main loop executions in milliseconds */
export const LOOP_INTERVAL = Number(getEnvVar("LOOP_INTERVAL")) || 20 * 1000;
/** Delay between retry attempts in milliseconds */
export const RETRY_INTERVAL = Number(getEnvVar("RETRY_INTERVAL")) || 10 * 1000;
/** Maximum number of retry attempts per bault */
export const MAX_RETRIES = Number(getEnvVar("MAX_RETRIES")) || 0;
/** Slippage for accounting swapping a wrapper to wbera  */
export const WRAPPER_SLIPPAGE_BPS = Number(getEnvVar("WRAPPER_SLIPPAGE_BPS")) || 100; //(100 = 0.1%)


export const RESTRICT_BAULTS = false;
export const ONLY_BAULT_ADDRESSES = [
    "0x1451308b8bbfd25d1820cdf108178f75dadd67d5"
]

export const RESTRICT_STAKING_TOKENS = false;
export const ONLY_STAKING_TOKEN_ADDRESSES = []

