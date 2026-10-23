import { handleMembershipInvitations } from "@app/lib/api/invitation";
import { switchContract } from "@app/lib/api/poke/switch_contract";
import { createPlugin } from "@app/lib/api/poke/types";
import {
  getTemplateCurrencyForRegion,
  listWorkspaceCreationTemplates,
  prepareContractFromTemplate,
} from "@app/lib/api/poke/workspace_templates";
import { config } from "@app/lib/api/regions/config";
import { Authenticator } from "@app/lib/auth";
import { createWorkspaceInternal } from "@app/lib/iam/workspaces";
import { getRegionDisplay } from "@app/lib/poke/regions";
import { MIN_PROGRAMMATIC_MONTHLY_CAP_DOLLARS } from "@app/lib/poke/switch_contract_templates";
import { isEmailValid } from "@app/lib/utils";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
} from "@app/types/locale";
import { mapToEnumValues } from "@app/types/poke/plugins";
import { Err, Ok } from "@app/types/shared/result";

const DURATION_UNITS = ["weeks", "months"] as const;
const isDurationUnit = (
  unit: string
): unit is (typeof DURATION_UNITS)[number] =>
  DURATION_UNITS.some((u) => u === unit);

export const createWorkspaceFromTemplatePlugin = createPlugin({
  manifest: {
    id: "create-workspace-from-template",
    name: "Create Workspace from Template",
    description: `Create a new workspace in ${getRegionDisplay(config.getCurrentRegion())} with a Metronome contract built from a Switch Contract template.`,
    resourceTypes: ["global"],
    args: {
      name: {
        type: "string",
        label: "Name",
        description: "The name of the workspace",
      },
      email: {
        type: "string",
        label: "Email",
        description: "The email of the admin user",
      },
      templateId: {
        type: "enum",
        label: "Template",
        description:
          "Switch Contract template the workspace contract is built from. The currency follows the region.",
        values: [],
        async: true,
        multiple: false,
      },
      seats: {
        type: "number",
        label: "Seats",
        description:
          "Number of seats on the template's seat type, committed and also used as the seat cap.",
        default: 0,
      },
      duration: {
        type: "number",
        label: "Duration",
        description:
          "How long the contract lasts, in the unit below. Overrides the template's duration. It starts immediately. The paid pilot lasts at least 1 month.",
        default: 2,
      },
      durationUnit: {
        type: "enum",
        label: "Duration unit",
        values: mapToEnumValues(DURATION_UNITS, (unit) => ({
          label: unit === "weeks" ? "Weeks" : "Months",
          value: unit,
          checked: unit === "weeks",
        })),
        multiple: false,
      },
      programmaticMonthlyCapDollars: {
        type: "number",
        label: "Programmatic usage (US$ per month)",
        description: `Monthly cap on programmatic (API) usage, in US$. Minimum $${MIN_PROGRAMMATIC_MONTHLY_CAP_DOLLARS}.`,
        default: MIN_PROGRAMMATIC_MONTHLY_CAP_DOLLARS,
      },
      stripeCustomerId: {
        type: "string",
        label: "Stripe customer ID",
        description:
          "Stripe customer the contract is billed to (cus_...). Required for the paid pilot; leave empty for the free pilot. Its currency must match the region's.",
        required: false,
      },
      locale: {
        type: "enum",
        label: "Locale",
        description:
          "Default locale of the workspace. Members who did not pick a locale use it.",
        values: mapToEnumValues(SUPPORTED_LOCALES, (locale) => ({
          label: `${LOCALE_LABELS[locale]} (${locale})`,
          value: locale,
          checked: locale === DEFAULT_LOCALE,
        })),
        multiple: false,
      },
    },
    requiredRoles: ["support"],
  },
  populateAsyncArgs: async () => {
    const currency = getTemplateCurrencyForRegion(
      config.getCurrentRegion()
    ).toUpperCase();

    return new Ok({
      templateId: listWorkspaceCreationTemplates().map((template) => ({
        label: `${template.name} (${currency})`,
        value: template.id,
      })),
    });
  },
  execute: async (auth, _, args) => {
    const email = args.email.trim();
    if (isEmailValid(email) === false) {
      return new Err(new Error("Email address is invalid."));
    }

    const name = args.name.trim();
    if (name.length === 0) {
      return new Err(new Error("Name is required."));
    }

    const locale = args.locale[0];
    if (!isSupportedLocale(locale)) {
      return new Err(new Error("Please select a locale."));
    }

    const durationUnit = args.durationUnit[0];
    if (!isDurationUnit(durationUnit)) {
      return new Err(new Error("Please select a duration unit."));
    }

    // Fully validate and resolve the contract before creating the workspace, so
    // an invalid input never leaves a workspace without a plan.
    const contractRes = await prepareContractFromTemplate({
      templateId: args.templateId[0] ?? "",
      seats: args.seats,
      duration: { value: args.duration, unit: durationUnit },
      programmaticMonthlyCapDollars: args.programmaticMonthlyCapDollars,
      stripeCustomerId: (args.stripeCustomerId ?? "").trim(),
    });
    if (contractRes.isErr()) {
      return new Err(contractRes.error);
    }
    const { template, body, currency } = contractRes.value;

    const workspace = await createWorkspaceInternal({
      name,
      isBusiness: false,
      planCode: null,
      endDate: null,
      locale,
    });

    const newWorkspaceAuth = await Authenticator.internalAdminForWorkspace(
      workspace.sId
    );

    const switchRes = await switchContract({ auth: newWorkspaceAuth, body });
    if (switchRes.isErr()) {
      return new Err(
        new Error(
          `Workspace created (id: ${workspace.sId}) but the contract failed, ` +
            `no invitation was sent: ${switchRes.error.message}`
        )
      );
    }

    const subscription = newWorkspaceAuth.subscription();
    if (!subscription) {
      return new Err(new Error("The workspace does not have a subscription."));
    }

    const invitationRes = await handleMembershipInvitations(newWorkspaceAuth, {
      owner: newWorkspaceAuth.getNonNullableWorkspace(),
      // Dust admin user who invited the new user.
      user: auth.toPokeUserJSON(),
      subscription,
      invitationRequests: [
        {
          email,
          role: "admin",
        },
      ],
    });

    if (invitationRes.isErr()) {
      return new Err(new Error(invitationRes.error.api_error.message));
    }

    const [result] = invitationRes.value;
    if (!result.success) {
      return new Err(new Error(result.error_message));
    }

    return new Ok({
      display: "textWithLink",
      value:
        `Workspace created (id: ${workspace.sId}) and invitation sent to ${result.email}.` +
        `\nTemplate: ${template.name}, ${args.duration} ${durationUnit}, ${args.seats} seats, ` +
        `$${args.programmaticMonthlyCapDollars} programmatic usage per month, ` +
        `${currency.toUpperCase()} (contract: ${switchRes.value.metronomeContractId})`,
      link: `poke/${workspace.sId}`,
      linkText: "View Workspace",
    });
  },
});
