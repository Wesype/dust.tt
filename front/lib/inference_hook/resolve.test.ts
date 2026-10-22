import { Authenticator } from "@app/lib/auth";
import {
  loadInferenceHook,
  resolveInferenceHooks,
} from "@app/lib/inference_hook/resolve";
import { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookFactory } from "@app/tests/utils/InferenceHookFactory";
import { describe, expect, it, vi } from "vitest";

const ENABLED = ["inference_hooks"] as const;

describe("resolveInferenceHooks", () => {
  it("does not read hooks when the feature flag is off", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    await InferenceHookFactory.basic(authenticator, { enforcement: "block" });
    const listActive = vi.spyOn(InferenceHookResource, "listByWorkspace");

    const plan = await resolveInferenceHooks(authenticator, {
      featureFlags: [],
    });

    expect(listActive).not.toHaveBeenCalled();
    expect(plan).toEqual({
      before_model_call: [],
      after_model_call: [],
    });
  });

  it("uses the events and enforcement of each active hook's current version", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const edited = await InferenceHookFactory.basic(authenticator, {
      enforcement: "block",
      events: ["before_model_call"],
    });
    await InferenceHookFactory.withNewVersion(authenticator, edited, {
      events: ["after_model_call"],
      enforcement: "monitor",
    });
    await InferenceHookFactory.basic(authenticator, {
      enforcement: "block",
      events: ["before_model_call", "after_model_call"],
      onError: "deny",
      timeoutMs: 1_500,
    });
    const providerEnforced = await InferenceHookFactory.basic(authenticator, {
      enforcement: null,
      events: ["before_model_call", "after_model_call"],
    });
    await InferenceHookFactory.archived(authenticator, {
      enforcement: "block",
      events: ["before_model_call"],
    });

    const plan = await resolveInferenceHooks(authenticator, {
      featureFlags: ENABLED,
    });

    expect(
      plan.before_model_call.filter(
        ({ enforcement }) => enforcement === "monitor"
      )
    ).toEqual([]);
    expect(
      plan.after_model_call.filter(
        ({ enforcement }) => enforcement === "monitor"
      )
    ).toEqual([
      expect.objectContaining({
        hookId: edited.sId,
        hookVersion: 2,
        enforcement: "monitor",
      }),
    ]);
    for (const event of ["before_model_call", "after_model_call"] as const) {
      const blockHooks = plan[event].filter(
        ({ enforcement }) => enforcement === "block"
      );
      expect(blockHooks).toHaveLength(2);
      expect(blockHooks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            enforcement: "block",
            onError: "deny",
            timeoutMs: 1_500,
          }),
          expect.objectContaining({
            hookId: providerEnforced.sId,
            enforcement: "block",
          }),
        ])
      );
    }
  });

  it("skips a hook when the user is in an excluded group", async () => {
    const { authenticator, globalGroup } = await createResourceTest({
      role: "admin",
    });
    await InferenceHookFactory.basic(authenticator, {
      enforcement: "block",
      timeoutMs: 1_000,
      excludedGroupIds: [globalGroup.id],
    });
    await InferenceHookFactory.basic(authenticator, {
      enforcement: "block",
      timeoutMs: 2_000,
    });

    const plan = await resolveInferenceHooks(authenticator, {
      featureFlags: ENABLED,
    });

    expect(plan.before_model_call.map((hook) => hook.timeoutMs)).toEqual([
      2_000,
    ]);
  });

  it("keeps an excluded hook for a run with no user", async () => {
    const { authenticator, workspace, globalGroup } = await createResourceTest({
      role: "admin",
    });
    await InferenceHookFactory.basic(authenticator, {
      enforcement: "block",
      excludedGroupIds: [globalGroup.id],
    });

    const plan = await resolveInferenceHooks(
      await Authenticator.internalAdminForWorkspace(workspace.sId),
      { featureFlags: ENABLED }
    );

    expect(plan.before_model_call).toHaveLength(1);
  });
});

describe("loadInferenceHook", () => {
  it("loads the pinned version after the hook was edited", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const hook = await InferenceHookFactory.basic(authenticator, {
      enforcement: "monitor",
      timeoutMs: 1_000,
    });
    await InferenceHookFactory.withNewVersion(authenticator, hook, {
      events: ["before_model_call"],
      enforcement: "monitor",
      timeoutMs: 9_000,
    });

    const result = await loadInferenceHook(authenticator, {
      hookId: hook.sId,
      hookVersion: 1,
    });

    expect(result.isOk() && result.value.timeoutMs).toBe(1_000);
  });

  it("returns an error for a hook of another workspace", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const hook = await InferenceHookFactory.basic(authenticator, {
      enforcement: "monitor",
    });
    const { authenticator: otherAuth } = await createResourceTest({
      role: "admin",
    });

    const result = await loadInferenceHook(otherAuth, {
      hookId: hook.sId,
      hookVersion: 1,
    });

    expect(result.isErr()).toBe(true);
  });
});
