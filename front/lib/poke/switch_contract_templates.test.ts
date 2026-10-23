import assert from "node:assert";

import { CREDIT_PRICED_ENTERPRISE_PILOT_PLAN_CODE } from "@app/lib/plans/plan_codes";
import {
  buildSwitchContractBodyFromTemplate,
  MIN_PROGRAMMATIC_MONTHLY_CAP_CREDITS,
  FREE_PILOT_TEMPLATE_ID,
  SWITCH_CONTRACT_TEMPLATES,
} from "@app/lib/poke/switch_contract_templates";
import { MetronomePackageSummaryFactory } from "@app/tests/utils/MetronomePackageSummaryFactory";
import type { SupportedCurrency } from "@app/types/currency";
import { describe, expect, it } from "vitest";

const freePilotTemplate = SWITCH_CONTRACT_TEMPLATES.find(
  (t) => t.id === FREE_PILOT_TEMPLATE_ID
);

const pooledPackage = (currency: SupportedCurrency) =>
  MetronomePackageSummaryFactory.enterprisePooled(currency);

const packages = [pooledPackage("usd"), pooledPackage("eur")];
const now = new Date("2026-10-22T14:37:12.000Z");

describe("buildSwitchContractBodyFromTemplate (free pilot)", () => {
  if (!freePilotTemplate) {
    throw new Error("Free pilot template not found");
  }

  it("builds a free 2-week pilot in the requested currency with committed and capped seats", () => {
    const res = buildSwitchContractBodyFromTemplate({
      template: freePilotTemplate,
      packages,
      currency: "eur",
      committedSeats: 12,
      now,
    });
    if (res.isErr()) {
      throw res.error;
    }
    const body = res.value;

    expect(body.planCode).toBe(CREDIT_PRICED_ENTERPRISE_PILOT_PLAN_CODE);
    expect(body.metronomePackageId).toBe("pooled-eur");
    expect(body.startingAt).toBeUndefined();
    expect(body.endingAt).toBe("2026-11-05T14:00:00.000Z");
    expect(body.seats?.workspace_yearly).toMatchObject({
      selected: true,
      minSeats: 12,
      maxSeats: 12,
      rate: 0,
      commitmentPrice: undefined,
    });
    expect(body.seats?.workspace).toMatchObject({
      selected: false,
      minSeats: 0,
      maxSeats: undefined,
    });
    expect(body.initialCredits).toMatchObject({
      amountCredits: 10000,
      invoiceAmount: 0,
      perUser: true,
    });
    expect(body.defaultPoolCapCredits).toBe(10000);
    expect(body.programmaticMonthlyCapCredits).toBe(
      MIN_PROGRAMMATIC_MONTHLY_CAP_CREDITS
    );
  });

  it("ends after the given duration instead of the template's", () => {
    const res = buildSwitchContractBodyFromTemplate({
      template: freePilotTemplate,
      packages,
      currency: "usd",
      committedSeats: 3,
      duration: { value: 1, unit: "months" },
      now,
    });
    if (res.isErr()) {
      throw res.error;
    }
    expect(res.value.metronomePackageId).toBe("pooled-usd");
    expect(res.value.endingAt).toBe("2026-11-22T14:00:00.000Z");
  });

  it("fails when the duration is not a positive integer", () => {
    const res = buildSwitchContractBodyFromTemplate({
      template: freePilotTemplate,
      packages,
      currency: "usd",
      committedSeats: 3,
      duration: { value: 0, unit: "weeks" },
      now,
    });
    expect(res.isErr()).toBe(true);
  });

  it("fails when no package matches the currency", () => {
    const res = buildSwitchContractBodyFromTemplate({
      template: freePilotTemplate,
      packages: [pooledPackage("usd")],
      currency: "eur",
      committedSeats: 5,
      now,
    });
    expect(res.isErr()).toBe(true);
  });

  it("fails when the seat count is not a positive integer", () => {
    for (const committedSeats of [0, -1, 2.5]) {
      const res = buildSwitchContractBodyFromTemplate({
        template: freePilotTemplate,
        packages,
        currency: "usd",
        committedSeats,
        now,
      });
      expect(res.isErr()).toBe(true);
    }
  });

  it("fails when the template has no plan code", () => {
    const res = buildSwitchContractBodyFromTemplate({
      template: { ...freePilotTemplate, planCode: undefined },
      packages,
      currency: "usd",
      committedSeats: 3,
      now,
    });
    expect(res.isErr()).toBe(true);
  });

  it("prices the seat commitment of a paid template over the contract period", () => {
    const paidPilotTemplate = SWITCH_CONTRACT_TEMPLATES.find(
      (t) => t.id === "enterprise-pilot-2m"
    );
    assert(paidPilotTemplate, "Paid pilot template not found");

    const res = buildSwitchContractBodyFromTemplate({
      template: paidPilotTemplate,
      packages,
      currency: "usd",
      committedSeats: 10,
      now,
    });
    if (res.isErr()) {
      throw res.error;
    }
    const seat = res.value.seats?.workspace_yearly;
    expect(seat).toMatchObject({ minSeats: 10, maxSeats: 10 });
    // 10 seats at 600/year over 2 months: about 1,000.
    expect(seat?.commitmentPrice).toBeGreaterThan(900);
    expect(seat?.commitmentPrice).toBeLessThan(1100);
  });

  it("fails when the package does not sell a seat type the template selects", () => {
    const res = buildSwitchContractBodyFromTemplate({
      template: freePilotTemplate,
      packages: [
        MetronomePackageSummaryFactory.enterprisePooled("usd", { seats: [] }),
      ],
      currency: "usd",
      committedSeats: 3,
      now,
    });
    assert(res.isErr());
    expect(res.error.message).toContain("workspace_yearly");
  });

  it("gives seats the template does not select no commitment and no cap", () => {
    const res = buildSwitchContractBodyFromTemplate({
      template: {
        ...freePilotTemplate,
        seats: {
          ...freePilotTemplate.seats,
          workspace: { selected: false, minSeats: 2, maxSeats: 4 },
        },
      },
      packages,
      currency: "usd",
      committedSeats: 3,
      now,
    });
    if (res.isErr()) {
      throw res.error;
    }
    expect(res.value.seats?.workspace).toMatchObject({
      selected: false,
      minSeats: 0,
      maxSeats: undefined,
    });
  });
});
