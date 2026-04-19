/**
 * Core simulation logic
 *
 * This module contains the shared simulation functions used by both
 * the CLI (main.ts) and library (simulator.ts) entry points.
 */

import { ethers, AbiCoder, Interface } from "ethers";
import {
    governorABI,
    receiverABI,
    timelockABI,
    compoundABI,
} from "../abis";
import { loadConfig, getSimulatorRpcUrl } from "../config";
import { getRevertReason } from "../utils";
import type { Backend } from "../backends";
import type {
    Proposal,
    ChainExecutionResult,
    TransactionExecution,
} from "../types";
import type { SimulationContext, GovernanceSimulationResult } from "./types";
import { bridgeABIs, messageIndex, CCIP_ROUTER } from "./constants";
import {
    getProposal,
    extractBridgedProposal,
    extractCCIPBridgedProposal,
    targetToL2Chain,
    isCCIPTarget,
    ccipTargetToL2Chain,
} from "./proposals";

const config = loadConfig();

// ============ Setup Functions ============

/**
 * Setup delegation for robinhood address to gain voting power
 */
export async function setupDelegation(ctx: SimulationContext): Promise<void> {
    const { backend, logger } = ctx;
    const robinhood = config.defaults.robinhood;
    const compAddress = config.defaults.COMP;

    const provider = backend.getProvider("mainnet");
    const compContract = new ethers.Contract(compAddress, compoundABI, provider);
    const delegateTx = await compContract.delegate.populateTransaction(robinhood);

    logger.section("Setup");
    logger.step("Delegating COMP voting power");

    await backend.impersonateAccount("mainnet", robinhood);
    const delegateResult = await backend.sendTransaction("mainnet", {
        from: robinhood,
        to: compAddress,
        data: delegateTx.data!,
    });
    logger.tx("Delegate", delegateResult);

    // Mine a block to activate voting power (it's snapshot-based)
    await backend.mineBlock("mainnet");
    logger.done("Delegation complete");
}

// ============ Governance Mode Simulation ============

/**
 * Submit a proposal to the governor and return the new proposal ID
 *
 * This re-submits the proposal with a fresh snapshot so robinhood has voting power.
 */
async function submitProposal(
    proposal: Proposal,
    originalProposalId: string,
    chain: string,
    ctx: SimulationContext
): Promise<string> {
    const { backend, logger } = ctx;
    const chainConfig = config.chains[chain];
    const provider = backend.getProvider(chain);
    const robinhood = config.defaults.robinhood;

    const governor = new ethers.Contract(
        chainConfig.governorAddress!,
        governorABI,
        provider,
    );

    // Get the next proposal ID before submitting
    const nextProposalId = await governor.getNextProposalId();

    // Create the propose transaction (copy arrays to avoid read-only issues)
    // Add timestamp to description to avoid duplicate proposal rejection on resubmission
    const proposeTx = await governor.propose.populateTransaction(
        [...proposal.targets],
        [...proposal.values],
        [...proposal.calldatas],
        `Simulation of proposal ${originalProposalId} at ${Date.now()}`
    );

    await backend.sendTransaction(chain, {
        from: robinhood,
        to: chainConfig.governorAddress!,
        gas: config.defaults.gas,
        gasPrice: config.defaults.gasPrice,
        data: proposeTx.data!,
    });

    // Mine a block to finalize the proposal
    await backend.mineBlock(chain);

    const newProposalId = nextProposalId.toString();
    logger.info("New proposal ID", newProposalId);
    return newProposalId;
}

/**
 * Advance to voting start and cast a vote
 */
async function advanceAndVote(
    proposalId: string,
    chain: string,
    ctx: SimulationContext
): Promise<void> {
    const { backend, logger } = ctx;
    const chainConfig = config.chains[chain];
    const provider = backend.getProvider(chain);
    const robinhood = config.defaults.robinhood;

    const governor = new ethers.Contract(
        chainConfig.governorAddress!,
        governorABI,
        provider,
    );

    // Advance to vote start block
    const currentBlockNumber = await provider.getBlockNumber();
    const voteStartBlock = Number(await governor.proposalSnapshot(proposalId)) + 1;

    if (voteStartBlock > currentBlockNumber) {
        logger.step(`Advancing to block ${voteStartBlock.toLocaleString()}`);
        await backend.mineBlock(chain, { blockNumber: voteStartBlock });
    }

    // Check voting power for the proposal
    const snapshotBlock = await governor.proposalSnapshot(proposalId);
    const votingPower = await governor.getVotes(robinhood, snapshotBlock);
    logger.info("Voting power at snapshot", votingPower.toString());

    // Cast vote
    logger.step("Casting vote");
    const voteTx = await governor.castVote.populateTransaction(proposalId, 1);
    await backend.sendTransaction(chain, {
        from: robinhood,
        to: chainConfig.governorAddress!,
        data: voteTx.data!,
    });
}

/**
 * Advance to end of voting period and queue the proposal
 */
async function advanceAndQueue(
    proposalId: string,
    chain: string,
    ctx: SimulationContext
): Promise<void> {
    const { backend, logger } = ctx;
    const chainConfig = config.chains[chain];
    const provider = backend.getProvider(chain);
    const robinhood = config.defaults.robinhood;

    const governor = new ethers.Contract(
        chainConfig.governorAddress!,
        governorABI,
        provider,
    );

    // Advance to end of voting period
    const votingPeriod = await governor.votingPeriod();
    const startingBlock = await governor.proposalSnapshot(proposalId);
    const proposalEndBlock = Number(startingBlock + votingPeriod);

    const currentBlockNumber = await provider.getBlockNumber();

    // Need to be PAST the deadline to queue (block > proposalEndBlock)
    const targetBlock = proposalEndBlock + 1;
    if (currentBlockNumber <= proposalEndBlock) {
        logger.step(`Advancing to block ${targetBlock.toLocaleString()}`);
        await backend.mineBlock(chain, { blockNumber: targetBlock });
    }

    // Queue proposal
    logger.step("Queueing proposal");
    const queueTx = await governor.queue.populateTransaction(proposalId);
    await backend.sendTransaction(chain, {
        from: robinhood,
        to: chainConfig.governorAddress!,
        data: queueTx.data!,
    });
}

/**
 * Advance past grace period and execute the proposal
 */
async function advanceAndExecute(
    proposalId: string,
    chain: string,
    ctx: SimulationContext,
    proposal: Proposal
): Promise<ChainExecutionResult> {
    const { backend, logger } = ctx;
    const chainConfig = config.chains[chain];
    const provider = backend.getProvider(chain);
    const robinhood = config.defaults.robinhood;

    const governor = new ethers.Contract(
        chainConfig.governorAddress!,
        governorABI,
        provider,
    );

    const timelock = new ethers.Contract(
        chainConfig.timelockAddress,
        timelockABI,
        provider,
    );

    // Advance time for execution
    const gracePeriod = Number(await timelock.GRACE_PERIOD());
    logger.step(`Advancing time by ${gracePeriod.toLocaleString()} seconds`);
    const currentBlock = await provider.getBlock("latest");
    const currentTimestamp = currentBlock!.timestamp;
    const executionTimestamp = currentTimestamp + gracePeriod;

    await backend.mineBlock(chain, { timestamp: executionTimestamp });
    await backend.mineBlock(chain);

    // Apply CCIP timestamp patches if proposal targets the CCIP Router
    const { applyCCIPTimestampPatches } = await import("../patches/ccip-timestamps");
    await applyCCIPTimestampPatches(backend, chain, proposal);

    // Execute proposal
    logger.step("Executing proposal");
    const executeTx = await governor.execute.populateTransaction(proposalId);
    const executeResult = await backend.sendTransaction(chain, {
        from: robinhood,
        to: chainConfig.governorAddress!,
        data: executeTx.data!,
    });
    logger.done("Execution complete");
    logger.tx("Execute proposal", executeResult);

    const receipt = await provider.waitForTransaction(executeResult);
    const success = receipt?.status === 1;
    const gasUsed = receipt?.gasUsed;

    // Extract revert reason if transaction failed
    let revertReason: string | undefined;
    if (!success && executeResult) {
        revertReason = await getRevertReason(provider, executeResult);
    }

    return {
        chain,
        chainId: chainConfig.chainId,
        success,
        timelockAddress: chainConfig.timelockAddress,
        executions: [{
            index: 0,
            target: chainConfig.governorAddress!,
            value: 0n,
            calldata: executeTx.data!,
            success,
            gasUsed,
            txHash: executeResult,
            revertReason,
        }],
        totalGasUsed: gasUsed,
        persisted: true,
        rpcUrl: getSimulatorRpcUrl(chain),
    };
}

/**
 * Run the full governance flow for a proposal
 *
 * This is the core simulation logic that:
 * 1. Submits a copy of the proposal (to get fresh voting snapshot)
 * 2. Advances to voting start and casts vote
 * 3. Advances to voting end and queues
 * 4. Advances past grace period and executes
 */
export async function runGovernanceFlow(
    proposal: Proposal,
    originalProposalId: string,
    chain: string,
    ctx: SimulationContext
): Promise<ChainExecutionResult> {
    const { backend, logger } = ctx;

    logger.section(chain);

    const robinhood = config.defaults.robinhood;
    await backend.impersonateAccount(chain, robinhood);

    // Always submit a fresh copy of the proposal for clean voting snapshot
    logger.step("Submitting proposal for fresh snapshot");
    const proposalId = await submitProposal(proposal, originalProposalId, chain, ctx);

    // Run the governance flow
    await advanceAndVote(proposalId, chain, ctx);
    await advanceAndQueue(proposalId, chain, ctx);
    return await advanceAndExecute(proposalId, chain, ctx, proposal);
}

/**
 * Simulate a proposal through the full governance flow
 *
 * This is a compatibility wrapper that checks if the proposal needs re-submission.
 * New code should prefer using runGovernanceFlow() directly.
 */
export async function simulateGovernance(
    proposalId: string,
    chain: string,
    ctx: SimulationContext,
    proposal?: Proposal
): Promise<GovernanceSimulationResult> {
    const { backend, logger } = ctx;

    logger.section(chain);
    const provider = backend.getProvider(chain);
    const chainConfig = config.chains[chain];

    const governor = new ethers.Contract(
        chainConfig.governorAddress!,
        governorABI,
        provider,
    );

    const robinhood = config.defaults.robinhood;
    await backend.impersonateAccount(chain, robinhood);

    // Check voting power at the proposal's snapshot block
    let actualProposalId = proposalId;
    const snapshotBlock = await governor.proposalSnapshot(proposalId);

    // snapshotBlock === 0 means the proposal doesn't exist (default mapping value)
    // In this case, we need to re-submit the proposal regardless of voting power
    const proposalExists = snapshotBlock > 0n;
    const votingPower = proposalExists ? await governor.getVotes(robinhood, snapshotBlock) : 0n;

    // Re-propose if:
    // 1. The proposal doesn't exist on this fork (snapshotBlock === 0)
    // 2. Or robinhood has no voting power at the original snapshot
    if ((!proposalExists || votingPower === 0n) && proposal) {
        if (!proposalExists) {
            logger.warn(`Proposal ${proposalId} does not exist on this fork`);
        } else {
            logger.warn("Robinhood has no voting power at original proposal snapshot");
        }
        logger.step("Re-submitting proposal to create fresh snapshot after delegation");

        actualProposalId = await submitProposal(proposal, proposalId, chain, ctx);
    }

    // Ensure we have the proposal object for CCIP detection
    const resolvedProposal = proposal ?? await getProposal(proposalId, provider);

    // Run the governance flow steps
    await advanceAndVote(actualProposalId, chain, ctx);
    await advanceAndQueue(actualProposalId, chain, ctx);
    const result = await advanceAndExecute(actualProposalId, chain, ctx, resolvedProposal);

    return {
        result,
        actualProposalId,
    };
}

// ============ L2 Bridging Simulation ============

/**
 * Simulate all L2 bridging calls in a proposal
 *
 * Uses the provided proposal object directly rather than querying the governor,
 * which avoids issues when:
 * - The proposal was re-submitted (different ID)
 * - The fork block is before the proposal was created
 * - The proposal state changed after execution
 */
export async function simulateBridging(
    proposal: Proposal,
    ctx: SimulationContext
): Promise<ChainExecutionResult[]> {
    const results: ChainExecutionResult[] = [];

    for (let i = 0; i < proposal.targets.length; i++) {
        const target = proposal.targets[i]!;
        const calldata = proposal.calldatas[i]!;

        // Traditional L2 bridges
        const l2 = targetToL2Chain(target);
        if (l2) {
            const result = await simulateL2(l2, calldata, ctx);
            results.push(result);
            continue;
        }

        // CCIP bridges (e.g. Ronin)
        if (isCCIPTarget(target)) {
            const chain = ccipTargetToL2Chain(calldata);
            if (chain) {
                const result = await simulateCCIPL2(chain, calldata, ctx);
                results.push(result);
            }
        }
    }

    return results;
}

/**
 * Simulate execution on an L2 chain after bridging
 */
export async function simulateL2(
    chain: string,
    calldata: string,
    ctx: SimulationContext
): Promise<ChainExecutionResult> {
    const { backend, logger } = ctx;

    logger.section(chain);

    const provider = backend.getProvider(chain);
    const chainConfig = config.chains[chain];
    const receiver = new ethers.Contract(
        chainConfig.receiver!,
        receiverABI,
        provider,
    );

    const timelockAddress = await receiver.localTimelock();
    const timelock = new ethers.Contract(timelockAddress, timelockABI, provider);
    const alias = chainConfig.l2msgsender!;

    // Set cross-chain message sender (xDomainMessageSender) so the bridge receiver
    // accepts the call as coming from the L1 timelock.
    // OP-Stack chains (Optimism, Base, Mantle, Unichain) store xDomainMsgSender at slot 0xcc (204).
    // Scroll has a different contract (L2ScrollMessenger) with xDomainMessageSender at slot 0xc9 (201).
    // Linea uses claimMessage flow (see below).
    if (["base", "optimism", "mantle", "unichain"].includes(chain)) {
        logger.step("Setting cross-chain message sender");
        await backend.setStorageAt(
            chain,
            alias,
            "0x00000000000000000000000000000000000000000000000000000000000000cc",
            "0x0000000000000000000000006d903f6003cca6255D85CcA4D3B5E5146dC33925"
        );
    } else if (chain === "scroll") {
        logger.step("Setting cross-chain message sender");
        await backend.setStorageAt(
            chain,
            alias,
            "0x00000000000000000000000000000000000000000000000000000000000000c9",
            "0x0000000000000000000000006d903f6003cca6255D85CcA4D3B5E5146dC33925"
        );
    }

    const iface = new Interface(bridgeABIs[chain] as ethers.InterfaceAbi);
    const bridgeCall = iface.parseTransaction({ data: calldata });
    const message = bridgeCall!.args[messageIndex[chain]!];

    // Impersonate and send the bridged message
    await backend.impersonateAccount(chain, alias);

    if (chain === "linea") {
        // Linea L2MessageService V6 uses EIP-1153 transient storage for _messageSender,
        // so we cannot override it via setStorageAt. Instead, we call claimMessage() on
        // the L2MessageService which sets TRANSIENT_MESSAGE_SENDER within the same tx.
        //
        // Steps:
        // 1. Compute the message hash matching claimMessage's expectation
        // 2. Set inboxL1L2MessageStatus[hash] = 1 (RECEIVED) in storage
        // 3. Call claimMessage, which sets transient sender and calls the receiver
        const _from = config.chains.mainnet.timelockAddress;
        const _to = bridgeCall!.args[0];    // receiver address
        const _fee = bridgeCall!.args[1];   // fee
        const _value = 0;
        const _nonce = 999999999;           // arbitrary unused nonce
        const _calldata = message;          // the bridged calldata

        // Message hash = keccak256(abi.encode(_from, _to, _fee, _value, _nonce, _calldata))
        const messageHash = ethers.keccak256(
            AbiCoder.defaultAbiCoder().encode(
                ["address", "address", "uint256", "uint256", "uint256", "bytes"],
                [_from, _to, _fee, _value, _nonce, _calldata]
            )
        );

        // inboxL1L2MessageStatus mapping is at base slot 0xb0 (176)
        // Storage slot for mapping key = keccak256(abi.encode(key, baseSlot))
        const INBOX_STATUS_MAPPING_SLOT = 0xb0;
        const statusSlot = ethers.keccak256(
            AbiCoder.defaultAbiCoder().encode(
                ["bytes32", "uint256"],
                [messageHash, INBOX_STATUS_MAPPING_SLOT]
            )
        );

        logger.step("Anchoring message hash in L2MessageService");
        // Set status to INBOX_STATUS_RECEIVED (1)
        await backend.setStorageAt(
            chain,
            alias,
            statusSlot,
            "0x0000000000000000000000000000000000000000000000000000000000000001"
        );

        // Call claimMessage on L2MessageService
        logger.step("Claiming message via L2MessageService");
        const claimMessageIface = new Interface([
            "function claimMessage(address _from, address _to, uint256 _fee, uint256 _value, address payable _feeRecipient, bytes _calldata, uint256 _nonce)",
        ]);
        const claimCalldata = claimMessageIface.encodeFunctionData("claimMessage", [
            _from,
            _to,
            _fee,
            _value,
            ethers.ZeroAddress,
            _calldata,
            _nonce,
        ]);
        await backend.sendTransaction(chain, {
            from: alias,
            to: alias, // claimMessage is called on the L2MessageService itself
            data: claimCalldata,
        });
    } else if (chain === "polygon") {
        // Polygon uses FxPortal: FxChild calls processMessageFromRoot on the receiver
        // instead of the fallback-based pattern used by OP-stack chains.
        const processMessageIface = new Interface([
            "function processMessageFromRoot(uint256 stateId, address rootMessageSender, bytes data)",
        ]);
        const encodedCall = processMessageIface.encodeFunctionData("processMessageFromRoot", [
            0,
            config.chains.mainnet.timelockAddress,
            message,
        ]);
        await backend.sendTransaction(chain, {
            from: alias,
            to: chainConfig.receiver!,
            data: encodedCall,
        });
    } else {
        await backend.sendTransaction(chain, {
            from: alias,
            to: chainConfig.receiver!,
            data: message,
        });
    }

    const gracePeriod = Number(await timelock.GRACE_PERIOD());
    logger.step(`Advancing time by ${gracePeriod.toLocaleString()} seconds`);
    const currentBlock = await provider.getBlock("latest");
    const currentTimestamp = currentBlock!.timestamp;
    const executionTimestamp = currentTimestamp + gracePeriod;

    await backend.mineBlock(chain, { timestamp: executionTimestamp });

    const proposalIdOnChain = await receiver.proposalCount();
    await backend.mineBlock(chain);

    logger.step("Executing proposal");
    const executeTx = await receiver.executeProposal.populateTransaction(proposalIdOnChain);
    const executeResult = await backend.sendTransaction(chain, {
        from: alias,
        to: chainConfig.receiver!,
        data: executeTx.data!,
    });
    logger.done("Execution complete");
    logger.tx("Execute proposal", executeResult);

    const receipt = await provider.waitForTransaction(executeResult);
    const success = receipt?.status === 1;
    const gasUsed = receipt?.gasUsed;

    // Extract revert reason if transaction failed
    let revertReason: string | undefined;
    if (!success && executeResult) {
        revertReason = await getRevertReason(provider, executeResult);
    }

    return {
        chain,
        chainId: chainConfig.chainId,
        success,
        timelockAddress: timelockAddress as string,
        executions: [{
            index: 0,
            target: chainConfig.receiver!,
            value: 0n,
            calldata: executeTx.data!,
            success,
            gasUsed,
            txHash: executeResult,
            revertReason,
        }],
        totalGasUsed: gasUsed,
        persisted: true,
        rpcUrl: getSimulatorRpcUrl(chain),
    };
}

/**
 * Simulate execution on a CCIP destination chain (e.g. Ronin)
 *
 * Similar to simulateL2 but uses CCIP-specific flow:
 * 1. Impersonate the CCIP Router on the destination chain
 * 2. Call ccipReceive() on the receiver contract
 * 3. Wait for the grace period
 * 4. Execute the queued proposal via the receiver
 */
export async function simulateCCIPL2(
    chain: string,
    calldata: string,
    ctx: SimulationContext
): Promise<ChainExecutionResult> {
    const { backend, logger } = ctx;

    logger.section(chain);

    const provider = backend.getProvider(chain);
    const chainConfig = config.chains[chain];

    if (!chainConfig?.receiver) {
        throw new Error(`Missing 'receiver' address for chain "${chain}" in compound-config.json`);
    }
    if (!chainConfig.l2msgsender) {
        throw new Error(`Missing 'l2msgsender' address for chain "${chain}" in compound-config.json`);
    }

    const receiverAddress = chainConfig.receiver;

    // Parse the ccipSend calldata to extract the CCIP message fields
    const ccipSendIface = new Interface([
        "function ccipSend(uint64 destinationChainSelector, tuple(bytes receiver, bytes data, tuple(address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) external payable returns (bytes32)",
    ]);
    const parsed = ccipSendIface.parseTransaction({ data: calldata });
    if (!parsed) throw new Error("Failed to parse ccipSend calldata");

    const sourceChainSelector = parsed.args[0];
    const message = parsed.args[1];
    const messageData: string = message.data;

    // Build the Any2EVMMessage struct for ccipReceive
    const ccipReceiverIface = new Interface([
        "function ccipReceive(tuple(bytes32 messageId, uint64 sourceChainSelector, bytes sender, bytes data, tuple(address token, uint256 amount)[] destTokenAmounts) message)",
    ]);
    const coder = AbiCoder.defaultAbiCoder();

    // sourceChainSelector for Ethereum mainnet (where the ccipSend originates)
    const ETH_MAINNET_CCIP_SELECTOR = "5009297550715157269";
    // govTimelock is the mainnet timelock — the sender the receiver expects
    const govTimelock = config.chains.mainnet.timelockAddress;
    const encodedSender = coder.encode(["address"], [govTimelock]);

    const ccipReceiveTx = ccipReceiverIface.encodeFunctionData("ccipReceive", [{
        messageId: ethers.keccak256(ethers.toUtf8Bytes(`simulation-${Date.now()}`)),
        sourceChainSelector: ETH_MAINNET_CCIP_SELECTOR,
        sender: encodedSender,
        data: messageData,
        destTokenAmounts: [],
    }]);

    // The CCIP receiver trusts calls from the L2 CCIP Router
    const l2Router = chainConfig.l2msgsender;
    await backend.impersonateAccount(chain, l2Router);

    logger.step("Sending CCIP message to receiver");
    await backend.sendTransaction(chain, {
        from: l2Router,
        to: receiverAddress,
        data: ccipReceiveTx,
    });

    // Use the standard receiver ABI for executeProposal / localTimelock
    const receiver = new ethers.Contract(receiverAddress, receiverABI, provider);
    const timelockAddress = await receiver.localTimelock();
    const timelock = new ethers.Contract(timelockAddress, timelockABI, provider);

    const gracePeriod = Number(await timelock.GRACE_PERIOD());
    logger.step(`Advancing time by ${gracePeriod.toLocaleString()} seconds`);
    const currentBlock = await provider.getBlock("latest");
    const currentTimestamp = currentBlock!.timestamp;
    const executionTimestamp = currentTimestamp + gracePeriod;

    await backend.mineBlock(chain, { timestamp: executionTimestamp });

    const proposalIdOnChain = await receiver.proposalCount();
    await backend.mineBlock(chain);

    logger.step("Executing proposal");
    const executeTx = await receiver.executeProposal.populateTransaction(proposalIdOnChain);
    const executeResult = await backend.sendTransaction(chain, {
        from: l2Router,
        to: receiverAddress,
        data: executeTx.data!,
    });
    logger.done("Execution complete");
    logger.tx("Execute proposal", executeResult);

    const receipt = await provider.waitForTransaction(executeResult);
    const success = receipt?.status === 1;
    const gasUsed = receipt?.gasUsed;

    let revertReason: string | undefined;
    if (!success && executeResult) {
        revertReason = await getRevertReason(provider, executeResult);
    }

    return {
        chain,
        chainId: chainConfig.chainId,
        success,
        timelockAddress: timelockAddress as string,
        executions: [{
            index: 0,
            target: receiverAddress,
            value: 0n,
            calldata: executeTx.data!,
            success,
            gasUsed,
            txHash: executeResult,
            revertReason,
        }],
        totalGasUsed: gasUsed,
        persisted: true,
        rpcUrl: getSimulatorRpcUrl(chain),
    };
}

// ============ Direct Mode Simulation ============

/**
 * Execute a proposal directly from the timelock (skip governance)
 */
export async function runDirect(
    proposal: Proposal,
    chain: string,
    persist: boolean,
    ctx: SimulationContext
): Promise<ChainExecutionResult> {
    const { backend, logger } = ctx;
    const provider = backend.getProvider(chain);

    const chainConfig = config.chains[chain];
    const fromAddress = chainConfig.timelockAddress;

    if (!fromAddress) {
        throw new Error(`Missing timelock address for chain ${chain}.`);
    }

    const executions: TransactionExecution[] = [];
    let totalGasUsed = 0n;

    const params = proposal.targets.map((target, i) => ({
        from: fromAddress,
        to: target,
        gas: config.defaults.gas,
        gasPrice: config.defaults.gasPrice,
        value: "0x" + proposal.values[i]!.toString(16),
        data: proposal.calldatas[i],
    }));

    // Impersonate the timelock
    await backend.impersonateAccount(chain, fromAddress);

    if (persist) {
        for (let i = 0; i < params.length; i++) {
            const param = params[i]!;
            logger.step(`Executing transaction ${i + 1}/${params.length}`);
            const txHash = await backend.sendTransaction(chain, param);
            const receipt = await provider.waitForTransaction(txHash);
            const success = receipt!.status === 1;
            const gasUsed = receipt!.gasUsed;

            // Extract revert reason if transaction failed
            let revertReason: string | undefined;
            if (!success && txHash) {
                revertReason = await getRevertReason(provider, txHash);
                logger.error(`Transaction ${i + 1} failed: ${revertReason ?? "unknown reason"}`);
            } else if (success) {
                logger.done(`Transaction ${i + 1} complete`);
            }
            logger.tx(`Transaction ${i + 1}`, txHash);
            logger.info("Gas used", gasUsed);

            executions.push({
                index: i,
                target: proposal.targets[i]!,
                value: proposal.values[i]!,
                calldata: proposal.calldatas[i]!,
                success,
                gasUsed,
                txHash,
                revertReason,
            });

            totalGasUsed += gasUsed;
        }
    } else {
        // Use bundle simulation for non-persistent mode
        logger.step(`Simulating ${params.length} transactions`);
        const bundleResults = await backend.simulateBundle(chain, params);
        const successCount = bundleResults.filter(entry => entry.success).length;
        logger.done(`Simulation complete: ${successCount}/${bundleResults.length} succeeded`);

        for (let i = 0; i < bundleResults.length; i++) {
            const result = bundleResults[i]!;

            executions.push({
                index: i,
                target: proposal.targets[i]!,
                value: proposal.values[i]!,
                calldata: proposal.calldatas[i]!,
                success: result.success,
                gasUsed: result.gasUsed,
                txHash: result.txHash,
                revertReason: result.revertReason,
            });

            if (result.gasUsed) {
                totalGasUsed += result.gasUsed;
            }
        }
    }

    return {
        chain,
        chainId: chainConfig.chainId,
        success: executions.every(e => e.success),
        timelockAddress: fromAddress,
        executions,
        totalGasUsed: totalGasUsed > 0n ? totalGasUsed : undefined,
        persisted: persist,
        rpcUrl: getSimulatorRpcUrl(chain),
    };
}

/**
 * Execute a proposal directly with L2 bridging
 */
export async function runDirectWithL2(
    proposal: Proposal,
    chain: string,
    persist: boolean,
    ctx: SimulationContext
): Promise<ChainExecutionResult[]> {
    const results: ChainExecutionResult[] = [];
    const mainnetResult = await runDirect(proposal, chain, persist, ctx);
    results.push(mainnetResult);

    if (chain !== "mainnet") {
        return results;
    }

    // Process L2 bridges
    for (let i = 0; i < proposal.targets.length; i++) {
        const target = proposal.targets[i]!;
        const calldata = proposal.calldatas[i]!;

        // Traditional L2 bridges
        const l2 = targetToL2Chain(target);
        if (l2) {
            const bridgedProposal = extractBridgedProposal(calldata, l2);
            const l2Result = await runDirect(bridgedProposal, l2, persist, ctx);
            results.push(l2Result);
            continue;
        }

        // CCIP bridges (e.g. Ronin)
        if (isCCIPTarget(target)) {
            const ccipChain = ccipTargetToL2Chain(calldata);
            if (ccipChain) {
                const bridgedProposal = extractCCIPBridgedProposal(calldata);
                const l2Result = await runDirect(bridgedProposal, ccipChain, persist, ctx);
                results.push(l2Result);
            }
        }
    }

    return results;
}

// ============ Proposal Submission ============

/**
 * Submit a proposal from calldata and return the created proposal ID
 */
export async function submitProposalFromCalldata(
    calldata: string,
    ctx: SimulationContext
): Promise<{ proposalId: string; proposal: Proposal }> {
    const { backend, logger } = ctx;
    const provider = backend.getProvider("mainnet");
    const robinhood = config.defaults.robinhood;

    const governor = new ethers.Contract(
        config.chains.mainnet.governorAddress!,
        governorABI,
        provider,
    );

    const nextProposalId = await governor.getNextProposalId();
    logger.step("Creating proposal from calldata");

    const proposeTxHash = await backend.sendTransaction("mainnet", {
        from: robinhood,
        to: config.chains.mainnet.governorAddress!,
        gas: config.defaults.gas,
        gasPrice: config.defaults.gasPrice,
        value: "0x0",
        data: calldata,
    });
    logger.tx("Propose", proposeTxHash);

    // Wait for the transaction and check if it succeeded
    const proposeReceipt = await provider.waitForTransaction(proposeTxHash);
    if (proposeReceipt?.status === 0) {
        logger.error("Propose transaction reverted");
        // Try to get revert reason
        try {
            await provider.call({
                from: robinhood,
                to: config.chains.mainnet.governorAddress,
                data: calldata,
            });
        } catch (err) {
            logger.error(`Revert reason: ${err}`);
        }
        throw new Error("Propose transaction reverted");
    }

    const proposalId = nextProposalId.toString();
    logger.done(`Proposal ${proposalId} created`);

    const proposal = await getProposal(proposalId, provider);
    return { proposalId, proposal };
}
