---
name: review-multisig-tx
description: Review a Gnosis Safe multisig transaction. Verifies the safe-tx hashes against what the front-end shows, recovers and checks signers, hunts for security issues, and simulates execution on a fresh Tenderly virtual testnet. Produces a markdown review plus a runnable bash simulation script.
disable-model-invocation: true
argument-hint: "<network> <safe-address> <nonce> | <bundle.json> | <safe-ui-url>"
---

Review the Safe multisig transaction identified by **$ARGUMENTS**, following the
workflow below. Produce two deliverables and treat hash verification as a hard
gate: if the computed safeTxHash does not match the front-end, stop and report.

# Safe Multisig Transaction Review Guide

## Deliverables

1. **Markdown review** at `reviews/multisig-<id>.md` (template in §7).
2. **Bash simulation script** at `reviews/multisig-<id>.simulate.sh`, generated
   from `assets/simulate-template.sh`, that runs the tx on a **fresh** Tenderly
   virtual testnet and asserts success.

`<id>` = `<network>-<safe-last4>-<nonce>` (e.g. `ethereum-c7bD-4`), or the bundle
filename stem when reviewing a JSON file.

## Tools available (already in this repo / environment)

- `safe-tx-hashes-util/safe_hashes.sh` — pcaversaccio's EIP-712 hash tool. **Prefer this.**
- `cast` / `forge` (Foundry) — on-chain reads, encoding, ecrecover.
- `pnpm decode <id>` — decodes Compound governance/timelock payloads.
- `assets/simulate-template.sh` — the simulation template.
- `references/security-checklist.md` — the multisig security checklist (read it in §5).
- `compound-config.json` (repo root) — `tenderlyAccessToken/Account/Project`, per-chain `rpcUrl`/`chainId`.

Finding severities: CRITICAL / HIGH / MEDIUM / LOW / INFO (same definitions as `review-proposal`).

---

## 1. Resolve the transaction details

Determine the input mode from `$ARGUMENTS` and extract the full Safe tx tuple
(`to`, `value`, `data`, `operation`, `safeTxGas`, `baseGas`, `gasPrice`,
`gasToken`, `refundReceiver`, `nonce`) plus `chainId` and the Safe address.

**Mode A — tx-service (`<network> <safe> <nonce>`):** the transaction is already
proposed. `safe_hashes.sh` will fetch it; you can also pull the raw tuple and the
collected signatures from the Safe Transaction Service:
```bash
curl -s "https://safe-transaction-<network>.safe.global/api/v1/multisig-transactions/?safe=<SAFE>&nonce=<NONCE>" | jq '.results[0]'
# fields: to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken,
#         refundReceiver, nonce, safeTxHash, confirmations[].{owner,signature}
```

**Mode B — Transaction Builder / Tally JSON (`<bundle.json>`):** parse
`transactions[]`. A single entry maps directly to `to`/`value`/`data` with
`operation = 0`. Multiple entries become one **MultiSend delegatecall**
(`operation = 1`, `to =` MultiSendCallOnly): build the packed payload
(`{operation u8}{to address}{value u256}{dataLen u256}{data}` per call, concatenated)
and wrap it with `cast calldata "multiSend(bytes)" 0x<packed>`. Such bundles are
usually **not yet proposed**, so use `--interactive` for hashing (§2).

**Mode C — Safe UI URL / raw params:** extract the Safe address and tx id from the
URL (`.../transactions/tx?safe=<chain>:<safe>&id=multisig_<safe>_<safeTxHash>`),
then fetch by `safeTxHash` from the tx-service as in Mode A, or accept raw params.

Record everything in the review's **Transaction Details** section.

---

## 2. Verify the hashes against the front-end  (hard gate)

Recompute the EIP-712 hashes and compare to what the Safe UI shows the signers.

```bash
./safe-tx-hashes-util/safe_hashes.sh --network <network> --address <SAFE> --nonce <NONCE>
# Not-yet-proposed bundle (Mode B): add --interactive and enter the tuple manually.
# Nested signer Safe: add --nested-safe-address <addr> --nested-safe-nonce <n>.
```
Capture the printed **Domain hash**, **Message hash**, and **safeTxHash**.

**Compare all three against the Safe front-end / signing device.** If any differ,
record a **CRITICAL** finding and stop — do not proceed to simulation.

Fallback if `safe_hashes.sh` is unavailable — compute the safeTxHash on-chain:
```bash
cast call <SAFE> "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
  <TO> <VALUE> <DATA> <OPERATION> <SAFE_TX_GAS> <BASE_GAS> <GAS_PRICE> <GAS_TOKEN> <REFUND_RECEIVER> <NONCE> \
  --rpc-url <RPC>
```

---

## 3. Verify the signers

For each `confirmations[].signature`, recover the signer and confirm they are a
real, current owner — and that the count meets threshold.

```bash
SIG=<signature>;  HASH=<safeTxHash>
R="0x${SIG:2:64}"; S="0x${SIG:66:64}"; V=$((16#${SIG:130:2}))
# eth_sign signatures use v = 31/32 -> subtract 4 before ecrecover.
[ "$V" -ge 31 ] && V=$((V-4))
RAW=$(cast call 0x0000000000000000000000000000000000000001 \
       "$(cast abi-encode "f(bytes32,uint256,bytes32,bytes32)" "$HASH" "$V" "$R" "$S")" --rpc-url <RPC>)
RECOVERED="0x${RAW:26}"
cast call <SAFE> "isOwner(address)(bool)" "$RECOVERED" --rpc-url <RPC>
```
Note: `v = 0/1` are contract / approved-hash (prevalidated) signatures, not
ECDSA — flag and verify separately. Confirm distinct valid owners ≥
`cast call <SAFE> "getThreshold()(uint256)"`.

---

## 4. Decode the actions

- Compound governance/timelock payload → `pnpm decode <id>` where applicable.
- Otherwise: identify the selector (`cast 4byte <0xsel>`) and decode args
  (`cast calldata-decode "<sig>" <DATA>`). Decode **every** sub-call of a MultiSend.
- Verify every address on-chain with `cast` (owner/admin/role relationships,
  token identities) — never trust Etherscan labels alone.

---

## 5. Security review

Walk **`references/security-checklist.md`** in full. It covers: calldata-vs-intent
mismatch, `operation`/delegatecall target trust, changes to the Safe's own
owners/threshold/modules/guard/fallback/singleton, ownership & role transfers
(incl. Zodiac Roles scoping), asset movement, gas/refund griefing, nonce/replay,
signers, and execution feasibility. Record each finding with its severity and a
verification source (a `cast` command, doc, or decode).

---

## 6. Simulate on a fresh Tenderly virtual testnet

Generate and run the simulation script:

1. Copy `assets/simulate-template.sh` → `reviews/multisig-<id>.simulate.sh`.
2. Fill the PARAMETERS block: `NETWORK`, `CHAIN_ID`, `SAFE`, the full tx tuple,
   `SAFE_NONCE`, and `SIGNATURES` (paste the concatenated collected signatures,
   **sorted by signer address ascending**, when threshold is already met; leave
   `SIGNATURES=""` to use the threshold-override + prevalidated-owner-sig fallback).
3. Run it and capture output:
   ```bash
   bash reviews/multisig-<id>.simulate.sh            # keeps the vnet for inspection
   bash reviews/multisig-<id>.simulate.sh --delete-after
   ```

The script: creates a fresh vnet → aligns the Safe nonce → funds the executor →
calls `Safe.execTransaction(...)` faithfully → if the inner call is
`TimelockController.schedule(...)` it advances time by the delay and calls
`execute(...)`. It asserts every receipt is `status 0x1` and warns on a Safe
`ExecutionFailure` event.

**The review may only be APPROVED if the simulation ends with `RESULT: SUCCESS`.**
Record the vnet id, the `execTransaction` tx hash + gas, any timelock `execute`
tx, and the dashboard URL.

---

## 7. Review output template

Write to `reviews/multisig-<id>.md`:

```markdown
# Multisig Tx Review — <id>

**Date:** YYYY-MM-DD
**Reviewer:** [Name]
**Status:** PENDING REVIEW | APPROVED | APPROVED WITH NOTES | REJECTED

## Summary
- **Safe:** <address> (<network>, chainId <n>)
- **Nonce:** <n>
- **Type:** [Owner change / Role update / Transfer / Timelock schedule / Mixed]
- **Risk Level:** [Low / Medium / High / Critical]

[1-2 sentence description of what this transaction does.]

## Transaction Details
| Field | Value |
|-------|-------|
| to | <addr> |
| value | <wei> |
| operation | 0 CALL / 1 DELEGATECALL |
| data | <0x… or hash + length> |
| safeTxGas / baseGas / gasPrice | … |
| gasToken / refundReceiver | … |
| nonce | <n> |

## Hash Verification
| Hash | Computed (safe_hashes.sh) | Front-end | Status |
|------|---------------------------|-----------|--------|
| Domain | 0x… | 0x… | ✓ MATCH |
| Message | 0x… | 0x… | ✓ MATCH |
| safeTxHash | 0x… | 0x… | ✓ MATCH |

## Signature Verification
| # | Expected signer | Recovered | isOwner | Status |
|---|-----------------|-----------|---------|--------|
| 1 | 0x… | 0x… | ✓ | VALID |

Threshold: <m> of <n> — **met / not met**.

## Decoded Actions
1. <target>.<fn>(<args>) — <plain-English meaning>

## Findings
| # | Severity | Description | Source |
|---|----------|-------------|--------|
| 1 | INFO | … | `cast call …` |

## Security Checklist
| Section | Result | Notes |
|---------|--------|-------|
| Calldata vs intent | ✓ | hashes match |
| operation / delegatecall | ✓ | … |
| Safe owners/threshold/modules | ✓ | unchanged |
| Ownership / roles | ✓ | … |
| Asset movement | ✓ | … |
| Gas / refund griefing | ✓ | gasPrice=0, refundReceiver=0 |
| Nonce / replay | ✓ | matches on-chain nonce |

## Simulation Results
| Check | Result | Details |
|-------|--------|---------|
| Fresh vnet | created | <vnetId> |
| execTransaction | SUCCESS | gas <…> · tx 0x… |
| Timelock execute | SUCCESS / N/A | tx 0x… |
| Dashboard | — | <url> |

## Recommendation
**[APPROVE / APPROVE WITH NOTES / REJECT]**

[Reasoning. List any conditions or follow-ups.]
```

---

## Quick reference

**Safe storage slots (≥ v1.3.0):** `owners` mapping = slot 2, `ownerCount` = slot 3,
`threshold` = slot 4, `nonce` = slot 5.

**Prevalidated (approved-hash) signature:** `r` = owner left-padded to 32 bytes,
`s` = 32 zero bytes, `v` = `01`. Valid when `msg.sender == owner` (or the owner
called `approveHash`). The template uses this for the threshold-override path.

**Trusted delegatecall libraries:** MultiSendCallOnly `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`;
MultiSend `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` (can itself delegatecall — extra scrutiny).

**Safe ExecutionFailure topic:** `0x23428b18acfb3ea64b08dc0c1d296ea9c09702c09083ca5272e64d115b687d23`.
**Safe ExecutionSuccess topic:** `0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e`.

**Common Compound addresses:** Timelock(v2) `0x6d903f6003cca6255D85CcA4D3B5E5146dC33925`,
COMP `0xc00e94Cb662C3520282E6f5717214004A7f26888`,
Comptroller `0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B`.

**RPCs:** ethereum `https://ethereum-rpc.publicnode.com` · base `https://base-rpc.publicnode.com` ·
optimism `https://optimism-rpc.publicnode.com` · arbitrum `https://arbitrum-one-rpc.publicnode.com` ·
polygon `https://polygon-bor-rpc.publicnode.com`. (Or use `chains.<net>.rpcUrl` from compound-config.json.)
