#!/usr/bin/env bash
# Verify the safeTxHash for a Safe multisig transaction by calling
# getTransactionHash on the Safe contract and comparing the result.
#
# Usage: ./verify-safetx-hash.sh [RPC_URL]
#        ETH_RPC_URL=https://... ./verify-safetx-hash.sh
#        (falls back to .chains.mainnet.rpcUrl in compound-config.json)

set -euo pipefail

# ---------------------------------------------------------------------------
# Transaction parameters (from Safe Transaction Service API)
# https://api.safe.global/tx-service/eth/api/v1/multisig-transactions/0x2344a643bff34694c776871102460add7635d56cc0b0d8fbac15dcf746a16117/
# ---------------------------------------------------------------------------
SAFE="0x0F5100684d0530A8321976B376a3196eb481c7bD"
TO="0x9641d764fc13c8B624c04430C7356C1C7C8102e2"
VALUE=0
DATA="0x8d80ff0a00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000264006b175474e89094c44da98b954eedeac495271d0f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044095ea7b3000000000000000000000000f6e72db5454dd049d0788e411b06cfaf1685304200000000000000000000000000000000000000000006f7011d57800e4680000000f6e72db5454dd049d0788e411b06cfaf16853042000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000448d7ef9bb0000000000000000000000000f5100684d0530a8321976b376a3196eb481c7bd000000000000000000000000000000000000000000000000000007a86f1be80000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044095ea7b3000000000000000000000000c3d688b66703497daa19211eedff47f25384cdc3000000000000000000000000000000000000000000000000000007a86f1be80000c3d688b66703497daa19211eedff47f25384cdc300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044f2b9fdb8000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000007a86f1be80000000000000000000000000000000000000000000000000000000000"
OPERATION=1
SAFE_TX_GAS=0
BASE_GAS=0
GAS_PRICE=0
GAS_TOKEN="0x0000000000000000000000000000000000000000"
REFUND_RECEIVER="0x0000000000000000000000000000000000000000"
NONCE=0

EXPECTED_HASH="0x2344a643bff34694c776871102460add7635d56cc0b0d8fbac15dcf746a16117"

# ---------------------------------------------------------------------------
# RPC URL
# Resolution order: $1 argument -> $ETH_RPC_URL -> compound-config.json
# Never hardcode a credentialed endpoint here; compound-config.json is gitignored.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/compound-config.json"

RPC_URL="${1:-${ETH_RPC_URL:-}}"

if [ -z "$RPC_URL" ] && [ -f "$CONFIG_FILE" ] && command -v jq >/dev/null 2>&1; then
  RPC_URL="$(jq -r ".chains.mainnet.rpcUrl // empty" "$CONFIG_FILE")"
fi

if [ -z "$RPC_URL" ]; then
  echo "Error: no mainnet RPC URL available." >&2
  echo "" >&2
  echo "Usage: $0 [RPC_URL]" >&2
  echo "   or: ETH_RPC_URL=https://... $0" >&2
  echo "   or: set .chains.mainnet.rpcUrl in $CONFIG_FILE" >&2
  exit 1
fi

# Redact any embedded API key before printing the endpoint.
RPC_DISPLAY="$(printf "%s" "$RPC_URL" | sed -E "s#(://[^/]+/)[^/?#]+#\\1***#")"

echo "=== Safe Transaction Hash Verification ==="
echo ""
echo "Safe:            $SAFE"
echo "To:              $TO"
echo "Value:           $VALUE"
echo "Operation:       $OPERATION (DelegateCall)"
echo "SafeTxGas:       $SAFE_TX_GAS"
echo "BaseGas:         $BASE_GAS"
echo "GasPrice:        $GAS_PRICE"
echo "GasToken:        $GAS_TOKEN"
echo "RefundReceiver:  $REFUND_RECEIVER"
echo "Nonce:           $NONCE"
echo "Data length:     ${#DATA} chars"
echo "RPC:             $RPC_DISPLAY"
echo ""

# ---------------------------------------------------------------------------
# Call getTransactionHash on the Safe contract
# Signature: getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)
# ---------------------------------------------------------------------------
echo "Calling getTransactionHash on Safe contract..."

COMPUTED_HASH=$(cast call "$SAFE" \
  "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
  "$TO" \
  "$VALUE" \
  "$DATA" \
  "$OPERATION" \
  "$SAFE_TX_GAS" \
  "$BASE_GAS" \
  "$GAS_PRICE" \
  "$GAS_TOKEN" \
  "$REFUND_RECEIVER" \
  "$NONCE" \
  --rpc-url "$RPC_URL")

echo ""
echo "Expected safeTxHash:  $EXPECTED_HASH"
echo "Computed safeTxHash:  $COMPUTED_HASH"
echo ""

if [ "$COMPUTED_HASH" = "$EXPECTED_HASH" ]; then
  echo "RESULT: MATCH - safeTxHash is verified!"
  exit 0
else
  echo "RESULT: MISMATCH - safeTxHash does NOT match!"
  exit 1
fi
