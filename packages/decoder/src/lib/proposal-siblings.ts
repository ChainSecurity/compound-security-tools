import { Interface } from "ethers";
import { checksum } from "@/utils";
import { logger } from "@/logger";
import type { SiblingCalls } from "@/registry";

/**
 * Insights are built from live chain state, but a governance proposal executes its
 * actions atomically and in order. Any action that reads state a *preceding action
 * in the same proposal* rewrites therefore reports a value that will already be
 * stale by the time the call it describes runs.
 *
 * Proposal 604 is the motivating case: action #0 bumps `CometFactoryV2.version`
 * from 1.0.0 to 1.2.1, actions #1/#4 point two markets at that factory, and
 * actions #3/#6 redeploy them. Read against live state, the factory insight
 * reports "version 1.0.0" and the redeploy insight reports the *old* factory and
 * concludes the market is "already on the code this factory currently produces" —
 * i.e. that the upgrade is a no-op, when in fact it deploys new v1.2.1 code.
 *
 * These helpers let a handler ask what an earlier action in the same proposal has
 * already staged, so the insight can describe execution-time state instead.
 */

const SET_VERSION_SIG =
  "setVersion(((uint64,uint64,uint64),string))";
const SET_FACTORY_SIG = "setFactory(address,address)";
const SET_EXTENSION_DELEGATE_SIG = "setExtensionDelegate(address,address)";

const setVersionIface = new Interface([`function ${SET_VERSION_SIG}`]);
const setFactoryIface = new Interface([`function ${SET_FACTORY_SIG}`]);
const setExtIface = new Interface([`function ${SET_EXTENSION_DELEGATE_SIG}`]);

function selectorOf(iface: Interface, name: string): string {
  return iface.getFunction(name)!.selector.toLowerCase();
}

const SET_VERSION_SELECTOR = selectorOf(setVersionIface, "setVersion");
const SET_FACTORY_SELECTOR = selectorOf(setFactoryIface, "setFactory");
const SET_EXTENSION_DELEGATE_SELECTOR = selectorOf(setExtIface, "setExtensionDelegate");

/** A change an earlier action in the same proposal has already staged. */
export type StagedChange<T> = {
  /** Index of the action that stages it, as printed in the decode output. */
  actionIndex: number;
  value: T;
};

/**
 * Walk only the actions that execute *before* the current one, on the same chain.
 * Later actions cannot affect the call being described, and actions on another
 * chain touch different contracts.
 */
function precedingCalls(
  siblings: SiblingCalls | undefined,
  chainId: number
): Array<{ index: number; target: string; rawCalldata: string }> {
  if (!siblings) return [];
  const out: Array<{ index: number; target: string; rawCalldata: string }> = [];
  for (let i = 0; i < siblings.calls.length && i < siblings.index; i++) {
    const call = siblings.calls[i]!;
    if (call.chainId !== chainId) continue;
    out.push({ index: i, target: checksum(call.target), rawCalldata: call.rawCalldata });
  }
  return out;
}

function selectorOfCalldata(rawCalldata: string): string {
  return rawCalldata.slice(0, 10).toLowerCase();
}

/**
 * The version an earlier action sets on `factory`, formatted `major.minor.patch`
 * (plus any `alternative` suffix). `null` when no earlier action touches it.
 */
export function stagedFactoryVersion(
  siblings: SiblingCalls | undefined,
  chainId: number,
  factory: string
): StagedChange<string> | null {
  const wanted = checksum(factory);
  let found: StagedChange<string> | null = null;
  for (const call of precedingCalls(siblings, chainId)) {
    if (call.target !== wanted) continue;
    if (selectorOfCalldata(call.rawCalldata) !== SET_VERSION_SELECTOR) continue;
    try {
      const args = setVersionIface.decodeFunctionData("setVersion", call.rawCalldata);
      const [version, alternative] = args[0] as [[bigint, bigint, bigint], string];
      // Later actions win: the factory ends up on whatever the last setVersion set.
      found = {
        actionIndex: call.index,
        value: `${version[0]}.${version[1]}.${version[2]}${alternative ? ` (${alternative})` : ""}`,
      };
    } catch (err) {
      logger.debug({ err, target: call.target }, "proposal-siblings: undecodable setVersion");
    }
  }
  return found;
}

function stagedAddressForComet(
  siblings: SiblingCalls | undefined,
  chainId: number,
  cometProxy: string,
  selector: string,
  iface: Interface,
  fnName: string
): StagedChange<string> | null {
  const wantedComet = checksum(cometProxy);
  let found: StagedChange<string> | null = null;
  for (const call of precedingCalls(siblings, chainId)) {
    if (selectorOfCalldata(call.rawCalldata) !== selector) continue;
    try {
      const args = iface.decodeFunctionData(fnName, call.rawCalldata);
      if (checksum(args[0] as string) !== wantedComet) continue;
      found = { actionIndex: call.index, value: checksum(args[1] as string) };
    } catch (err) {
      logger.debug({ err, fnName }, "proposal-siblings: undecodable setter");
    }
  }
  return found;
}

/** The factory an earlier `setFactory(comet, ...)` in this proposal stages for `cometProxy`. */
export function stagedFactory(
  siblings: SiblingCalls | undefined,
  chainId: number,
  cometProxy: string
): StagedChange<string> | null {
  return stagedAddressForComet(
    siblings,
    chainId,
    cometProxy,
    SET_FACTORY_SELECTOR,
    setFactoryIface,
    "setFactory"
  );
}

/** The delegate an earlier `setExtensionDelegate(comet, ...)` stages for `cometProxy`. */
export function stagedExtensionDelegate(
  siblings: SiblingCalls | undefined,
  chainId: number,
  cometProxy: string
): StagedChange<string> | null {
  return stagedAddressForComet(
    siblings,
    chainId,
    cometProxy,
    SET_EXTENSION_DELEGATE_SELECTOR,
    setExtIface,
    "setExtensionDelegate"
  );
}
