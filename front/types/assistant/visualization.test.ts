import { getFramePropsFromUrlParams } from "@app/types/assistant/visualization";
import { describe, expect, it } from "vitest";
import { getFramePropsFromSearchParams } from "../../../viz/app/lib/frame-props";

describe("getFramePropsFromUrlParams", () => {
  it.each([
    {
      "props.region": "EU & UK",
      "props.year": ["2026", "2025"],
      "props.empty": "",
      source: "email",
      props: "x",
    },
    { "props.": "x" },
    { "prop.region": "x" },
    { "props.key": "x", "props.ref": "x" },
    { "props._a": "x", "props.1a": "x", "props.a-b": "x" },
    { "props.a_1": "x", "props.B": undefined },
  ])("reads the props viz reads from %j", (params) => {
    expect(getFramePropsFromUrlParams(params)).toEqual(
      getFramePropsFromSearchParams(params)
    );
  });
});
