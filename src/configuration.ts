import { Hex, Address } from "viem";

// Cross-runtime environment variable access
const getEnvVar = (key: string): string | undefined => {
  // Bun uses Bun.env, Node.js uses process.env
  if (typeof Bun !== "undefined" && Bun.env) {
    return Bun.env[key];
  }
  return process.env[key];
};

export const KODIAK_STAGING_BAULTS_API_URL =
  "https://staging.backend.kodiak.finance/vaults?withBaults=true"; // Use staging for now
export const CHAIN_ID = 80094;
export const RPC_URL = getEnvVar("RPC_URL");
export const ENSO_API_KEY = getEnvVar("ENSO_API_KEY");
export const PRIVATE_KEY = getEnvVar("PRIVATE_KEY") as Hex | undefined;

// Contract addresses
export const YBGT = "0x7e768f47dfDD5DAe874Aac233f1Bc5817137E453";
export const LBGT = "0xBaadCC2962417C01Af99fb2B7C75706B9bd6Babe";
export const iBGT = "0xac03CABA51e17c86c921E1f6CBFBdC91F8BB2E6b";
export const WBERA = "0x6969696969696969696969696969696969696969";
export const DEFAULT_BGT_WRAPPER_ADDRESS = iBGT as Address;

export const BOUNTY_HELPER_ADDRESS =
  "0xd7af1F067d038fB5Aaa58a3F2707A0e95AAb998B" as Address;
export const BOUNTY_FUNDER_ADDRESS =
  "0xE6A443EE33A23A25cdF820f77F69B001cBAbA4E9" as Address;
export const BENEFICIARY_ADDRESS = "" as Address; // The account that gets back the excess tokens

export const COMPOUND_SLIPPAGE_BPS = 20; // Default slippage for compounding (0.2%)
export const MAX_COMPOUND_SLIPPAGE_BPS = 100; // Maximum slippage for compounding (1%)
export const SLIPPAGE_INCREMENT_PER_RETRY = 15; // Additional slippage per retry (0.1%)

// Configuration for the bot
export const MIN_EARNINGS_BGT = "0.3"; // Minimum earnings in BGT to be eligible for enso quote fetching
export const LOOP_INTERVAL = 30 * 1000;
export const RETRY_INTERVAL = 3 * 1000;
export const MAX_RETRIES = 3;
