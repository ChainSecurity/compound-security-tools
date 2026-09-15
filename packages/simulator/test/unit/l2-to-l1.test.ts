/**
 * Unit tests for L2→L1 message relay simulation
 *
 * Tests cover:
 * - OP-Stack (Base / Optimism / Mantle / Unichain): SentMessage event parsing and relay
 * - Arbitrum: L2ToL1Tx event parsing and relay
 * - Early-exit conditions (unsupported chain, null receipt, failed L2 tx, no relevant logs)
 * - Relay failure is captured as a failed result (not thrown)
 * - Multiple messages in one receipt produce independent relay results
 * - xDomainMsgSender storage slot is set correctly for OP-Stack
 * - L1 messenger address resolved dynamically via OTHER_MESSENGER()
 * - ETH value forwarded when L2ToL1Tx carries callvalue
 */

import { describe, it, expect, vi } from "vitest";
import { ethers, AbiCoder } from "ethers";
import { simulateL2ToL1Messages } from "../../src/core/l2-to-l1.js";
import type { Backend } from "../../src/backends/types.js";
import { nullLogger } from "../../src/core/types.js";

// vi.mock is hoisted before any const declarations, so values must be inlined here
vi.mock("../../src/config.js", () => ({
    loadConfig: () => ({
        chains: {
            mainnet: {
                chainId: 1,
                timelockAddress: "0x6d903f6003cca6255D85CcA4D3B5E5146dC33925",
                rpcUrl: "http://mock-rpc",
            },
        },
        defaults: { gas: "0xffffff", gasPrice: "0x0" },
    }),
    getSimulatorRpcUrl: () => undefined,
}));

// ─── Shared constants ───────────────────────────────────────────────────────

const MAINNET_TIMELOCK  = "0x6d903f6003cca6255D85CcA4D3B5E5146dC33925";
const OP_L2_MESSENGER   = "0x4200000000000000000000000000000000000007";
const ARB_SYS           = "0x0000000000000000000000000000000000000064";
const ARB_OUTBOX        = "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840";

// Canonical L1 messenger for Base (what OTHER_MESSENGER() returns on Base)
const BASE_L1_MESSENGER = "0x866E82a600A1414e583f7F13623F1aC5d58b0Afa";

// Representative L1 / L2 bridge addresses
const L1_STANDARD_BRIDGE = "0x3154Cf16ccdb4C6d922629664174b904d80F2C35";
const L2_STANDARD_BRIDGE = "0x4200000000000000000000000000000000000010";
const USDC_L1 = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Fake tx hashes used in mocks
const L2_TX_HASH   = "0x" + "cd".repeat(32);
const RELAY_TX_HASH = "0x" + "ab".repeat(32);

// Topic hashes for the two events we care about
const SENT_MESSAGE_TOPIC = ethers.id("SentMessage(address,address,bytes,uint256,uint256)");
const ARB_L2_TO_L1_TX_TOPIC = ethers.id(
    "L2ToL1Tx(address,address,uint64,uint64,uint256,uint256,uint256,uint256,bytes)"
);
const OTHER_MESSENGER_SELECTOR = ethers.id("OTHER_MESSENGER()").slice(0, 10);

const coder = AbiCoder.defaultAbiCoder();

// ─── Log builders ───────────────────────────────────────────────────────────

/**
 * Build a synthetic SentMessage log as emitted by OP-Stack L2CrossDomainMessenger.
 * Matches: SentMessage(address indexed target, address sender, bytes message,
 *                      uint256 messageNonce, uint256 gasLimit)
 */
function opSentMessageLog(target: string, sender: string, message: string) {
    return {
        address: OP_L2_MESSENGER,
        topics: [
            SENT_MESSAGE_TOPIC,
            ethers.zeroPadValue(target, 32), // indexed target
        ],
        data: coder.encode(
            ["address", "bytes", "uint256", "uint256"],
            [sender, message, 1n, 200_000n]  // sender, message, nonce, gasLimit
        ),
    };
}

/**
 * Build a synthetic L2ToL1Tx log as emitted by Arbitrum ArbSys.
 * Matches: L2ToL1Tx(address caller, address indexed destination,
 *                   uint64 indexed hash, uint64 indexed position,
 *                   uint256 arbBlockNum, uint256 ethBlockNum,
 *                   uint256 timestamp, uint256 callvalue, bytes data)
 */
function arbL2ToL1Log(
    destination: string,
    caller: string,
    calldata: string,
    callvalue = 0n,
) {
    return {
        address: ARB_SYS,
        topics: [
            ARB_L2_TO_L1_TX_TOPIC,
            ethers.zeroPadValue(destination, 32), // indexed destination
            ethers.zeroPadValue("0x01", 32),       // indexed hash (arbitrary)
            ethers.zeroPadValue("0x01", 32),       // indexed position (arbitrary)
        ],
        data: coder.encode(
            ["address", "uint256", "uint256", "uint256", "uint256", "bytes"],
            [caller, 100n, 200n, 1_000n, callvalue, calldata]
        ),
    };
}

// ─── Mock backend factory ───────────────────────────────────────────────────

interface MockBackendOptions {
    l2Receipt?: object | null;
    l1RelaySuccess?: boolean;
    /** Address returned by OTHER_MESSENGER() on the L2 messenger */
    l1MessengerAddress?: string;
}

function makeMockBackend(opts: MockBackendOptions = {}) {
    const l1MessengerAddress = opts.l1MessengerAddress ?? BASE_L1_MESSENGER;

    // L2 provider: serves the execution receipt and responds to OTHER_MESSENGER() eth_calls
    const l2Provider = {
        getTransactionReceipt: vi.fn().mockResolvedValue(opts.l2Receipt ?? null),
        waitForTransaction: vi.fn().mockResolvedValue(opts.l2Receipt ?? null),
        call: vi.fn().mockImplementation(async (tx: { data?: string }) => {
            if (tx.data?.startsWith(OTHER_MESSENGER_SELECTOR)) {
                return coder.encode(["address"], [l1MessengerAddress]);
            }
            return "0x";
        }),
    };

    // L1 provider: serves relay receipts and supports revert-reason lookup
    const l1Provider = {
        getTransactionReceipt: vi.fn(),
        waitForTransaction: vi.fn().mockResolvedValue({
            status: opts.l1RelaySuccess !== false ? 1 : 0,
            gasUsed: 50_000n,
        }),
        getTransaction: vi.fn().mockResolvedValue(null), // getRevertReason returns undefined
    };

    const setStorage    = vi.fn().mockResolvedValue(undefined);
    const impersonate   = vi.fn().mockResolvedValue(undefined);
    const sendTx        = vi.fn().mockResolvedValue(RELAY_TX_HASH);

    const backend: Partial<Backend> = {
        name: "tenderly",
        getProvider: vi.fn().mockImplementation((chain: string) =>
            chain === "mainnet" ? (l1Provider as unknown as ethers.JsonRpcProvider)
                                : (l2Provider as unknown as ethers.JsonRpcProvider)
        ),
        setStorageAt: setStorage,
        impersonateAccount: impersonate,
        sendTransaction: sendTx,
        stopImpersonating: vi.fn().mockResolvedValue(undefined),
        initialize: vi.fn(),
        cleanup: vi.fn(),
        mineBlock: vi.fn(),
        advanceTime: vi.fn(),
        simulateBundle: vi.fn(),
        snapshot: vi.fn(),
        revert: vi.fn(),
        supportsPersistentSnapshots: vi.fn().mockReturnValue(true),
    };

    return {
        backend: backend as Backend,
        spies: { setStorage, impersonate, sendTx },
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// Minimal calldata representing a finalizeERC20Withdrawal call
const WITHDRAW_MESSAGE = "0xa9f9e675" + coder
    .encode(
        ["address", "address", "address", "address", "uint256", "bytes"],
        [USDC_L1, "0x" + "02".repeat(20), "0x" + "03".repeat(20), "0x" + "04".repeat(20), 1_000n, "0x"],
    )
    .slice(2);

describe("simulateL2ToL1Messages", () => {

    // ── Early-exit conditions ─────────────────────────────────────────────────

    describe("early exits — no relay attempted", () => {
        it("returns [] for unsupported chain (scroll)", async () => {
            const { backend } = makeMockBackend({ l2Receipt: { status: 1, logs: [] } });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("scroll", L2_TX_HASH, ctx);

            expect(results).toEqual([]);
        });

        it("returns [] when receipt is null (tx not found)", async () => {
            const { backend } = makeMockBackend({ l2Receipt: null });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(results).toEqual([]);
        });

        it("returns [] when L2 execution reverted (status=0)", async () => {
            // Even if logs were somehow present, a failed L2 tx should be ignored
            const receipt = { status: 0, logs: [opSentMessageLog(L1_STANDARD_BRIDGE, L2_STANDARD_BRIDGE, WITHDRAW_MESSAGE)] };
            const { backend } = makeMockBackend({ l2Receipt: receipt });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(results).toEqual([]);
        });

        it("returns [] when receipt has no relevant logs (no SentMessage)", async () => {
            const receipt = {
                status: 1,
                logs: [{ address: "0x" + "ff".repeat(20), topics: ["0xdeadbeef"], data: "0x" }],
            };
            const { backend } = makeMockBackend({ l2Receipt: receipt });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(results).toEqual([]);
        });

        it("ignores SentMessage-shaped logs from addresses other than L2CrossDomainMessenger", async () => {
            const receipt = {
                status: 1,
                logs: [{
                    address: "0x" + "aa".repeat(20), // NOT the L2 messenger
                    topics: [SENT_MESSAGE_TOPIC, ethers.zeroPadValue(L1_STANDARD_BRIDGE, 32)],
                    data: coder.encode(["address", "bytes", "uint256", "uint256"], [L2_STANDARD_BRIDGE, "0x", 1n, 1n]),
                }],
            };
            const { backend } = makeMockBackend({ l2Receipt: receipt });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(results).toEqual([]);
        });

        it("ignores non-SentMessage logs emitted by L2CrossDomainMessenger", async () => {
            const receipt = {
                status: 1,
                logs: [{
                    address: OP_L2_MESSENGER,
                    topics: ["0x" + "dead".repeat(8)], // wrong topic
                    data: "0x",
                }],
            };
            const { backend } = makeMockBackend({ l2Receipt: receipt });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(results).toEqual([]);
        });
    });

    // ── OP-Stack relay ────────────────────────────────────────────────────────

    describe("OP-Stack relay (base)", () => {
        function makeOPReceipt(target = L1_STANDARD_BRIDGE, sender = L2_STANDARD_BRIDGE, msg = WITHDRAW_MESSAGE) {
            return { status: 1, logs: [opSentMessageLog(target, sender, msg)] };
        }

        it("calls relay on L1 with target and message extracted from SentMessage event", async () => {
            const { backend, spies } = makeMockBackend({ l2Receipt: makeOPReceipt() });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(spies.sendTx).toHaveBeenCalledOnce();
            expect(spies.sendTx).toHaveBeenCalledWith("mainnet", expect.objectContaining({
                to:   L1_STANDARD_BRIDGE,
                data: WITHDRAW_MESSAGE,
            }));
        });

        it("sets xDomainMsgSender on L1CrossDomainMessenger to the L2 sender from the event", async () => {
            const { backend, spies } = makeMockBackend({ l2Receipt: makeOPReceipt() });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(spies.setStorage).toHaveBeenCalledWith(
                "mainnet",
                BASE_L1_MESSENGER,
                "0x00000000000000000000000000000000000000000000000000000000000000cc",
                ethers.zeroPadValue(L2_STANDARD_BRIDGE, 32),
            );
        });

        it("impersonates the L1CrossDomainMessenger resolved via OTHER_MESSENGER()", async () => {
            const { backend, spies } = makeMockBackend({ l2Receipt: makeOPReceipt(), l1MessengerAddress: BASE_L1_MESSENGER });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(spies.impersonate).toHaveBeenCalledWith("mainnet", BASE_L1_MESSENGER);
        });

        it("the relay tx is sent from the L1 messenger address", async () => {
            // Use checksummed address — ethers.getAddress normalises what OTHER_MESSENGER() returns
            const customMessenger = ethers.getAddress("0x" + "cc".repeat(20));
            const { backend, spies } = makeMockBackend({ l2Receipt: makeOPReceipt(), l1MessengerAddress: customMessenger });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(spies.sendTx).toHaveBeenCalledWith("mainnet", expect.objectContaining({
                from: customMessenger,
            }));
        });

        it("returns one successful ChainExecutionResult per relayed message", async () => {
            const { backend } = makeMockBackend({ l2Receipt: makeOPReceipt() });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                chain: "base→mainnet",
                chainId: 1,
                success: true,
                timelockAddress: MAINNET_TIMELOCK,
                executions: [expect.objectContaining({
                    target:  L1_STANDARD_BRIDGE,
                    success: true,
                    txHash:  RELAY_TX_HASH,
                })],
            });
        });

        it("marks result as failed when relay tx reverts on L1", async () => {
            const { backend } = makeMockBackend({ l2Receipt: makeOPReceipt(), l1RelaySuccess: false });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                success: false,
                executions: [expect.objectContaining({ success: false, txHash: RELAY_TX_HASH })],
            });
        });

        it("handles two SentMessage logs in one receipt as two independent relay calls", async () => {
            const target1 = "0x" + "11".repeat(20);
            const target2 = "0x" + "22".repeat(20);
            const msg1 = "0xaaaa";
            const msg2 = "0xbbbb";
            const receipt = {
                status: 1,
                logs: [
                    opSentMessageLog(target1, L2_STANDARD_BRIDGE, msg1),
                    opSentMessageLog(target2, L2_STANDARD_BRIDGE, msg2),
                ],
            };
            const { backend, spies } = makeMockBackend({ l2Receipt: receipt });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(results).toHaveLength(2);
            expect(spies.sendTx).toHaveBeenCalledTimes(2);
            expect(spies.sendTx).toHaveBeenCalledWith("mainnet", expect.objectContaining({ to: target1, data: msg1 }));
            expect(spies.sendTx).toHaveBeenCalledWith("mainnet", expect.objectContaining({ to: target2, data: msg2 }));
        });

        it("result execution index matches order of messages in the receipt", async () => {
            const receipt = {
                status: 1,
                logs: [
                    opSentMessageLog("0x" + "11".repeat(20), L2_STANDARD_BRIDGE, "0xaa"),
                    opSentMessageLog("0x" + "22".repeat(20), L2_STANDARD_BRIDGE, "0xbb"),
                ],
            };
            const { backend } = makeMockBackend({ l2Receipt: receipt });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            expect(results[0]!.executions[0]!.index).toBe(0);
            expect(results[1]!.executions[0]!.index).toBe(1);
        });

        it("does not include value in the relay tx when message has no ETH attached", async () => {
            const { backend, spies } = makeMockBackend({ l2Receipt: makeOPReceipt() });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("base", L2_TX_HASH, ctx);

            const txArg = spies.sendTx.mock.calls[0]?.[1] as Record<string, unknown>;
            expect(txArg?.value).toBeUndefined();
        });

        it("works identically for optimism, mantle, and unichain (same OP-Stack logic)", async () => {
            for (const chain of ["optimism", "mantle", "unichain"]) {
                const receipt = { status: 1, logs: [opSentMessageLog(L1_STANDARD_BRIDGE, L2_STANDARD_BRIDGE, WITHDRAW_MESSAGE)] };
                const { backend, spies } = makeMockBackend({ l2Receipt: receipt });
                const ctx = { backend, logger: nullLogger };

                const results = await simulateL2ToL1Messages(chain, L2_TX_HASH, ctx);

                expect(results).toHaveLength(1);
                expect(results[0]!.chain).toBe(`${chain}→mainnet`);
                // All OP-Stack chains set the xDomainMsgSender storage slot
                expect(spies.setStorage).toHaveBeenCalled();
                // All OP-Stack chains use the address from OTHER_MESSENGER(), not a hardcoded one
                expect(spies.impersonate).toHaveBeenCalledWith("mainnet", BASE_L1_MESSENGER);
            }
        });
    });

    // ── Arbitrum relay ────────────────────────────────────────────────────────

    describe("Arbitrum relay", () => {
        // Checksummed: ethers normalises addresses extracted from ABI-decoded topics/data
        const L1_GATEWAY  = ethers.getAddress("0x" + "bb".repeat(20));
        const L2_GATEWAY  = ethers.getAddress("0x" + "cc".repeat(20));
        const FINALIZE_TX = "0x" + "cafe".repeat(16);

        function makeArbReceipt(destination = L1_GATEWAY, caller = L2_GATEWAY, data = FINALIZE_TX, value = 0n) {
            return { status: 1, logs: [arbL2ToL1Log(destination, caller, data, value)] };
        }

        it("calls relay on L1 from Outbox with destination and calldata from L2ToL1Tx event", async () => {
            const { backend, spies } = makeMockBackend({ l2Receipt: makeArbReceipt() });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("arbitrum", L2_TX_HASH, ctx);

            expect(spies.sendTx).toHaveBeenCalledOnce();
            expect(spies.sendTx).toHaveBeenCalledWith("mainnet", expect.objectContaining({
                from: ARB_OUTBOX,
                to:   L1_GATEWAY,
                data: FINALIZE_TX,
            }));
        });

        it("impersonates the canonical Arbitrum Outbox address", async () => {
            const { backend, spies } = makeMockBackend({ l2Receipt: makeArbReceipt() });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("arbitrum", L2_TX_HASH, ctx);

            expect(spies.impersonate).toHaveBeenCalledWith("mainnet", ARB_OUTBOX);
        });

        it("does NOT set any storage slot (no xDomainMsgSender mechanism in Arbitrum)", async () => {
            const { backend, spies } = makeMockBackend({ l2Receipt: makeArbReceipt() });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("arbitrum", L2_TX_HASH, ctx);

            expect(spies.setStorage).not.toHaveBeenCalled();
        });

        it("forwards ETH value when L2ToL1Tx carries callvalue", async () => {
            const ethValue = 500_000_000_000_000_000n; // 0.5 ETH
            const { backend, spies } = makeMockBackend({ l2Receipt: makeArbReceipt(L1_GATEWAY, L2_GATEWAY, "0x", ethValue) });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("arbitrum", L2_TX_HASH, ctx);

            expect(spies.sendTx).toHaveBeenCalledWith("mainnet", expect.objectContaining({
                value: "0x" + ethValue.toString(16),
            }));
        });

        it("omits value field when callvalue is 0", async () => {
            const { backend, spies } = makeMockBackend({ l2Receipt: makeArbReceipt() });
            const ctx = { backend, logger: nullLogger };

            await simulateL2ToL1Messages("arbitrum", L2_TX_HASH, ctx);

            const txArg = spies.sendTx.mock.calls[0]?.[1] as Record<string, unknown>;
            expect(txArg?.value).toBeUndefined();
        });

        it("returns correct result structure with chain 'arbitrum→mainnet'", async () => {
            const { backend } = makeMockBackend({ l2Receipt: makeArbReceipt() });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("arbitrum", L2_TX_HASH, ctx);

            expect(results).toHaveLength(1);
            expect(results[0]).toMatchObject({
                chain: "arbitrum→mainnet",
                chainId: 1,
                success: true,
                executions: [expect.objectContaining({ target: L1_GATEWAY, success: true })],
            });
        });

        it("captures relay failure as failed result", async () => {
            const { backend } = makeMockBackend({ l2Receipt: makeArbReceipt(), l1RelaySuccess: false });
            const ctx = { backend, logger: nullLogger };

            const results = await simulateL2ToL1Messages("arbitrum", L2_TX_HASH, ctx);

            expect(results[0]).toMatchObject({ success: false });
        });
    });
});
