import { describe, expect, it } from "vitest";

import { stableStringify } from "@app/types/shared/utils/stable_stringify";

describe("stableStringify", () => {
  it("sorts keys at every depth", () => {
    expect(stableStringify({ b: { d: 1, c: [{ f: 1, e: 2 }] }, a: 0 })).toBe(
      '{"a":0,"b":{"c":[{"e":2,"f":1}],"d":1}}'
    );
  });

  it("drops undefined properties and returns null for non-JSON values", () => {
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
    expect(stableStringify(undefined)).toBeNull();
    expect(stableStringify(() => 1)).toBeNull();
  });

  it("keeps a JSON key named __proto__", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"source":"crm"}}');

    expect(stableStringify(parsed)).toBe('{"__proto__":{"source":"crm"}}');
    expect(stableStringify(parsed)).not.toBe(stableStringify({}));
  });
});
