import { AbiCoder, Contract, Interface, JsonRpcProvider, getBytes, hexlify, keccak256 } from "ethers";
import {
  receiverABI,
  l1CdmEventABI,
  l2CrossDomainMessengerABI,
  L2_CROSS_DOMAIN_MESSENGER,
  arbitrumInboxEventABI,
  scrollL1MessengerEventABI,
  scrollL2MessengerABI,
  SCROLL_L2_MESSENGER,
  lineaL1MessageServiceEventABI,
  lineaL2MessageServiceABI,
  LINEA_L2_MESSAGE_SERVICE,
} from "./abis.js";
import { getRpcUrl } from "./config.js";
import type { CrossChainAction, CrossChainActionResult, CrossChainStatus } from "./types.js";
import { ReceiverState } from "./types.js";

// ── Helpers ────────────────────────────────────────────────────────

function receiverStateToStatus(state: number): CrossChainStatus {
  switch (state) {
    case ReceiverState.Queued:
      return "pending";
    case ReceiverState.Executed:
      return "executed";
    case ReceiverState.Expired:
      return "expired";
    default:
      return "not-transmitted";
  }
}

// ── ProposalCreated event type ─────────────────────────────────────

interface ProposalCreatedEvent {
  id: number;
  targets: string[];
  values: string[];    // decimal strings
  calldatas: string[]; // hex strings
  eta: number;
  transactionHash: string;
}

function parseProposalCreatedLog(
  log: { topics: readonly string[]; data: string; transactionHash: string },
  receiverIface: Interface,
): ProposalCreatedEvent | null {
  const parsed = receiverIface.parseLog({
    topics: log.topics as string[],
    data: log.data,
  });
  if (!parsed) return null;
  // event ProposalCreated(address indexed rootMessageSender, uint256 id,
  //   address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 eta)
  return {
    id: Number(parsed.args[1]),
    targets: Array.from(parsed.args[2] as string[]),
    values: Array.from(parsed.args[3] as bigint[]).map((v) => v.toString()),
    calldatas: Array.from(parsed.args[5] as string[]),
    eta: Number(parsed.args[6]),
    transactionHash: log.transactionHash,
  };
}

// ── Query helpers ──────────────────────────────────────────────────

async function queryAllProposalCreatedEvents(
  receiver: Contract,
  provider: JsonRpcProvider,
): Promise<ProposalCreatedEvent[]> {
  const filter = receiver.filters.ProposalCreated!();
  let logs;
  try {
    const latest = await provider.getBlockNumber();
    logs = await receiver.queryFilter(filter, 0, latest);
  } catch {
    try {
      const latest = await provider.getBlockNumber();
      const from = Math.max(0, latest - 500_000);
      logs = await receiver.queryFilter(filter, from, latest);
    } catch {
      return [];
    }
  }
  return logs
    .map((log) => parseProposalCreatedLog(log, receiver.interface))
    .filter((e): e is ProposalCreatedEvent => e !== null);
}

interface ProposalExecutedEvent {
  id: number;
  transactionHash: string;
}

async function queryProposalExecutedEvents(
  receiver: Contract,
  provider: JsonRpcProvider,
): Promise<ProposalExecutedEvent[]> {
  const filter = receiver.filters.ProposalExecuted!();
  let logs;
  try {
    const latest = await provider.getBlockNumber();
    logs = await receiver.queryFilter(filter, 0, latest);
  } catch {
    try {
      const latest = await provider.getBlockNumber();
      const from = Math.max(0, latest - 500_000);
      logs = await receiver.queryFilter(filter, from, latest);
    } catch {
      return [];
    }
  }
  return logs
    .map((log) => {
      const parsed = receiver.interface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) return null;
      return { id: Number(parsed.args[0]), transactionHash: log.transactionHash };
    })
    .filter((e): e is ProposalExecutedEvent => e !== null);
}

async function findProposalCreatedInTx(
  txHash: string,
  provider: JsonRpcProvider,
  receiver: Contract,
): Promise<ProposalCreatedEvent | null> {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return null;
  const receiverAddr = await receiver.getAddress();
  const proposalCreatedTopic = receiver.interface.getEvent("ProposalCreated")!.topicHash;
  const log = receipt.logs.find(
    (l) =>
      l.address.toLowerCase() === receiverAddr.toLowerCase() &&
      l.topics[0] === proposalCreatedTopic,
  );
  if (!log) return null;
  return parseProposalCreatedLog(log, receiver.interface);
}

// ── Bridge-specific matching ───────────────────────────────────────

async function findViaOpCdm(
  action: CrossChainAction,
  l1Provider: JsonRpcProvider,
  executionTxHash: string,
  l2Provider: JsonRpcProvider,
  receiver: Contract,
): Promise<ProposalCreatedEvent | null> {
  const l1Receipt = await l1Provider.getTransactionReceipt(executionTxHash);
  if (!l1Receipt) return null;

  const l1CdmIface = new Interface(l1CdmEventABI);
  const sentMsgTopic = l1CdmIface.getEvent("SentMessage")!.topicHash;
  const sentMsgLog = l1Receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === action.bridgeAddress.toLowerCase() &&
      log.topics[0] === sentMsgTopic,
  );
  if (!sentMsgLog) return null;

  const parsed = l1CdmIface.parseLog({ topics: sentMsgLog.topics as string[], data: sentMsgLog.data });
  if (!parsed) return null;

  const { target, sender, message, messageNonce, gasLimit } = parsed.args as unknown as {
    target: string; sender: string; message: string; messageNonce: bigint; gasLimit: bigint;
  };

  // Bedrock msgHash = keccak256(encodeFunctionData("relayMessage", [nonce, sender, target, 0, gasLimit, message]))
  const relayIface = new Interface(["function relayMessage(uint256,address,address,uint256,uint256,bytes)"]);
  const encoded = relayIface.encodeFunctionData("relayMessage", [messageNonce, sender, target, 0n, gasLimit, message]);
  const msgHash = keccak256(encoded);

  const l2Cdm = new Contract(L2_CROSS_DOMAIN_MESSENGER, l2CrossDomainMessengerABI, l2Provider);
  let relayLogs;
  try {
    const latest = await l2Provider.getBlockNumber();
    relayLogs = await l2Cdm.queryFilter(l2Cdm.filters.RelayedMessage!(msgHash), 0, latest);
  } catch {
    return null;
  }
  if (relayLogs.length === 0) return null;

  return findProposalCreatedInTx(relayLogs[0]!.transactionHash, l2Provider, receiver);
}

async function findViaArbitrum(
  action: CrossChainAction,
  l1Provider: JsonRpcProvider,
  executionTxHash: string,
  l2Provider: JsonRpcProvider,
  receiver: Contract,
): Promise<ProposalCreatedEvent | null> {
  const l1Receipt = await l1Provider.getTransactionReceipt(executionTxHash);
  if (!l1Receipt) return null;

  const inboxIface = new Interface(arbitrumInboxEventABI);
  const inboxTopic = inboxIface.getEvent("InboxMessageDelivered")!.topicHash;
  const inboxLog = l1Receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === action.bridgeAddress.toLowerCase() &&
      log.topics[0] === inboxTopic,
  );
  if (!inboxLog) return null;

  const parsed = inboxIface.parseLog({ topics: inboxLog.topics as string[], data: inboxLog.data });
  if (!parsed) return null;

  const messageNum: bigint = parsed.args[0] as bigint;

  // ticketHash = keccak256(abi.encode(uint256(0), uint256(messageNum)))
  // autoRedeemHash = ticketHash XOR 0x01
  const coder = AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(["uint256", "uint256"], [0n, messageNum]);
  const ticketHash = keccak256(encoded);
  const ticketBytes = getBytes(ticketHash);
  ticketBytes[31]! ^= 1;
  const autoRedeemHash = hexlify(ticketBytes);

  return findProposalCreatedInTx(autoRedeemHash, l2Provider, receiver);
}

async function findViaScroll(
  action: CrossChainAction,
  l1Provider: JsonRpcProvider,
  executionTxHash: string,
  l2Provider: JsonRpcProvider,
  receiver: Contract,
): Promise<ProposalCreatedEvent | null> {
  const l1Receipt = await l1Provider.getTransactionReceipt(executionTxHash);
  if (!l1Receipt) return null;

  const messengerIface = new Interface(scrollL1MessengerEventABI);
  const sentMsgTopic = messengerIface.getEvent("SentMessage")!.topicHash;
  const sentMsgLog = l1Receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === action.bridgeAddress.toLowerCase() &&
      log.topics[0] === sentMsgTopic,
  );
  if (!sentMsgLog) return null;

  const parsed = messengerIface.parseLog({ topics: sentMsgLog.topics as string[], data: sentMsgLog.data });
  if (!parsed) return null;

  const { from, to, value, messageNonce, message } = parsed.args as unknown as {
    from: string; to: string; value: bigint; messageNonce: bigint; message: string;
  };

  // messageHash = keccak256(encodeWithSig("relayMessage(address,address,uint256,uint256,bytes)", from, to, value, nonce, message))
  const relayIface = new Interface(["function relayMessage(address,address,uint256,uint256,bytes)"]);
  const encodedMsg = relayIface.encodeFunctionData("relayMessage", [from, to, value, messageNonce, message]);
  const messageHash = keccak256(encodedMsg);

  const l2Messenger = new Contract(SCROLL_L2_MESSENGER, scrollL2MessengerABI, l2Provider);
  let relayLogs;
  try {
    const latest = await l2Provider.getBlockNumber();
    relayLogs = await l2Messenger.queryFilter(l2Messenger.filters.RelayedMessage!(messageHash), 0, latest);
  } catch {
    return null;
  }
  if (relayLogs.length === 0) return null;

  return findProposalCreatedInTx(relayLogs[0]!.transactionHash, l2Provider, receiver);
}

async function findViaLinea(
  action: CrossChainAction,
  l1Provider: JsonRpcProvider,
  executionTxHash: string,
  l2Provider: JsonRpcProvider,
  receiver: Contract,
): Promise<ProposalCreatedEvent | null> {
  const l1Receipt = await l1Provider.getTransactionReceipt(executionTxHash);
  if (!l1Receipt) return null;

  const lineaIface = new Interface(lineaL1MessageServiceEventABI);
  const msgSentTopic = lineaIface.getEvent("MessageSent")!.topicHash;
  const msgSentLog = l1Receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === action.bridgeAddress.toLowerCase() &&
      log.topics[0] === msgSentTopic,
  );
  if (!msgSentLog) return null;

  const parsed = lineaIface.parseLog({ topics: msgSentLog.topics as string[], data: msgSentLog.data });
  if (!parsed) return null;

  // _messageHash is indexed (topic[3]) — ethers includes it in parsed.args
  const messageHash: string = parsed.args["_messageHash"] as string;

  const l2Service = new Contract(LINEA_L2_MESSAGE_SERVICE, lineaL2MessageServiceABI, l2Provider);
  let claimLogs;
  try {
    const latest = await l2Provider.getBlockNumber();
    claimLogs = await l2Service.queryFilter(l2Service.filters.MessageClaimed!(messageHash), 0, latest);
  } catch {
    return null;
  }
  if (claimLogs.length === 0) return null;

  return findProposalCreatedInTx(claimLogs[0]!.transactionHash, l2Provider, receiver);
}

// ── Payload fallback ───────────────────────────────────────────────

function findViaPayload(
  action: CrossChainAction,
  events: ProposalCreatedEvent[],
  l1ExecTimestamp?: number,
): ProposalCreatedEvent | null {
  const matches = events.filter(
    (ev) =>
      targetsMatch(action.innerTargets, ev.targets) &&
      valuesMatch(action.innerValues, ev.values) &&
      calldatasMatch(action.innerCalldatas, ev.calldatas),
  );
  if (matches.length <= 1) return matches[0] ?? null;

  // Multiple L2 proposals share this exact payload — typically because the same
  // proposal was re-submitted on mainnet after an earlier attempt expired. Picking
  // the first match (the oldest) silently mis-attributes a stale duplicate, so we
  // disambiguate using the L1 execution time: the L2 proposal produced by THIS
  // execution must have been created after it, and its eta (creation + bridge delay)
  // is therefore strictly later. The earliest qualifying match is the right one.
  if (l1ExecTimestamp !== undefined) {
    const after = matches
      .filter((ev) => ev.eta >= l1ExecTimestamp)
      .sort((a, b) => a.eta - b.eta);
    // If nothing post-dates the execution, the bridge message hasn't produced an
    // L2 proposal yet; return null (→ "not-transmitted") rather than a stale match.
    return after[0] ?? null;
  }

  // L1 execution time unavailable: prefer the most recent match over the oldest,
  // since stale duplicates from earlier proposals are created earlier.
  return matches.reduce((latest, ev) => (ev.eta > latest.eta ? ev : latest));
}

function targetsMatch(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((t, i) => t.toLowerCase() === actual[i]!.toLowerCase());
}

function valuesMatch(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((v, i) => BigInt(v) === BigInt(actual[i]!));
}

function calldatasMatch(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((c, i) => c.toLowerCase() === actual[i]!.toLowerCase());
}

// ── Bridge dispatch ────────────────────────────────────────────────

async function findViaBridge(
  action: CrossChainAction,
  l1Provider: JsonRpcProvider,
  executionTxHash: string,
  l2Provider: JsonRpcProvider,
  receiver: Contract,
): Promise<ProposalCreatedEvent | null> {
  try {
    switch (action.bridgeType) {
      case "op-cdm":   return await findViaOpCdm(action, l1Provider, executionTxHash, l2Provider, receiver);
      case "arbitrum": return await findViaArbitrum(action, l1Provider, executionTxHash, l2Provider, receiver);
      case "scroll":   return await findViaScroll(action, l1Provider, executionTxHash, l2Provider, receiver);
      case "linea":    return await findViaLinea(action, l1Provider, executionTxHash, l2Provider, receiver);
      default:         return null;
    }
  } catch {
    return null;
  }
}

// ── processChain ───────────────────────────────────────────────────

async function processChain(
  chainName: string,
  actions: CrossChainAction[],
  l1Provider: JsonRpcProvider,
  executionTxHash: string | undefined,
  l1ExecTimestamp: number | undefined,
): Promise<CrossChainActionResult[]> {
  const rpcUrl = getRpcUrl(chainName);
  if (!rpcUrl) {
    return actions.map((action) => ({
      action,
      status: "not-transmitted" as CrossChainStatus,
      error: `No RPC URL configured for ${chainName}`,
    }));
  }

  const receiverAddr = actions[0]!.receiverAddress;
  if (!receiverAddr) {
    return actions.map((action) => ({
      action,
      status: "not-transmitted" as CrossChainStatus,
      error: `No receiver address configured for ${chainName}`,
    }));
  }

  const l2Provider = new JsonRpcProvider(rpcUrl);
  const receiver = new Contract(receiverAddr, receiverABI, l2Provider);

  // Lazily fetch all ProposalCreated events (only needed for payload fallback)
  let cachedEvents: ProposalCreatedEvent[] | undefined;
  async function getEvents(): Promise<ProposalCreatedEvent[]> {
    if (!cachedEvents) {
      cachedEvents = await queryAllProposalCreatedEvents(receiver, l2Provider);
    }
    return cachedEvents;
  }

  const results: CrossChainActionResult[] = [];

  for (const action of actions) {
    let match: ProposalCreatedEvent | null = null;

    // 1. Bridge-message matching (precise)
    if (executionTxHash) {
      match = await findViaBridge(action, l1Provider, executionTxHash, l2Provider, receiver);
    }

    // 2. Payload fallback: targets + values + calldatas
    if (!match) {
      const events = await getEvents();
      match = findViaPayload(action, events, l1ExecTimestamp);
    }

    if (!match) {
      results.push({ action, status: "not-transmitted" });
      continue;
    }

    try {
      const state = Number(await receiver.state(match.id));
      results.push({
        action,
        status: receiverStateToStatus(state),
        l2ProposalId: match.id,
        eta: match.eta,
        creationTxHash: match.transactionHash,
      });
    } catch (err) {
      results.push({
        action,
        status: "not-transmitted",
        l2ProposalId: match.id,
        eta: match.eta,
        creationTxHash: match.transactionHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Enrich executed results with execution tx hashes
  const hasExecuted = results.some((r) => r.status === "executed");
  if (hasExecuted) {
    const executedEvents = await queryProposalExecutedEvents(receiver, l2Provider);
    for (const result of results) {
      if (result.status === "executed" && result.l2ProposalId !== undefined) {
        const execEvent = executedEvents.find((e) => e.id === result.l2ProposalId);
        if (execEvent) result.executionTxHash = execEvent.transactionHash;
      }
    }
  }

  return results;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Resolve the block timestamp (in seconds) of the L1 execution transaction.
 * Returns undefined if no tx hash is given or the receipt/block can't be fetched.
 */
async function getL1ExecutionTimestamp(
  l1Provider: JsonRpcProvider,
  executionTxHash: string | undefined,
): Promise<number | undefined> {
  if (!executionTxHash) return undefined;
  try {
    const receipt = await l1Provider.getTransactionReceipt(executionTxHash);
    if (!receipt) return undefined;
    const block = await l1Provider.getBlock(receipt.blockNumber);
    return block?.timestamp;
  } catch {
    return undefined;
  }
}

export async function checkL2StatusBatch(
  actions: CrossChainAction[],
  l1Provider: JsonRpcProvider,
  executionTxHash?: string,
): Promise<CrossChainActionResult[]> {
  const byChain = new Map<string, CrossChainAction[]>();
  for (const action of actions) {
    const group = byChain.get(action.chainName) ?? [];
    group.push(action);
    byChain.set(action.chainName, group);
  }

  // Resolve the L1 execution block timestamp once — used to disambiguate L2
  // proposals that share an identical payload (re-submitted proposals).
  const l1ExecTimestamp = await getL1ExecutionTimestamp(l1Provider, executionTxHash);

  const chainResults = await Promise.allSettled(
    Array.from(byChain.entries()).map(([chainName, chainActions]) =>
      processChain(chainName, chainActions, l1Provider, executionTxHash, l1ExecTimestamp),
    ),
  );

  const results: CrossChainActionResult[] = [];
  let chainIdx = 0;
  for (const [, chainActions] of byChain.entries()) {
    const result = chainResults[chainIdx]!;
    if (result.status === "fulfilled") {
      results.push(...result.value);
    } else {
      for (const action of chainActions) {
        results.push({
          action,
          status: "not-transmitted",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
    chainIdx++;
  }

  results.sort((a, b) => a.action.actionIndex - b.action.actionIndex);
  return results;
}
