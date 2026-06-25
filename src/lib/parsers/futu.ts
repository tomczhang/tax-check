import * as XLSX from "xlsx";
import { asCurrency, asNumber, normalizeSymbol, ParserValidationError, sourceId } from "./common";
import { emptyParsedInput } from "@/lib/tax/calculator";
import type {
  CostBasisRequest,
  Currency,
  DividendIncome,
  OpenPosition,
  ParsedInput,
  RealizedTrade,
  ReviewIssue,
  TradeActivity,
} from "@/lib/tax/types";

interface FutuFileInput {
  name: string;
  data: ArrayBuffer;
}

interface WorkbookContext {
  fileName: string;
  workbook: XLSX.WorkBook;
  year: number;
}

interface PositionState {
  market: string;
  currency: Currency;
  name: string;
  quantity: number;
  costBasis: number;
}

export interface ManualCostInput {
  id: string;
  costBasis: number;
}

interface MissingCostAggregate {
  id: string;
  broker: string;
  sellDate: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  proceeds: number;
  trackedQuantity: number;
  source: string;
  note: string;
  sales: MissingCostSale[];
}

interface MissingCostSale {
  date: string;
  time: string;
  sequence: number;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  proceeds: number;
  source: string;
  note: string;
}

type FutuEvent =
  | {
      kind: "acquire";
      date: string;
      time: string;
      sequence: number;
      market: string;
      currency: Currency;
      symbol: string;
      securityName: string;
      quantity: number;
      cost: number;
      source: string;
      note: string;
    }
  | {
      kind: "buy" | "sell";
      date: string;
      time: string;
      sequence: number;
      market: string;
      currency: Currency;
      symbol: string;
      securityName: string;
      quantity: number;
      unitPrice: number;
      grossAmount: number;
      fee: number;
      cash: number;
      source: string;
      note: string;
    };

const REQUIRED_SHEETS = ["账户信息", "证券-持仓总览", "证券-交易流水", "证券-资产进出", "证券-资金进出"];
const REQUIRED_HEADERS: Record<string, string[]> = {
  账户信息: ["姓名", "牛牛号", "账户号码", "账户名称", "年份"],
  "证券-持仓总览": ["时期类型", "日期", "代码名称", "交易所/市场", "币种", "数量/面值", "价格", "市值"],
  "证券-交易流水": ["成交时间", "代码名称", "交易所/市场", "方向", "币种", "数量/面值", "变动金额"],
  "证券-资产进出": ["日期", "代码名称", "交易所/市场", "方向", "类型", "币种", "数量", "备注"],
  "证券-资金进出": ["日期", "类型", "方向", "币种", "变动金额", "备注"],
};

const KNOWN_SECURITY_NAMES: Record<string, string> = {
  "00175": "吉利汽车",
  "00700": "腾讯控股 / TENCENT",
  "01828": "FWD集团 / FWD GROUP",
  "02050": "三花智控 / SANHUA",
  "02590": "极智嘉-W / GEEKPLUS-W",
  "03288": "海天味业 / HAITIAN FLAV",
  "06082": "颖通控股",
  "06613": "蓝思科技 / LENS",
  "09618": "京东集团-SW / JD-SW",
  "09988": "阿里巴巴-W / BABA-W",
};

function rowObject(headers: unknown[], values: unknown[]) {
  return Object.fromEntries(headers.map((header, index) => [String(header ?? ""), values[index]]));
}

function readRows(workbook: XLSX.WorkBook, sheetName: string) {
  const sheet = workbook.Sheets[sheetName];
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
}

function validateWorkbook(fileName: string, workbook: XLSX.WorkBook) {
  const missingSheets = REQUIRED_SHEETS.filter((sheetName) => !workbook.Sheets[sheetName]);
  if (missingSheets.length > 0) {
    throw new ParserValidationError(
      `富途只支持“年度报表”Excel。${fileName} 不是需要的文件，请删除后重新解析。`,
      fileName,
    );
  }

  for (const [sheetName, requiredHeaders] of Object.entries(REQUIRED_HEADERS)) {
    const rows = readRows(workbook, sheetName);
    const headers = new Set((rows[0] ?? []).map((header) => String(header ?? "")));
    const missingHeaders = requiredHeaders.filter((header) => !headers.has(header));
    if (missingHeaders.length > 0) {
      throw new ParserValidationError(
        `富途只支持“年度报表”Excel。${fileName} 不是需要的文件，请删除后重新解析。`,
        fileName,
      );
    }
  }
}

function parseWorkbookYear(fileName: string, workbook: XLSX.WorkBook) {
  const rows = readRows(workbook, "账户信息");
  const headers = rows[0] ?? [];
  for (const values of rows.slice(1)) {
    const row = rowObject(headers, values);
    const year = Number(String(row["年份"] ?? "").slice(0, 4));
    if (Number.isFinite(year) && year >= 2000) return year;
  }
  const fileYear = fileName.match(/20\d{2}/)?.[0];
  if (fileYear) return Number(fileYear);
  return new Date().getFullYear();
}

function normalizeFutuDate(value: unknown) {
  const text = String(value ?? "").trim();
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const datetime = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}:\d{2}:\d{2}))?/);
  if (datetime) return `${datetime[1]}-${datetime[2]}-${datetime[3]}`;
  return text;
}

function normalizeFutuTime(value: unknown) {
  const text = String(value ?? "").trim();
  return text.match(/\b(\d{2}:\d{2}:\d{2})\b/)?.[1] ?? "99:99:99";
}

function marketName(value: unknown) {
  const text = String(value ?? "").toUpperCase();
  if (text.includes("SEHK") || text.includes("HK")) return "香港市场";
  if (text.includes("US")) return "美国市场";
  return text || "未知市场";
}

function securityName(symbol: string) {
  return KNOWN_SECURITY_NAMES[symbol] ?? symbol;
}

function securityNameForCategory(symbol: string, category: unknown) {
  return String(category ?? "").trim() === "基金" ? `基金 ${symbol}` : securityName(symbol);
}

function includesDividendMarker(note: string) {
  const upper = note.toUpperCase();
  return upper.includes("F/D") || upper.includes("S/D") || upper.includes("DIVIDEND");
}

function parseSecurityFromNote(note: string) {
  const sehk = note.match(/<(?:SEHK|HKEX|HKFX)\s+0?(\d{3,5})\s+([^>]+)>/i);
  if (sehk) {
    const symbol = normalizeSymbol(sehk[1]);
    return {
      symbol,
      securityName: KNOWN_SECURITY_NAMES[symbol] ?? sehk[2].replace(/\s+\d+\s*(shares|股|shs).*$/i, "").trim(),
    };
  }
  const hash = note.match(/#0?(\d{3,5})/i);
  if (hash) {
    const symbol = normalizeSymbol(hash[1]);
    return {
      symbol,
      securityName: securityName(symbol),
    };
  }
  return {
    symbol: "UNKNOWN",
    securityName: "未识别证券",
  };
}

function extractIpoSymbol(note: string) {
  const match = note.match(/#0?(\d{3,5})/);
  return match ? normalizeSymbol(match[1]) : null;
}

function isSupportedTradeCategory(value: unknown) {
  const category = String(value ?? "").trim();
  return !category || category === "证券" || category === "基金";
}

function isFutuBuySide(value: unknown) {
  const side = String(value ?? "");
  return side.includes("买入") || side.includes("申购");
}

function isFutuSellSide(value: unknown) {
  const side = String(value ?? "");
  return side.includes("卖出") || side.includes("赎回");
}

function positionKey(currency: Currency, symbol: string) {
  return `${currency}::${symbol}`;
}

function stateAvgCost(state: PositionState) {
  return Math.abs(state.quantity) < 1e-9 ? 0 : state.costBasis / state.quantity;
}

function tradeId(event: FutuEvent, costBasis: number) {
  return `futu-${event.date}-${event.currency}-${event.symbol}-${event.quantity}-${Math.round(costBasis * 100)}`;
}

function activityAmount(event: FutuEvent) {
  if ("cash" in event) return event.kind === "buy" ? -event.cash : event.cash;
  return event.cost;
}

function buildTradeActivities(events: FutuEvent[]): TradeActivity[] {
  return events.map((event) => ({
    id: `futu-activity-${event.date}-${event.sequence}-${event.currency}-${event.symbol}-${event.kind}`,
    broker: "富途",
    date: event.date,
    time: event.time,
    sequence: event.sequence,
    market: event.market,
    currency: event.currency,
    symbol: event.symbol,
    securityName: event.securityName,
    side: event.kind === "acquire" ? "acquire" : event.kind,
    quantity: event.quantity,
    unitPrice: "unitPrice" in event ? event.unitPrice : undefined,
    grossAmount: "grossAmount" in event ? event.grossAmount : undefined,
    fee: "fee" in event ? event.fee : undefined,
    amount: activityAmount(event),
    source: event.source,
    note: event.note,
  }));
}

function parseDividends(contexts: WorkbookContext[]): DividendIncome[] {
  const dividends: DividendIncome[] = [];

  for (const context of contexts) {
    const rows = readRows(context.workbook, "证券-资金进出");
    const headers = rows[0] ?? [];
    const dividendMap = new Map<string, DividendIncome>();
    const pendingFees = new Map<string, number>();

    rows.slice(1).forEach((values, index) => {
      const row = rowObject(headers, values);
      const note = String(row["备注"] ?? "");
      const amount = asNumber(row["变动金额"]);
      const direction = String(row["方向"] ?? "");
      const date = normalizeFutuDate(row["日期"]);

      if (includesDividendMarker(note) && amount > 0) {
        const security = parseSecurityFromNote(note);
        const id = `${context.fileName}-dividend-${date}-${security.symbol}-${index}`;
        const feeKey = `${date}-${security.symbol}`;
        dividendMap.set(id, {
          id,
          broker: "富途",
          date,
          currency: asCurrency(row["币种"]),
          symbol: security.symbol,
          securityName: security.securityName,
          grossAmount: amount,
          taxWithheld: 0,
          fee: pendingFees.get(feeKey) ?? 0,
          source: sourceId(context.fileName, index + 2),
          note,
        });
        pendingFees.delete(feeKey);
      }

      if ((note.toUpperCase().includes("HANDLING") || note.includes("手续费")) && direction === "Out") {
        const security = parseSecurityFromNote(note);
        const feeKey = `${date}-${security.symbol}`;
        const nearby = Array.from(dividendMap.values()).reverse().find((dividend) => {
          return dividend.date === date && dividend.symbol === security.symbol;
        });
        if (nearby) {
          nearby.fee += Math.abs(amount);
        } else {
          pendingFees.set(feeKey, (pendingFees.get(feeKey) ?? 0) + Math.abs(amount));
        }
      }
    });

    dividends.push(...dividendMap.values());
  }

  return dividends;
}

function buildIpoCostMap(contexts: WorkbookContext[]) {
  const ipoCostMap = new Map<string, number>();

  for (const context of contexts) {
    const rows = readRows(context.workbook, "证券-资金进出");
    const headers = rows[0] ?? [];
    for (const values of rows.slice(1)) {
      const row = rowObject(headers, values);
      const type = String(row["类型"] ?? "");
      const note = String(row["备注"] ?? "");
      if (!type.includes("IPO") && !note.includes("IPO")) continue;
      const symbol = extractIpoSymbol(note);
      if (!symbol) continue;
      const currency = asCurrency(row["币种"]);
      const account = String(row["账户号码"] ?? "");
      const key = `${account}::${currency}::${symbol}`;
      ipoCostMap.set(key, (ipoCostMap.get(key) ?? 0) - asNumber(row["变动金额"]));
    }
  }

  return ipoCostMap;
}

function parseFutuEvents(contexts: WorkbookContext[]) {
  const events: FutuEvent[] = [];
  const ipoCostMap = buildIpoCostMap(contexts);
  let sequence = 0;

  for (const context of contexts) {
    const tradeRows = readRows(context.workbook, "证券-交易流水");
    const tradeHeaders = tradeRows[0] ?? [];
    for (const [index, values] of tradeRows.slice(1).entries()) {
      const row = rowObject(tradeHeaders, values);
      if (!isSupportedTradeCategory(row["品类"])) continue;
      const side = String(row["方向"] ?? "");
      const isBuy = isFutuBuySide(side);
      const isSell = isFutuSellSide(side);
      if (!isBuy && !isSell) continue;
      const symbol = normalizeSymbol(row["代码名称"]);
      const quantity = Math.abs(asNumber(row["数量/面值"]));
      const unitPrice = Math.abs(asNumber(row["价格"]));
      const grossAmountFromColumn = Math.abs(asNumber(row["成交金额"]));
      const cash = asNumber(row["变动金额"]);
      const grossAmount = grossAmountFromColumn || quantity * unitPrice;
      const explicitFee = Math.abs(asNumber(row["总费用"]));
      const impliedFee = grossAmount ? Math.abs(Math.abs(cash) - grossAmount) : 0;
      const fee = explicitFee || impliedFee;
      if (!symbol || quantity <= 0) continue;
      events.push({
        kind: isBuy ? "buy" : "sell",
        date: normalizeFutuDate(row["成交时间"]),
        time: normalizeFutuTime(row["成交时间"]),
        sequence,
        market: marketName(row["交易所/市场"]),
        currency: asCurrency(row["币种"]),
        symbol,
        securityName: securityNameForCategory(symbol, row["品类"]),
        quantity,
        unitPrice,
        grossAmount,
        fee,
        cash,
        source: sourceId(context.fileName, index + 2),
        note: side,
      });
      sequence += 1;
    }

    const moveRows = readRows(context.workbook, "证券-资产进出");
    const moveHeaders = moveRows[0] ?? [];
    for (const [index, values] of moveRows.slice(1).entries()) {
      const row = rowObject(moveHeaders, values);
      const type = String(row["类型"] ?? "");
      const direction = String(row["方向"] ?? "");
      if (direction !== "In" || !type.includes("IPO")) continue;
      const symbol = normalizeSymbol(row["代码名称"]);
      const currency = asCurrency(row["币种"]);
      const account = String(row["账户号码"] ?? "");
      const quantity = asNumber(row["数量"]);
      const cost = ipoCostMap.get(`${account}::${currency}::${symbol}`) ?? 0;
      if (!symbol || quantity <= 0) continue;
      events.push({
        kind: "acquire",
        date: normalizeFutuDate(row["日期"]),
        time: "00:00:00",
        sequence,
        market: marketName(row["交易所/市场"]),
        currency,
        symbol,
        securityName: securityName(symbol),
        quantity,
        cost,
        source: sourceId(context.fileName, index + 2),
        note: "IPO中签",
      });
      sequence += 1;
    }
  }

  return events.sort((a, b) => {
    return a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.sequence - b.sequence;
  });
}

function buildRealizedTrades(
  events: FutuEvent[],
  targetYear: number,
  manualCosts: Map<string, number>,
): { trades: RealizedTrade[]; issues: ReviewIssue[]; costBasisRequests: CostBasisRequest[] } {
  const states = new Map<string, PositionState>();
  const trades: RealizedTrade[] = [];
  const issues: ReviewIssue[] = [];
  const missingCost = new Map<string, MissingCostAggregate>();

  for (const event of events) {
    const key = positionKey(event.currency, event.symbol);
    const state =
      states.get(key) ??
      ({
        market: event.market,
        currency: event.currency,
        name: event.securityName,
        quantity: 0,
        costBasis: 0,
      } satisfies PositionState);
    state.market = event.market || state.market;
    state.currency = event.currency || state.currency;
    state.name = event.securityName || state.name;

    if (event.kind === "acquire") {
      state.quantity += event.quantity;
      state.costBasis += event.cost;
    } else if (event.kind === "buy") {
      state.quantity += event.quantity;
      state.costBasis += -event.cash;
    } else {
      if (state.quantity + 1e-7 < event.quantity) {
        if (event.date.startsWith(String(targetYear))) {
          const existing = missingCost.get(key);
          const requestId = `futu-cost-${targetYear}-${event.currency}-${event.symbol}`;
          missingCost.set(key, {
            id: requestId,
            broker: "富途",
            sellDate: existing?.sellDate ?? event.date,
            market: event.market,
            currency: event.currency,
            symbol: event.symbol,
            securityName: event.securityName,
            quantity: (existing?.quantity ?? 0) + event.quantity,
            proceeds: (existing?.proceeds ?? 0) + event.cash,
            trackedQuantity: Math.max(existing?.trackedQuantity ?? 0, state.quantity),
            source: existing?.source ?? event.source,
            note: "手动补录总成本后计入资本利得",
            sales: [
              ...(existing?.sales ?? []),
              {
                date: event.date,
                time: event.time,
                sequence: event.sequence,
                market: event.market,
                currency: event.currency,
                symbol: event.symbol,
                securityName: event.securityName,
                quantity: event.quantity,
                proceeds: event.cash,
                source: event.source,
                note: event.note,
              },
            ],
          });
        }
        state.quantity = 0;
        state.costBasis = 0;
        states.set(key, state);
        continue;
      }

      const costBasis = event.quantity * stateAvgCost(state);
      if (event.date.startsWith(String(targetYear))) {
        trades.push({
          id: tradeId(event, costBasis),
          broker: "富途",
          sellDate: event.date,
          market: event.market,
          currency: event.currency,
          symbol: event.symbol,
          securityName: event.securityName,
          quantity: event.quantity,
          proceeds: event.cash,
          costBasis,
          gainLoss: event.cash - costBasis,
          source: event.source,
          note: event.note,
        });
      }

      state.quantity -= event.quantity;
      state.costBasis -= costBasis;
      if (Math.abs(state.quantity) < 1e-8) {
        state.quantity = 0;
        state.costBasis = 0;
      }
    }

    states.set(key, state);
  }

  const costBasisRequests: CostBasisRequest[] = [];

  for (const item of missingCost.values()) {
    const manualCostBasis = manualCosts.get(item.id);
    if (manualCostBasis !== undefined) {
      let allocatedCost = 0;
      item.sales.forEach((sale, index) => {
        const costBasis =
          index === item.sales.length - 1
            ? manualCostBasis - allocatedCost
            : (manualCostBasis * sale.quantity) / item.quantity;
        allocatedCost += costBasis;
        trades.push({
          id: `${item.id}-${sale.date}-${sale.sequence}-manual`,
          broker: item.broker,
          sellDate: sale.date,
          market: sale.market,
          currency: sale.currency,
          symbol: sale.symbol,
          securityName: sale.securityName,
          quantity: sale.quantity,
          proceeds: sale.proceeds,
          costBasis,
          gainLoss: sale.proceeds - costBasis,
          source: sale.source,
          note: `用户手动补录总成本：${manualCostBasis}；按卖出数量分摊`,
        });
      });
      continue;
    }

    costBasisRequests.push({
      id: item.id,
      broker: item.broker,
      sellDate: item.sellDate,
      market: item.market,
      currency: item.currency,
      symbol: item.symbol,
      securityName: item.securityName,
      quantity: item.quantity,
      proceeds: item.proceeds,
      source: item.source,
      note: item.note,
    });
    issues.push({
      id: `futu-${targetYear}-${item.symbol}-cost-gap`,
      severity: "warning",
      title: `${item.symbol} 历史成本缺失`,
      detail: `目标年度卖出 ${item.quantity} 股，但上传文件中最多只追踪到 ${item.trackedQuantity} 股成本；相关卖出未计入资本利得，需要补充更早年度记录或手动在 **盈亏明细-待补成本** 中添加成本。`,
      source: item.source,
    });
  }

  return { trades, issues, costBasisRequests };
}

function manualCostMap(manualCosts: ManualCostInput[] = []) {
  const costs = new Map<string, number>();
  for (const item of manualCosts) {
    if (!item.id) continue;
    if (!Number.isFinite(item.costBasis) || item.costBasis < 0) continue;
    costs.set(item.id, item.costBasis);
  }
  return costs;
}

function parseOpenPositions(contexts: WorkbookContext[], targetYear?: number): OpenPosition[] {
  const positions = new Map<string, OpenPosition>();

  for (const context of contexts) {
    const rows = readRows(context.workbook, "证券-持仓总览");
    const headers = rows[0] ?? [];
    for (const [index, values] of rows.slice(1).entries()) {
      const row = rowObject(headers, values);
      const periodType = String(row["时期类型"] ?? "");
      const category = String(row["品类"] ?? "");
      const asOf = normalizeFutuDate(row["日期"]);
      const symbol = normalizeSymbol(row["代码名称"]);
      const quantity = asNumber(row["数量/面值"]);
      const price = asNumber(row["价格"]);
      const multiplier = asNumber(row["乘数"]) || 1;
      const marketValue = asNumber(row["市值"]) || quantity * price * multiplier;
      const positionYear = Number(asOf.slice(0, 4));
      if (!periodType.includes("期末")) continue;
      if (category && category !== "证券" && category !== "基金") continue;
      if (targetYear && !asOf.startsWith(String(targetYear))) continue;
      if (!symbol || quantity <= 0 || !Number.isFinite(positionYear)) continue;

      const currency = asCurrency(row["币种"]);
      const key = `${positionYear}::${currency}::${symbol}`;
      const existing = positions.get(key);
      if (existing) {
        existing.quantity += quantity;
        existing.marketValue += marketValue;
        continue;
      }

      positions.set(key, {
        id: `futu-open-${positionYear}-${currency}-${symbol}`,
        broker: "富途",
        asOf,
        market: marketName(row["交易所/市场"]),
        currency,
        symbol,
        securityName: securityNameForCategory(symbol, row["品类"]),
        quantity,
        marketValue,
        source: sourceId(context.fileName, index + 2),
        note: "富途证券-持仓总览期末持仓；未提供历史成本时仅展示期末估值。",
      });
    }
  }

  return Array.from(positions.values());
}

function inferOpenPositionsFromEvents(events: FutuEvent[], targetYear: number, existingPositions: OpenPosition[]): OpenPosition[] {
  const existingKeys = new Set(
    existingPositions.map((position) => `${position.asOf.slice(0, 4)}::${position.currency}::${position.symbol}`),
  );
  const states = new Map<
    string,
    {
      market: string;
      currency: Currency;
      symbol: string;
      securityName: string;
      quantity: number;
      lastPrice: number;
      lastDate: string;
      source: string;
    }
  >();
  const endDate = `${targetYear}-12-31`;

  for (const event of events) {
    if (event.date > endDate) continue;
    const key = positionKey(event.currency, event.symbol);
    const state =
      states.get(key) ??
      ({
        market: event.market,
        currency: event.currency,
        symbol: event.symbol,
        securityName: event.securityName,
        quantity: 0,
        lastPrice: 0,
        lastDate: event.date,
        source: event.source,
      } satisfies {
        market: string;
        currency: Currency;
        symbol: string;
        securityName: string;
        quantity: number;
        lastPrice: number;
        lastDate: string;
        source: string;
      });

    state.market = event.market || state.market;
    state.securityName = event.securityName || state.securityName;
    state.lastDate = event.date;
    state.source = event.source;

    if (event.kind === "sell") {
      state.quantity = Math.max(0, state.quantity - event.quantity);
      state.lastPrice = event.unitPrice || state.lastPrice;
    } else {
      state.quantity += event.quantity;
      if ("unitPrice" in event) state.lastPrice = event.unitPrice || state.lastPrice;
    }

    if (Math.abs(state.quantity) < 1e-8) state.quantity = 0;
    states.set(key, state);
  }

  return Array.from(states.values())
    .filter((state) => {
      if (state.quantity <= 1e-8 || state.lastPrice <= 0) return false;
      return !existingKeys.has(`${targetYear}::${state.currency}::${state.symbol}`);
    })
    .map((state) => ({
      id: `futu-inferred-open-${targetYear}-${state.currency}-${state.symbol}`,
      broker: "富途",
      asOf: endDate,
      market: state.market,
      currency: state.currency,
      symbol: state.symbol,
      securityName: state.securityName,
      quantity: state.quantity,
      marketValue: state.quantity * state.lastPrice,
      source: state.source,
      note: `富途交易流水反推期末持仓；年度持仓总览未列出该标的，使用 ${state.lastDate} 最后成交价估算期末市值。`,
    }));
}

export function parseFutuWorkbooks(files: FutuFileInput[], manualCosts: ManualCostInput[] = [], taxYear?: number): ParsedInput {
  const parsed = emptyParsedInput();
  const contexts = files.map((file) => {
    const workbook = XLSX.read(file.data, { type: "array", cellDates: false });
    validateWorkbook(file.name, workbook);
    return {
      fileName: file.name,
      workbook,
      year: parseWorkbookYear(file.name, workbook),
    } satisfies WorkbookContext;
  });

  if (contexts.length === 0) return parsed;

  const targetYear = taxYear ?? Math.max(...contexts.map((context) => context.year));
  const events = parseFutuEvents(contexts);
  const realized = buildRealizedTrades(events, targetYear, manualCostMap(manualCosts));

  parsed.realizedTrades.push(...realized.trades);
  parsed.tradeActivities.push(...buildTradeActivities(events));
  parsed.dividends.push(...parseDividends(contexts));
  const openPositions = parseOpenPositions(contexts, targetYear);
  parsed.openPositions.push(...openPositions, ...inferOpenPositionsFromEvents(events, targetYear, openPositions));
  parsed.issues.push(...realized.issues);
  parsed.costBasisRequests.push(...realized.costBasisRequests);

  return parsed;
}

export function parseFutuWorkbook(fileName: string, buffer: ArrayBuffer, taxYear?: number): ParsedInput {
  return parseFutuWorkbooks([{ name: fileName, data: buffer }], [], taxYear);
}
