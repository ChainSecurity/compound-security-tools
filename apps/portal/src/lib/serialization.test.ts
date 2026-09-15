import { describe, it, expect } from "vitest";
import { serializeBigInts } from "./serialization";

describe("serializeBigInts", () => {
  it("converts bigint to string", () => {
    expect(serializeBigInts(123n)).toBe("123");
    expect(serializeBigInts(0n)).toBe("0");
    expect(serializeBigInts(BigInt("99999999999999999999"))).toBe("99999999999999999999");
  });

  it("passes through primitives unchanged", () => {
    expect(serializeBigInts(42)).toBe(42);
    expect(serializeBigInts("hello")).toBe("hello");
    expect(serializeBigInts(true)).toBe(true);
    expect(serializeBigInts(false)).toBe(false);
  });

  it("passes through null and undefined", () => {
    expect(serializeBigInts(null)).toBeNull();
    expect(serializeBigInts(undefined)).toBeUndefined();
  });

  it("recursively serializes bigints in objects", () => {
    const input = { value: 100n, label: "test", count: 5 };
    expect(serializeBigInts(input)).toEqual({ value: "100", label: "test", count: 5 });
  });

  it("recursively serializes bigints in arrays", () => {
    expect(serializeBigInts([1n, 2n, 3n])).toEqual(["1", "2", "3"]);
    expect(serializeBigInts([1n, "a", true])).toEqual(["1", "a", true]);
  });

  it("recursively serializes nested structures", () => {
    const input = {
      nested: { gas: 1000000n, name: "tx" },
      values: [10n, 20n],
    };
    expect(serializeBigInts(input)).toEqual({
      nested: { gas: "1000000", name: "tx" },
      values: ["10", "20"],
    });
  });

  it("skips argParams and rawArgs fields", () => {
    const input = {
      method: "transfer",
      argParams: { something: "internal" },
      rawArgs: [1n, 2n],
      value: 99n,
    };
    const result = serializeBigInts(input) as Record<string, unknown>;
    expect(result.method).toBe("transfer");
    expect(result.value).toBe("99");
    expect(result.argParams).toBeUndefined();
    expect(result.rawArgs).toBeUndefined();
  });

  it("handles arrays of objects with bigints", () => {
    const input = [{ gas: 1n }, { gas: 2n }];
    expect(serializeBigInts(input)).toEqual([{ gas: "1" }, { gas: "2" }]);
  });

  it("round-trips through JSON.parse/stringify", () => {
    const input = { gasUsed: 1234567890n, success: true, name: "exec" };
    const serialized = serializeBigInts(input);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ gasUsed: "1234567890", success: true, name: "exec" });
  });
});
