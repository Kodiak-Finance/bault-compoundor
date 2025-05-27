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
export const KODIAK_STAGING_BAULTS_API_URL =
  "https://staging.backend.kodiak.finance/vaults?withBaults=true"; // Use staging for now

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
export const WBERA = "0x6969696969696969696969696969696969696969";

export const ONLY_ALLOW_DEFAULT_WRAPPER = false;  // will find the best wrapper for the bault if set to false, otherwise will only use the default wrapper.
export const DEFAULT_BGT_WRAPPER_ADDRESS = iBGT as Address; // The default wrapper address to use if ONLY_ALLOW_DEFAULT_WRAPPER is true

// Contract Addresses for Compounding
/** BountyHelper contract for executing compound transactions */
export const BOUNTY_HELPER_ADDRESS =
  "0xd7af1F067d038fB5Aaa58a3F2707A0e95AAb998B" as Address;
export const BOUNTY_FUNDER_ADDRESS =
  "0xE6A443EE33A23A25cdF820f77F69B001cBAbA4E9" as Address;
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
export const MIN_EARNINGS_BGT = "0.3";
/** Interval between main loop executions in milliseconds */
export const LOOP_INTERVAL = 30 * 1000;
/** Delay between retry attempts in milliseconds */
export const RETRY_INTERVAL = 3 * 1000;
/** Maximum number of retry attempts per bault */
export const MAX_RETRIES = 3;
