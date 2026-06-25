export type Currency = "HKD" | "USD" | "CNY";

export type Severity = "info" | "warning" | "blocking";

export interface FxRates {
  HKD: number;
  USD: number;
  CNY: number;
}

export interface TaxConfig {
  taxRate: number;
  fxRates: FxRates;
  capitalGainMode: "annual-netting";
}

export type TaxYearMode = "calendar";
export type CostBasisMethod = "fifo" | "acb";
export type TaxScenarioId = "calendar-fifo" | "calendar-acb";

export interface RealizedTrade {
  id: string;
  broker: string;
  sellDate: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  proceeds: number;
  costBasis: number;
  gainLoss: number;
  source: string;
  note?: string;
  excluded?: boolean;
  exclusionReason?: string;
  useBrokerReportedGainLoss?: boolean;
}

export type TradeActivitySide = "buy" | "sell" | "acquire" | "transfer_in" | "transfer_out";

export interface TradeActivity {
  id: string;
  broker: string;
  date: string;
  time?: string;
  sequence?: number;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  side: TradeActivitySide;
  quantity: number;
  unitPrice?: number;
  grossAmount?: number;
  fee?: number;
  amount: number;
  source: string;
  note?: string;
  excludedFromTaxReplay?: boolean;
}

export interface TaxStatementSummary {
  id: string;
  broker: string;
  source: string;
  currency: Currency;
  periodStart?: string;
  periodEnd?: string;
  grossProceeds?: number;
  realizedGainLoss: number;
  cashDividends: number;
  dividendTaxWithheld: number;
  interest?: number;
}

export interface DividendIncome {
  id: string;
  broker: string;
  date: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  grossAmount: number;
  taxWithheld: number;
  fee: number;
  source: string;
  note?: string;
  evidence?: {
    page: number;
    text: string;
    imageDataUrl?: string;
  };
}

export interface OpenPosition {
  id: string;
  broker: string;
  asOf: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  marketValue: number;
  costBasis?: number;
  unrealizedGainLoss?: number;
  source: string;
  note?: string;
}

export interface ReviewIssue {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  source?: string;
}

export interface CostBasisRequest {
  id: string;
  broker: string;
  sellDate: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  proceeds: number;
  source: string;
  note?: string;
}

export interface CostBasisCorrection {
  id: string;
  costBasis: number;
}

export interface ParsedInput {
  realizedTrades: RealizedTrade[];
  tradeActivities: TradeActivity[];
  dividends: DividendIncome[];
  openPositions: OpenPosition[];
  issues: ReviewIssue[];
  costBasisRequests: CostBasisRequest[];
  taxStatementSummaries: TaxStatementSummary[];
}

export interface SymbolSummary {
  broker: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  proceeds: number;
  costBasis: number;
  gainLoss: number;
  gainLossRmb: number;
  positiveGainReference: number;
  positiveGainReferenceRmb: number;
  status: "gain" | "loss" | "flat";
}

export interface BrokerSummary {
  broker: string;
  gainLossRmb: number;
  taxableBaseRmb: number;
  estimatedTaxRmb: number;
}

export interface CurrencySummary {
  currency: Currency;
  gainLoss: number;
  taxableBase: number;
  estimatedTaxRmb: number;
}

export interface DividendSummary {
  grossRmb: number;
  withholdingCreditRmb: number;
  taxableBaseRmb: number;
  estimatedTaxRmb: number;
}

export interface TaxScenarioSummary {
  id: TaxScenarioId;
  label: string;
  yearLabel: string;
  yearStart: string;
  yearEnd: string;
  taxYearMode: TaxYearMode;
  costBasisMethod: CostBasisMethod;
  capitalGainRmb: number;
  capitalTaxBaseRmb: number;
  capitalEstimatedTaxRmb: number;
  realizedTradeCount: number;
  missingCostIssueCount: number;
  isDefault: boolean;
}

export interface TaxAnalysis {
  config: TaxConfig;
  generatedAt: string;
  summary: {
    capitalGainRmb: number;
    capitalTaxBaseRmb: number;
    capitalEstimatedTaxRmb: number;
    dividend: DividendSummary;
    totalEstimatedTaxRmb: number;
    strictPositiveGainTaxReferenceRmb: number;
  };
  brokers: BrokerSummary[];
  currencies: CurrencySummary[];
  symbols: SymbolSummary[];
  realizedTrades: RealizedTrade[];
  tradeActivities: TradeActivity[];
  excludedTrades: RealizedTrade[];
  dividends: DividendIncome[];
  openPositions: OpenPosition[];
  issues: ReviewIssue[];
  costBasisRequests: CostBasisRequest[];
  taxScenarios: TaxScenarioSummary[];
}
