# Changelog

# Version 1.0.2 - Latest

## Performance Optimizations

### RPC Call Batching
- **Multicall Optimization**: Reduced RPC calls from N to 1 for fetching bault data across all baults
- **Batch Wrapper Previews**: Consolidated wrapper preview calls into a single multicall, eliminating per-bault RPC overhead
- **RPC Stats Tracking**: Added logging to monitor multicall vs non-multicall request counts

# Version 1.0.1 - 24th June 2025
https://github.com/Kodiak-Finance/bault-compoundor/releases/tag/v1.0.1

## New Features

### Updates BGT Compounding Strategy to allow claiming BERA
- **BERA Token Support**: Now claims BGT and burns for BERA, when it provides better compounding value than paying mint tax compared to BGT derivates' premium.

### Allows Filtering and Targeting of Baults to Compound
- **Bault Address Filtering**: 
  - `RESTRICT_BAULTS` configuration to limit compounding to specific bault addresses
  - `ONLY_BAULT_ADDRESSES` array of Baults allowed
- **Staking Token Filtering**:
  - `RESTRICT_STAKING_TOKENS` configuration to filter by underlying asset addresses (Staking token) 
  - `ONLY_STAKING_TOKEN_ADDRESSES` array of stakingToken addresses to allow


## Configuration Changes

### Updated Contract Addresses
- **Bounty Helper**: Updated to `0xE903feC95ACf0590854db206F0EE24992b50c79a`
- **Bounty Funder**: Updated to `0x39bEBd199136f9f508f8a6b19FC832e5a0CE3fc2`
- **WBERA Integration**: Added wrapped BERA token support to claim when it returns the best value compared to LSTs
- **Added fields**
    - RESTRICT_BAULTS
    - ONLY_BAULT_ADDRESSES
    - RESTRICT_STAKING_TOKENS
    - ONLY_STAKING_TOKEN_ADDRESSES,
- **Additonal fiels added to env**
    - Loop_Interval
    - Retry_Interval
    - MAX_RETRIES

## Performance Optimizations

### Reduction on Enso/Router API Dependencies for finding best wrapper and checking for profitability

- **Subgraph-First Approach**: 
  - Implemented subgraph-based(Kodiak v3) price fetch for BGT Wrappers, Bera and staking tokens(bounty)
  - Implements profitability check approximation on Subgraph as an intermediate state.
  - Now queries Enso when subgraph indicates compound readiness

### Improved Transaction Management
- **Transaction Failure Reduction**: Added nonce check usign RPC to check for pending transactions before creating new ones.
