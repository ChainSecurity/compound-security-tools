import boxen from "boxen";
import stringWidth from "string-width";
import chalk from "chalk";
import wrapAnsi from "wrap-ansi";
import { checksum } from "@/utils";
import type { AddressMetadataMap, CallInsight, CallNode, DecodedProposal, CallEdge, SourcedAddressMetadataMap } from "@/types";
import { unwrap } from "@/types/sources";
import type { ParamType } from "ethers";
import assert from "assert";

/* ----------------------------- width helpers ----------------------------- */

function termWidth(): number {
  // clamp to something readable; many CI envs report very large/small widths
  const w =
    typeof process !== "undefined" && process.stdout && process.stdout.columns
      ? process.stdout.columns
      : 120;
  return Math.max(80, w);
}

function innerWidth(parentWidth: number, indentSpaces = 2): number {
  // account for indent plus a bit of breathing room
  return Math.max(0, parentWidth - indentSpaces);
}

/* ------------------------------- formatting ------------------------------ */

function selectorOf(data: string): string {
  if (!data || data === "0x") return "0x00000000";
  return data.slice(0, 10);
}

function renderAddressValue(value: unknown, metadata?: AddressMetadataMap | SourcedAddressMetadataMap): string {
  const raw = typeof value === "string" ? value : String(value ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return raw;

  try {
    const addr = checksum(raw);
    const info = metadata?.[addr];
    if (!info) return addr;

    const descriptors: string[] = [];
    const push = (part?: string | null) => {
      if (!part) return;
      const trimmed = part.trim();
      if (!trimmed || descriptors.includes(trimmed)) return;
      descriptors.push(trimmed);
    };

    // Unwrap potentially sourced values
    push(unwrap(info.contractName) ?? undefined);
    push(unwrap(info.etherscanLabel) ?? undefined);
    push(unwrap(info.tokenSymbol) ?? undefined);
    push(unwrap(info.ensName) ?? undefined);
    if (info.labels && info.labels.length) {
      push(info.labels[0]);
    }

    let rendered = addr;
    if (descriptors.length) {
      rendered += ` ${chalk.gray(`(${descriptors.join(" · ")})`)}`;
    }

    if (info.implementation) {
      const implParts: string[] = [];
      const pushImpl = (part?: string | null) => {
        if (!part) return;
        const trimmed = part.trim();
        if (!trimmed || implParts.includes(trimmed)) return;
        implParts.push(trimmed);
      };
      pushImpl(unwrap(info.implementation.contractName) ?? undefined);
      pushImpl(unwrap(info.implementation.etherscanLabel) ?? undefined);
      pushImpl(unwrap(info.implementation.tokenSymbol) ?? undefined);
      if (info.implementation.labels && info.implementation.labels.length) {
        pushImpl(info.implementation.labels[0]);
      }
      pushImpl(unwrap(info.implementation.ensName) ?? undefined);

      const implAddr = unwrap(info.implementation.address);
      rendered += ` ${chalk.gray(`→ ${implAddr}`)}`;
      if (implParts.length) {
        rendered += ` ${chalk.gray(`(${implParts.join(" · ")})`)}`;
      }
    }

    return rendered;
  } catch {
    return raw;
  }
}

function wrapLine(s: string, width: number): string {
  return wrapAnsi(s, width, { hard: true, trim: false });
}

function wrapLines(lines: string[], width: number): string[] {
  return lines.flatMap((l) => wrapLine(l, width).split("\n"));
}

function formatCalldata(data: string, width: number): string[] {
  if (!data || data === "0x") return [`${chalk.cyan("Calldata:")} 0x`];

  const lenBytes = (data.length - 2) / 2;
  const head = data.slice(0, 46); // 32 bytes + 0x + 2 chars
  const tail = data.length > 120 ? data.slice(-38) : "";
  const preview = tail ? `${head}…${tail}` : data;
  const line = `${chalk.cyan("Calldata:")} ${preview}  ${chalk.gray(`(${lenBytes} bytes)`)}`;
  return wrapLines([line], width);
}

function isUintType(param: ParamType): boolean {
  const base = param.baseType;
  if (typeof base !== "string") return false;
  return base.startsWith("uint");
}

function coerceToBigInt(value: unknown): bigint | null {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === "string") {
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }
  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof (value as { toString(): unknown }).toString === "function"
  ) {
    try {
      const asString = (value as { toString(): string }).toString();
      return BigInt(asString);
    } catch {
      return null;
    }
  }
  return null;
}

function formatWithFixedDecimals(value: bigint, decimals = 18): string {
  const base = 10n ** BigInt(decimals);
  const negative = value < 0n;
  const absValue = negative ? -value : value;
  const integer = absValue / base;
  const fraction = absValue % base;
  const fractionStr = fraction.toString().padStart(decimals, "0");
  const prefix = negative ? "-" : "";
  return `${prefix}${integer.toString()}.${fractionStr}`;
}

function formatUintValue(value: unknown): string {
  const big = coerceToBigInt(value);
  if (big === null) return String(value);
  const prefix = big < 0n ? "-0x" : "0x";
  const hex = `${prefix}${(big < 0n ? -big : big).toString(16)}`;
  const dec = big.toString(10);
  const dec18 = formatWithFixedDecimals(big);
  return `${hex} (int: ${dec}; /1e18: ${dec18})`;
}

/**
 * bytes32 arguments are often a left-aligned, NUL-padded ASCII tag (TimelockController
 * salts, role identifiers, market names). Show the text alongside the hex so a reviewer
 * does not have to decode it by hand.
 */
function bytes32Ascii(value: unknown): string | null {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  const bytes = Buffer.from(value.slice(2), "hex");
  const nul = bytes.indexOf(0);
  const head = nul === -1 ? bytes : bytes.subarray(0, nul);
  if (head.length < 3) return null;
  if (bytes.subarray(head.length).some((b) => b !== 0)) return null;
  if (head.some((b) => b < 0x20 || b > 0x7e)) return null;
  return head.toString("ascii");
}

function stringifyWithBigInt(value: unknown): string {
  try {
    return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  } catch {
    return String(value);
  }
}

function formatValueForDisplay(
  value: unknown,
  param: ParamType,
  metadata?: AddressMetadataMap | SourcedAddressMetadataMap
): string {
  if (param.baseType === "array" && Array.isArray(value) && param.arrayChildren) {
    const child = param.arrayChildren;
    const rendered = value.map((item) => formatValueForDisplay(item, child, metadata));
    return `[${rendered.join(", ")}]`;
  }

  if (param.baseType === "array") {
    return String(value);
  }

  if (param.baseType === "address") {
    return renderAddressValue(value, metadata);
  }

  if (isUintType(param)) {
    return formatUintValue(value);
  }

  if (param.type === "bytes32") {
    const ascii = bytes32Ascii(value);
    if (ascii) return `${String(value)} (ascii: "${ascii}")`;
  }

  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;

  return stringifyWithBigInt(value);
}

function prettyPrintArg(
  lines: string[],
  arg: unknown,
  param: ParamType,
  width: number,
  indent: number,
  metadata?: AddressMetadataMap | SourcedAddressMetadataMap
) {
  const prefix = " ".repeat(indent);
  const name = param.name ? chalk.cyan(`${param.name}`) : chalk.gray("(unnamed)");
  const typeNote = chalk.gray(`(${param.type})`);

  if (param.baseType === "tuple") {
    if (!Array.isArray(arg) || !param.components) {
      lines.push(
        ...wrapLines(
          [`${prefix}- ${name} ${typeNote}: ${chalk.red("(invalid/missing tuple data)")}`],
          width
        )
      );
    } else if (arg.length !== param.components.length) {
      lines.push(
        ...wrapLines(
          [
            `${prefix}- ${name} ${typeNote}: ${chalk.red(
              `(tuple length mismatch: expected ${param.components.length}, got ${arg.length})`
            )}`,
          ],
          width
        )
      );
    }

    assert(Array.isArray(arg) && param.components);

    lines.push(...wrapLines([`${prefix}- ${name} ${typeNote}:`], width));
    param.components?.forEach((comp, i) => {
      prettyPrintArg(lines, arg[i], comp, width, indent + 2, metadata);
    });

    return;
  }

  if (param.type === "string") {
    let rendered: string;
    try {
      const parsed = JSON.parse(String(arg ?? ""));
      rendered = JSON.stringify(parsed, null, 2);
    } catch {
      rendered = JSON.stringify(arg ?? "");
    }

    const newLines = wrapLines([`${prefix}- ${name} ${typeNote}: ${chalk.white(rendered)}`], width);
    if (newLines.length === 1) {
      lines.push(...newLines);
    } else {
      lines.push(
        ...wrapLines([`${prefix}- ${name} ${chalk.gray(`(${param.type} [json])`)}:`], width)
      );
      for (const l of rendered.split("\n")) {
        lines.push(
          ...wrapLines([chalk.white(l)], width - prefix.length - 2).map((ll) => prefix + "  " + ll)
        );
      }
    }
    return;
  }

  if (param.baseType === "array" && (!Array.isArray(arg) || !param.arrayChildren)) {
    const errorLine = `${prefix}- ${name} ${typeNote}: ${chalk.red("(invalid/missing array data)")}`;
    lines.push(...wrapLines([errorLine], width));
    return;
  }

  let rendered = formatValueForDisplay(arg, param, metadata);
  if (rendered.startsWith('"') && rendered.endsWith('"')) {
    rendered = rendered.slice(1, -1);
  }
  const newLine = `${prefix}- ${name} ${typeNote}: ${chalk.white(rendered)}`;
  if (stringWidth(newLine) <= width) {
    lines.push(newLine);
  } else {
    lines.push(`${prefix}- ${name} ${typeNote}:`);
    for (const l of rendered.split("\n")) {
      lines.push(
        ...wrapLines([chalk.white(l)], width - prefix.length - 2).map((ll) => prefix + "  " + ll)
      );
    }
  }
}

function edgeLabel(edge: CallEdge) {
  const edgeType = unwrap(edge.type);
  const edgeChainId = edge.chainId ? unwrap(edge.chainId) : undefined;
  const edgeLabelStr = edge.label ? unwrap(edge.label) : undefined;

  if (edgeType === "bridge") {
    return `Bridge → chain ${edgeChainId ?? "?"}${edgeLabelStr ? ` (${edgeLabelStr})` : ""}`;
  }
  if (edgeType === "multicall") {
    const idx = typeof edge.meta?.index === "number" ? ` #${edge.meta.index}` : "";
    return `Multicall${idx}`;
  }
  if (edgeType === "delegatecall") return "Delegatecall";
  if (edgeType === "staticcall") return "Staticcall";
  return edgeLabelStr || edgeType || "child";
}

/* ------------------------------ render node ------------------------------ */

function renderInsight(insight: CallInsight, width: number): string {
  const lines: string[] = [];
  insight.entries.forEach(({ label, value }) => {
    const valueStr = unwrap(value);
    const header = `${chalk.gray(label)}:`;
    const line = `${header} ${chalk.white(valueStr)}`;
    if (stringWidth(line) <= width - 4) {
      lines.push(line);
    } else {
      lines.push(header);
      lines.push(
        ...wrapLines([chalk.white(valueStr)], width - 4).map((l) => `${" ".repeat(2)}${l}`)
      );
    }
  });

  const body = lines.join("\n");
  return boxen(body, {
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    margin: 0,
    borderStyle: "round",
    borderColor: "cyan",
    title: chalk.cyan.bold(`INSIGHT · ${insight.title}`),
    titleAlignment: "left",
    width,
  });
}

function renderNodeBody(node: CallNode, contentWidth: number): string {
  const lines: string[] = [];
  const name = node.targetContractName
    ? `${chalk.bold(node.targetContractName)} (${node.target})`
    : node.target;

  lines.push(...wrapLines([`${chalk.cyan("Chain:")}    ${node.chainId}`], contentWidth));
  lines.push(...wrapLines([`${chalk.cyan("Target:")}   ${name}`], contentWidth));
  if (node.implementation) {
    const implName = node.implementationContractName
      ? `${chalk.bold(node.implementationContractName)} (${node.implementation})`
      : node.implementation;
    lines.push(...wrapLines([`${chalk.cyan("Impl:")}     ${implName}`], contentWidth));
  }
  const valueWei = unwrap(node.valueWei);
  const rawCalldata = unwrap(node.rawCalldata);
  lines.push(
    ...wrapLines([`${chalk.cyan("Value:")}    ${valueWei.toString()} wei`], contentWidth)
  );
  lines.push(
    ...wrapLines([`${chalk.cyan("Selector:")} ${selectorOf(rawCalldata)}`], contentWidth)
  );
  lines.push(...formatCalldata(rawCalldata, contentWidth));
  lines.push(""); // spacer

  if (node.decoded) {
    const argSignature = node.decoded.argParams
      .map((p) => `${chalk.gray(p.type)} ${chalk.cyan(p.name)}`)
      .join(", ");
    const decodedName = unwrap(node.decoded.name);
    lines.push(
      ...wrapLines(
        [`${chalk.cyan("Function:")} ${decodedName}(${argSignature})`],
        contentWidth
      )
    );
    if (node.decoded.args.length > 0) {
      lines.push(...wrapLines([chalk.cyan("Arguments:")], contentWidth));
      node.decoded.args.forEach((arg, i) => {
        if (node.decoded?.argParams[i]) {
          prettyPrintArg(
            lines,
            arg,
            node.decoded.argParams[i],
            contentWidth,
            2,
            node.decoded.addressMetadata
          );
        }
      });
    } else {
      lines.push(...wrapLines([chalk.gray("  (no args)")], contentWidth));
    }

    if (node.insights?.length) {
      lines.push("");
      node.insights.forEach((ins) => {
        lines.push(renderInsight(ins, contentWidth));
      });
    }
  } else {
    lines.push(
      ...wrapLines([chalk.gray("(no decode available for target ABI / selector)")], contentWidth)
    );
  }

  if (node.notes?.length) {
    lines.push(""); // spacer
    node.notes.forEach((n) => {
      lines.push(...wrapLines([`${chalk.cyan("Note:")}     ${chalk.yellow(n)}`], contentWidth));
    });
  }

  // Children: render each child as a labeled sub-box inside this box
  if (node.children?.length) {
    const childW = innerWidth(contentWidth, 0);
    lines.push(""); // spacer
    for (const { edge, node: child } of node.children) {
      const label = edgeLabel(edge);
      const childBox = renderNode(child, label, childW); // full box string already width-controlled
      lines.push(childBox);
    }
  }

  return lines.join("\n");
}

/**
 * Render a call node as a boxed block.
 * @param node The call node to render
 * @param title Box title
 * @param width Total box width (including borders)
 */
export function renderNode(node: CallNode, title = "Call", width = termWidth()): string {
  // boxen width includes borders; internal text width is handled by wrapLine() above
  const body = renderNodeBody(node, width - 8); // -4 ~= borders/padding budget
  return boxen(body, {
    title: chalk.green.bold(title),
    padding: 1,
    margin: 0,
    borderStyle: "round",
    borderColor: "green",
    width,
  });
}

/* ----------------------------- proposal header --------------------------- */

export function prettyPrint(proposal: DecodedProposal) {
  const width = termWidth();

  const headerLines = [
    `${chalk.cyan("Governor:")}      ${proposal.governor}`,
    `${chalk.cyan("Proposal ID:")}   ${proposal.proposalId}`,
    `${chalk.cyan("DescriptionHW:")} ${proposal.descriptionHash}`,
    `${chalk.cyan("Actions:")}       ${proposal.calls.length}`,
  ];

  const header = boxen(wrapLines(headerLines, width - 8).join("\n"), {
    title: chalk.yellow.bold("Proposal Details"),
    padding: 1,
    margin: 0,
    borderStyle: "round",
    borderColor: "yellow",
    width: width,
  });

  console.log(header);

  proposal.calls.forEach((node, idx) => {
    console.log(renderNode(node, `Action #${idx}`, width));
  });
}
