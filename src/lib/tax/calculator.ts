import { defaultTaxConfig } from "./config";
import type {
  BrokerSummary,
  CostBasisCorrection,
  CostBasisMethod,
  Currency,
  CurrencySummary,
  ParsedInput,
  RealizedTrade,
  ReviewIssue,
  SymbolSummary,
  TaxAnalysis,
  TaxConfig,
  TaxStatementSummary,
  TaxScenarioId,
  TaxScenarioSummary,
  TaxYearMode,
  TradeActivity,
} from "./types";

function key(parts: Array<string | number>) {
  return parts.join("::");
}

export function toRmb(amount: number, currency: Currency, config: TaxConfig) {
  return amount * config.fxRates[currency];
}

function statusFor(value: number): "gain" | "loss" | "flat" {
  if (value > 0.005) return "gain";
  if (value < -0.005) return "loss";
  return "flat";
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function inSummaryPeriod(summary: TaxStatementSummary, window: TaxWindow) {
  const start = summary.periodStart;
  const end = summary.periodEnd;
  if (!start && !end) return true;
  if (start && start > window.end) return false;
  if (end && end < window.start) return false;
  return true;
}

function hasDetailedBrokerData(input: ParsedInput, broker: string) {
  return (
    input.tradeActivities.some((activity) => activity.broker === broker) ||
    input.realizedTrades.some((trade) => trade.broker === broker)
  );
}

function activeTaxStatementSummaries(input: ParsedInput, window?: TaxWindow) {
  return (input.taxStatementSummaries ?? []).filter((summary) => {
    if (window && !inSummaryPeriod(summary, window)) return false;
    return !hasDetailedBrokerData(input, summary.broker);
  });
}

function taxStatementReviewIssues(input: ParsedInput, trades: RealizedTrade[]): ReviewIssue[] {
  const summaries = input.taxStatementSummaries ?? [];
  if (summaries.length === 0) return [];

  return summaries
    .filter((summary) => hasDetailedBrokerData(input, summary.broker))
    .map((summary) => {
      const brokerTrades = trades.filter((trade) => trade.broker === summary.broker);
      const brokerGainLoss = brokerTrades.reduce((sum, trade) => sum + trade.gainLoss, 0);
      const diff = brokerGainLoss - summary.realizedGainLoss;
      const diffText =
        brokerTrades.length > 0
          ? `当前明细计算已实现盈亏 ${summary.currency} ${roundMoney(brokerGainLoss).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}，税表汇总为 ${summary.currency} ${roundMoney(summary.realizedGainLoss).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}，差额 ${summary.currency} ${roundMoney(diff).toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}。请确认账号、日期区间和币种口径是否一致。`
          : "已识别同券商交易明细，系统会优先使用逐笔明细计算，税表汇总仅用于核对，不重复计入总体数据。";

      return {
        id: `${summary.id}-detail-reconciliation`,
        severity: Math.abs(diff) > 1 ? "warning" : "info",
        title: "已用交易明细核对税表汇总",
        detail: diffText,
        source: summary.source,
      } satisfies ReviewIssue;
    });
}

function inputIssuesForAnalysis(input: ParsedInput) {
  const summariesWithDetails = new Set(
    (input.taxStatementSummaries ?? [])
      .filter((summary) => hasDetailedBrokerData(input, summary.broker))
      .map((summary) => summary.id),
  );
  if (summariesWithDetails.size === 0) return input.issues;
  return input.issues.filter((issue) => {
    return !Array.from(summariesWithDetails).some((summaryId) => issue.id === `${summaryId}-no-trade-detail`);
  });
}

export function costCorrectionKeyForRealizedTradeId(id: string) {
  return String(id).replace(/-calendar-(fifo|acb)$/, "");
}

interface TaxWindow {
  mode: TaxYearMode;
  start: string;
  end: string;
  label: string;
}

interface ReplayState {
  market: string;
  currency: Currency;
  securityName: string;
  quantity: number;
  costBasis: number;
  lots: Array<{ quantity: number; costBasis: number }>;
}

function tradeKey(trade: Pick<RealizedTrade, "broker" | "currency" | "symbol">) {
  return key([trade.broker, trade.currency, trade.symbol]);
}

function activityKey(activity: Pick<TradeActivity, "broker" | "currency" | "symbol">) {
  return key([activity.broker, activity.currency, activity.symbol]);
}

function positionKey(position: Pick<OpenPosition, "broker" | "currency" | "symbol">) {
  return key([position.broker, position.currency, position.symbol]);
}

function maxActivityYear(input: ParsedInput) {
  const years = [...input.tradeActivities.map((activity) => activity.date), ...input.realizedTrades.map((trade) => trade.sellDate)]
    .map((date) => Number(date.slice(0, 4)))
    .filter((year) => Number.isFinite(year) && year >= 2000);
  return years.length > 0 ? Math.max(...years) : new Date().getFullYear();
}

function taxWindows(targetYear: number): TaxWindow[] {
  return [
    {
      mode: "calendar",
      start: `${targetYear}-01-01`,
      end: `${targetYear}-12-31`,
      label: `${targetYear}自然年`,
    },
  ];
}

function inWindow(date: string, window: TaxWindow) {
  return date >= window.start && date <= window.end;
}

function sortActivities(activities: TradeActivity[]) {
  const rank: Record<TradeActivity["side"], number> = {
    acquire: 1,
    transfer_in: 1,
    buy: 2,
    sell: 2,
    transfer_out: 3,
  };
  return [...activities].sort((a, b) => {
    return (
      a.date.localeCompare(b.date) ||
      rank[a.side] - rank[b.side] ||
      (a.time ?? "99:99:99").localeCompare(b.time ?? "99:99:99") ||
      (a.sequence ?? 0) - (b.sequence ?? 0)
    );
  });
}

function synthesizeActivities(input: ParsedInput) {
  if (input.tradeActivities.length === 0) {
    return input.realizedTrades.flatMap<TradeActivity>((trade, index) => [
      {
        id: `${trade.id}-synthetic-cost`,
        broker: trade.broker,
        date: trade.sellDate,
        sequence: index * 2,
        market: trade.market,
        currency: trade.currency,
        symbol: trade.symbol,
        securityName: trade.securityName,
        side: "transfer_in",
        quantity: trade.quantity,
        amount: trade.costBasis,
        source: trade.source,
        note: "由已实现卖出明细反推的成本活动",
      },
      {
        id: `${trade.id}-synthetic-sell`,
        broker: trade.broker,
        date: trade.sellDate,
        sequence: index * 2 + 1,
        market: trade.market,
        currency: trade.currency,
        symbol: trade.symbol,
        securityName: trade.securityName,
        side: "sell",
        quantity: trade.quantity,
        amount: trade.proceeds,
        source: trade.source,
        note: trade.note,
      },
    ]);
  }

  const activities = [...input.tradeActivities];
  for (const [index, trade] of input.realizedTrades.entries()) {
    if (!trade.note?.includes("用户手动补录")) continue;
    activities.push({
      id: `${trade.id}-manual-cost-activity`,
      broker: trade.broker,
      date: trade.sellDate,
      sequence: -100000 + index,
      market: trade.market,
      currency: trade.currency,
      symbol: trade.symbol,
      securityName: trade.securityName,
      side: "transfer_in",
      quantity: trade.quantity,
      amount: trade.costBasis,
      source: trade.source,
      note: "用户手动补录成本",
    });
  }
  return activities;
}

function addCost(state: ReplayState, quantity: number, costBasis: number) {
  state.quantity += quantity;
  state.costBasis += costBasis;
  state.lots.push({ quantity, costBasis });
}

function consumeAcb(state: ReplayState, quantity: number) {
  const costBasis = quantity * (state.quantity === 0 ? 0 : state.costBasis / state.quantity);
  state.quantity -= quantity;
  state.costBasis -= costBasis;
  if (Math.abs(state.quantity) < 1e-8) {
    state.quantity = 0;
    state.costBasis = 0;
  }
  return costBasis;
}

function consumeFifo(state: ReplayState, quantity: number) {
  let remaining = quantity;
  let costBasis = 0;
  while (remaining > 1e-8 && state.lots.length > 0) {
    const lot = state.lots[0];
    const used = Math.min(remaining, lot.quantity);
    const lotCost = lot.quantity === 0 ? 0 : (lot.costBasis * used) / lot.quantity;
    costBasis += lotCost;
    lot.quantity -= used;
    lot.costBasis -= lotCost;
    remaining -= used;
    if (lot.quantity <= 1e-8) state.lots.shift();
  }
  state.quantity -= quantity;
  state.costBasis -= costBasis;
  if (Math.abs(state.quantity) < 1e-8) {
    state.quantity = 0;
    state.costBasis = 0;
    state.lots = [];
  }
  return costBasis;
}

function quantityMatches(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(1e-7, Math.abs(right) * 1e-7);
}

function replayScenario(
  input: ParsedInput,
  window: TaxWindow,
  costBasisMethod: CostBasisMethod,
  config: TaxConfig,
) {
  const excludedKeys = new Set(input.realizedTrades.filter((trade) => trade.excluded).map(tradeKey));
  const states = new Map<string, ReplayState>();
  const trades: RealizedTrade[] = [];
  let missingCostIssueCount = 0;

  for (const activity of sortActivities(synthesizeActivities(input)).filter((item) => !item.excludedFromTaxReplay)) {
    if (activity.date > window.end) break;
    const state =
      states.get(activityKey(activity)) ??
      ({
        market: activity.market,
        currency: activity.currency,
        securityName: activity.securityName,
        quantity: 0,
        costBasis: 0,
        lots: [],
      } satisfies ReplayState);
    state.market = activity.market || state.market;
    state.currency = activity.currency || state.currency;
    state.securityName = activity.securityName || state.securityName;

    if (activity.side === "buy" || activity.side === "acquire" || activity.side === "transfer_in") {
      addCost(state, activity.quantity, activity.amount);
    } else if (activity.side === "sell") {
      if (state.quantity + 1e-7 < activity.quantity) {
        if (inWindow(activity.date, window) && !excludedKeys.has(activityKey(activity))) {
          missingCostIssueCount += 1;
        }
        state.quantity = 0;
        state.costBasis = 0;
        state.lots = [];
        states.set(activityKey(activity), state);
        continue;
      }
      const costBasis =
        costBasisMethod === "fifo" ? consumeFifo(state, activity.quantity) : consumeAcb(state, activity.quantity);
      if (inWindow(activity.date, window) && !excludedKeys.has(activityKey(activity))) {
        trades.push({
          id: `${activity.id}-${window.mode}-${costBasisMethod}`,
          broker: activity.broker,
          sellDate: activity.date,
          market: activity.market,
          currency: activity.currency,
          symbol: activity.symbol,
          securityName: activity.securityName,
          quantity: activity.quantity,
          proceeds: activity.amount,
          costBasis,
          gainLoss: activity.amount - costBasis,
          source: activity.source,
          note: activity.note,
        });
      }
    } else {
      if (state.quantity + 1e-7 >= activity.quantity) {
        if (costBasisMethod === "fifo") {
          consumeFifo(state, activity.quantity);
        } else {
          consumeAcb(state, activity.quantity);
        }
      } else {
        state.quantity = 0;
        state.costBasis = 0;
        state.lots = [];
      }
    }

    states.set(activityKey(activity), state);
  }

  const capitalGainRmb = trades.reduce((sum, trade) => sum + toRmb(trade.gainLoss, trade.currency, config), 0);
  const capitalTaxBaseRmb = Math.max(capitalGainRmb, 0);
  return {
    capitalGainRmb,
    capitalTaxBaseRmb,
    capitalEstimatedTaxRmb: capitalTaxBaseRmb * config.taxRate,
    missingCostIssueCount,
    realizedTradeCount: trades.length,
    trades,
    endingStates: states,
  };
}

function enrichOpenPositionsWithEndingCosts(
  positions: OpenPosition[],
  endingStates: Map<string, ReplayState>,
  costBasisMethod: CostBasisMethod,
): OpenPosition[] {
  return positions.map((position) => {
    if (Number.isFinite(position.costBasis) && Number.isFinite(position.unrealizedGainLoss)) return position;
    const state = endingStates.get(positionKey(position));
    if (!state || state.quantity <= 1e-8 || !quantityMatches(state.quantity, position.quantity)) return position;

    const costBasis = roundMoney(state.costBasis);
    const unrealizedGainLoss = roundMoney(position.marketValue - state.costBasis);
    return {
      ...position,
      costBasis,
      unrealizedGainLoss,
      note: `${position.note ? `${position.note}；` : ""}已按${costBasisMethod.toUpperCase()}重放交易流水估算期末剩余成本。`,
    };
  });
}

function brokerReportedTradesInWindow(input: ParsedInput, window: TaxWindow) {
  return input.realizedTrades.filter((trade) => trade.useBrokerReportedGainLoss && !trade.excluded && inWindow(trade.sellDate, window));
}

function costCorrectionMap(corrections: CostBasisCorrection[] = []) {
  const map = new Map<string, number>();
  for (const correction of corrections) {
    if (!correction.id) continue;
    if (!Number.isFinite(correction.costBasis) || correction.costBasis < 0) continue;
    map.set(correction.id, correction.costBasis);
  }
  return map;
}

function applyCostCorrections(trades: RealizedTrade[], corrections: CostBasisCorrection[] = []) {
  if (corrections.length === 0) return trades;
  const correctionsById = costCorrectionMap(corrections);
  if (correctionsById.size === 0) return trades;

  return trades.map((trade) => {
    const correction =
      correctionsById.get(costCorrectionKeyForRealizedTradeId(trade.id)) ?? correctionsById.get(trade.id);
    if (correction === undefined) return trade;

    const costBasis = roundMoney(correction);
    const gainLoss = roundMoney(trade.proceeds - costBasis);
    return {
      ...trade,
      costBasis,
      gainLoss,
      note: `${trade.note ? `${trade.note}；` : ""}用户手动订正成本：${costBasis}`,
    };
  });
}

function capitalGainRmbFromTrades(trades: RealizedTrade[], config: TaxConfig) {
  return trades.reduce((sum, trade) => sum + toRmb(trade.gainLoss, trade.currency, config), 0);
}

function buildTaxScenarios(
  input: ParsedInput,
  config: TaxConfig,
  selectedYear?: number,
  costCorrections: CostBasisCorrection[] = [],
): TaxScenarioSummary[] {
  const targetYear = selectedYear ?? maxActivityYear(input);
  return taxWindows(targetYear).flatMap((window) => {
    return (["fifo", "acb"] as const).map((method) => {
      const result = replayScenario(input, window, method, config);
      const trades = applyCostCorrections([...result.trades, ...brokerReportedTradesInWindow(input, window)], costCorrections);
      const id = `calendar-${method}` as TaxScenarioId;
      const capitalGainRmb = capitalGainRmbFromTrades(trades, config);
      const activeSummaries = activeTaxStatementSummaries(input, window);
      const summaryCapitalGainRmb = activeSummaries.reduce(
        (sum, summary) => sum + toRmb(summary.realizedGainLoss, summary.currency, config),
        0,
      );
      const totalCapitalGainRmb = capitalGainRmb + summaryCapitalGainRmb;
      const capitalTaxBaseRmb = Math.max(totalCapitalGainRmb, 0);
      return {
        id,
        label: `自然年 ${method.toUpperCase()}`,
        yearLabel: window.label,
        yearStart: window.start,
        yearEnd: window.end,
        taxYearMode: window.mode,
        costBasisMethod: method,
        capitalGainRmb: roundMoney(totalCapitalGainRmb),
        capitalTaxBaseRmb: roundMoney(capitalTaxBaseRmb),
        capitalEstimatedTaxRmb: roundMoney(capitalTaxBaseRmb * config.taxRate),
        realizedTradeCount: trades.length,
        missingCostIssueCount: result.missingCostIssueCount,
        isDefault: method === "acb",
      } satisfies TaxScenarioSummary;
    });
  });
}

export function analyzeTaxInput(
  input: ParsedInput,
  config: TaxConfig = defaultTaxConfig,
): TaxAnalysis {
  const included = input.realizedTrades.filter((trade) => !trade.excluded);
  const excluded = input.realizedTrades.filter((trade) => trade.excluded);
  const activeSummaries = activeTaxStatementSummaries(input);

  const symbolMap = new Map<string, SymbolSummary>();
  const brokerMap = new Map<string, BrokerSummary>();
  const currencyMap = new Map<Currency, CurrencySummary>();

  for (const trade of included) {
    const symbolKey = key([trade.broker, trade.currency, trade.symbol]);
    const existing =
      symbolMap.get(symbolKey) ??
      ({
        broker: trade.broker,
        currency: trade.currency,
        symbol: trade.symbol,
        securityName: trade.securityName,
        quantity: 0,
        proceeds: 0,
        costBasis: 0,
        gainLoss: 0,
        gainLossRmb: 0,
        positiveGainReference: 0,
        positiveGainReferenceRmb: 0,
        status: "flat",
      } satisfies SymbolSummary);

    existing.quantity += trade.quantity;
    existing.proceeds += trade.proceeds;
    existing.costBasis += trade.costBasis;
    existing.gainLoss += trade.gainLoss;
    existing.gainLossRmb += toRmb(trade.gainLoss, trade.currency, config);
    if (trade.gainLoss > 0) {
      existing.positiveGainReference += trade.gainLoss;
      existing.positiveGainReferenceRmb += toRmb(trade.gainLoss, trade.currency, config);
    }
    existing.status = statusFor(existing.gainLoss);
    symbolMap.set(symbolKey, existing);

    const broker =
      brokerMap.get(trade.broker) ??
      ({
        broker: trade.broker,
        gainLossRmb: 0,
        taxableBaseRmb: 0,
        estimatedTaxRmb: 0,
      } satisfies BrokerSummary);
    broker.gainLossRmb += toRmb(trade.gainLoss, trade.currency, config);
    brokerMap.set(trade.broker, broker);

    const currency =
      currencyMap.get(trade.currency) ??
      ({
        currency: trade.currency,
        gainLoss: 0,
        taxableBase: 0,
        estimatedTaxRmb: 0,
      } satisfies CurrencySummary);
    currency.gainLoss += trade.gainLoss;
    currencyMap.set(trade.currency, currency);
  }

  const capitalGainRmb = included.reduce(
    (sum, trade) => sum + toRmb(trade.gainLoss, trade.currency, config),
    0,
  ) + activeSummaries.reduce((sum, summary) => sum + toRmb(summary.realizedGainLoss, summary.currency, config), 0);
  const capitalTaxBaseRmb = Math.max(capitalGainRmb, 0);
  const capitalEstimatedTaxRmb = capitalTaxBaseRmb * config.taxRate;

  const strictPositiveGainTaxReferenceRmb =
    included.reduce((sum, trade) => {
      return sum + toRmb(Math.max(trade.gainLoss, 0), trade.currency, config);
    }, 0) * config.taxRate +
    activeSummaries.reduce((sum, summary) => {
      return sum + toRmb(Math.max(summary.realizedGainLoss, 0), summary.currency, config);
    }, 0) *
      config.taxRate;

  for (const summary of activeSummaries) {
    const broker =
      brokerMap.get(summary.broker) ??
      ({
        broker: summary.broker,
        gainLossRmb: 0,
        taxableBaseRmb: 0,
        estimatedTaxRmb: 0,
      } satisfies BrokerSummary);
    broker.gainLossRmb += toRmb(summary.realizedGainLoss, summary.currency, config);
    brokerMap.set(summary.broker, broker);

    const currency =
      currencyMap.get(summary.currency) ??
      ({
        currency: summary.currency,
        gainLoss: 0,
        taxableBase: 0,
        estimatedTaxRmb: 0,
      } satisfies CurrencySummary);
    currency.gainLoss += summary.realizedGainLoss;
    currencyMap.set(summary.currency, currency);
  }

  const finalBrokers = Array.from(brokerMap.values()).map((broker) => {
    const taxableBaseRmb = Math.max(broker.gainLossRmb, 0);
    return {
      ...broker,
      gainLossRmb: roundMoney(broker.gainLossRmb),
      taxableBaseRmb: roundMoney(taxableBaseRmb),
      estimatedTaxRmb: roundMoney(taxableBaseRmb * config.taxRate),
    };
  });

  const currencies = Array.from(currencyMap.values()).map((currency) => {
    const taxableBase = Math.max(currency.gainLoss, 0);
    return {
      ...currency,
      gainLoss: roundMoney(currency.gainLoss),
      taxableBase: roundMoney(taxableBase),
      estimatedTaxRmb: roundMoney(toRmb(taxableBase, currency.currency, config) * config.taxRate),
    };
  });

  const dividendGrossRmb = input.dividends.reduce(
    (sum, dividend) => sum + toRmb(dividend.grossAmount, dividend.currency, config),
    0,
  ) + activeSummaries.reduce((sum, summary) => sum + toRmb(summary.cashDividends, summary.currency, config), 0);
  const withholdingCreditRmb = input.dividends.reduce(
    (sum, dividend) => sum + toRmb(dividend.taxWithheld, dividend.currency, config),
    0,
  ) + activeSummaries.reduce((sum, summary) => sum + toRmb(Math.abs(summary.dividendTaxWithheld), summary.currency, config), 0);
  const dividendTaxBeforeCredit = dividendGrossRmb * config.taxRate;
  const dividendEstimatedTaxRmb = Math.max(dividendTaxBeforeCredit - withholdingCreditRmb, 0);

  return {
    config,
    generatedAt: new Date().toISOString(),
    summary: {
      capitalGainRmb: roundMoney(capitalGainRmb),
      capitalTaxBaseRmb: roundMoney(capitalTaxBaseRmb),
      capitalEstimatedTaxRmb: roundMoney(capitalEstimatedTaxRmb),
      dividend: {
        grossRmb: roundMoney(dividendGrossRmb),
        withholdingCreditRmb: roundMoney(withholdingCreditRmb),
        taxableBaseRmb: roundMoney(dividendGrossRmb),
        estimatedTaxRmb: roundMoney(dividendEstimatedTaxRmb),
      },
      totalEstimatedTaxRmb: roundMoney(capitalEstimatedTaxRmb + dividendEstimatedTaxRmb),
      strictPositiveGainTaxReferenceRmb: roundMoney(strictPositiveGainTaxReferenceRmb),
    },
    brokers: finalBrokers,
    currencies,
    symbols: Array.from(symbolMap.values())
      .map((symbol) => ({
        ...symbol,
        quantity: roundMoney(symbol.quantity),
        proceeds: roundMoney(symbol.proceeds),
        costBasis: roundMoney(symbol.costBasis),
        gainLoss: roundMoney(symbol.gainLoss),
        gainLossRmb: roundMoney(symbol.gainLossRmb),
        positiveGainReference: roundMoney(symbol.positiveGainReference),
        positiveGainReferenceRmb: roundMoney(symbol.positiveGainReferenceRmb),
      }))
      .sort((a, b) => b.gainLossRmb - a.gainLossRmb),
    realizedTrades: included,
    tradeActivities: input.tradeActivities,
    excludedTrades: excluded,
    dividends: input.dividends,
    openPositions: input.openPositions,
    issues: [...inputIssuesForAnalysis(input), ...taxStatementReviewIssues(input, included)],
    costBasisRequests: input.costBasisRequests,
    taxScenarios: buildTaxScenarios(input, config),
  };
}

export function analyzeTaxScenarioInput(
  input: ParsedInput,
  targetYear: number,
  costBasisMethod: CostBasisMethod,
  config: TaxConfig = defaultTaxConfig,
  costCorrections: CostBasisCorrection[] = [],
): TaxAnalysis {
  const [window] = taxWindows(targetYear);
  const scenario = replayScenario(input, window, costBasisMethod, config);
  const correctedTrades = applyCostCorrections(
    [...scenario.trades, ...brokerReportedTradesInWindow(input, window)],
    costCorrections,
  );
  const dividends = input.dividends.filter((dividend) => inWindow(dividend.date, window));
  const openPositions = enrichOpenPositionsWithEndingCosts(
    input.openPositions.filter((position) => !position.asOf || position.asOf.startsWith(String(targetYear))),
    scenario.endingStates,
    costBasisMethod,
  );
  const scopedInput: ParsedInput = {
    ...input,
    realizedTrades: correctedTrades,
    dividends,
    openPositions,
    costBasisRequests: input.costBasisRequests.filter((request) => inWindow(request.sellDate, window)),
    taxStatementSummaries: (input.taxStatementSummaries ?? []).filter((summary) => inSummaryPeriod(summary, window)),
  };
  const analysis = analyzeTaxInput(scopedInput, config);
  return {
    ...analysis,
    taxScenarios: buildTaxScenarios(input, config, targetYear, costCorrections),
  };
}

export function emptyParsedInput(): ParsedInput {
  return {
    realizedTrades: [],
    tradeActivities: [],
    dividends: [],
    openPositions: [],
    issues: [],
    costBasisRequests: [],
    taxStatementSummaries: [],
  };
}

export function mergeParsedInputs(inputs: ParsedInput[]): ParsedInput {
  return inputs.reduce<ParsedInput>(
    (merged, current) => ({
      realizedTrades: [...merged.realizedTrades, ...current.realizedTrades],
      tradeActivities: [...merged.tradeActivities, ...current.tradeActivities],
      dividends: [...merged.dividends, ...current.dividends],
      openPositions: [...merged.openPositions, ...current.openPositions],
      issues: [...merged.issues, ...current.issues],
      costBasisRequests: [...merged.costBasisRequests, ...current.costBasisRequests],
      taxStatementSummaries: [...merged.taxStatementSummaries, ...(current.taxStatementSummaries ?? [])],
    }),
    emptyParsedInput(),
  );
}

export function realizedTradeId(trade: Omit<RealizedTrade, "id">) {
  return key([
    trade.broker,
    trade.sellDate,
    trade.currency,
    trade.symbol,
    trade.quantity,
    trade.proceeds,
  ]);
}
