import { amountCents, currencyToAwuCredits } from "@app/lib/metronome/amounts";
import type { MetronomePackageSummary } from "@app/lib/metronome/client";
import {
  addDuration,
  commitmentAmount,
  commitmentPeriodEnd,
} from "@app/lib/metronome/seat_commitment";
import {
  CREDIT_PRICED_ENTERPRISE_DEFAULT_PLAN_CODE,
  CREDIT_PRICED_ENTERPRISE_PILOT_PLAN_CODE,
} from "@app/lib/plans/plan_codes";
import {
  CP_ENTERPRISE_BASIS,
  CP_MAX_SEAT_COST_YEARLY,
  CP_PRO_SEAT_COST_YEARLY,
} from "@app/lib/plans/pricing";
import type { SupportedCurrency } from "@app/types/currency";
import type { MembershipSeatType } from "@app/types/memberships";
import type { SwitchContractBodySchema } from "@app/types/poke/switch_contract";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import type { z } from "zod";

// Hardcoded pre-fill templates for the Switch Contract poke dialog. Selecting a
// template fills the form with these values; the operator can then edit any
// field before submitting. Every field is optional — an omitted field keeps the
// form's current/default value.
//
// Packages are referenced by tier (+ optional case-insensitive name substring)
// rather than by Metronome package id, since ids differ per environment; the
// dialog resolves the matching package in the resolved currency at apply time.
// Seats are keyed by seat type and merged onto the selected package's seats, so
// a seat type the package does not sell is ignored.

type PaymentFrequency =
  | "one_time"
  | "monthly"
  | "quarterly"
  | "semi_annually"
  | "annually";

type TemplatePaymentSchedule = {
  frequency: PaymentFrequency;
  periods?: number;
};

export type ContractDurationUnit = "years" | "months" | "weeks";

type TemplateSeat = {
  selected?: boolean;
  minSeats?: number;
  maxSeats?: number;
  // Per-seat rate in the currency's major units (dollars / euros); the monthly
  // rate for a monthly seat, the yearly rate for a yearly seat. Omit to keep the
  // package's default rate.
  rate?: number;
  commitmentPrice?: number;
  paymentSchedule?: TemplatePaymentSchedule;
};

export type SwitchContractTemplate = {
  id: string;
  name: string;
  description?: string;
  // Contract type. Resolved to a concrete package at apply time.
  package?: {
    tier: "business" | "enterprise";
    namePattern?: string;
    billingAnchor?: MetronomePackageSummary["billingAnchor"];
  };
  planCode?: string;
  startMode?: "immediately" | "retroactive_first_of_month" | "select";
  // datetime-local shape ("YYYY-MM-DDTHH:mm", interpreted as UTC). Only used
  // when startMode is "select".
  startingAt?: string;
  // Sets the contract end date to start + duration (via the "Set duration"
  // toggle), which also drives the commitment period.
  duration?: { value: number; unit: ContractDurationUnit };
  // How Metronome collects Stripe invoices for the customer. `send_invoice`
  // emails the invoice for manual payment; `charge_automatically` charges the
  // card on file. Only takes effect when a Stripe customer is wired in.
  stripeCollectionMethod?: "charge_automatically" | "send_invoice";
  netPaymentTermsDays?: number;
  defaultDiscountPercent?: number;
  usageCapCredits?: number;
  // Default per-user workspace credit pool monthly limit (credits).
  defaultPoolCapCredits?: number;
  // Workspace monthly cap on programmatic (API) usage (credits). 0 or unset
  // blocks programmatic access.
  programmaticMonthlyCapCredits?: number;
  paygEnabled?: boolean;
  autoSeatUpgradeEnabled?: boolean;
  topUpEnabled?: boolean;
  autoInvoiceFinalizationEnabled?: boolean;
  promoteNoneSeatsTo?: MembershipSeatType;
  seats?: Partial<Record<MembershipSeatType, TemplateSeat>>;
  initialCredits?: {
    amountCredits: number;
    invoiceAmount: number;
    perUser?: boolean;
    paymentSchedule: TemplatePaymentSchedule;
  };
  scheduledCharge?: {
    name?: string;
    invoiceAmount: number;
    paymentSchedule: TemplatePaymentSchedule;
  };
  recurringFreeCredit?: number;
  // Promotional free leading period: reduces the seat commitment's earliest
  // bill(s) by the prorated value of this duration, so the customer pays nothing
  // for it (the granted seats are unchanged).
  offerFreePeriod?: { value: number; unit: ContractDurationUnit };
};

export const FREE_PILOT_TEMPLATE_ID = "enterprise-free-pilot-2w";
export const PAID_PILOT_TEMPLATE_ID = "enterprise-pilot-2m";
// Minimum programmatic (API) monthly cap of a workspace created from a template
// by the "Create Workspace from Template" poke plugin, and the free pilot's
// default.
export const MIN_PROGRAMMATIC_MONTHLY_CAP_DOLLARS = 50;
export const MIN_PROGRAMMATIC_MONTHLY_CAP_CREDITS = currencyToAwuCredits(
  MIN_PROGRAMMATIC_MONTHLY_CAP_DOLLARS,
  "usd"
);

export const SWITCH_CONTRACT_TEMPLATES: SwitchContractTemplate[] = [
  {
    id: "enterprise-pooled",
    name: "Enterprise pooled",
    description: "Enterprise Pooled, yearly workspace seats, pooled credits.",
    package: {
      tier: "enterprise",
      namePattern: "pooled",
      billingAnchor: "contract_start_date",
    },
    planCode: CREDIT_PRICED_ENTERPRISE_DEFAULT_PLAN_CODE,
    startMode: "select",
    stripeCollectionMethod: "send_invoice",
    seats: {
      workspace_yearly: { selected: true },
    },
  },
  {
    id: "enterprise-pooled-monthly",
    name: "Enterprise pooled — monthly",
    description:
      "Enterprise Pooled billed monthly: monthly workspace seats at 1/12 the yearly rate, pooled credits.",
    package: {
      tier: "enterprise",
      namePattern: "pooled",
      billingAnchor: "contract_start_date",
    },
    planCode: CREDIT_PRICED_ENTERPRISE_DEFAULT_PLAN_CODE,
    startMode: "select",
    stripeCollectionMethod: "send_invoice",
    seats: {
      // Disable the package's default yearly seat; bill the monthly workspace
      // seat instead at 1/12 the yearly rate (yearly = CP_ENTERPRISE_BASIS * 12),
      // invoiced monthly.
      workspace_yearly: { selected: false },
      workspace: {
        selected: true,
        rate: CP_ENTERPRISE_BASIS,
        paymentSchedule: { frequency: "monthly", periods: 12 },
      },
    },
  },
  {
    id: "enterprise-seat-based",
    name: "Enterprise seat-based",
    description: "Enterprise Seat-based, yearly Pro/Max per-user seats.",
    package: { tier: "enterprise", namePattern: "seat-based" },
    planCode: CREDIT_PRICED_ENTERPRISE_DEFAULT_PLAN_CODE,
    startMode: "select",
    stripeCollectionMethod: "send_invoice",
    seats: {
      pro_yearly: { selected: true },
      max_yearly: { selected: true },
    },
  },
  {
    id: "enterprise-seat-based-monthly",
    name: "Enterprise seat-based — monthly",
    description:
      "Enterprise Seat-based billed monthly: monthly Pro/Max per-user seats at 1/12 the yearly rate.",
    package: { tier: "enterprise", namePattern: "seat-based" },
    planCode: CREDIT_PRICED_ENTERPRISE_DEFAULT_PLAN_CODE,
    startMode: "select",
    stripeCollectionMethod: "send_invoice",
    seats: {
      // Disable the package's default yearly seats; bill the monthly Pro/Max
      // seats instead at 1/12 the yearly rate (yearly = monthly rate * 12),
      // invoiced monthly.
      pro_yearly: { selected: false },
      max_yearly: { selected: false },
      pro: {
        selected: true,
        rate: CP_ENTERPRISE_BASIS + CP_PRO_SEAT_COST_YEARLY,
        paymentSchedule: { frequency: "monthly", periods: 12 },
      },
      max: {
        selected: true,
        rate: CP_ENTERPRISE_BASIS + CP_MAX_SEAT_COST_YEARLY,
        paymentSchedule: { frequency: "monthly", periods: 12 },
      },
    },
  },
  {
    id: FREE_PILOT_TEMPLATE_ID,
    name: "Free pilot — 2 weeks",
    description:
      "Enterprise pooled, 2-week commitment, free workspace seats, 10k free credits per committed seat.",
    package: {
      tier: "enterprise",
      namePattern: "pooled",
      billingAnchor: "contract_start_date",
    },
    planCode: CREDIT_PRICED_ENTERPRISE_PILOT_PLAN_CODE,
    startMode: "select",
    stripeCollectionMethod: "send_invoice",
    duration: { value: 2, unit: "weeks" },
    defaultPoolCapCredits: 10000,
    programmaticMonthlyCapCredits: MIN_PROGRAMMATIC_MONTHLY_CAP_CREDITS,
    seats: {
      workspace_yearly: { selected: true, rate: 0 },
    },
    initialCredits: {
      amountCredits: 10000,
      invoiceAmount: 0,
      perUser: true,
      paymentSchedule: { frequency: "one_time" },
    },
  },
  {
    id: PAID_PILOT_TEMPLATE_ID,
    name: "Paid pilot",
    description:
      "Enterprise pooled, 2-month commitment, workspace seats at 600/year, first 2 weeks free, 10k initial credits per committed seat.",
    package: {
      tier: "enterprise",
      namePattern: "pooled",
      billingAnchor: "contract_start_date",
    },
    planCode: CREDIT_PRICED_ENTERPRISE_PILOT_PLAN_CODE,
    startMode: "select",
    stripeCollectionMethod: "send_invoice",
    duration: { value: 2, unit: "months" },
    defaultPoolCapCredits: 10000,
    // First 2 weeks offered for free.
    offerFreePeriod: { value: 2, unit: "weeks" },
    // Override the workspace-seat rate to 600/year (major units). Set the seat
    // commitment (minSeats) at apply time — the per-user initial credits below
    // scale with it.
    seats: {
      workspace_yearly: { selected: true, rate: 600 },
    },
    // 10k credits per committed seat (scaled by the workspace_yearly commitment
    // the operator enters).
    initialCredits: {
      amountCredits: 10000,
      invoiceAmount: 0,
      perUser: true,
      paymentSchedule: { frequency: "one_time" },
    },
  },
  {
    id: "partner",
    name: "Partner",
    description:
      "Partner Demo Enterprise, free pooled platform seats, monthly shared free credit pool.",
    package: { tier: "enterprise", namePattern: "partner" },
    planCode: CREDIT_PRICED_ENTERPRISE_DEFAULT_PLAN_CODE,
    startMode: "select",
    stripeCollectionMethod: "send_invoice",
    // Partner Demo entitles the monthly (pooled) workspace seat at $0.
    seats: {
      workspace: { selected: true, rate: 0 },
    },
    // Shared monthly free pool granted at the contract level; adjust per deal.
    recurringFreeCredit: 10000,
    defaultPoolCapCredits: 10000,
  },
];

export type TemplateSeatValue = {
  selected: boolean;
  minSeats: number;
  maxSeats?: number;
  rate: number;
  commitmentPrice?: number;
  paymentSchedule: TemplatePaymentSchedule;
};

// Default seat settings for a package: entitled seats pre-selected, the rest
// unchecked for the operator to opt into; minSeats 0 and the rate converted from
// Metronome's fiat unit to major units (dollars / euros).
export function buildDefaultSeats(
  seats: { seatType: string; defaultRate: number | null; entitled: boolean }[],
  resolvedCurrency: SupportedCurrency | null | undefined
): Record<string, TemplateSeatValue> {
  const next: Record<string, TemplateSeatValue> = {};
  for (const seat of seats) {
    const rate =
      seat.defaultRate != null && resolvedCurrency
        ? amountCents(seat.defaultRate, resolvedCurrency) / 100
        : (seat.defaultRate ?? 0);
    next[seat.seatType] = {
      selected: seat.entitled,
      minSeats: 0,
      maxSeats: undefined,
      rate,
      paymentSchedule: { frequency: "one_time" },
    };
  }
  return next;
}

// Merge a template's per-seat overrides onto a package's default seats. Seat
// types the package does not sell have no entry to merge onto and are skipped.
export function mergeTemplateSeats(
  base: Record<string, TemplateSeatValue>,
  templateSeats: SwitchContractTemplate["seats"]
): Record<string, TemplateSeatValue> {
  if (!templateSeats) {
    return base;
  }
  const next = { ...base };
  for (const [seatType, override] of Object.entries(templateSeats)) {
    if (!override || !next[seatType]) {
      continue;
    }
    next[seatType] = { ...next[seatType], ...override };
  }
  return next;
}

// Resolve a template's contract type to a concrete package in the given
// currency: same tier and, when given, a case-insensitive name-substring match
// and billing anchor.
export function findTemplatePackage(
  template: SwitchContractTemplate,
  packages: MetronomePackageSummary[],
  currency: SupportedCurrency | null | undefined
): MetronomePackageSummary | null {
  const templatePackage = template.package;
  if (!templatePackage) {
    return null;
  }
  const pattern = templatePackage.namePattern?.toLowerCase();
  return (
    packages.find(
      (p) =>
        p.tier === templatePackage.tier &&
        p.currency === currency &&
        (!pattern || p.name.toLowerCase().includes(pattern)) &&
        (!templatePackage.billingAnchor ||
          p.billingAnchor === templatePackage.billingAnchor)
    ) ?? null
  );
}

/**
 * @cc [owner:thomasvicaire,label:product] immediate-start-with-template-duration
 * The returned body MUST leave `startingAt` unset (the contract starts at the
 * current hour, whatever the template's `startMode`) and, when a `duration` is
 * given (falling back to the template's), MUST set `endingAt` to the current UTC
 * hour floored plus that duration. Fails when that duration value is not a
 * positive integer. `programmaticMonthlyCapCredits`, when given, overrides the
 * template's.
 */
/**
 * @cc [owner:thomasvicaire,label:product] committed-seats-commitment-and-cap
 * Every seat the template marks `selected: true` MUST get `minSeats` and
 * `maxSeats` equal to `committedSeats`; every other package seat MUST get
 * `minSeats` 0 and no cap, whatever the template sets. Fails when the template
 * has no package or selects no seat type, no package matches `currency`, that
 * package does not sell every selected seat type, or `committedSeats` is not a
 * positive integer.
 */
export function buildSwitchContractBodyFromTemplate({
  template,
  packages,
  currency,
  committedSeats,
  duration = template.duration,
  programmaticMonthlyCapCredits = template.programmaticMonthlyCapCredits,
  now,
}: {
  template: SwitchContractTemplate;
  packages: MetronomePackageSummary[];
  currency: SupportedCurrency;
  committedSeats: number;
  duration?: { value: number; unit: ContractDurationUnit };
  programmaticMonthlyCapCredits?: number;
  now: Date;
}): Result<z.input<typeof SwitchContractBodySchema>, Error> {
  if (!Number.isInteger(committedSeats) || committedSeats < 1) {
    return new Err(
      new Error("The number of seats must be a positive integer.")
    );
  }
  if (duration && (!Number.isInteger(duration.value) || duration.value < 1)) {
    return new Err(
      new Error("The contract duration must be a positive integer.")
    );
  }
  if (!template.planCode) {
    return new Err(new Error(`Template "${template.name}" has no plan code.`));
  }
  const pkg = findTemplatePackage(template, packages, currency);
  if (!pkg) {
    return new Err(
      new Error(
        `Template "${template.name}": no ${template.package?.tier ?? ""} package` +
          (template.package?.namePattern
            ? ` matching "${template.package.namePattern}"`
            : "") +
          ` found for ${currency.toUpperCase()}.`
      )
    );
  }

  const start = new Date(now);
  start.setUTCMinutes(0, 0, 0);
  const endingAt = duration
    ? addDuration(start, duration.value, duration.unit)
    : undefined;
  const commitmentEnd = commitmentPeriodEnd(start, endingAt);

  const selectedSeatTypes = new Set(
    Object.entries(template.seats ?? {})
      .filter(([, seat]) => seat?.selected)
      .map(([seatType]) => seatType)
  );
  if (selectedSeatTypes.size === 0) {
    return new Err(
      new Error(`Template "${template.name}" selects no seat type.`)
    );
  }
  const missingSeatTypes = [...selectedSeatTypes].filter(
    (seatType) => !pkg.seats.some((s) => s.seatType === seatType)
  );
  if (missingSeatTypes.length > 0) {
    return new Err(
      new Error(
        `Package "${pkg.name}" does not sell the seat types selected by template ` +
          `"${template.name}": ${missingSeatTypes.join(", ")}.`
      )
    );
  }

  const mergedSeats = mergeTemplateSeats(
    buildDefaultSeats(pkg.seats, currency),
    template.seats
  );
  const seats: Record<string, TemplateSeatValue> = {};
  for (const [seatType, seat] of Object.entries(mergedSeats)) {
    if (!selectedSeatTypes.has(seatType)) {
      seats[seatType] = { ...seat, minSeats: 0, maxSeats: undefined };
      continue;
    }
    // Same default as the Switch Contract dialog: a paid seat commitment is
    // invoiced at its prorated value over the commitment period.
    const commitmentPriceCurrencyUnits =
      seat.commitmentPrice ??
      (seat.rate > 0
        ? Math.round(
            commitmentAmount({
              minSeats: committedSeats,
              ratePerPeriod: seat.rate,
              isAnnual: seatType.endsWith("_yearly"),
              start,
              end: commitmentEnd,
            }) * 100
          ) / 100
        : undefined);
    seats[seatType] = {
      ...seat,
      minSeats: committedSeats,
      maxSeats: committedSeats,
      commitmentPrice: commitmentPriceCurrencyUnits,
    };
  }

  return new Ok({
    planCode: template.planCode,
    metronomePackageId: pkg.id,
    endingAt: endingAt?.toISOString(),
    netPaymentTermsDays: template.netPaymentTermsDays,
    stripeCollectionMethod: template.stripeCollectionMethod,
    paygEnabled: template.paygEnabled,
    usageCapCredits: template.usageCapCredits,
    initialCredits: template.initialCredits,
    scheduledCharge: template.scheduledCharge,
    recurringFreeCredit: template.recurringFreeCredit,
    promoteNoneSeatsTo: template.promoteNoneSeatsTo,
    seats,
    defaultDiscountPercent: template.defaultDiscountPercent,
    defaultPoolCapCredits: template.defaultPoolCapCredits,
    programmaticMonthlyCapCredits,
    autoSeatUpgradeEnabled: template.autoSeatUpgradeEnabled,
    topUpEnabled: template.topUpEnabled,
    autoInvoiceFinalizationEnabled: template.autoInvoiceFinalizationEnabled,
    offerFreePeriod: template.offerFreePeriod,
  });
}
