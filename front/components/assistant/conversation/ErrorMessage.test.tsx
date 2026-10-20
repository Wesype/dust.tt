import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LightWorkspaceFactory } from "@app/tests/utils/LightWorkspaceFactory";
import { ErrorMessage } from "./ErrorMessage";

describe("ErrorMessage", () => {
  it("offers a retry for a retryable error", () => {
    render(
      <ErrorMessage
        owner={LightWorkspaceFactory.build()}
        error={{
          code: "multi_actions_error",
          message: "The model returned no content.",
          metadata: { category: "empty_content" },
        }}
        retryHandler={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("does not offer a retry when a workspace hook blocked the request", () => {
    render(
      <ErrorMessage
        owner={LightWorkspaceFactory.build()}
        error={{
          code: "inference_hook_denied",
          message: "Prompt injection detected.",
          metadata: {
            category: "hook_blocked",
            lifecycleEvent: "before_model_call",
          },
        }}
        retryHandler={vi.fn()}
      />
    );

    expect(screen.getByText("Blocked by your workspace policy")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
