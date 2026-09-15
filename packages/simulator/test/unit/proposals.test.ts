import { describe, it, expect, vi } from "vitest";
import { AbiCoder, FunctionFragment, Interface, getAddress, id } from "ethers";

/**
 * Bridge addresses used in the mocked config — must be inlined here because
 * vi.mock() is hoisted before any variable declarations.
 */
vi.mock("../../src/config.js", () => ({
    loadConfig: () => ({
        chains: {
            mainnet: {
                chainId: 1,
                governorAddress: "0x309a862bbC1A00e45506cB8A802D1ff10004c8C0",
                timelockAddress: "0x6d903f6003cca6255D85CcA4D3B5E5146dC33925",
            },
            scroll:   { bridge: "0x1111111111111111111111111111111111111111" },
            arbitrum: { bridge: "0x2222222222222222222222222222222222222222" },
            optimism: { bridge: "0x3333333333333333333333333333333333333333" },
            base:     { bridge: "0x4444444444444444444444444444444444444444" },
            mantle:   { bridge: "0x5555555555555555555555555555555555555555" },
            linea:    { bridge: "0x6666666666666666666666666666666666666666" },
            unichain: { bridge: "0x7777777777777777777777777777777777777777" },
            polygon:  { bridge: "0x8888888888888888888888888888888888888888" },
        },
        defaults: {
            gas: "0xffffff",
            gasPrice: "0x0",
            robinhood: "0x9AA835Bc7b8cE13B9B0C9764A52FbF71AC62cCF1",
            COMP: "0xc00e94Cb662C3520282E6f5717214004A7f26888",
        },
    }),
}));

// Must be imported after mock registration
import {
    selectorOfSig,
    isCCIPTarget,
    ccipTargetToL2Chain,
    extractCCIPBridgedProposal,
    extractBridgedProposal,
    detectL2Chains,
    targetToL2Chain,
    parseProposalCalldata,
} from "../../src/core/proposals.js";
import { bridgeABIs, messageIndex, CCIP_ROUTER, CCIP_CHAIN_SELECTORS } from "../../src/core/constants.js";
import { governorABI } from "../../src/abis.js";

// ── Config addresses (must match the inline values in vi.mock above) ────────
const SCROLL_BRIDGE   = "0x1111111111111111111111111111111111111111";
const ARBITRUM_BRIDGE = "0x2222222222222222222222222222222222222222";
const OPTIMISM_BRIDGE = "0x3333333333333333333333333333333333333333";
const BASE_BRIDGE     = "0x4444444444444444444444444444444444444444";
const MANTLE_BRIDGE   = "0x5555555555555555555555555555555555555555";
const LINEA_BRIDGE    = "0x6666666666666666666666666666666666666666";
const UNICHAIN_BRIDGE = "0x7777777777777777777777777777777777777777";
const POLYGON_BRIDGE  = "0x8888888888888888888888888888888888888888";

// ── Fixture helpers ──────────────────────────────────────────────────────────

const coder = AbiCoder.defaultAbiCoder();

/** Encode a proposal as bytes the way L1 bridges expect: (address[], uint256[], string[], bytes[]) */
function encodeProposalMsg(
    targets: string[],
    values: bigint[],
    signatures: string[],
    rawCalldatas: string[],
): string {
    return coder.encode(["address[]", "uint256[]", "string[]", "bytes[]"], [
        targets, values, signatures, rawCalldatas,
    ]);
}

/**
 * Build valid bridge calldata for a given chain using minimal function signatures
 * that match the actual bridge ABIs so the selectors are identical.
 */
const BRIDGE_FUNS: Record<string, string> = {
    scroll:   "function sendMessage(address _to, uint256 _value, bytes _message, uint256 _gasLimit)",
    optimism: "function sendMessage(address _target, bytes _message, uint32 _minGasLimit)",
    base:     "function sendMessage(address _target, bytes _message, uint32 _minGasLimit)",
    mantle:   "function sendMessage(address _target, bytes _message, uint32 _minGasLimit)",
    unichain: "function sendMessage(address _target, bytes _message, uint32 _minGasLimit)",
    linea:    "function sendMessage(address _to, uint256 _fee, bytes _calldata)",
    arbitrum: "function createRetryableTicket(address to, uint256 l2CallValue, uint256 maxSubmissionCost, address excessFeeRefundAddress, address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, bytes data)",
    polygon:  "function sendMessageToChild(address _receiver, bytes _data)",
};

function buildBridgeCalldata(chain: string, messagePayload: string): string {
    const iface = new Interface([BRIDGE_FUNS[chain]!]);
    const fn = iface.fragments[0] as FunctionFragment;
    const msgIdx = messageIndex[chain]!;
    const args = fn.inputs.map((input, i) => {
        if (i === msgIdx) return messagePayload;
        if (input.type === "address") return "0x" + "00".repeat(20);
        if (input.type === "bytes") return "0x";
        return 0n; // uint*, bool, etc.
    });
    return iface.encodeFunctionData(fn.name, args);
}

/** Build a valid propose() calldata using the actual governor ABI */
function buildProposeCalldata(
    targets: string[],
    values: bigint[],
    calldatas: string[],
    description = "Test proposal",
): string {
    const iface = new Interface(governorABI as unknown[]);
    return iface.encodeFunctionData("propose", [targets, values, calldatas, description]);
}

// CCIP helpers
const CCIP_IFACE = new Interface([
    "function ccipSend(uint64 destinationChainSelector, tuple(bytes receiver, bytes data, tuple(address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) external payable returns (bytes32)",
]);
const RONIN_CHAIN_SELECTOR = Object.keys(CCIP_CHAIN_SELECTORS).find(
    k => CCIP_CHAIN_SELECTORS[k] === "ronin",
)!;

function buildCCIPCalldata(chainSelector: string, msgData: string): string {
    return CCIP_IFACE.encodeFunctionData("ccipSend", [
        BigInt(chainSelector),
        {
            receiver: "0x" + "aa".repeat(20),
            data: msgData,
            tokenAmounts: [],
            feeToken: "0x" + "00".repeat(20),
            extraArgs: "0x",
        },
    ]);
}

// ── selectorOfSig ────────────────────────────────────────────────────────────

describe("selectorOfSig", () => {
    it("returns the correct 4-byte selector for a known signature", () => {
        // keccak256("transfer(address,uint256)") first 4 bytes = 0xa9059cbb
        expect(selectorOfSig("transfer(address,uint256)")).toBe("0xa9059cbb");
    });

    it("returns a 10-char hex string (0x + 8 nibbles)", () => {
        const sel = selectorOfSig("execute()");
        expect(sel).toMatch(/^0x[0-9a-f]{8}$/);
    });

    it("is case-sensitive — different case gives a different selector", () => {
        expect(selectorOfSig("Transfer(address,uint256)")).not.toBe(
            selectorOfSig("transfer(address,uint256)"),
        );
    });

    it("handles an empty string without throwing", () => {
        // keccak256("") is well-defined; we just check it produces a valid selector
        const sel = selectorOfSig("");
        expect(sel).toMatch(/^0x[0-9a-f]{8}$/);
    });

    it("is consistent with ethers id()", () => {
        const sig = "approve(address,uint256)";
        expect(selectorOfSig(sig)).toBe(id(sig).slice(0, 10));
    });
});

// ── isCCIPTarget ─────────────────────────────────────────────────────────────

describe("isCCIPTarget", () => {
    it("returns true for the exact CCIP router address", () => {
        expect(isCCIPTarget(CCIP_ROUTER)).toBe(true);
    });

    it("is case-insensitive (lowercased input)", () => {
        expect(isCCIPTarget(CCIP_ROUTER.toLowerCase())).toBe(true);
    });

    it("is case-insensitive (uppercased input)", () => {
        expect(isCCIPTarget(CCIP_ROUTER.toUpperCase())).toBe(true);
    });

    it("returns false for a different address", () => {
        expect(isCCIPTarget("0x" + "00".repeat(20))).toBe(false);
    });

    it("returns false for an address that shares only a prefix", () => {
        const truncated = CCIP_ROUTER.slice(0, -2) + "00";
        expect(isCCIPTarget(truncated)).toBe(false);
    });

    it("returns false for an empty string", () => {
        expect(isCCIPTarget("")).toBe(false);
    });
});

// ── ccipTargetToL2Chain ──────────────────────────────────────────────────────

describe("ccipTargetToL2Chain", () => {
    it("returns 'ronin' for the Ronin chain selector", () => {
        const calldata = buildCCIPCalldata(RONIN_CHAIN_SELECTOR, "0x1234");
        expect(ccipTargetToL2Chain(calldata)).toBe("ronin");
    });

    it("returns undefined for an unknown chain selector", () => {
        const calldata = buildCCIPCalldata("9999999999999999999", "0x");
        expect(ccipTargetToL2Chain(calldata)).toBeUndefined();
    });

    it("returns undefined for completely malformed calldata", () => {
        expect(ccipTargetToL2Chain("0xdeadbeef")).toBeUndefined();
    });

    it("returns undefined for empty calldata", () => {
        expect(ccipTargetToL2Chain("0x")).toBeUndefined();
    });

    it("returns undefined for a non-ccipSend function selector", () => {
        // Valid ABI-encoded data but wrong function selector
        const wrongIface = new Interface(["function transfer(address to, uint256 amount)"]);
        const calldata = wrongIface.encodeFunctionData("transfer", [
            "0x" + "aa".repeat(20),
            1000n,
        ]);
        expect(ccipTargetToL2Chain(calldata)).toBeUndefined();
    });
});

// ── extractCCIPBridgedProposal ───────────────────────────────────────────────

describe("extractCCIPBridgedProposal", () => {
    it("extracts targets, values, and calldatas from valid CCIP calldata", () => {
        // getAddress gives the checksummed form — ethers checksums on ABI decode
        const TARGET = getAddress("0x" + "ab".repeat(20));
        const SIG = "transfer(address,uint256)";
        const RAW_CD = coder.encode(["address", "uint256"], [
            "0x" + "cc".repeat(20), 1000n,
        ]);
        const msgData = encodeProposalMsg([TARGET], [0n], [SIG], [RAW_CD]);
        const calldata = buildCCIPCalldata(RONIN_CHAIN_SELECTOR, msgData);

        const proposal = extractCCIPBridgedProposal(calldata);

        expect(proposal.targets).toEqual([TARGET]);
        expect(proposal.values).toEqual([0n]);
        // calldata is reconstructed as selector + rawCalldata (no leading 0x from rawCalldata)
        expect(proposal.calldatas[0]).toBe(selectorOfSig(SIG) + RAW_CD.slice(2));
    });

    it("handles proposals with multiple actions", () => {
        const targets = [
            "0x" + "11".repeat(20),
            "0x" + "22".repeat(20),
        ];
        const values = [0n, 500n];
        const sigs = ["doA()", "doB(uint256)"];
        const cds = ["0x", coder.encode(["uint256"], [42n])];
        const msgData = encodeProposalMsg(targets, values, sigs, cds);
        const calldata = buildCCIPCalldata(RONIN_CHAIN_SELECTOR, msgData);

        const proposal = extractCCIPBridgedProposal(calldata);

        expect(proposal.targets).toHaveLength(2);
        expect(proposal.values[1]).toBe(500n);
    });

    it("throws on completely malformed calldata", () => {
        expect(() => extractCCIPBridgedProposal("0xdeadbeef")).toThrow();
    });

    it("throws when calldata is empty", () => {
        expect(() => extractCCIPBridgedProposal("0x")).toThrow();
    });

    it("throws when message.data is not ABI-encoded proposal tuple", () => {
        // ccipSend with garbage data field
        const calldata = buildCCIPCalldata(RONIN_CHAIN_SELECTOR, "0x1234567890");
        expect(() => extractCCIPBridgedProposal(calldata)).toThrow();
    });
});

// ── extractBridgedProposal ───────────────────────────────────────────────────

describe("extractBridgedProposal", () => {
    const CHAINS_WITH_KNOWN_FUNS = ["scroll", "optimism", "base", "mantle", "unichain", "linea", "arbitrum", "polygon"];

    for (const chain of CHAINS_WITH_KNOWN_FUNS) {
        it(`extracts proposal from ${chain} bridge calldata`, () => {
            // getAddress gives checksummed form — ethers checksums on ABI decode
            const TARGET = getAddress("0x" + "ab".repeat(20));
            const SIG = "execute(uint256)";
            const RAW_CD = coder.encode(["uint256"], [7n]);
            const msgPayload = encodeProposalMsg([TARGET], [0n], [SIG], [RAW_CD]);
            const calldata = buildBridgeCalldata(chain, msgPayload);

            const proposal = extractBridgedProposal(calldata, chain);

            expect(proposal.targets).toEqual([TARGET]);
            expect(proposal.values).toEqual([0n]);
            expect(proposal.calldatas[0]).toBe(selectorOfSig(SIG) + RAW_CD.slice(2));
        });
    }

    it("throws for an unknown chain", () => {
        expect(() => extractBridgedProposal("0x1234", "unknown-chain")).toThrow(/Missing ABI/);
    });

    it("throws for a chain with no messageIndex entry", () => {
        // 'polygon' has ABI but no messageIndex — verify it throws cleanly
        // Actually polygon does have messageIndex so let's use a truly unknown chain
        expect(() => extractBridgedProposal("0x", "nonexistent")).toThrow();
    });

    it("throws when calldata is not a valid bridge function call", () => {
        // Encode something that has a valid selector but is not a real bridge call
        const wrongIface = new Interface(["function foo()"]);
        const calldata = wrongIface.encodeFunctionData("foo", []);
        expect(() => extractBridgedProposal(calldata, "optimism")).toThrow();
    });
});

// ── targetToL2Chain ──────────────────────────────────────────────────────────

describe("targetToL2Chain", () => {
    const BRIDGE_MAP: [string, string][] = [
        [SCROLL_BRIDGE,   "scroll"],
        [ARBITRUM_BRIDGE, "arbitrum"],
        [OPTIMISM_BRIDGE, "optimism"],
        [BASE_BRIDGE,     "base"],
        [MANTLE_BRIDGE,   "mantle"],
        [LINEA_BRIDGE,    "linea"],
        [UNICHAIN_BRIDGE, "unichain"],
        [POLYGON_BRIDGE,  "polygon"],
    ];

    for (const [bridge, chain] of BRIDGE_MAP) {
        it(`maps ${chain} bridge address to "${chain}"`, () => {
            expect(targetToL2Chain(bridge)).toBe(chain);
        });
    }

    it("returns undefined for an unknown address", () => {
        expect(targetToL2Chain("0x" + "00".repeat(20))).toBeUndefined();
    });

    it("returns undefined for the zero address", () => {
        expect(targetToL2Chain("0x0000000000000000000000000000000000000000")).toBeUndefined();
    });

    it("is case-sensitive — mismatched case returns undefined", () => {
        // The config stores addresses as-is; comparison uses ===
        expect(targetToL2Chain(OPTIMISM_BRIDGE.toUpperCase())).toBeUndefined();
    });
});

// ── detectL2Chains ───────────────────────────────────────────────────────────

describe("detectL2Chains", () => {
    it("returns empty array for an empty proposal", () => {
        expect(detectL2Chains({ targets: [], values: [], calldatas: [] })).toEqual([]);
    });

    it("returns empty array when no bridge targets are present", () => {
        expect(detectL2Chains({
            targets: ["0x" + "dd".repeat(20)],
            values: [0n],
            calldatas: ["0x"],
        })).toEqual([]);
    });

    it("detects a single L2 bridge", () => {
        const chains = detectL2Chains({
            targets: [OPTIMISM_BRIDGE],
            values: [0n],
            calldatas: ["0x"],
        });
        expect(chains).toEqual(["optimism"]);
    });

    it("detects multiple different L2 bridges", () => {
        const chains = detectL2Chains({
            targets: [OPTIMISM_BRIDGE, BASE_BRIDGE, ARBITRUM_BRIDGE],
            values: [0n, 0n, 0n],
            calldatas: ["0x", "0x", "0x"],
        });
        expect(chains).toContain("optimism");
        expect(chains).toContain("base");
        expect(chains).toContain("arbitrum");
        expect(chains).toHaveLength(3);
    });

    it("deduplicates when the same bridge is called twice", () => {
        const chains = detectL2Chains({
            targets: [OPTIMISM_BRIDGE, OPTIMISM_BRIDGE],
            values: [0n, 0n],
            calldatas: ["0x", "0x"],
        });
        expect(chains).toEqual(["optimism"]);
    });

    it("detects a CCIP target as a chain when selector is known", () => {
        const ccipCalldata = buildCCIPCalldata(RONIN_CHAIN_SELECTOR, "0x");
        const chains = detectL2Chains({
            targets: [CCIP_ROUTER],
            values: [0n],
            calldatas: [ccipCalldata],
        });
        expect(chains).toEqual(["ronin"]);
    });

    it("ignores a CCIP call with an unknown chain selector", () => {
        const ccipCalldata = buildCCIPCalldata("9999999999999999999", "0x");
        const chains = detectL2Chains({
            targets: [CCIP_ROUTER],
            values: [0n],
            calldatas: [ccipCalldata],
        });
        expect(chains).toEqual([]);
    });

    it("handles mixed bridge and non-bridge targets", () => {
        const nonBridge = "0x" + "ff".repeat(20);
        const chains = detectL2Chains({
            targets: [nonBridge, BASE_BRIDGE, nonBridge],
            values: [0n, 0n, 0n],
            calldatas: ["0x", "0x", "0x"],
        });
        expect(chains).toEqual(["base"]);
    });
});

// ── parseProposalCalldata ────────────────────────────────────────────────────

describe("parseProposalCalldata", () => {
    it("parses a valid propose() calldata", () => {
        const targets = ["0x" + "11".repeat(20)];
        const values = [0n];
        const calldatas = ["0xdeadbeef"];
        const calldata = buildProposeCalldata(targets, values, calldatas, "My proposal");

        const parsed = parseProposalCalldata(calldata);

        expect(parsed.targets).toEqual(targets);
        expect(parsed.values).toEqual(values);
        expect(parsed.calldatas).toEqual(calldatas);
        expect(parsed.descriptionHash).toBe("My proposal");
    });

    it("parses a propose() calldata with multiple actions", () => {
        const targets = ["0x" + "11".repeat(20), "0x" + "22".repeat(20)];
        const values = [0n, 1000n];
        const calldatas = ["0x11223344", "0xaabbccdd"];
        const calldata = buildProposeCalldata(targets, values, calldatas);

        const parsed = parseProposalCalldata(calldata);

        expect(parsed.targets).toHaveLength(2);
        expect(parsed.values[1]).toBe(1000n);
        expect(parsed.calldatas[1]).toBe("0xaabbccdd");
    });

    it("parses a propose() calldata with empty arrays", () => {
        const calldata = buildProposeCalldata([], [], []);
        const parsed = parseProposalCalldata(calldata);
        expect(parsed.targets).toEqual([]);
        expect(parsed.values).toEqual([]);
        expect(parsed.calldatas).toEqual([]);
    });

    it("throws when calldata is not a propose() call", () => {
        // Use a different function selector
        const wrongIface = new Interface(["function execute(uint256 proposalId)"]);
        const calldata = wrongIface.encodeFunctionData("execute", [1n]);
        expect(() => parseProposalCalldata(calldata)).toThrow(/Invalid calldata/);
    });

    it("throws on completely random hex input", () => {
        expect(() => parseProposalCalldata("0xdeadbeefcafe1234")).toThrow();
    });

    it("throws on empty hex input", () => {
        expect(() => parseProposalCalldata("0x")).toThrow();
    });

    it("throws on non-hex input", () => {
        expect(() => parseProposalCalldata("not-hex")).toThrow();
    });
});
