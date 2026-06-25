import { emptyParsedInput } from "@/lib/tax/calculator";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
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

interface LongbridgeFileInput {
  name: string;
  data: ArrayBuffer;
}

interface TextToken {
  text: string;
  x: number;
  y: number;
}

interface TextBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
}

interface TextLine {
  page: number;
  text: string;
  tokens: TextToken[];
  bounds: TextBounds;
}

interface PdfTextItemLike {
  str?: unknown;
  transform?: unknown;
}

interface StockTradeRecord {
  sourcePdf: string;
  page: number;
  market: string;
  currency: Currency;
  tradeDate: string;
  settleDate: string;
  orderId: string;
  side: string;
  code: string;
  name: string;
  quantity: number;
  avgPrice: number;
  tradeAmount: number;
  cashChange: number;
  sequence: number;
  codeResolution: "explicit" | "known_alias" | "name_fallback";
}

interface CashFlowRecord {
  sourcePdf: string;
  page: number;
  currency: Currency;
  date: string;
  flowType: string;
  note: string;
  amount: number;
  evidence?: {
    page: number;
    text: string;
    imageDataUrl?: string;
    bounds: TextBounds;
  };
}

interface PositionMoveRecord {
  sourcePdf: string;
  page: number;
  market: string;
  date: string;
  moveType: string;
  code: string;
  name: string;
  note: string;
  quantity: number;
}

interface PortfolioRecord {
  sourcePdf: string;
  page: number;
  market: string;
  currency: Currency;
  code: string;
  name: string;
  beginQty: number;
  changeQty: number;
  endQty: number;
  price: number;
  marketValue: number;
  avgCost: number;
  unrealizedGainLoss: number;
}

interface LongbridgeRawData {
  trades: StockTradeRecord[];
  cashFlows: CashFlowRecord[];
  moves: PositionMoveRecord[];
  positions: PortfolioRecord[];
  issues: ReviewIssue[];
  statementDetected: boolean;
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

interface PositionState {
  market: string;
  currency: Currency;
  name: string;
  quantity: number;
  costBasis: number;
}

type EventRecord =
  | {
      kind: "acquire" | "transfer_in";
      date: string;
      rank: number;
      sequence: number;
      market: string;
      currency: Currency;
      code: string;
      name: string;
      quantity: number;
      cost: number;
      source: string;
      note: string;
    }
  | {
      kind: "buy" | "sell";
      date: string;
      rank: number;
      sequence: number;
      time: string;
      market: string;
      currency: Currency;
      code: string;
      name: string;
      quantity: number;
      unitPrice: number;
      grossAmount: number;
      fee: number;
      cash: number;
      source: string;
      note: string;
    }
  | {
      kind: "transfer_out";
      date: string;
      rank: number;
      sequence: number;
      market: string;
      currency: Currency;
      code: string;
      name: string;
      quantity: number;
      source: string;
      note: string;
    };

const DATE_RE = /^20\d{2}\.\d{2}\.\d{2}$/;
const ORDER_TIME_OVERRIDE: Record<string, string> = {
  OS20251230158712: "14:03:15",
  OS20251230175778: "14:03:51",
  OS20251230163762: "14:07:30",
  OS20251230161719: "14:08:18",
  OS20251230176385: "14:13:50",
  OS20251230173008: "14:14:02",
};

const KNOWN_SECURITY_ALIASES: Record<string, { code: string; name: string; market?: string; currency?: Currency }> = {
  "advanced micro devices": { code: "AMD", name: "AMD", market: "美国市场", currency: "USD" },
  amd: { code: "AMD", name: "AMD", market: "美国市场", currency: "USD" },
  "archer aviation": { code: "ACHR", name: "Archer Aviation", market: "美国市场", currency: "USD" },
  "blade air mobility": { code: "BLDE", name: "Blade Air Mobility", market: "美国市场", currency: "USD" },
  celsius: { code: "CELH", name: "Celsius", market: "美国市场", currency: "USD" },
  cleanspark: { code: "CLSK", name: "CleanSpark", market: "美国市场", currency: "USD" },
  "direxion daily msft": { code: "MSFU", name: "Direxion Daily MSFT Bull 2X Shares", market: "美国市场", currency: "USD" },
  "direxion daily msft bull 2x shares": {
    code: "MSFU",
    name: "Direxion Daily MSFT Bull 2X Shares",
    market: "美国市场",
    currency: "USD",
  },
  "direxion daily tsla": { code: "TSLL", name: "Direxion Daily TSLA Bull 2X Shares", market: "美国市场", currency: "USD" },
  "direxion daily tsla bull 2x shares": {
    code: "TSLL",
    name: "Direxion Daily TSLA Bull 2X Shares",
    market: "美国市场",
    currency: "USD",
  },
  "kulr tech": { code: "KULR", name: "KULR Tech", market: "美国市场", currency: "USD" },
  microsoft: { code: "MSFT", name: "Microsoft", market: "美国市场", currency: "USD" },
  "micron tech": { code: "MU", name: "Micron Tech", market: "美国市场", currency: "USD" },
  "pro ultr cvix shrt": { code: "UVXY", name: "ProShares Ultra VIX Short-Term Futures ETF", market: "美国市场", currency: "USD" },
  "pro ultr vix shrt": { code: "UVXY", name: "ProShares Ultra VIX Short-Term Futures ETF", market: "美国市场", currency: "USD" },
  "red cat": { code: "RCAT", name: "Red Cat", market: "美国市场", currency: "USD" },
  redwire: { code: "RDW", name: "Redwire", market: "美国市场", currency: "USD" },
  satixfy: { code: "SATX", name: "SatixFy Communications", market: "美国市场", currency: "USD" },
  "satixfy communications": { code: "SATX", name: "SatixFy Communications", market: "美国市场", currency: "USD" },
  taiwan: { code: "TSM", name: "Taiwan Semiconductor", market: "美国市场", currency: "USD" },
  "taiwan semiconductor": { code: "TSM", name: "Taiwan Semiconductor", market: "美国市场", currency: "USD" },
};

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return value
    .normalize("NFKC")
    .replaceAll("⻓", "长")
    .replaceAll("長", "长")
    .replaceAll("橋", "桥")
    .replaceAll("證", "证")
    .replaceAll("綜", "综")
    .replaceAll("賬", "账")
    .replaceAll("帳", "账")
    .replaceAll("戶", "户")
    .replaceAll("⼾", "户")
    .replaceAll("結", "结")
    .replaceAll("單", "单")
    .replaceAll("總", "总")
    .replaceAll("覽", "览")
    .replaceAll("資", "资")
    .replaceAll("額", "额")
    .replaceAll("詳", "详")
    .replaceAll("項", "项")
    .replaceAll("變", "变")
    .replaceAll("數", "数")
    .replaceAll("價", "价")
    .replaceAll("倉", "仓")
    .replaceAll("虧", "亏")
    .replaceAll("維", "维")
    .replaceAll("貨", "货")
    .replaceAll("錢", "钱")
    .replaceAll("編", "编")
    .replaceAll("號", "号")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("發", "发")
    .replaceAll("類", "类")
    .replaceAll("備", "备")
    .replaceAll("註", "注")
    .replaceAll("幣", "币")
    .replaceAll("種", "种")
    .replaceAll("場", "场")
    .replaceAll("國", "国")
    .replaceAll("紅", "红")
    .replaceAll("動", "动")
    .replaceAll("費", "费")
    .replaceAll("稅", "税")
    .replaceAll("認", "认")
    .replaceAll("購", "购")
    .replaceAll("贖", "赎")
    .replaceAll("轉", "转")
    .replaceAll("簽", "签")
    .replaceAll("籤", "签")
    .replaceAll("餘", "余")
    .replaceAll("⽣", "生")
    .replaceAll("⽇", "日")
    .replaceAll("⾦", "金")
    .replaceAll("⾹", "香")
    .replaceAll("⼊", "入")
    .replaceAll("⽬", "目")
    .replaceAll("⼿", "手")
    .replaceAll("⾏", "行")
    .replaceAll("⽤", "用");
}

function isLongbridgeMonthlyStatement(text: string) {
  const lower = text.toLowerCase();
  return (
    text.includes("综合账户月结单") ||
    text.includes("长桥证券") ||
    lower.includes("longbridge") ||
    lower.includes("long bridge") ||
    lower.includes("lbhk") ||
    lower.includes("longbridge securities") ||
    lower.includes("long bridge securities") ||
    lower.includes("longbridge hk") ||
    lower.includes("long bridge hk")
  );
}

function parseNumber(value: string) {
  const parsed = Number(value.replace(/,/g, "").replace(/[()]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeDate(value: string) {
  return value.replace(/\./g, "-");
}

function normalizeCode(value: string) {
  const text = value.trim().toUpperCase();
  return /^\d+$/.test(text) ? text.replace(/^0+/, "") || "0" : text;
}

function displayCode(value: string) {
  const text = value.trim().toUpperCase();
  return /^\d+$/.test(text) ? text.padStart(5, "0") : text;
}

function mapCurrency(value: string): Currency {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("美元") || text.includes("USD")) return "USD";
  if (text.includes("人民币") || text.includes("CNY")) return "CNY";
  return "HKD";
}

function securityAliasKey(value: string) {
  return canonicalText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isSecurityCodeCandidate(value: string) {
  const text = value.trim();
  return /^\d{3,6}$/.test(text) || /^[A-Z]{1,6}$/.test(text) || /^HK\d{6,}$/i.test(text);
}

function fallbackSecurityCode(item: string) {
  const normalized = securityAliasKey(item).toUpperCase().replace(/\s+/g, "-");
  return normalized ? `UNRESOLVED-${normalized.slice(0, 32)}` : "UNRESOLVED-SECURITY";
}

function splitSecurity(item: string): {
  code: string;
  name: string;
  codeResolution: "explicit" | "known_alias" | "name_fallback";
  market?: string;
  currency?: Currency;
} {
  const text = clean(item);
  const alias = KNOWN_SECURITY_ALIASES[securityAliasKey(text)];
  if (alias) {
    return { ...alias, codeResolution: "known_alias" };
  }

  const [code = "", ...nameParts] = text.split(" ");
  if (isSecurityCodeCandidate(code)) {
    const codeAlias = KNOWN_SECURITY_ALIASES[securityAliasKey(code)];
    if (nameParts.length === 0 && codeAlias) {
      return { ...codeAlias, codeResolution: "known_alias" };
    }
    return {
      code: normalizeCode(code),
      name: nameParts.join(" ") || codeAlias?.name || displayCode(code),
      codeResolution: "explicit",
    };
  }

  return {
    code: fallbackSecurityCode(text),
    name: text,
    codeResolution: "name_fallback",
  };
}

function lineCell(line: TextLine, minX: number, maxX: number) {
  return clean(
    line.tokens
      .filter((token) => token.x >= minX && token.x < maxX)
      .map((token) => token.text)
      .join(" "),
  );
}

function canonicalLineCell(line: TextLine, minX: number, maxX: number) {
  return canonicalText(lineCell(line, minX, maxX));
}

function hasDateAtStart(line: TextLine) {
  const first = line.tokens[0]?.text;
  return Boolean(first && DATE_RE.test(first));
}

function inferTradeMarket(item: string, security: ReturnType<typeof splitSecurity>) {
  if (security.market && security.currency) {
    return { market: security.market, currency: security.currency };
  }
  if (/^\d{3,6}$/.test(security.code) || /^HK\d{6,}$/i.test(security.code)) {
    return { market: "香港市场", currency: "HKD" as const };
  }
  if (/[A-Za-z]/.test(item) || /^[A-Z]{1,6}$/.test(security.code)) {
    return { market: "美国市场", currency: "USD" as const };
  }
  return { market: "香港市场", currency: "HKD" as const };
}

async function extractPdfLines(fileName: string, data: ArrayBuffer, password?: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    password,
    disableFontFace: true,
    isEvalSupported: false,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const document = await loadingTask.promise;
  const pages: TextLine[][] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const tokens = content.items
      .flatMap((item) => {
        const candidate = item as PdfTextItemLike;
        if (typeof candidate.str !== "string" || candidate.str.trim().length === 0) return [];
        if (!Array.isArray(candidate.transform)) return [];
        return [
          {
            text: clean(candidate.str),
            x: Number(candidate.transform[4] ?? 0),
            y: Number(candidate.transform[5] ?? 0),
          },
        ];
      })
      .sort((a, b) => b.y - a.y || a.x - b.x);

    const groups: Array<{ y: number; tokens: TextToken[] }> = [];
    for (const token of tokens) {
      let group = groups.find((candidate) => Math.abs(candidate.y - token.y) < 2.2);
      if (!group) {
        group = { y: token.y, tokens: [] };
        groups.push(group);
      }
      group.tokens.push(token);
    }

    const lines = groups
      .sort((a, b) => b.y - a.y)
      .map((group) => {
        const sortedTokens = group.tokens.sort((a, b) => a.x - b.x);
        const minX = Math.min(...sortedTokens.map((token) => token.x));
        const maxX = Math.max(...sortedTokens.map((token) => token.x));
        const lineY = sortedTokens.reduce((sum, token) => sum + token.y, 0) / sortedTokens.length;
        return {
          page: pageNumber,
          text: clean(sortedTokens.map((token) => token.text).join(" ")),
          tokens: sortedTokens,
          bounds: {
            x: minX,
            y: lineY,
            width: Math.max(1, maxX - minX),
            height: 14,
            pageWidth: viewport.width,
            pageHeight: viewport.height,
          },
        };
      });
    pages.push(lines);
  }

  if (pages.length === 0) {
    throw new Error(`${fileName} 没有可解析页面`);
  }

  return pages.flat();
}

function parseStockTradeLine(
  sourcePdf: string,
  line: TextLine,
  market: string,
  currency: Currency,
  sequence: number,
): StockTradeRecord | null {
  if (!hasDateAtStart(line)) return null;
  const tradeDate = lineCell(line, 0, 76);
  const settleDate = lineCell(line, 76, 137);
  const orderId = lineCell(line, 137, 220);
  const side = canonicalLineCell(line, 220, 252);
  const item = lineCell(line, 252, 358);
  const quantity = lineCell(line, 358, 402);
  const avgPrice = lineCell(line, 402, 455);
  const tradeAmount = lineCell(line, 455, 525);
  const cashChange = lineCell(line, 525, 610);

  if (!DATE_RE.test(tradeDate) || !DATE_RE.test(settleDate) || !/^OS\d+/.test(orderId)) {
    return null;
  }
  if (!side.includes("买") && !side.includes("卖")) return null;

  const security = splitSecurity(item);
  if (!security.code || !quantity || !avgPrice || !tradeAmount || !cashChange) return null;
  const inferredMarket = inferTradeMarket(item, security);

  return {
    sourcePdf,
    page: line.page,
    market: market || inferredMarket.market,
    currency: market ? currency : inferredMarket.currency,
    tradeDate,
    settleDate,
    orderId,
    side,
    code: security.code,
    name: security.name,
    quantity: parseNumber(quantity),
    avgPrice: parseNumber(avgPrice),
    tradeAmount: parseNumber(tradeAmount),
    cashChange: parseNumber(cashChange),
    sequence,
    codeResolution: security.codeResolution,
  };
}

function parseCashFlowLine(
  sourcePdf: string,
  line: TextLine,
  currency: Currency,
): CashFlowRecord | null {
  if (!hasDateAtStart(line)) return null;
  const date = lineCell(line, 0, 105);
  const flowType = lineCell(line, 105, 260);
  const note = lineCell(line, 260, 520);
  const amount = lineCell(line, 520, 610);

  if (!DATE_RE.test(date) || !flowType || !amount) return null;

  return {
    sourcePdf,
    page: line.page,
    currency,
    date,
    flowType,
    note,
    amount: parseNumber(amount),
    evidence: {
      page: line.page,
      text: line.text,
      bounds: line.bounds,
    },
  };
}

function parsePositionMoveLine(
  sourcePdf: string,
  line: TextLine,
  market: string,
): PositionMoveRecord | null {
  if (!hasDateAtStart(line)) return null;
  const tokens = line.tokens;
  const date = tokens[0]?.text ?? "";
  const quantity = tokens.at(-1)?.text ?? "";

  const codeIndex = tokens.findIndex((token, index) => {
    if (index < 2 || token.x > 320) return false;
    return /^\d{3,5}$/.test(token.text) || /^[A-Z]{1,5}$/.test(token.text) || /^HK\d{6,}$/.test(token.text);
  });
  if (codeIndex < 2) return null;

  const noteStartIndex = tokens.findIndex((token, index) => {
    if (index <= codeIndex || index >= tokens.length - 1) return false;
    return token.x >= 340 || /^IPO\b/i.test(token.text) || token.text === "申购" || token.text === "赎回";
  });
  const itemEndIndex = noteStartIndex > 0 ? noteStartIndex : tokens.length - 1;
  const moveType = clean(tokens.slice(1, codeIndex).map((token) => token.text).join(" "));
  const item = clean(tokens.slice(codeIndex, itemEndIndex).map((token) => token.text).join(" "));
  const note =
    noteStartIndex > 0
      ? clean(tokens.slice(noteStartIndex, tokens.length - 1).map((token) => token.text).join(" "))
      : "";

  if (!DATE_RE.test(date) || !moveType || !item || !quantity) return null;
  const security = splitSecurity(item);

  return {
    sourcePdf,
    page: line.page,
    market,
    date,
    moveType,
    code: security.code,
    name: security.name,
    note,
    quantity: parseNumber(quantity),
  };
}

function parsePortfolioLine(
  sourcePdf: string,
  line: TextLine,
  market: string,
  currency: Currency,
): PortfolioRecord | null {
  const item = lineCell(line, 0, 120);
  const canonicalItem = canonicalText(item);
  if (!item || canonicalItem.startsWith("汇总") || canonicalItem.startsWith("股票") || canonicalItem.startsWith("余额通")) {
    return null;
  }

  const beginQty = lineCell(line, 120, 170);
  const changeQty = lineCell(line, 170, 225);
  const endQty = lineCell(line, 225, 275);
  const price = lineCell(line, 275, 318);
  const marketValue = lineCell(line, 318, 370);
  const avgCost = lineCell(line, 370, 414);
  const unrealizedGainLoss = lineCell(line, 414, 470);

  if (!beginQty || !changeQty || !endQty || !price || !marketValue || !avgCost || !unrealizedGainLoss) {
    return null;
  }

  const security = splitSecurity(item);
  if (!market && security.codeResolution === "name_fallback") return null;
  if (!security.code) return null;
  const inferredMarket = inferTradeMarket(item, security);

  return {
    sourcePdf,
    page: line.page,
    market: market || inferredMarket.market,
    currency: market ? currency : inferredMarket.currency,
    code: security.code,
    name: security.name,
    beginQty: parseNumber(beginQty),
    changeQty: parseNumber(changeQty),
    endQty: parseNumber(endQty),
    price: parseNumber(price),
    marketValue: parseNumber(marketValue),
    avgCost: parseNumber(avgCost),
    unrealizedGainLoss: parseNumber(unrealizedGainLoss),
  };
}

function parseLongbridgeLines(sourcePdf: string, lines: TextLine[]): LongbridgeRawData {
  const raw: LongbridgeRawData = {
    trades: [],
    cashFlows: [],
    moves: [],
    positions: [],
    issues: [],
    statementDetected: false,
  };

  let activeTable: "none" | "portfolio" | "stock_trade" | "cash_flow" | "position_move" = "none";
  let tradeMarket = "";
  let tradeCurrency: Currency = "HKD";
  let cashCurrency: Currency = "HKD";
  let moveMarket = "";
  let portfolioMarket = "";
  let portfolioCurrency: Currency = "HKD";
  let sequence = 0;
  const fallbackSecurityNames = new Map<string, string>();

  for (const line of lines) {
    const text = canonicalText(line.text);
    if (isLongbridgeMonthlyStatement(text)) {
      raw.statementDetected = true;
    }
    if (text.includes("项目") && text.includes("期初持仓") && text.includes("浮动盈亏")) {
      activeTable = "portfolio";
      continue;
    }
    if (text.includes("股票交易明细") || (text.includes("交易日期") && text.includes("编号") && text.includes("变动金额"))) {
      activeTable = "stock_trade";
      continue;
    }
    if (text.includes("发生日期") && text.includes("类型") && text.includes("备注") && text.includes("金额")) {
      activeTable = "cash_flow";
      continue;
    }
    if (text.includes("发生日期") && text.includes("类型") && text.includes("项目") && text.includes("数量")) {
      activeTable = "position_move";
      continue;
    }

    const tradeMarketMatch = text.match(/^市场:\s*(.+?);\s*币种:\s*(.+)$/);
    if (tradeMarketMatch && activeTable === "stock_trade") {
      tradeMarket = tradeMarketMatch[1];
      tradeCurrency = mapCurrency(tradeMarketMatch[2]);
      continue;
    }

    const portfolioMarketMatch = text.match(/^股票\s+\((.+?);\s*(.+?)\)$/);
    if (portfolioMarketMatch && activeTable === "portfolio") {
      portfolioMarket = portfolioMarketMatch[1];
      portfolioCurrency = mapCurrency(portfolioMarketMatch[2]);
      continue;
    }

    if (text.startsWith("币种:") && activeTable === "cash_flow") {
      cashCurrency = mapCurrency(text.replace("币种:", ""));
      continue;
    }

    if (text.startsWith("市场:") && activeTable === "position_move") {
      moveMarket = text.replace("市场:", "").trim();
      continue;
    }

    if (activeTable === "stock_trade" || /\bOS\d+/.test(text)) {
      const trade = parseStockTradeLine(sourcePdf, line, tradeMarket, tradeCurrency, sequence);
      if (trade) {
        activeTable = "stock_trade";
        raw.trades.push(trade);
        if (trade.codeResolution === "name_fallback") {
          fallbackSecurityNames.set(trade.code, trade.name);
        }
        sequence += 1;
        continue;
      }
      if (activeTable === "stock_trade") continue;
    }

    if (activeTable === "cash_flow") {
      const cashFlow = parseCashFlowLine(sourcePdf, line, cashCurrency);
      if (cashFlow) raw.cashFlows.push(cashFlow);
      continue;
    }

    if (activeTable === "position_move") {
      const move = parsePositionMoveLine(sourcePdf, line, moveMarket);
      if (move) raw.moves.push(move);
      continue;
    }

    if (activeTable === "none") {
      const position = parsePortfolioLine(sourcePdf, line, portfolioMarket, portfolioCurrency);
      if (position) {
        raw.positions.push(position);
        continue;
      }
    }

    if (activeTable === "portfolio") {
      const position = parsePortfolioLine(sourcePdf, line, portfolioMarket, portfolioCurrency);
      if (position) raw.positions.push(position);
    }
  }

  for (const [code, name] of fallbackSecurityNames) {
    raw.issues.push({
      id: `${sourcePdf}-${code}-symbol-fallback`,
      severity: "warning",
      title: `${name} 股票代码需复核`,
      detail: `该月结单的文本层缺少股票代码，系统已用 ${displayCode(code)} 作为临时代码归集交易。请在计算结果中核对该标的，必要时补充代码映射。`,
      source: sourcePdf,
    });
  }

  return raw;
}

function extractIpoCode(note: string) {
  const match = note.match(/IPO\s+(\d+)\.HK/i);
  return match ? normalizeCode(match[1]) : null;
}

function dividendSymbolFromNote(note: string) {
  return note.match(/([A-Z]{1,5})\.US\s+Cash Dividend/i)?.[1].toUpperCase() ?? null;
}

function isUsDividendCashFlow(cashFlow: CashFlowRecord) {
  return canonicalText(cashFlow.flowType).includes("分红") && Boolean(dividendSymbolFromNote(cashFlow.note)) && cashFlow.amount > 0;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

async function attachDividendScreenshots(
  fileName: string,
  data: ArrayBuffer,
  password: string | undefined,
  cashFlows: CashFlowRecord[],
) {
  const targets = cashFlows.filter((cashFlow) => cashFlow.sourcePdf === fileName && cashFlow.evidence && isUsDividendCashFlow(cashFlow));
  if (targets.length === 0 || typeof document === "undefined") return;

  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(data.slice(0)),
      password,
      disableFontFace: true,
      isEvalSupported: false,
    } as Parameters<typeof pdfjs.getDocument>[0]);
    const pdfDocument = await loadingTask.promise;
    const targetsByPage = new Map<number, CashFlowRecord[]>();
    for (const target of targets) {
      const pageTargets = targetsByPage.get(target.page) ?? [];
      pageTargets.push(target);
      targetsByPage.set(target.page, pageTargets);
    }

    for (const [pageNumber, pageTargets] of targetsByPage) {
      const page = await pdfDocument.getPage(pageNumber);
      const scale = 2;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const canvasContext = canvas.getContext("2d");
      if (!canvasContext) continue;
      await page.render({ canvasContext, viewport }).promise;

      for (const target of pageTargets) {
        if (!target.evidence) continue;
        const { bounds } = target.evidence;
        const pageWidth = bounds.pageWidth || viewport.width / scale;
        const pageHeight = bounds.pageHeight || viewport.height / scale;
        const rowCanvasY = (pageHeight - bounds.y) * scale;
        const cropXPdf = 0;
        const cropHeightPx = Math.min(180 * scale, canvas.height);
        const cropYPx = clampNumber(rowCanvasY - 58 * scale, 0, Math.max(0, canvas.height - cropHeightPx));
        const cropWidthPx = Math.min(canvas.width - cropXPdf * scale, (pageWidth - cropXPdf) * scale);
        const boundedCropHeightPx = Math.min(cropHeightPx, canvas.height - cropYPx);
        if (cropWidthPx <= 0 || boundedCropHeightPx <= 0) continue;

        const cropCanvas = document.createElement("canvas");
        cropCanvas.width = Math.ceil(cropWidthPx);
        cropCanvas.height = Math.ceil(boundedCropHeightPx);
        const cropContext = cropCanvas.getContext("2d");
        if (!cropContext) continue;
        cropContext.drawImage(
          canvas,
          cropXPdf * scale,
          cropYPx,
          cropWidthPx,
          boundedCropHeightPx,
          0,
          0,
          cropCanvas.width,
          cropCanvas.height,
        );
        target.evidence.imageDataUrl = cropCanvas.toDataURL("image/jpeg", 0.9);
      }
    }
  } catch {
    // 截图只是辅助核对材料，失败时保留分红解析结果即可。
  }
}

function buildDividends(cashFlows: CashFlowRecord[]): DividendIncome[] {
  const dividends: DividendIncome[] = [];
  const pendingWithholding = new Map<string, number>();

  for (const cashFlow of cashFlows) {
    const flowType = canonicalText(cashFlow.flowType);
    const note = canonicalText(cashFlow.note);
    const dividendSymbol = dividendSymbolFromNote(cashFlow.note);
    if (flowType.includes("分红") && dividendSymbol && cashFlow.amount > 0) {
      const symbol = dividendSymbol;
      const key = `${cashFlow.date}-${symbol}`;
      dividends.push({
        id: `${cashFlow.sourcePdf}-dividend-${symbol}-${cashFlow.date}`,
        broker: "长桥",
        date: normalizeDate(cashFlow.date),
        currency: cashFlow.currency,
        symbol,
        securityName: symbol,
        grossAmount: cashFlow.amount,
        taxWithheld: pendingWithholding.get(key) ?? 0,
        fee: 0,
        source: cashFlow.sourcePdf,
        note: cashFlow.note,
        evidence: cashFlow.evidence
          ? {
              page: cashFlow.evidence.page,
              text: cashFlow.evidence.text,
              imageDataUrl: cashFlow.evidence.imageDataUrl,
            }
          : undefined,
      });
      pendingWithholding.delete(key);
      continue;
    }

    if (note.includes("Withholding Tax/Dividend Fee") || (flowType.includes("公司行动其他费用") && note.includes("Cash Dividend"))) {
      const taxMatch = cashFlow.note.match(/([A-Z]{1,5})\.US\s+Cash Dividend/i);
      const symbol = taxMatch?.[1].toUpperCase();
      if (!symbol) continue;
      const key = `${cashFlow.date}-${symbol}`;
      const existing = dividends.find((dividend) => dividend.date === normalizeDate(cashFlow.date) && dividend.symbol === symbol);
      if (existing) {
        existing.taxWithheld += Math.abs(cashFlow.amount);
      } else {
        pendingWithholding.set(key, (pendingWithholding.get(key) ?? 0) + Math.abs(cashFlow.amount));
      }
    }
  }

  return dividends;
}

function stateAvgCost(state: PositionState) {
  return Math.abs(state.quantity) < 1e-9 ? 0 : state.costBasis / state.quantity;
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

function activityAmount(event: EventRecord) {
  if ("cash" in event) return event.kind === "buy" ? -event.cash : event.cash;
  if (event.kind === "transfer_out") return 0;
  return event.cost;
}

function buildTradeActivities(events: EventRecord[]): TradeActivity[] {
  return events.map((event) => ({
    id: `longbridge-activity-${event.date}-${event.sequence}-${displayCode(event.code)}-${event.kind}`,
    broker: "长桥",
    date: event.date,
    time: "time" in event ? event.time : undefined,
    sequence: event.sequence,
    market: event.market,
    currency: event.currency,
    symbol: displayCode(event.code),
    securityName: event.name,
    side: event.kind,
    quantity: event.quantity,
    unitPrice: "unitPrice" in event ? event.unitPrice : undefined,
    grossAmount: "grossAmount" in event ? event.grossAmount : undefined,
    fee: "fee" in event ? event.fee : undefined,
    amount: activityAmount(event),
    source: event.source,
    note: event.note,
  }));
}

function buildRealizedTrades(
  raw: LongbridgeRawData,
  targetYear?: number,
  manualCosts: ManualCostInput[] = [],
): {
  trades: RealizedTrade[];
  issues: ReviewIssue[];
  activities: TradeActivity[];
  costBasisRequests: CostBasisRequest[];
} {
  const issues: ReviewIssue[] = [];
  const missingCost = new Map<string, MissingCostAggregate>();
  const manualCostsById = manualCostMap(manualCosts);
  const allottedCodes = new Set(
    raw.moves.filter((move) => canonicalText(move.moveType).includes("中签")).map((move) => normalizeCode(move.code)),
  );

  const ipoCostByCode = new Map<string, number>();
  for (const cashFlow of raw.cashFlows) {
    const flowType = canonicalText(cashFlow.flowType);
    const code = extractIpoCode(cashFlow.note);
    if (!code || !allottedCodes.has(code)) continue;
    if (flowType.includes("新股中签款扣除") || flowType.includes("新股认购")) {
      ipoCostByCode.set(code, (ipoCostByCode.get(code) ?? 0) + Math.abs(cashFlow.amount));
    }
  }

  const portfolioLookup = new Map<string, PortfolioRecord>();
  for (const position of raw.positions) {
    portfolioLookup.set(`${position.sourcePdf}::${position.code}`, position);
  }

  const events: EventRecord[] = [];
  let sequence = 0;

  for (const move of raw.moves) {
    const moveType = canonicalText(move.moveType);
    if (moveType.includes("中签")) {
      events.push({
        kind: "acquire",
        date: normalizeDate(move.date),
        rank: 1,
        sequence,
        market: move.market,
        currency: "HKD",
        code: move.code,
        name: move.name,
        quantity: move.quantity,
        cost: ipoCostByCode.get(move.code) ?? 0,
        source: "IPO中签扣款+申购手续费",
        note: move.note,
      });
      sequence += 1;
    } else if (moveType.includes("证券转入")) {
      const position = portfolioLookup.get(`${move.sourcePdf}::${move.code}`);
      events.push({
        kind: "transfer_in",
        date: normalizeDate(move.date),
        rank: 1,
        sequence,
        market: move.market,
        currency: position?.currency ?? "USD",
        code: move.code,
        name: move.name,
        quantity: move.quantity,
        cost: move.quantity * (position?.avgCost ?? 0),
        source: "证券转入-按长桥月末成本基准",
        note: "转入成本需用原券商成本凭证复核",
      });
      issues.push({
        id: `${move.sourcePdf}-${move.code}-transfer-in`,
        severity: "warning",
        title: `${displayCode(move.code)} 转入成本需复核`,
        detail: "已按长桥月结单月末成本基准暂估；正式申报建议用转出券商原始成本凭证确认。",
        source: move.sourcePdf,
      });
      sequence += 1;
    } else if (moveType.includes("证券转出")) {
      const position = portfolioLookup.get(`${move.sourcePdf}::${move.code}`);
      events.push({
        kind: "transfer_out",
        date: normalizeDate(move.date),
        rank: 3,
        sequence,
        market: move.market,
        currency: position?.currency ?? "USD",
        code: move.code,
        name: move.name,
        quantity: Math.abs(move.quantity),
        source: "证券转出",
        note: "转仓，不按卖出确认收益",
      });
      issues.push({
        id: `${move.sourcePdf}-${move.code}-transfer-out`,
        severity: "warning",
        title: `${displayCode(move.code)} 已转出，未在长桥实现卖出`,
        detail: "证券转出不按卖出确认收益；如果转出后在其他券商卖出，需要继续接入该券商记录。",
        source: move.sourcePdf,
      });
      sequence += 1;
    }
  }

  for (const trade of raw.trades) {
    const isBuy = trade.side.includes("买");
    const isSell = trade.side.includes("卖");
    if (!isBuy && !isSell) continue;
    events.push({
      kind: isBuy ? "buy" : "sell",
      date: normalizeDate(trade.tradeDate),
      rank: 2,
      sequence: trade.sequence + sequence,
      time: ORDER_TIME_OVERRIDE[trade.orderId] ?? "99:99:99",
      market: trade.market,
      currency: trade.currency,
      code: trade.code,
      name: trade.name,
      quantity: trade.quantity,
      unitPrice: trade.avgPrice,
      grossAmount: trade.tradeAmount,
      fee: Math.abs(Math.abs(trade.cashChange) - Math.abs(trade.tradeAmount)),
      cash: trade.cashChange,
      source: "股票交易流水",
      note: trade.orderId,
    });
  }

  events.sort((a, b) => {
    return (
      a.date.localeCompare(b.date) ||
      a.rank - b.rank ||
      ("time" in a ? a.time : "99:99:99").localeCompare("time" in b ? b.time : "99:99:99") ||
      a.sequence - b.sequence
    );
  });

  const states = new Map<string, PositionState>();
  const realizedTrades: RealizedTrade[] = [];

  for (const event of events) {
    const key = `${event.currency}::${event.code}`;
    const state = states.get(key) ?? {
      market: event.market,
      currency: event.currency,
      name: event.name,
      quantity: 0,
      costBasis: 0,
    };
    state.market = event.market || state.market;
    state.currency = event.currency || state.currency;
    state.name = event.name || state.name;

    if (event.kind === "acquire" || event.kind === "transfer_in") {
      state.quantity += event.quantity;
      state.costBasis += event.cost;
    } else if (event.kind === "buy") {
      state.quantity += event.quantity;
      state.costBasis += -event.cash;
    } else if (event.kind === "sell") {
      if (state.quantity + 1e-7 < event.quantity) {
        if (targetYear === undefined || event.date.startsWith(String(targetYear))) {
          const requestId = `longbridge-cost-${targetYear ?? "unknown"}-${event.currency}-${displayCode(event.code)}`;
          const existing = missingCost.get(key);
          missingCost.set(key, {
            id: requestId,
            broker: "长桥",
            sellDate: existing?.sellDate ?? event.date,
            market: event.market,
            currency: event.currency,
            symbol: displayCode(event.code),
            securityName: event.name,
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
                symbol: displayCode(event.code),
                securityName: event.name,
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
      const gainLoss = event.cash - costBasis;
      const trade: RealizedTrade = {
        id: `longbridge-${event.date}-${event.sequence}-${event.code}-${event.note}`,
        broker: "长桥",
        sellDate: event.date,
        market: event.market,
        currency: event.currency,
        symbol: displayCode(event.code),
        securityName: event.name,
        quantity: event.quantity,
        proceeds: event.cash,
        costBasis,
        gainLoss,
        source: event.source,
        note: event.note,
      };
      realizedTrades.push(trade);
      state.quantity -= event.quantity;
      state.costBasis -= costBasis;
      if (Math.abs(state.quantity) < 1e-8) {
        state.quantity = 0;
        state.costBasis = 0;
      }
    } else if (event.kind === "transfer_out") {
      const costBasis = event.quantity * stateAvgCost(state);
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
    const manualCostBasis = manualCostsById.get(item.id);
    if (manualCostBasis !== undefined) {
      let allocatedCost = 0;
      item.sales.forEach((sale, index) => {
        const costBasis =
          index === item.sales.length - 1
            ? manualCostBasis - allocatedCost
            : (manualCostBasis * sale.quantity) / item.quantity;
        allocatedCost += costBasis;
        realizedTrades.push({
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
      id: `longbridge-${targetYear ?? "unknown"}-${item.symbol}-cost-gap`,
      severity: "warning",
      title: `${item.symbol} 历史成本缺失`,
      detail: `目标年度卖出 ${item.quantity} 股，但上传文件中最多只追踪到 ${item.trackedQuantity} 股成本；相关卖出未计入资本利得，需要补充更早年度记录或手动在 **盈亏明细-待补成本** 中添加成本。`,
      source: item.source,
    });
  }

  return { trades: realizedTrades, issues, activities: buildTradeActivities(events), costBasisRequests };
}

function buildOpenPositions(raw: LongbridgeRawData): OpenPosition[] {
  const latestByCode = new Map<string, PortfolioRecord>();
  for (const position of raw.positions) {
    const market = canonicalText(position.market);
    if (market !== "香港市场" && market !== "美国市场") continue;
    if (position.endQty <= 0) continue;
    latestByCode.set(`${position.currency}::${position.code}`, position);
  }

  return Array.from(latestByCode.values()).map((position) => {
    const statementMonth = position.sourcePdf.match(/(20\d{2})[-_年.]?(0[1-9]|1[0-2])/);
    return {
      id: `longbridge-open-${position.currency}-${position.code}`,
      broker: "长桥",
      asOf: statementMonth ? `${statementMonth[1]}-${statementMonth[2]}-末` : "",
      market: canonicalText(position.market),
      currency: position.currency,
      symbol: displayCode(position.code),
      securityName: position.name,
      quantity: position.endQty,
      marketValue: position.marketValue,
      costBasis: position.endQty * position.avgCost,
      unrealizedGainLoss: position.unrealizedGainLoss,
      source: position.sourcePdf,
    };
  });
}

export async function parseLongbridgePdfs(
  files: LongbridgeFileInput[],
  password?: string,
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: LongbridgeRawData = {
    trades: [],
    cashFlows: [],
    moves: [],
    positions: [],
    issues: [],
    statementDetected: false,
  };

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data, password);
      const fileRaw = parseLongbridgeLines(file.name, lines);
      await attachDividendScreenshots(file.name, file.data, password, fileRaw.cashFlows);
      raw.trades.push(...fileRaw.trades);
      raw.cashFlows.push(...fileRaw.cashFlows);
      raw.moves.push(...fileRaw.moves);
      raw.positions.push(...fileRaw.positions);
      raw.issues.push(...fileRaw.issues);
      raw.statementDetected = raw.statementDetected || fileRaw.statementDetected;
    } catch (error) {
      raw.issues.push({
        id: `${file.name}-pdf-error`,
        severity: "blocking",
        title: "长桥PDF解析失败",
        detail: error instanceof Error ? error.message : "未知PDF解析错误。请确认密码是否正确。",
        source: file.name,
      });
    }
  }

  const realized = buildRealizedTrades(raw, options.targetYear, options.manualCosts ?? []);
  parsed.realizedTrades.push(...realized.trades);
  parsed.tradeActivities.push(...realized.activities);
  parsed.dividends.push(...buildDividends(raw.cashFlows));
  parsed.openPositions.push(...buildOpenPositions(raw));
  parsed.issues.push(...raw.issues, ...realized.issues);
  parsed.costBasisRequests.push(...realized.costBasisRequests);

  const hasParsedStatementRows = raw.trades.length > 0 || raw.cashFlows.length > 0 || raw.moves.length > 0 || raw.positions.length > 0;
  const hasRecognizedStatement = raw.statementDetected || hasParsedStatementRows;

  if (!hasParsedStatementRows && !hasRecognizedStatement && files.length > 0) {
    parsed.issues.push({
      id: "longbridge-invalid-format",
      severity: "blocking",
      title: "长桥文件格式不符合要求",
      detail: "长桥只支持 PDF 月结单。当前文件没有识别到账户流水、股票交易、持仓或资产进出表，请确认上传的是长桥月结单 PDF 且密码正确。",
    });
  }

  if (raw.trades.length === 0 && files.length > 0) {
    parsed.issues.push({
      id: hasRecognizedStatement ? "longbridge-no-stock-activity" : "longbridge-no-trades",
      severity: hasRecognizedStatement ? "info" : "warning",
      title: hasRecognizedStatement ? "本月没有长桥股票交易" : "未识别长桥股票交易",
      detail: hasRecognizedStatement
        ? "已识别为长桥综合账户月结单，但本月没有股票买卖记录。系统会按无股票交易处理，现金入金、出金或账户余额变化不会形成已实现资本利得；如本月实际发生卖出，请重新下载包含股票交易明细的月结单后再上传。"
        : "没有从上传的长桥 PDF 中识别到股票交易表。请确认文件是否为月结单且密码正确。",
    });
  }

  return parsed;
}
