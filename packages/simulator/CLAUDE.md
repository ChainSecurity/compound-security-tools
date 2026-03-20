# Compound Proposal Simulator

## Project Overview

A CLI tool for simulating Compound governance proposals. Supports two simulation backends:
- **Tenderly** (default): Cloud simulation using Tenderly virtual testnets - fast block advancement
- **Anvil**: Local simulation using Foundry's Anvil - works with any public RPC

Supports mainnet and L2 chains (Arbitrum, Scroll, Optimism, Base, Mantle, Linea, Unichain).

## Key Files

- `src/main.ts` - CLI entry point (thin wrapper around core)
- `src/simulator.ts` - Library entry point for programmatic use (thin wrapper around core)
- `src/core/` - Shared simulation logic used by both CLI and library
  - `types.ts` - Logger interface, SimulationContext
  - `constants.ts` - Bridge ABIs, message indices, tuple types
  - `proposals.ts` - Proposal fetching and parsing utilities
  - `snapshots.ts` - Snapshot management functions
  - `simulation.ts` - Core simulation logic (governance, L2, direct modes)
  - `index.ts` - Re-exports all core functionality
- `src/backends/` - Backend abstraction layer
  - `types.ts` - Backend interface definition
  - `tenderly.ts` - Tenderly virtual testnet implementation
  - `anvil.ts` - Local Anvil (Foundry) implementation
  - `index.ts` - Factory function and exports
- `src/logger.ts` - Structured logging utilities
- `src/printer.ts` - Pretty printing for simulation results
- `src/config.ts` - Configuration loader (reads from monorepo root `compound-config.json`)
- `src/abis.ts` - Smart contract ABIs (governor, receiver, timelock, bridges)
- `src/utils.ts` - Utility functions (zip)
- `src/format-address.ts` - Address formatting utilities
- `src/patches/patch-524.ts` - Proposal-specific patches (CCIP timestamp updates)
- `../../.snapshots/*.json` - Store EVM snapshot IDs per chain at monorepo root (shared with portal)

## Configuration Setup

**IMPORTANT**: `proposal.config.json` must be created from `proposal.config.json.example` before use.

```bash
cp proposal.config.json.example proposal.config.json
```

### Required Config Structure

```json
{
  "chains": {
    "mainnet": {
      "rpcUrl": "https://virtual.mainnet.eu.rpc.tenderly.co/YOUR-TESTNET-ID",
      "chainId": "1",
      "timelockAddress": "0x6d903f6003cca6255D85CcA4D3B5E5146dC33925",
      "governorAddress": "0x309a862bbC1A00e45506cB8A802D1ff10004c8C0"
    },
    "arbitrum": {
      "rpcUrl": "...",
      "chainId": "42161",
      "timelockAddress": "...",
      "bridge": "0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f",
      "receiver": "...",
      "l2msgsender": "..."
    }
    // Similar for: scroll, optimism, base, mantle
  },
  "defaults": {
    "gas": "0xffffff",
    "gasPrice": "0x0",
    "robinhood": "0x9AA835Bc7b8cE13B9B0C9764A52FbF71AC62cCF1",
    "COMP": "0xc00e94Cb662C3520282E6f5717214004A7f26888"
  }
}
```

### Required Fields

- **mainnet**: `rpcUrl`, `chainId`, `timelockAddress`, `governorAddress`
- **L2 chains**: All of the above plus `bridge`, `receiver`, `l2msgsender`
- **defaults**: `gas`, `gasPrice`, `robinhood` (COMP whale for voting), `COMP` (token address)

### Common Issues

1. **"virtual testnet not found"**: The Tenderly RPC URL is expired/invalid. Create new virtual testnets on Tenderly.
2. **"Cannot read properties of undefined (reading 'bridge')"**: Missing L2 chain config. Add all L2 chains even if you don't have valid RPC URLs for them.
3. **Config not loading in Next.js**: The simulator reads config at module init time. If config is missing, imports from `@compound-security/simulator` will fail.

## CLI Commands

```bash
# From monorepo root:
pnpm simulate <proposalId>                       # Simulate with Tenderly (default)
pnpm simulate <proposalId> --backend tenderly    # Simulate with Tenderly
pnpm simulate <0xcalldata>                       # Simulate from raw calldata
pnpm simulate <id> --direct                      # Direct execution (skip governance)
pnpm simulate <id> --direct --persist            # Direct execution with persistence
pnpm simulate snapshot [--chain <chain>]         # Create snapshot (Tenderly only)
pnpm simulate revert [--chain <chain>] [--snapshot <ref>] [--all]  # Revert (Tenderly only)
pnpm simulate list [--chain <chain>]             # List snapshots

# From packages/simulator:
pnpm simulate <args>
```

## Backend Selection

The simulator supports two backends, specified via `--backend`:

### Tenderly Backend (default)
- **Cloud simulation** using Tenderly virtual testnets
- **Uses `simulatorRpcUrl`** in config (Tenderly-specific URL)
- **Fast block advancement**: Can set block numbers directly, making governance simulation fast (~7s)
- **Persistent**: State persists across runs on virtual testnet
- **Requirements**: Tenderly account with virtual testnets configured

### Anvil Backend
- **Local simulation** using Foundry's Anvil
- **Forks from `rpcUrl`** in config (any public RPC works: LlamaNodes, Alchemy, Infura)
- **Spawns separate Anvil process** per chain (mainnet + any L2s)
- **Ephemeral**: State is lost when simulation ends
- **Slower block advancement**: Governance simulation takes ~2.5min due to mining ~20k blocks
- **Requirements**: Foundry must be installed (`curl -L https://foundry.paradigm.xyz | bash && foundryup`)

### Configuration for Each Backend

```json
{
  "chains": {
    "mainnet": {
      "rpcUrl": "https://eth.llamarpc.com",              // For Anvil forking
      "simulatorRpcUrl": "https://virtual.mainnet.eu.rpc.tenderly.co/...",  // For Tenderly
      ...
    }
  }
}
```

**Anvil users only need `rpcUrl`** - any public RPC endpoint works.

**Tenderly users need `simulatorRpcUrl`** - virtual testnet URLs from Tenderly dashboard.

## Simulation Modes

### Simulate Mode (default, no `--direct`)
1. Creates snapshot (checkpoint before any state changes)
2. Delegates COMP to robinhood address (300k COMP)
3. Advances blocks to make proposal active
4. Casts vote as robinhood
5. Advances blocks to end voting
6. Queues proposal via timelock
7. Advances time by GRACE_PERIOD
8. Executes proposal
9. Simulates L2 bridging if applicable

### Direct Mode (`--direct`)
- Skips governance flow, executes directly from timelock
- Useful for debugging individual transactions
- With `--persist`: Creates snapshot, then executes real transactions
- Without `--persist`: Uses bundle simulation (read-only)
  - Tenderly: `tenderly_simulateBundle`
  - Anvil: snapshot + execute + revert pattern

## Snapshot Behavior

- **All modes**: Exactly one mainnet snapshot is created at the start of simulation (before any state changes including delegation)
- **Direct + persist on L2**: Additional snapshots created inside `run_direct()` for each L2 chain
- **Direct without persist**: No additional snapshots (read-only simulation via bundle simulation)

**Note**: Anvil snapshots are ephemeral - they only work within a single simulation session. Use Tenderly backend for persistent snapshot/revert operations.

## Delegation

Delegation happens in BOTH modes because it's needed to check proposals not yet on-chain. The robinhood address is used to vote and execute proposals.

## L2 Bridging

When simulating mainnet proposals that target L2 bridges, the simulator:
1. Extracts bridged proposal calldata
2. Recursively calls `run_direct()` for each L2 chain
3. Executes on L2 timelock with proper msg.sender spoofing

## RPC Methods by Backend

### Tenderly
- `evm_snapshot` / `evm_revert` - State checkpointing
- `tenderly_simulateBundle` - Batch simulation (read-only)
- `tenderly_setStorageAt` - Storage manipulation
- `tenderly_mineBlock` - Block/time advancement
- `eth_sendTransaction` - Execute transactions

### Anvil
- `evm_snapshot` / `evm_revert` - State checkpointing
- `anvil_setStorageAt` - Storage manipulation
- `anvil_impersonateAccount` / `anvil_stopImpersonatingAccount` - Account impersonation
- `anvil_mine` - Mine multiple blocks
- `evm_setNextBlockTimestamp` + `evm_mine` - Time advancement
- `eth_sendTransaction` - Execute transactions (after impersonation)

### RPC Method Mapping

| Operation | Tenderly | Anvil |
|-----------|----------|-------|
| Set storage | `tenderly_setStorageAt` | `anvil_setStorageAt` |
| Mine block with params | `tenderly_mineBlock` | `evm_setNextBlockTimestamp` + `evm_mine` |
| Advance to block N | `tenderly_mineBlock({number})` | `anvil_mine(N - current, 0)` |
| Impersonate | (automatic) | `anvil_impersonateAccount` |
| Bundle simulate | `tenderly_simulateBundle` | snapshot + execute + revert |

## CCIP Handling

Updates Chainlink CCIP price registry timestamps before execution to avoid staleness reverts (specifically for Ronin chain selector in proposal 524).

## Lessons Learned

### Calldata Simulation

When simulating from raw calldata (not proposal ID), track the proposal ID separately:
- `args.proposalId` is undefined for calldata input
- Use `governor.getNextProposalId()` before sending the propose transaction
- Store in a separate variable (`proposalIdToSimulate`) for use in `simulate()` and `simulateBridging()`

### Voting Power Activation

Compound-style governors use snapshot-based voting power. The voting power is determined at the proposal's snapshot block, not the current block:

1. The delegation transaction must happen **before** the proposal's snapshot block
2. For governance mode with Anvil, the simulator automatically forks from a block before the snapshot
3. After delegation, we mine a block to activate the voting power
4. Without forking before the snapshot, votes won't count (`GovernorInsufficientVotingPower`)

### Virtual Testnet State (Tenderly)

Tenderly virtual testnets persist state across runs:
- If robinhood already has an active proposal, creating a new one fails
- Always revert to a clean snapshot before running calldata simulations
- Use `pnpm simulate revert --backend tenderly` to reset to the last snapshot

### Anvil State (Anvil)

Anvil processes are ephemeral:
- State is fresh on every simulation run (no cleanup needed)
- Snapshots work within a session but don't persist
- `revert`/`snapshot`/`list` commands warn about Anvil limitations

### Transaction Receipt Checking

`eth_sendTransaction` returns a transaction hash even if the transaction reverts:
- Always check `receipt.status` after `waitForTransaction()`
- Use `eth_call` to get the revert reason if status is 0

### Anvil Block Advancement Limitations

Anvil cannot fast-forward block numbers like Tenderly:
- `anvil_setNextBlockNumber` does not exist
- Must mine blocks one-by-one with `anvil_mine(count, interval)`
- Mining ~20k blocks for governance takes ~2.5min vs ~7s on Tenderly
- This is why Tenderly is the default backend for governance simulation

### Anvil Base Fee Configuration

**Problem**: Transactions fail with "max fee per gas less than block base fee" when forking mainnet.
**Solution**: Add `--block-base-fee-per-gas 0` to Anvil spawn args to allow zero gas price simulations.

### Proposal Re-submission for Voting Power

**Problem**: When simulating existing proposals, robinhood may have zero voting power at the proposal's snapshot block (delegation happened after snapshot).
**Solution**: Re-submit the proposal as a new one after delegation to get a fresh snapshot where robinhood has voting power. This approach:
- Works for both Tenderly and Anvil backends
- Simpler than trying to fork from a block before the snapshot
- Automatically triggered when `getVotes()` returns 0

### Anvil Process Cleanup

**Problem**: Lingering Anvil processes from previous runs cause stale state (e.g., snapshot ID 0x1 instead of 0x0).
**Solution**: Kill existing Anvil processes on startup with `pkill -9 anvil` before spawning new ones.

### Gas Limit Configuration

**Problem**: Anvil rejects transactions with "intrinsic gas too high" when config gas exceeds block gas limit.
**Solution**: Use reasonable gas values in config (e.g., `0x1C9C380` = 30M) rather than extremely high values. Don't modify block gas limit as this can cause other issues.

### Non-Existent Proposal Detection

**Problem**: When simulating a proposal that doesn't exist on the virtual testnet fork (e.g., fork is from before the proposal was created), `governor.proposalSnapshot(proposalId)` returns 0 (default mapping value) instead of throwing. If `getVotes(robinhood, 0)` returns non-zero (historical voting power at block 0), the simulator incorrectly proceeds without re-submitting, causing `GovernorNonexistentProposal` errors in `simulateBridging`.
**Solution**: Check if `snapshotBlock === 0n` to detect non-existent proposals. If true, treat it as needing re-submission regardless of voting power.
**Key insight**: Solidity mapping lookups return default values (0) for non-existent keys. Always validate that returned values indicate real data before using them.

### Core Module Architecture

**Problem**: `main.ts` (CLI) and `simulator.ts` (library) duplicated ~500 lines of simulation logic (~45% of each file), leading to divergence and maintenance burden.
**Solution**: Extract shared logic into a `core/` module with a `Logger` interface that abstracts output. CLI uses the real logger, library uses `nullLogger` (silent). All simulation functions take a `SimulationContext` containing the backend and logger.
**Key insight**: Use dependency injection (passing a context object) to share code between CLI and library entry points while allowing different behaviors (logging vs silent).

### L2 Bridging with Re-submitted Proposals

**Problem**: `simulateBridging` queried `governor.proposalDetails(proposalId)` after governance execution, causing `GovernorNonexistentProposal` errors when: (1) the proposal was re-submitted with a new ID (for voting power), (2) the fork block was before proposal creation, or (3) on-chain state changed after execution.
**Solution**: Changed `simulateBridging` to accept a `Proposal` object directly instead of a proposal ID, matching the pattern used by `runDirectWithL2`. The proposal object is available from the start of simulation.
**Key insight**: Avoid re-querying on-chain state after modifying it. Pass data objects through the call chain rather than re-fetching by ID.

### Duplicate Proposal Rejection on Resubmission

**Problem**: When simulating the same proposal multiple times on Tenderly (where state persists), the second simulation fails because the Governor rejects proposals with identical parameters (targets, values, calldatas, description hash).
**Solution**: Add a timestamp to the proposal description to make each resubmission unique:
```typescript
`Simulation of proposal ${proposalId} at ${Date.now()}`
```
**Key insight**: Compound Governor (and many Governor implementations) use the hash of proposal parameters to detect duplicates. Even with sequential proposal IDs, submitting identical parameters will be rejected. Always include a unique element (timestamp, nonce) in the description when resubmitting proposals.

## Logging

The CLI uses structured logging via `src/logger.ts` for consistent, professional output:

```typescript
import { log } from "./logger";

log.section("Governance Simulation");  // ═══ GOVERNANCE SIMULATION ═══════════
log.step("Casting vote");              //   → Casting vote
log.done("Vote cast successfully");    //   ✓ Vote cast successfully
log.info("Gas used", 45000);           //     Gas used: 45,000
log.tx("Execute", "0xabc...def");      //     Execute tx: 0xabc123...def456
log.warn("High gas consumption");      //   ⚠ High gas consumption
log.error("Transaction reverted");     //   ✗ Transaction reverted
```

Guidelines:
- Use `log.section()` for major phases (setup, chain execution)
- Use `log.step()` before async operations, `log.done()` after success
- Use `log.info()` for key-value data (numbers are auto-formatted with commas)
- Use `log.tx()` for transaction hashes (auto-truncated)
- Avoid raw `console.log()` in main.ts - use appropriate logger method
- The library entry point (`simulator.ts`) should remain quiet for programmatic use

## Monorepo Integration

This package follows the standard monorepo patterns:

- **Build**: Uses `tsup` with `packages: "external"` to bundle source while keeping dependencies external
- **Config loading**: Uses `import.meta.url` + `fs.readFileSync` for `compound-config.json` (at monorepo root) to ensure correct path resolution regardless of working directory
- **TypeScript**: Extends `../../tsconfig.base.json` with path aliases (`@/*` → `src/*`)
- **Docker**: Multi-stage Dockerfile using `turbo prune` for minimal image size; includes Foundry binaries (`anvil`, `cast`) for the Anvil backend option

## Library Usage

```typescript
import { simulateProposal } from "@compound-security/simulator";

// Simulate with Tenderly (default)
const result = await simulateProposal({
  proposalId: "528",
  mode: "governance",
  backend: "tenderly",
});

// Simulate with Anvil
const result = await simulateProposal({
  proposalId: "528",
  mode: "direct",
  backend: "anvil",
});

if (result.success) {
  console.log("Simulation passed!");
}
```

The library automatically:
- Creates and initializes the appropriate backend
- Spawns Anvil processes per chain (for Anvil backend)
- Cleans up resources on completion or error

## Core Module

The `src/core/` module contains shared simulation logic. Both `main.ts` and `simulator.ts` are thin wrappers.

### SimulationContext

All core functions receive a `SimulationContext`:

```typescript
interface SimulationContext {
    backend: Backend;
    logger: Logger;
}
```

CLI creates context with the real logger:
```typescript
const ctx: SimulationContext = { backend, logger: log };
```

Library creates context with silent logger:
```typescript
import { nullLogger } from "./core/types";
const ctx: SimulationContext = { backend, logger: nullLogger };
```

### Key Functions

- `setupDelegation(ctx)` - Delegate COMP to robinhood
- `simulateGovernance(proposalId, chain, ctx, proposal?)` - Full governance flow
- `simulateBridging(proposalId, ctx)` - Simulate L2 bridging
- `simulateL2(chain, calldata, ctx)` - Execute on L2 chain
- `runDirect(proposal, chain, persist, ctx)` - Direct timelock execution
- `runDirectWithL2(proposal, chain, persist, ctx)` - Direct with L2 bridging
