import { config } from "@app/lib/api/regions/config";
import { currencyToAwuCredits } from "@app/lib/metronome/amounts";
import { listMetronomePackages } from "@app/lib/metronome/client";
import { addDuration } from "@app/lib/metronome/seat_commitment";
import { resolveCurrencyFromStripe } from "@app/lib/plans/billing_currency";
import { getStripeCustomer } from "@app/lib/plans/stripe";
import type {
  ContractDurationUnit,
  SwitchContractTemplate,
} from "@app/lib/poke/switch_contract_templates";
import {
  buildSwitchContractBodyFromTemplate,
  FREE_PILOT_TEMPLATE_ID,
  MIN_PROGRAMMATIC_MONTHLY_CAP_DOLLARS,
  PAID_PILOT_TEMPLATE_ID,
  SWITCH_CONTRACT_TEMPLATES,
} from "@app/lib/poke/switch_contract_templates";
import type { SupportedCurrency } from "@app/types/currency";
import type { SwitchContractBody } from "@app/types/poke/switch_contract";
import { SwitchContractBodySchema } from "@app/types/poke/switch_contract";
import type { RegionType } from "@app/types/region";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { fromError } from "zod-validation-error";

type ContractDuration = { value: number; unit: ContractDurationUnit };

type WorkspaceCreationTemplateRules = {
  templateId: string;
  // Templates that invoice something need a Stripe customer to bill.
  requiresStripeCustomer: boolean;
  minDuration?: ContractDuration;
};

// Switch Contract templates a workspace can be created from, with the rules
// the "Create Workspace from Template" poke plugin enforces for each.
const WORKSPACE_CREATION_TEMPLATE_RULES: WorkspaceCreationTemplateRules[] = [
  { templateId: FREE_PILOT_TEMPLATE_ID, requiresStripeCustomer: false },
  {
    templateId: PAID_PILOT_TEMPLATE_ID,
    requiresStripeCustomer: true,
    minDuration: { value: 1, unit: "months" },
  },
];

export function listWorkspaceCreationTemplates(): SwitchContractTemplate[] {
  return SWITCH_CONTRACT_TEMPLATES.filter((t) =>
    WORKSPACE_CREATION_TEMPLATE_RULES.some((r) => r.templateId === t.id)
  );
}

/**
 * @cc [owner:thomasvicaire,label:product] currency-from-dust-region
 * A workspace created from a template is billed in EUR in the EU region and in
 * USD in the US region.
 */
export function getTemplateCurrencyForRegion(
  region: RegionType
): SupportedCurrency {
  switch (region) {
    case "europe-west1":
      return "eur";
    case "us-central1":
      return "usd";
    default:
      return assertNever(region);
  }
}

// Validates the Stripe customer a contract is billed to: it must exist and be
// billed in the contract currency.
async function checkStripeCustomer(
  stripeCustomerId: string,
  currency: SupportedCurrency
): Promise<Result<void, Error>> {
  const stripeCustomer = await getStripeCustomer(stripeCustomerId);
  if (!stripeCustomer) {
    return new Err(
      new Error(`Stripe customer not found: ${stripeCustomerId}.`)
    );
  }
  const stripeCurrency = resolveCurrencyFromStripe({ stripeCustomer });
  if (stripeCurrency !== currency) {
    return new Err(
      new Error(
        `Stripe customer ${stripeCustomerId} is billed in ${stripeCurrency.toUpperCase()}, ` +
          `but workspaces in this region are billed in ${currency.toUpperCase()}.`
      )
    );
  }
  return new Ok(undefined);
}

// "1 month", "2 weeks".
function formatDuration({ value, unit }: ContractDuration): string {
  return `${value} ${value === 1 ? unit.slice(0, -1) : unit}`;
}

export type TemplateContract = {
  template: SwitchContractTemplate;
  body: SwitchContractBody;
  currency: SupportedCurrency;
};

/**
 * @cc [owner:thomasvicaire,label:product] contract-from-template
 * Returns the `switchContract` body built from the workspace creation template
 * `templateId`: the current Dust region's currency, ending after `duration`,
 * with `seats` committed and capped on the template's selected seats, billed to
 * `stripeCustomerId` (none when empty). It does not touch any workspace, so
 * callers MUST call it before creating anything. Fails when `templateId` is not
 * a workspace creation template, an input is invalid, or the template's package
 * cannot be resolved for that currency.
 */
/**
 * @cc [owner:thomasvicaire,label:product] programmatic-minimum
 * The contract MUST enable programmatic usage with a monthly cap of at least
 * `MIN_PROGRAMMATIC_MONTHLY_CAP_DOLLARS` (converted to AWU credits at the USD
 * price); a lower `programmaticMonthlyCapDollars` fails.
 */
/**
 * @cc [owner:thomasvicaire,label:product] template-rules
 * Fails when the template requires a Stripe customer and `stripeCustomerId` is
 * empty, when a given Stripe customer does not exist or is not billed in the
 * region's currency, and when `duration` is shorter than the template's
 * minimum duration.
 */
export async function prepareContractFromTemplate({
  templateId,
  seats,
  duration,
  programmaticMonthlyCapDollars,
  stripeCustomerId,
}: {
  templateId: string;
  seats: number;
  duration: ContractDuration;
  programmaticMonthlyCapDollars: number;
  stripeCustomerId: string;
}): Promise<Result<TemplateContract, Error>> {
  const rules = WORKSPACE_CREATION_TEMPLATE_RULES.find(
    (r) => r.templateId === templateId
  );
  const template = SWITCH_CONTRACT_TEMPLATES.find((t) => t.id === templateId);
  if (!rules || !template) {
    return new Err(
      new Error(`Unknown workspace creation template: ${templateId}.`)
    );
  }

  if (
    !Number.isFinite(programmaticMonthlyCapDollars) ||
    programmaticMonthlyCapDollars < MIN_PROGRAMMATIC_MONTHLY_CAP_DOLLARS
  ) {
    return new Err(
      new Error(
        `Programmatic usage must be at least $${MIN_PROGRAMMATIC_MONTHLY_CAP_DOLLARS} per month.`
      )
    );
  }

  const now = new Date();
  if (
    rules.minDuration &&
    addDuration(now, duration.value, duration.unit) <
      addDuration(now, rules.minDuration.value, rules.minDuration.unit)
  ) {
    return new Err(
      new Error(
        `"${template.name}" must last at least ${formatDuration(rules.minDuration)}.`
      )
    );
  }

  const currency = getTemplateCurrencyForRegion(config.getCurrentRegion());
  if (rules.requiresStripeCustomer && !stripeCustomerId) {
    return new Err(
      new Error(`"${template.name}" requires a Stripe customer to bill.`)
    );
  }
  if (stripeCustomerId) {
    const stripeRes = await checkStripeCustomer(stripeCustomerId, currency);
    if (stripeRes.isErr()) {
      return stripeRes;
    }
  }

  const packagesRes = await listMetronomePackages();
  if (packagesRes.isErr()) {
    return new Err(packagesRes.error);
  }

  const bodyRes = buildSwitchContractBodyFromTemplate({
    template,
    packages: packagesRes.value,
    currency,
    committedSeats: seats,
    duration,
    programmaticMonthlyCapCredits: Math.round(
      currencyToAwuCredits(programmaticMonthlyCapDollars, "usd")
    ),
    now,
  });
  if (bodyRes.isErr()) {
    return new Err(bodyRes.error);
  }

  const body = SwitchContractBodySchema.safeParse({
    ...bodyRes.value,
    stripeCustomerId,
  });
  if (!body.success) {
    return new Err(
      new Error(`Invalid template contract: ${fromError(body.error)}`)
    );
  }

  return new Ok({ template, body: body.data, currency });
}
