/**
 * Anvil Backend Implementation
 *
 * Uses local Anvil processes (from Foundry) for simulation:
 * - Spawns one Anvil process per chain with --fork-url
 * - Uses Anvil-specific RPC methods for state manipulation
 * - Implements bundle simulation via snapshot+execute+revert pattern
 */

import { ethers } from "ethers";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import type {
    Backend,
    BackendType,
    TransactionParams,
    BundleTransactionResult,
    MineBlockOptions,
    BackendInitOptions,
} from "./types";
import { getForkUrl } from "../config";
import { EIP7825_TX_GAS_CAP } from "../core/constants";

const BASE_PORT = 8545;
const STARTUP_TIMEOUT_MS = 30000;
const STARTUP_POLL_INTERVAL_MS = 100;
const MINE_CHUNK_SIZE = 2000;

/**
 * Chains on which we enforce the EIP-7825 per-transaction gas cap at the node level.
 *
 * EIP-7825 is an Ethereum rule. Arbitrum, Polygon and Mantle have their own gas models
 * with much higher per-transaction allowances, and the OP-stack chains only inherit it
 * as they adopt the hardfork - enforcing it there would manufacture false failures.
 */
const TX_GAS_CAP_CHAINS = new Set(["mainnet"]);

interface AnvilProcess {
    process: ChildProcess;
    port: number;
    provider: ethers.JsonRpcProvider;
    chain: string;
}

export class AnvilBackend implements Backend {
    readonly name: BackendType = "anvil";

    private processes: Map<string, AnvilProcess> = new Map();
    private impersonatedAccounts: Map<string, Set<string>> = new Map();
    private nextPort = BASE_PORT;
    private forkBlocks: Record<string, number> = {};

    async initialize(chains: string[], options?: BackendInitOptions): Promise<void> {
        this.forkBlocks = options?.forkBlocks ?? {};

        // Kill any existing Anvil processes on ports we'll use to avoid stale state
        this.killExistingAnvilProcesses(chains.length);

        for (const chain of chains) {
            await this.spawnAnvil(chain);
        }
    }

    private killExistingAnvilProcesses(_numChains: number): void {
        // Kill any existing Anvil processes to avoid stale state
        // This handles cases where previous simulations crashed or were killed
        try {
            // Use simple pattern matching - kill any process with 'anvil' in command line
            execSync('pkill -9 anvil 2>/dev/null || true', { stdio: 'ignore' });
        } catch {
            // Ignore errors - no anvil processes running
        }
    }

    async cleanup(): Promise<void> {
        const cleanupPromises: Promise<void>[] = [];

        for (const [chain, anvilProcess] of this.processes) {
            cleanupPromises.push(this.stopAnvil(chain, anvilProcess));
        }

        await Promise.all(cleanupPromises);
        this.processes.clear();
        this.impersonatedAccounts.clear();
        this.nextPort = BASE_PORT;
    }

    private async stopAnvil(chain: string, anvilProcess: AnvilProcess): Promise<void> {
        return new Promise((resolve) => {
            if (anvilProcess.process.killed) {
                resolve();
                return;
            }

            anvilProcess.process.on("exit", () => resolve());
            anvilProcess.process.on("error", () => resolve());

            // Try graceful shutdown first
            anvilProcess.process.kill("SIGTERM");

            // Force kill after timeout
            setTimeout(() => {
                if (!anvilProcess.process.killed) {
                    anvilProcess.process.kill("SIGKILL");
                }
                resolve();
            }, 5000);
        });
    }

    private async spawnAnvil(chain: string): Promise<void> {
        const forkUrl = getForkUrl(chain);
        if (!forkUrl) {
            throw new Error(`No rpcUrl configured for chain: ${chain}`);
        }

        const port = this.nextPort++;
        const rpcUrl = `http://127.0.0.1:${port}`;

        const args = [
            "--fork-url", forkUrl,
            "--port", port.toString(),
            "--no-mining", // We control mining explicitly
            "--silent", // Reduce noise
            "--block-base-fee-per-gas", "0", // Allow zero gas price for simulations
            "--disable-block-gas-limit", // defaults.gas is deliberately huge (Tenderly-style); don't cap it
        ];

        // Enforce the EIP-7825 per-transaction gas cap on mainnet, so a proposal that
        // cannot be executed in a single mainnet transaction fails here too. Anvil only
        // applies the check when explicitly enabled.
        if (TX_GAS_CAP_CHAINS.has(chain)) {
            args.push("--hardfork", "osaka");
            args.push("--enable-tx-gas-limit");
        }

        // Add fork block if specified (allows forking from historical state)
        const forkBlock = this.forkBlocks[chain];
        if (forkBlock) {
            args.push("--fork-block-number", forkBlock.toString());
        }

        const anvilProcess = spawn("anvil", args, {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
        });

        // Capture stderr for debugging
        let stderrOutput = "";
        anvilProcess.stderr?.on("data", (data) => {
            stderrOutput += data.toString();
        });

        anvilProcess.on("error", (err) => {
            throw new Error(`Failed to spawn Anvil for ${chain}: ${err.message}`);
        });

        // Wait for Anvil to be ready
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        await this.waitForAnvil(provider, chain, stderrOutput);

        this.processes.set(chain, {
            process: anvilProcess,
            port,
            provider,
            chain,
        });

        this.impersonatedAccounts.set(chain, new Set());
    }

    private async waitForAnvil(provider: ethers.JsonRpcProvider, chain: string, stderrOutput: string): Promise<void> {
        const startTime = Date.now();

        while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
            try {
                await provider.getBlockNumber();
                return; // Anvil is ready
            } catch {
                await new Promise(resolve => setTimeout(resolve, STARTUP_POLL_INTERVAL_MS));
            }
        }

        throw new Error(`Anvil for ${chain} failed to start within ${STARTUP_TIMEOUT_MS}ms. Stderr: ${stderrOutput}`);
    }

    getProvider(chain: string): ethers.JsonRpcProvider {
        const anvilProcess = this.processes.get(chain);
        if (!anvilProcess) {
            throw new Error(`Chain not initialized: ${chain}`);
        }
        return anvilProcess.provider;
    }

    async setStorageAt(chain: string, address: string, slot: string, value: string): Promise<void> {
        const provider = this.getProvider(chain);
        await provider.send("anvil_setStorageAt", [address, slot, value]);
    }

    async mineBlock(chain: string, options?: MineBlockOptions): Promise<void> {
        const provider = this.getProvider(chain);

        if (options?.timestamp) {
            // Set the timestamp for the next block
            await provider.send("evm_setNextBlockTimestamp", [options.timestamp]);
        }

        if (options?.blockNumber) {
            // Anvil doesn't have direct block number setting in tenderly_mineBlock style
            // We need to mine until we reach the target block
            const currentBlock = await provider.getBlockNumber();
            const blocksToMine = options.blockNumber - currentBlock;
            if (blocksToMine > 0) {
                // anvil_mine(numBlocks, interval) - interval 0 means same timestamp for all blocks.
                // Mine in chunks: a single ~20k-block call exceeds the JSON-RPC request timeout.
                let remaining = blocksToMine;
                while (remaining > 0) {
                    const chunk = Math.min(remaining, MINE_CHUNK_SIZE);
                    await provider.send("anvil_mine", [chunk, 0]);
                    remaining -= chunk;
                }
                return;
            }
        }

        // Mine a single block
        await provider.send("evm_mine", []);
    }

    async advanceTime(chain: string, seconds: number): Promise<void> {
        const provider = this.getProvider(chain);
        const currentBlock = await provider.getBlock("latest");
        if (!currentBlock) {
            throw new Error("Failed to get current block");
        }
        const newTimestamp = currentBlock.timestamp + seconds;
        await provider.send("evm_setNextBlockTimestamp", [newTimestamp]);
        await provider.send("evm_mine", []);
    }

    async impersonateAccount(chain: string, address: string): Promise<void> {
        const provider = this.getProvider(chain);
        const accounts = this.impersonatedAccounts.get(chain);

        const normalizedAddress = address.toLowerCase();
        if (accounts && !accounts.has(normalizedAddress)) {
            await provider.send("anvil_impersonateAccount", [address]);
            accounts.add(normalizedAddress);
        }
    }

    async stopImpersonating(chain: string, address: string): Promise<void> {
        const provider = this.getProvider(chain);
        const accounts = this.impersonatedAccounts.get(chain);

        const normalizedAddress = address.toLowerCase();
        if (accounts && accounts.has(normalizedAddress)) {
            await provider.send("anvil_stopImpersonatingAccount", [address]);
            accounts.delete(normalizedAddress);
        }
    }

    /**
     * Clamp a requested gas limit to the EIP-7825 cap on chains where it is enforced.
     *
     * Callers pass `defaults.gas` (deliberately huge, Tenderly-style) for most
     * transactions. With `--enable-tx-gas-limit` the node rejects those outright, so
     * clamp to the largest limit mainnet would accept. This is faithful rather than
     * permissive: the cap IS the maximum a real sender could supply, and a transaction
     * that then runs out of gas is genuinely unexecutable on mainnet.
     */
    private capGasLimit(chain: string, gas: string | undefined): string | undefined {
        if (gas === undefined || !TX_GAS_CAP_CHAINS.has(chain)) return gas;
        return BigInt(gas) > BigInt(EIP7825_TX_GAS_CAP)
            ? "0x" + EIP7825_TX_GAS_CAP.toString(16)
            : gas;
    }

    async simulateBundle(chain: string, transactions: TransactionParams[]): Promise<BundleTransactionResult[]> {
        const provider = this.getProvider(chain);

        // Take a snapshot before executing
        const snapshotId = await this.snapshot(chain);

        const results: BundleTransactionResult[] = [];

        try {
            for (const tx of transactions) {
                // Impersonate the sender
                await this.impersonateAccount(chain, tx.from);

                try {
                    // Send the transaction
                    const txHash = await provider.send("eth_sendTransaction", [{
                        from: tx.from,
                        to: tx.to,
                        gas: this.capGasLimit(chain, tx.gas),
                        gasPrice: tx.gasPrice,
                        value: tx.value ?? "0x0",
                        data: tx.data,
                    }]);

                    // Mine the transaction
                    await provider.send("evm_mine", []);

                    // Get receipt
                    const receipt = await provider.getTransactionReceipt(txHash);
                    const success = receipt?.status === 1;

                    results.push({
                        success,
                        gasUsed: receipt?.gasUsed,
                        txHash,
                        revertReason: success ? undefined : "Transaction reverted",
                    });
                } catch (error) {
                    // Transaction failed to send or execute
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    results.push({
                        success: false,
                        revertReason: errorMessage,
                    });
                }
            }
        } finally {
            // Revert to snapshot to maintain read-only semantics
            await this.revert(chain, snapshotId);
        }

        return results;
    }

    async snapshot(chain: string): Promise<string> {
        const provider = this.getProvider(chain);
        return await provider.send("evm_snapshot", []);
    }

    async revert(chain: string, snapshotId: string): Promise<boolean> {
        const provider = this.getProvider(chain);
        return await provider.send("evm_revert", [snapshotId]);
    }

    supportsPersistentSnapshots(): boolean {
        return false; // Anvil is ephemeral
    }

    async sendTransaction(chain: string, tx: TransactionParams): Promise<string> {
        const provider = this.getProvider(chain);

        // Ensure account is impersonated
        await this.impersonateAccount(chain, tx.from);

        const txHash = await provider.send("eth_sendTransaction", [{
            from: tx.from,
            to: tx.to,
            gas: this.capGasLimit(chain, tx.gas),
            gasPrice: tx.gasPrice,
            value: tx.value ?? "0x0",
            data: tx.data,
        }]);

        // Mine the transaction
        await provider.send("evm_mine", []);

        return txHash;
    }
}
