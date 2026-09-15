# Multisig (Safe) Transaction Security Checklist

Work through every section. For each item, record the **observed value**, the
**verification source** (a `cast` command, an authoritative doc, or a decode),
and a severity if something is off. "Trust the front-end" is never a source.

> Severity scale (same as `review-proposal`): CRITICAL / HIGH / MEDIUM / LOW / INFO.

---

## 0. The cardinal rule — does the calldata match the intent?

The single most common Safe exploit is a UI that shows benign intent while the
signed calldata does something else.

- [ ] `safe_hashes.sh` domain hash, message hash and **safeTxHash** match what
      the Safe front-end displays. **Any mismatch = CRITICAL, stop.**
- [ ] The decoded `to` / `value` / `data` / `operation` match the human
      description of the transaction.
- [ ] Calldata was taken from the wallet/hardware device or recomputed — **not**
      copied from the Safe UI "copy" button.

---

## 1. `operation` and delegatecall targets

`operation = 1` is a **DELEGATECALL** — the target's code runs in the Safe's
storage context and can rewrite owners, threshold, modules, or the singleton.

- [ ] If `operation == 1`, the target is a **known, trusted** library only:
  - MultiSendCallOnly `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` (cannot itself delegatecall)
  - MultiSend `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` (⚠ can delegatecall — riskier)
  - SignMessageLib, or another explicitly vetted address.
- [ ] An unrecognised delegatecall target = **CRITICAL**.
- [ ] For a MultiSend batch, decode **every** inner sub-call (to / value /
      operation / data) and run the rest of this checklist on each one. A
      sub-call with its own `operation = 1` is a red flag.

---

## 2. Changes to the Safe's own security parameters

Any call where `to == SAFE` mutates the multisig itself. Verify the new state.

- [ ] `addOwnerWithThreshold(owner, threshold)` — new owner expected? threshold sane?
- [ ] `removeOwner(prev, owner, threshold)` — does not drop below intended threshold.
- [ ] `swapOwner(prev, old, new)` — `new` is a known signer.
- [ ] `changeThreshold(n)` — not lowered to an unsafe value (e.g. 1).
- [ ] `enableModule` / `disableModule` — a module can move funds **without
      signatures**. New module = HIGH until proven trusted.
- [ ] `setGuard` — a guard can block or hijack every future execution. New guard
      = HIGH; verify the guard contract source.
- [ ] `setFallbackHandler` — fallback handler can add behaviour; verify address.
- [ ] Singleton / `masterCopy` change (a delegatecall that writes slot 0) —
      this is a Safe implementation upgrade = CRITICAL unless explicitly intended.

Verify resulting state on the simulated vnet after execution:
```bash
cast call <SAFE> "getOwners()(address[])"      --rpc-url <VNET>
cast call <SAFE> "getThreshold()(uint256)"     --rpc-url <VNET>
cast call <SAFE> "getModulesPaginated(address,uint256)(address[],address)" 0x0000000000000000000000000000000000000001 10 --rpc-url <VNET>
```

---

## 3. Ownership / privilege transfers in target contracts

- [ ] `transferOwnership(addr)` / `acceptOwnership()` — `addr` is the intended
      controller (often a timelock or the Safe). Verify with
      `cast call <TARGET> "owner()(address)"` and `pendingOwner()` where present.
- [ ] `grantRole` / `revokeRole` / `setPendingAdmin` / `_setPendingAdmin` —
      confirm the role and grantee.
- [ ] Zodiac **Roles** changes (`scopeTarget`, `scopeFunction`, `allowFunction`,
      `revokeTarget`, `revokeFunction`, `allowTarget`): for **each** call verify
      the target address, the 4-byte selector, and the condition tree. A
      `scopeFunction`/`allowFunction` widening permissions to an unverified
      router or selector = HIGH. Cross-check every router/selector on-chain.

---

## 4. Asset movement

- [ ] ERC20 `transfer` / `transferFrom`: recipient and amount match intent
      (mind decimals — USDC/USDT = 6, COMP/WETH = 18).
- [ ] ERC20 `approve`: spender is trusted; allowance is bounded (not an
      unnecessary `type(uint256).max`); existing allowance considered.
- [ ] Native `value` transfers: recipient correct; Safe/timelock has the balance.
- [ ] Source has sufficient balance for the action
      (`cast call <TOKEN> "balanceOf(address)(uint256)" <SOURCE>`).

---

## 5. Gas / refund griefing

A non-zero refund path lets the executor drain the Safe under the guise of gas.

- [ ] `gasPrice == 0` (or refunds are intended and bounded).
- [ ] `gasToken == 0x0` (no exotic refund token).
- [ ] `refundReceiver == 0x0` (or an expected address).
- [ ] `safeTxGas` / `baseGas` are 0 or reasonable — large values combined with a
      non-zero `gasPrice` enable over-refund. Any non-zero refund config = MEDIUM,
      investigate.

---

## 6. Nonce, replay, and ordering

- [ ] The reviewed `nonce` equals the Safe's current on-chain nonce (no gap that
      lets a different tx execute first):
      `cast call <SAFE> "nonce()(uint256)"`.
- [ ] No other pending Safe tx shares this nonce (front-running / replacement).
- [ ] The tx is chain-specific (`chainId` in the domain matches the intended
      network) — a signature is not replayable on another chain.

---

## 7. Signers

- [ ] Each collected signature recovers to an address that is a **current Safe
      owner** (`cast call <SAFE> "isOwner(address)(bool)" <RECOVERED>`).
- [ ] Number of valid, distinct owner signatures ≥ `getThreshold()`.
- [ ] Signature `v` handled correctly (eth_sign uses `v = 31/32`; subtract 4
      before ecrecover). Contract/approved-hash signatures (`v = 0/1`) noted.

---

## 8. Execution feasibility (will it revert?)

- [ ] Target contracts are not paused; required preconditions hold.
- [ ] For a Safe → `TimelockController.schedule(...)`: the Safe holds
      `PROPOSER_ROLE`; the delay matches `getMinDelay()`; the matching
      `execute(...)` caller holds `EXECUTOR_ROLE` (or it is open / `address(0)`).
- [ ] The simulation (see SKILL.md §6) ends with **all receipts `status 0x1`**
      and no `ExecutionFailure` event from the Safe.
