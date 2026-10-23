import type { MetronomePackageSummary } from "@app/lib/metronome/client";
import type { SupportedCurrency } from "@app/types/currency";

// Sync, in-memory factory for Metronome package summaries, as returned by
// `listMetronomePackages`. Does not touch Metronome nor the database.
export class MetronomePackageSummaryFactory {
  // Enterprise pooled package anchored on the contract start date, selling
  // yearly workspace seats (entitled) and monthly workspace seats.
  static enterprisePooled(
    currency: SupportedCurrency,
    overrides: Partial<MetronomePackageSummary> = {}
  ): MetronomePackageSummary {
    return {
      id: `pooled-${currency}`,
      name: `Enterprise Pooled ${currency.toUpperCase()}`,
      aliases: [`enterprise-pooled-${currency}`],
      tier: "enterprise",
      currency,
      billingAnchor: "contract_start_date",
      seats: [
        {
          seatType: "workspace_yearly",
          productId: "p-workspace-yearly",
          productName: "Workspace seat (yearly)",
          defaultRate: 60000,
          entitled: true,
        },
        {
          seatType: "workspace",
          productId: "p-workspace",
          productName: "Workspace seat",
          defaultRate: null,
          entitled: false,
        },
      ],
      ...overrides,
    };
  }
}
