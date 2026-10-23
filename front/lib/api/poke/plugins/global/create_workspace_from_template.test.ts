import assert from "node:assert";

import { createWorkspaceFromTemplatePlugin } from "@app/lib/api/poke/plugins/global/create_workspace_from_template";
import { SwitchContractError } from "@app/lib/api/poke/switch_contract";
import { config } from "@app/lib/api/regions/config";
import { Authenticator } from "@app/lib/auth";
import { CREDIT_PRICED_ENTERPRISE_PILOT_PLAN_CODE } from "@app/lib/plans/plan_codes";
import {
  FREE_PILOT_TEMPLATE_ID,
  MIN_PROGRAMMATIC_MONTHLY_CAP_CREDITS,
  PAID_PILOT_TEMPLATE_ID,
} from "@app/lib/poke/switch_contract_templates";
import { MetronomePackageSummaryFactory } from "@app/tests/utils/MetronomePackageSummaryFactory";
import { UserFactory } from "@app/tests/utils/UserFactory";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import { DEFAULT_LOCALE } from "@app/types/locale";
import { Err, Ok } from "@app/types/shared/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockCreateWorkspaceInternal,
  mockListMetronomePackages,
  mockSwitchContract,
  mockHandleMembershipInvitations,
  mockGetStripeCustomer,
} = vi.hoisted(() => ({
  mockCreateWorkspaceInternal: vi.fn(),
  mockListMetronomePackages: vi.fn(),
  mockSwitchContract: vi.fn(),
  mockHandleMembershipInvitations: vi.fn(),
  mockGetStripeCustomer: vi.fn(),
}));

// Workspace creation provisions a WorkOS organization: stubbed with a plain
// factory workspace.
vi.mock("@app/lib/iam/workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/lib/iam/workspaces")>()),
  createWorkspaceInternal: mockCreateWorkspaceInternal,
}));

vi.mock("@app/lib/metronome/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/lib/metronome/client")>()),
  listMetronomePackages: mockListMetronomePackages,
}));

vi.mock("@app/lib/api/poke/switch_contract", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@app/lib/api/poke/switch_contract")
  >()),
  switchContract: mockSwitchContract,
}));

vi.mock("@app/lib/api/invitation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/lib/api/invitation")>()),
  handleMembershipInvitations: mockHandleMembershipInvitations,
}));

vi.mock("@app/lib/plans/stripe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/lib/plans/stripe")>()),
  getStripeCustomer: mockGetStripeCustomer,
}));

const ADMIN_EMAIL = "admin@customer.com";
const STRIPE_CUSTOMER_ID = "cus_pilot";

type PluginArgs = Parameters<
  typeof createWorkspaceFromTemplatePlugin.execute
>[2];

function freePilotArgs(overrides: Partial<PluginArgs> = {}): PluginArgs {
  return {
    name: "Customer pilot",
    email: ADMIN_EMAIL,
    templateId: [FREE_PILOT_TEMPLATE_ID],
    seats: 12,
    duration: 2,
    durationUnit: ["weeks"],
    programmaticMonthlyCapDollars: 50,
    stripeCustomerId: "",
    locale: [DEFAULT_LOCALE],
    ...overrides,
  };
}

function paidPilotArgs(overrides: Partial<PluginArgs> = {}): PluginArgs {
  return freePilotArgs({
    templateId: [PAID_PILOT_TEMPLATE_ID],
    seats: 10,
    duration: 2,
    durationUnit: ["months"],
    stripeCustomerId: STRIPE_CUSTOMER_ID,
    ...overrides,
  });
}

async function superUserAuth() {
  const superUser = await UserFactory.superUser();
  return Authenticator.fromDustSuperUser({ user: superUser });
}

async function runPlugin(args: PluginArgs) {
  return createWorkspaceFromTemplatePlugin.execute(
    await superUserAuth(),
    null,
    args
  );
}

describe("createWorkspaceFromTemplatePlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(config, "getCurrentRegion").mockReturnValue("europe-west1");

    mockCreateWorkspaceInternal.mockImplementation(() =>
      WorkspaceFactory.withoutSubscription()
    );
    mockListMetronomePackages.mockResolvedValue(
      new Ok([
        MetronomePackageSummaryFactory.enterprisePooled("usd"),
        MetronomePackageSummaryFactory.enterprisePooled("eur"),
      ])
    );
    mockSwitchContract.mockResolvedValue(
      new Ok({ metronomeContractId: "contract-pilot" })
    );
    mockHandleMembershipInvitations.mockResolvedValue(
      new Ok([{ success: true, email: ADMIN_EMAIL }])
    );
    mockGetStripeCustomer.mockResolvedValue({
      id: STRIPE_CUSTOMER_ID,
      currency: "eur",
    });
  });

  it("offers the free and paid pilot templates in the region's currency", async () => {
    const res = await createWorkspaceFromTemplatePlugin.populateAsyncArgs(
      await superUserAuth(),
      null
    );

    assert(res.isOk());
    expect(res.value.templateId).toEqual([
      { label: "Free pilot — 2 weeks (EUR)", value: FREE_PILOT_TEMPLATE_ID },
      { label: "Paid pilot (EUR)", value: PAID_PILOT_TEMPLATE_ID },
    ]);
  });

  it("creates the workspace without a plan, switches it to the template contract, then invites the admin", async () => {
    const res = await runPlugin(freePilotArgs());

    assert(res.isOk(), res.isErr() ? res.error.message : "");
    expect(mockCreateWorkspaceInternal).toHaveBeenCalledWith(
      expect.objectContaining({ planCode: null, endDate: null })
    );
    expect(mockSwitchContract).toHaveBeenCalledTimes(1);
    const { body } = mockSwitchContract.mock.calls[0][0];
    expect(body).toMatchObject({
      planCode: CREDIT_PRICED_ENTERPRISE_PILOT_PLAN_CODE,
      metronomePackageId: "pooled-eur",
      stripeCustomerId: "",
      programmaticMonthlyCapCredits: MIN_PROGRAMMATIC_MONTHLY_CAP_CREDITS,
      seats: {
        workspace_yearly: {
          selected: true,
          minSeats: 12,
          maxSeats: 12,
          rate: 0,
        },
      },
    });
    expect(body.startingAt).toBeUndefined();
    expect(body.endingAt).toBeDefined();

    expect(mockHandleMembershipInvitations).toHaveBeenCalledTimes(1);
    expect(mockSwitchContract.mock.invocationCallOrder[0]).toBeLessThan(
      mockHandleMembershipInvitations.mock.invocationCallOrder[0]
    );
    expect(res.value.value).toContain("contract-pilot");
  });

  it("bills in USD in the US region", async () => {
    vi.spyOn(config, "getCurrentRegion").mockReturnValue("us-central1");

    const res = await runPlugin(freePilotArgs());

    assert(res.isOk(), res.isErr() ? res.error.message : "");
    expect(mockSwitchContract.mock.calls[0][0].body.metronomePackageId).toBe(
      "pooled-usd"
    );
  });

  it("uses the given duration and programmatic usage", async () => {
    const before = Date.now();

    const res = await runPlugin(
      freePilotArgs({
        duration: 3,
        durationUnit: ["months"],
        programmaticMonthlyCapDollars: 120,
      })
    );

    assert(res.isOk(), res.isErr() ? res.error.message : "");
    const { body } = mockSwitchContract.mock.calls[0][0];
    expect(body.programmaticMonthlyCapCredits).toBe(12_000);
    const durationMs = Date.parse(body.endingAt) - before;
    const DAY_MS = 24 * 60 * 60 * 1000;
    // Three months from the current hour, floored.
    expect(durationMs).toBeGreaterThan(88 * DAY_MS);
    expect(durationMs).toBeLessThan(93 * DAY_MS);
  });

  it.each([
    ["no seats", { seats: 0 }, "number of seats"],
    ["a fractional seat count", { seats: 2.5 }, "number of seats"],
    ["a zero duration", { duration: 0 }, "duration"],
    [
      "programmatic usage below $50",
      { programmaticMonthlyCapDollars: 49 },
      "at least $50",
    ],
    [
      "a template not offered for workspace creation",
      { templateId: ["enterprise-pooled"] },
      "Unknown workspace creation template",
    ],
  ])(
    "rejects %s before creating any workspace",
    async (_, overrides: Partial<PluginArgs>, expectedError) => {
      const res = await runPlugin(freePilotArgs(overrides));

      assert(res.isErr());
      expect(res.error.message).toContain(expectedError);
      expect(mockCreateWorkspaceInternal).not.toHaveBeenCalled();
      expect(mockSwitchContract).not.toHaveBeenCalled();
    }
  );

  it("rejects before creating any workspace when no package exists for the region's currency", async () => {
    mockListMetronomePackages.mockResolvedValue(
      new Ok([MetronomePackageSummaryFactory.enterprisePooled("usd")])
    );

    const res = await runPlugin(freePilotArgs());

    assert(res.isErr());
    expect(res.error.message).toContain("found for EUR");
    expect(mockCreateWorkspaceInternal).not.toHaveBeenCalled();
  });

  it("reports the created workspace and sends no invitation when the contract switch fails", async () => {
    mockSwitchContract.mockResolvedValue(
      new Err(
        new SwitchContractError("metronome_api_error", "Metronome is down")
      )
    );

    const res = await runPlugin(freePilotArgs());

    assert(res.isErr());
    const workspace = await mockCreateWorkspaceInternal.mock.results[0].value;
    expect(res.error.message).toContain(`id: ${workspace.sId}`);
    expect(res.error.message).toContain("Metronome is down");
    expect(res.error.message).toContain("no invitation was sent");
    expect(mockCreateWorkspaceInternal).toHaveBeenCalledTimes(1);
    expect(mockHandleMembershipInvitations).not.toHaveBeenCalled();
  });

  describe("paid pilot", () => {
    it("bills the paid pilot to the Stripe customer at the template's seat rate", async () => {
      const res = await runPlugin(paidPilotArgs());

      assert(res.isOk(), res.isErr() ? res.error.message : "");
      expect(mockGetStripeCustomer).toHaveBeenCalledWith(STRIPE_CUSTOMER_ID);
      const { body } = mockSwitchContract.mock.calls[0][0];
      expect(body).toMatchObject({
        planCode: CREDIT_PRICED_ENTERPRISE_PILOT_PLAN_CODE,
        metronomePackageId: "pooled-eur",
        stripeCustomerId: STRIPE_CUSTOMER_ID,
        offerFreePeriod: { value: 2, unit: "weeks" },
        seats: {
          workspace_yearly: {
            selected: true,
            minSeats: 10,
            maxSeats: 10,
            rate: 600,
          },
        },
      });
      expect(body.seats.workspace_yearly.commitmentPrice).toBeGreaterThan(0);
    });

    it.each([
      [
        "no Stripe customer",
        { stripeCustomerId: "" },
        "requires a Stripe customer",
      ],
      [
        "a duration under 1 month",
        { duration: 3, durationUnit: ["weeks"] },
        "at least 1 month.",
      ],
    ])(
      "rejects %s before creating any workspace",
      async (_, overrides: Partial<PluginArgs>, expectedError) => {
        const res = await runPlugin(paidPilotArgs(overrides));

        assert(res.isErr());
        expect(res.error.message).toContain(expectedError);
        expect(mockCreateWorkspaceInternal).not.toHaveBeenCalled();
      }
    );

    it("rejects an unknown Stripe customer before creating any workspace", async () => {
      mockGetStripeCustomer.mockResolvedValue(null);

      const res = await runPlugin(paidPilotArgs());

      assert(res.isErr());
      expect(res.error.message).toContain("Stripe customer not found");
      expect(mockCreateWorkspaceInternal).not.toHaveBeenCalled();
    });

    it("rejects a Stripe customer billed in another currency before creating any workspace", async () => {
      mockGetStripeCustomer.mockResolvedValue({
        id: STRIPE_CUSTOMER_ID,
        currency: "usd",
      });

      const res = await runPlugin(paidPilotArgs());

      assert(res.isErr());
      expect(res.error.message).toContain("billed in USD");
      expect(mockCreateWorkspaceInternal).not.toHaveBeenCalled();
    });
  });
});
