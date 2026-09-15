/**
 * Minimal ABI fragments for on-chain interactions.
 * Uses human-readable format for readability.
 */

// ── Governor (mainnet) ──────────────────────────────────────────────

export const governorABI = [
  "function state(uint256 proposalId) view returns (uint8)",
  "function proposalDetails(uint256 proposalId) view returns (address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash)",
  "event ProposalExecuted(uint256 id)",
];

// ── BaseBridgeReceiver (L2) ─────────────────────────────────────────

export const receiverABI = [
  "function proposalCount() view returns (uint256)",
  "function proposals(uint256) view returns (uint256 id, uint256 eta, bool executed)",
  "function state(uint256 proposalId) view returns (uint8)",
  "event ProposalCreated(address indexed rootMessageSender, uint256 id, address[] targets, uint256[] values, string[] signatures, bytes[] calldatas, uint256 eta)",
  "event ProposalExecuted(uint256 indexed id)",
];

// ── L1 Bridge functions (calldata decoding) ─────────────────────────

export const arbitrumBridgeABI = [
  "function createRetryableTicket(address to, uint256 l2CallValue, uint256 maxSubmissionCost, address excessFeeRefundAddress, address callValueRefundAddress, uint256 gasLimit, uint256 maxFeePerGas, bytes calldata data) external payable returns (uint256)",
];

export const opCdmBridgeABI = [
  "function sendMessage(address _target, bytes memory _message, uint32 _minGasLimit) external",
];

export const scrollBridgeABI = [
  "function sendMessage(address _to, uint256 _value, bytes memory _message, uint256 _gasLimit) external payable",
];

export const lineaBridgeABI = [
  "function sendMessage(address _to, uint256 _fee, bytes calldata _calldata) external payable",
];

export const polygonBridgeABI = [
  "function sendMessageToChild(address _receiver, bytes calldata _data) external",
];

export const ccipBridgeABI = [
  "function ccipSend(uint64 destinationChainSelector, tuple(bytes receiver, bytes data, tuple(address token, uint256 amount)[] tokenAmounts, address feeToken, bytes extraArgs) message) external payable returns (bytes32)",
];

// ── L1 Bridge events (execution tx parsing) ─────────────────────────

/**
 * OP-CDM L1 CrossDomainMessenger SentMessage event.
 * Emitted by: Optimism CDM, Base CDM, Mantle CDM, Unichain CDM.
 */
export const l1CdmEventABI = [
  "event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)",
];

/**
 * Arbitrum Inbox InboxMessageDelivered event.
 * Emitted when createRetryableTicket is called.
 */
export const arbitrumInboxEventABI = [
  "event InboxMessageDelivered(uint256 indexed messageNum, bytes data)",
];

/**
 * Scroll L1ScrollMessenger SentMessage event.
 */
export const scrollL1MessengerEventABI = [
  "event SentMessage(address indexed from, address indexed to, uint256 value, uint256 messageNonce, uint256 gasLimit, bytes message)",
];

/**
 * Linea L1 MessageService MessageSent event.
 * Includes _messageHash directly in the event.
 */
export const lineaL1MessageServiceEventABI = [
  "event MessageSent(address indexed _from, address indexed _to, uint256 _fee, uint256 _value, uint256 _nonce, bytes _calldata, bytes32 indexed _messageHash)",
];

// ── L2 Protocol contracts (message delivery verification) ───────────

/**
 * OP stack L2 CrossDomainMessenger predeploy — same address on all OP chains.
 * Emits RelayedMessage when a message from L1 is successfully processed.
 */
export const L2_CROSS_DOMAIN_MESSENGER = "0x4200000000000000000000000000000000000007";

export const l2CrossDomainMessengerABI = [
  "event RelayedMessage(bytes32 indexed msgHash)",
];

/**
 * Scroll L2 ScrollMessenger.
 */
export const SCROLL_L2_MESSENGER = "0x781e90f1c8Fc4611c9b7497C3B47F99Ef639dBb1";

export const scrollL2MessengerABI = [
  "event RelayedMessage(bytes32 indexed messageHash)",
];

/**
 * Linea L2 MessageService.
 */
export const LINEA_L2_MESSAGE_SERVICE = "0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec";

export const lineaL2MessageServiceABI = [
  "event MessageClaimed(bytes32 indexed _messageHash)",
];
