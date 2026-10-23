import { isToolAuthorized } from "@app/lib/api/frames/tool_authorization_coverage";
import { describe, expect, it } from "vitest";

describe("isToolAuthorized", () => {
  it("returns false for an empty authorized set", () => {
    expect(isToolAuthorized([], ["msv_a", "search"])).toBe(false);
  });

  it("matches an exact server/tool pair", () => {
    expect(
      isToolAuthorized(
        [
          ["msv_a", "search"],
          ["msv_b", "post"],
        ],
        ["msv_a", "search"]
      )
    ).toBe(true);
    expect(isToolAuthorized([["msv_a", "search"]], ["msv_a", "other"])).toBe(
      false
    );
    expect(isToolAuthorized([["msv_a", "search"]], ["msv_b", "search"])).toBe(
      false
    );
  });
});
