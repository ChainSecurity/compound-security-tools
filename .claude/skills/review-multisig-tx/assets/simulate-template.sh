#!/usr/bin/env bash
# =============================================================================
# Safe multisig transaction simulation on a FRESH Tenderly virtual testnet.
#
# This is a TEMPLATE used by the `review-multisig-tx` skill. Copy it to
# `reviews/multisig-<id>.simulate.sh`, fill in the PARAMETERS block, and run it.
#
# It faithfully exercises the Safe execution path:
#   1. Create a fresh Tenderly virtual testnet (fork of the target chain)
#   2. Fund the executor (and the Safe) with ETH
#   3. Align the Safe nonce to the reviewed nonce (storage override)
#   4. If >= threshold real signatures were collected, use them as-is.
#      Otherwise override threshold -> 1 and use a prevalidated (approved-hash)
#      signature from an impersonated current owner.
#   5. Call Safe.execTransaction(...) and assert the receipt succeeded
#   6. Timelock fallback: if the inner call is TimelockController.schedule(...),
#      advance time by the delay and call execute(...), asserting success
#   7. Print the Tenderly dashboard URL, tx hashes and gas used
#
# Requirements: bash >= 4, jq, curl, cast (foundry)
#   compound-config.json (workspace root) with tenderlyAccessToken/Account/Project
#
# Storage-layout assumption: Safe >= v1.3.0 (threshold = slot 4, nonce = slot 5).
#
# Usage:
#   ./multisig-<id>.simulate.sh                 # create fresh vnet, keep it
#   ./multisig-<id>.simulate.sh --delete-after  # tear the vnet down on exit
# =============================================================================
set -euo pipefail

# -----------------------------------------------------------------------------
# PARAMETERS  --  FILL THESE IN (from the Safe tx-service / front-end / bundle)
# -----------------------------------------------------------------------------
NETWORK="ethereum"                 # informational label
CHAIN_ID=1                         # 1=ethereum, 42161=arbitrum, 8453=base, 10=optimism, ...
SAFE="0x0000000000000000000000000000000000000000"   # Safe multisig under review

# --- The exact Safe transaction tuple that was hashed and signed ---
TO="0x0000000000000000000000000000000000000000"      # target of the Safe tx
VALUE="0"
DATA="0x"                                            # inner calldata (or MultiSend payload)
OPERATION=0                                          # 0 = CALL, 1 = DELEGATECALL
SAFE_TX_GAS=0
BASE_GAS=0
GAS_PRICE=0
GAS_TOKEN="0x0000000000000000000000000000000000000000"
REFUND_RECEIVER="0x0000000000000000000000000000000000000000"
SAFE_NONCE=0

# --- Collected signatures (optional) ---
# Concatenated 65-byte signatures, ALREADY SORTED by signer address ascending,
# as returned by the Safe tx-service. Leave empty ("") to use the
# threshold-override + prevalidated-signature fallback.
SIGNATURES=""

# --- Tunables ---
TX_GAS="0x5f5e100"                 # 100M gas for the execTransaction call
FUND_AMOUNT="0x8AC7230489E80000"   # 10 ETH

# -----------------------------------------------------------------------------
# Constants
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Walk up to find compound-config.json (works from reviews/ or repo root)
find_config() {
  local d="$SCRIPT_DIR"
  for _ in 1 2 3 4 5; do
    [[ -f "$d/compound-config.json" ]] && { echo "$d/compound-config.json"; return; }
    d="$(dirname "$d")"
  done
  echo ""
}
CONFIG_PATH="$(find_config)"

SCHEDULE_SELECTOR="0x01d5062a"     # TimelockController.schedule(address,uint256,bytes,bytes32,bytes32,uint256)
THRESHOLD_SLOT="0x0000000000000000000000000000000000000000000000000000000000000004"
NONCE_SLOT="0x0000000000000000000000000000000000000000000000000000000000000005"
ONE_WORD="0x0000000000000000000000000000000000000000000000000000000000000001"

DELETE_AFTER=0
[[ "${1:-}" == "--delete-after" ]] && DELETE_AFTER=1

# -----------------------------------------------------------------------------
# Sanity checks
# -----------------------------------------------------------------------------
for cmd in jq curl cast; do
  command -v "$cmd" >/dev/null || { echo "Missing dependency: $cmd" >&2; exit 1; }
done
[[ -n "$CONFIG_PATH" ]] || { echo "compound-config.json not found near $SCRIPT_DIR" >&2; exit 1; }

TENDERLY_TOKEN=$(jq -r '.tenderlyAccessToken' "$CONFIG_PATH")
TENDERLY_ACCOUNT=$(jq -r '.tenderlyAccount' "$CONFIG_PATH")
TENDERLY_PROJECT=$(jq -r '.tenderlyProject' "$CONFIG_PATH")
for v in "$TENDERLY_TOKEN" "$TENDERLY_ACCOUNT" "$TENDERLY_PROJECT"; do
  [[ -n "$v" && "$v" != "null" ]] || { echo "Missing tenderly* fields in $CONFIG_PATH" >&2; exit 1; }
done

# -----------------------------------------------------------------------------
# RPC helpers (bound to ADMIN_RPC once the vnet exists)
# -----------------------------------------------------------------------------
rpc()        { curl -sS -X POST "$ADMIN_RPC" -H "Content-Type: application/json" \
                 -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}"; }
rpc_result() { rpc "$1" "$2" | jq -r '.result'; }

require_receipt_ok() {
  local tx="$1" label="$2" status rcpt gas_used
  rcpt=$(rpc_result eth_getTransactionReceipt "[\"$tx\"]")
  [[ "$rcpt" != "null" && -n "$rcpt" ]] || { echo "  ✗ $label: no receipt for $tx" >&2; exit 1; }
  status=$(echo "$rcpt"   | jq -r '.status')
  gas_used=$(echo "$rcpt" | jq -r '.gasUsed')
  if [[ "$status" != "0x1" ]]; then
    echo "  ✗ $label REVERTED (status=$status, gasUsed=$gas_used, tx=$tx)" >&2
    exit 1
  fi
  echo "  ✓ $label ok (gasUsed=$gas_used)"
  LAST_GAS_USED="$gas_used"
}

# -----------------------------------------------------------------------------
# 1. Create a fresh Tenderly virtual testnet
# -----------------------------------------------------------------------------
echo "=== 1. Creating fresh Tenderly virtual testnet (chain $CHAIN_ID) ==="
SLUG="multisig-sim-$(date -u +%Y%m%d-%H%M%S)-$RANDOM"
CREATE_RESPONSE=$(curl -sS -X POST \
  "https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT}/project/${TENDERLY_PROJECT}/vnets" \
  -H "X-Access-Key: ${TENDERLY_TOKEN}" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d "$(cat <<EOF
{
  "slug": "${SLUG}",
  "display_name": "multisig review sim (${NETWORK})",
  "fork_config": { "network_id": ${CHAIN_ID}, "block_number": "latest" },
  "virtual_network_config": { "chain_config": { "chain_id": ${CHAIN_ID} } },
  "sync_state_config": { "enabled": false },
  "explorer_page_config": { "enabled": false, "verification_visibility": "bytecode" }
}
EOF
)")

VNET_ID=$(echo "$CREATE_RESPONSE"   | jq -r '.id')
ADMIN_RPC=$(echo "$CREATE_RESPONSE" | jq -r '.rpcs[] | select(.name == "Admin RPC") | .url')
if [[ -z "$VNET_ID" || "$VNET_ID" == "null" || -z "$ADMIN_RPC" || "$ADMIN_RPC" == "null" ]]; then
  echo "Failed to create virtual testnet:" >&2; echo "$CREATE_RESPONSE" | jq . >&2; exit 1
fi
DASHBOARD="https://dashboard.tenderly.co/${TENDERLY_ACCOUNT}/${TENDERLY_PROJECT}/testnet/${VNET_ID}"
echo "  vnet id:   $VNET_ID"
echo "  admin rpc: $ADMIN_RPC"
echo "  dashboard: $DASHBOARD"

cleanup() {
  if [[ "$DELETE_AFTER" == "1" ]]; then
    echo ""; echo "=== Tearing down vnet $VNET_ID ==="
    curl -sS -X DELETE \
      "https://api.tenderly.co/api/v1/account/${TENDERLY_ACCOUNT}/project/${TENDERLY_PROJECT}/vnets/${VNET_ID}" \
      -H "X-Access-Key: ${TENDERLY_TOKEN}" >/dev/null
    echo "  deleted."
  else
    echo ""; echo "Vnet kept for inspection. Pass --delete-after to tear down."
  fi
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# 2. Read current Safe state (threshold, owners, nonce)
# -----------------------------------------------------------------------------
echo ""
echo "=== 2. Reading Safe state ==="
THRESHOLD=$(cast call "$SAFE" "getThreshold()(uint256)" --rpc-url "$ADMIN_RPC")
ONCHAIN_NONCE=$(cast call "$SAFE" "nonce()(uint256)" --rpc-url "$ADMIN_RPC")
OWNER0=$(cast call "$SAFE" "getOwners()(address[])" --rpc-url "$ADMIN_RPC" | tr -d '[]" ' | cut -d',' -f1)
echo "  threshold:      $THRESHOLD"
echo "  on-chain nonce: $ONCHAIN_NONCE  (reviewed nonce: $SAFE_NONCE)"
echo "  first owner:    $OWNER0"

# -----------------------------------------------------------------------------
# 3. Align nonce + decide signature strategy
# -----------------------------------------------------------------------------
echo ""
echo "=== 3. Preparing execution context ==="
# Align the on-chain nonce to the reviewed nonce so the safeTxHash matches.
if [[ "$ONCHAIN_NONCE" != "$SAFE_NONCE" ]]; then
  echo "  aligning Safe nonce $ONCHAIN_NONCE -> $SAFE_NONCE (storage slot 5)"
  rpc tenderly_setStorageAt "[\"$SAFE\", \"$NONCE_SLOT\", \"$(cast to-uint256 "$SAFE_NONCE")\"]" >/dev/null
fi

if [[ -n "$SIGNATURES" && "$SIGNATURES" != "0x" ]]; then
  echo "  using ${#SIGNATURES} chars of collected signatures (real-signature path)"
  EXECUTOR="$SAFE"   # anyone can relay valid signatures; relay from the Safe itself
  EXEC_SIGS="$SIGNATURES"
else
  echo "  no signatures supplied -> override threshold to 1, use prevalidated owner sig"
  rpc tenderly_setStorageAt "[\"$SAFE\", \"$THRESHOLD_SLOT\", \"$ONE_WORD\"]" >/dev/null
  EXECUTOR="$OWNER0"
  # Prevalidated (approved-hash) signature: r = owner (left-padded), s = 0, v = 1.
  # Valid because msg.sender == owner (we send execTransaction from OWNER0).
  R_PADDED="$(cast abi-encode 'f(address)' "$OWNER0")"; R_PADDED="${R_PADDED#0x}"
  EXEC_SIGS="0x${R_PADDED}$(printf '0%.0s' {1..64})01"
fi
echo "  executor: $EXECUTOR"

# -----------------------------------------------------------------------------
# 4. Fund accounts
# -----------------------------------------------------------------------------
echo ""
echo "=== 4. Funding executor and Safe ==="
rpc tenderly_setBalance "[[\"$EXECUTOR\", \"$SAFE\"], \"$FUND_AMOUNT\"]" >/dev/null
echo "  executor balance: $(rpc_result eth_getBalance "[\"$EXECUTOR\", \"latest\"]")"

# -----------------------------------------------------------------------------
# 5. Build + send execTransaction
# -----------------------------------------------------------------------------
echo ""
echo "=== 5. Submitting Safe.execTransaction() ==="
EXEC_DATA=$(cast calldata \
  "execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)" \
  "$TO" "$VALUE" "$DATA" "$OPERATION" "$SAFE_TX_GAS" "$BASE_GAS" "$GAS_PRICE" \
  "$GAS_TOKEN" "$REFUND_RECEIVER" "$EXEC_SIGS")

EXEC_TX=$(rpc_result eth_sendTransaction "[{
  \"from\":\"$EXECUTOR\",
  \"to\":\"$SAFE\",
  \"data\":\"$EXEC_DATA\",
  \"gas\":\"$TX_GAS\",
  \"gasPrice\":\"0x0\",
  \"value\":\"0x0\"
}]")
echo "  tx: $EXEC_TX"
require_receipt_ok "$EXEC_TX" "execTransaction()"
EXEC_GAS="$LAST_GAS_USED"

# A Safe with threshold met can emit ExecutionFailure instead of reverting when
# the inner call fails. Detect that topic explicitly.
EXEC_FAIL_TOPIC="0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23"
EXEC_RET=$(rpc eth_getTransactionReceipt "[\"$EXEC_TX\"]" | jq -r \
  '.result.logs[]?.topics[0]' | grep -i "$EXEC_FAIL_TOPIC" || true)
if [[ -n "$EXEC_RET" ]]; then
  echo "  ⚠ Safe emitted ExecutionFailure — the inner call reverted (tx still mined)."
  echo "    Inspect on the dashboard before approving."
fi

# -----------------------------------------------------------------------------
# 6. Timelock fallback: if the inner call is schedule(...), advance + execute()
# -----------------------------------------------------------------------------
TIMELOCK_TX=""
if [[ "$OPERATION" == "0" && "${DATA:0:10}" == "$SCHEDULE_SELECTOR" ]]; then
  echo ""
  echo "=== 6. Inner call is TimelockController.schedule() — advancing + execute() ==="
  mapfile -t DEC < <(cast calldata-decode \
    "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" "$DATA")
  TGT="${DEC[0]}"; TVAL="${DEC[1]%% *}"; IDATA="${DEC[2]}"
  PRED="${DEC[3]}"; SALT="${DEC[4]}"; DELAY="${DEC[5]%% *}"
  echo "  target:$TGT value:$TVAL delay:${DELAY}s"

  CUR_TS=$(( $(rpc eth_getBlockByNumber '["latest", false]' | jq -r '.result.timestamp') ))
  NEW_TS_HEX=$(printf '0x%x' "$((CUR_TS + DELAY + 1))")
  rpc tenderly_mineBlock "[{\"time\":\"$NEW_TS_HEX\",\"number\":null,\"difficulty\":null,\"gasLimit\":null,\"coinbase\":null,\"random\":null,\"baseFee\":null}]" >/dev/null
  echo "  advanced time to $NEW_TS_HEX"

  EXECUTE_DATA=$(cast calldata "execute(address,uint256,bytes,bytes32,bytes32)" \
    "$TGT" "$TVAL" "$IDATA" "$PRED" "$SALT")
  TIMELOCK_TX=$(rpc_result eth_sendTransaction "[{
    \"from\":\"$SAFE\",
    \"to\":\"$TO\",
    \"data\":\"$EXECUTE_DATA\",
    \"gas\":\"$TX_GAS\",
    \"gasPrice\":\"0x0\",
    \"value\":\"0x0\"
  }]")
  echo "  tx: $TIMELOCK_TX"
  require_receipt_ok "$TIMELOCK_TX" "timelock execute()"
fi

# -----------------------------------------------------------------------------
# 7. Summary
# -----------------------------------------------------------------------------
echo ""
echo "=== Summary ==="
echo "  vnet:            $VNET_ID"
echo "  dashboard:       $DASHBOARD"
echo "  execTransaction: $EXEC_TX (gas $EXEC_GAS)"
[[ -n "$TIMELOCK_TX" ]] && echo "  timelock exec:   $TIMELOCK_TX"
echo "  RESULT: SUCCESS"
