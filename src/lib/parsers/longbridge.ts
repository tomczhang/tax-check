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
  tradeTime?: string;
  codeResolution: "explicit" | "known_alias" | "name_fallback";
}

interface StockTradeFields {
  tradeDate: string;
  settleDate: string;
  orderId: string;
  side: string;
  item: string;
  quantity: string;
  avgPrice: string;
  tradeAmount: string;
  cashChange: string;
}

interface PortfolioFields {
  item: string;
  beginQty: string;
  changeQty: string;
  endQty: string;
  price: string;
  marketValue: string;
  avgCost: string;
  unrealizedGainLoss: string;
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
  statementMonth?: string;
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

export interface ManualSecurityAliasInput {
  name: string;
  symbol: string;
  market?: string;
  currency?: Currency;
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

interface SecurityAlias {
  code: string;
  name: string;
  market?: string;
  currency?: Currency;
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
    }
  | {
      kind: "stock_split";
      date: string;
      rank: number;
      sequence: number;
      market: string;
      currency: Currency;
      code: string;
      name: string;
      quantity: number;
      splitRatio: number;
      splitFromQuantity: number;
      splitToQuantity: number;
      cashInLieu?: number;
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

const KNOWN_SECURITY_ALIASES: Record<string, SecurityAlias> = {
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
  nvidia: { code: "NVDA", name: "NVIDIA", market: "美国市场", currency: "USD" },
  英伟达: { code: "NVDA", name: "英伟达", market: "美国市场", currency: "USD" },
  辉达: { code: "NVDA", name: "英伟达", market: "美国市场", currency: "USD" },
  拼多多: { code: "PDD", name: "拼多多", market: "美国市场", currency: "USD" },
  台积电: { code: "TSM", name: "台积电", market: "美国市场", currency: "USD" },
  阿里巴巴: { code: "BABA", name: "阿里巴巴", market: "美国市场", currency: "USD" },
  "阿里巴巴 w": { code: "09988", name: "阿里巴巴-W", market: "香港市场", currency: "HKD" },
  "阿里巴巴 sw": { code: "09988", name: "阿里巴巴-SW", market: "香港市场", currency: "HKD" },
  联合健康: { code: "UNH", name: "联合健康", market: "美国市场", currency: "USD" },
  苹果: { code: "AAPL", name: "Apple", market: "美国市场", currency: "USD" },
  微软: { code: "MSFT", name: "Microsoft", market: "美国市场", currency: "USD" },
  特斯拉: { code: "TSLA", name: "Tesla", market: "美国市场", currency: "USD" },
  亚马逊: { code: "AMZN", name: "Amazon", market: "美国市场", currency: "USD" },
  奈飞: { code: "NFLX", name: "Netflix", market: "美国市场", currency: "USD" },
  博通: { code: "AVGO", name: "Broadcom", market: "美国市场", currency: "USD" },
  高通: { code: "QCOM", name: "Qualcomm", market: "美国市场", currency: "USD" },
  美光: { code: "MU", name: "Micron Tech", market: "美国市场", currency: "USD" },
  超微电脑: { code: "SMCI", name: "Super Micro Computer", market: "美国市场", currency: "USD" },
  百度: { code: "BIDU", name: "百度", market: "美国市场", currency: "USD" },
  京东: { code: "JD", name: "京东", market: "美国市场", currency: "USD" },
  网易: { code: "NTES", name: "网易", market: "美国市场", currency: "USD" },
  哔哩哔哩: { code: "BILI", name: "哔哩哔哩", market: "美国市场", currency: "USD" },
  蔚来: { code: "NIO", name: "蔚来", market: "美国市场", currency: "USD" },
  小鹏: { code: "XPEV", name: "小鹏", market: "美国市场", currency: "USD" },
  理想汽车: { code: "LI", name: "理想汽车", market: "美国市场", currency: "USD" },
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
    lower.includes("long bridge hk") ||
    lower.includes("monthly statement/tax invoice")
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
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isSecurityCodeCandidate(value: string) {
  const text = value.trim();
  return /^\d{3,6}$/.test(text) || /^[A-Z]{1,6}$/.test(text) || /^HK\d{6,}$/i.test(text);
}

function hasHongKongNameSuffix(value: string) {
  return /\p{Script=Han}/u.test(value) && /(?:^|\s)(?:SW|SS|W|B|S|R|U|P)$/i.test(securityAliasKey(value));
}

function fallbackSecurityCode(item: string) {
  const normalized = securityAliasKey(item);
  const ascii = normalized.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (ascii) return `UNRESOLVED-${ascii.slice(0, 32)}`;

  let hash = 0;
  const hashSource = normalized || canonicalText(item);
  for (const char of hashSource) {
    hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  }
  return hash ? `UNRESOLVED-${hash.toString(36).toUpperCase()}` : "UNRESOLVED-SECURITY";
}

function splitSecurity(
  item: string,
  documentAliases: Map<string, SecurityAlias> = new Map(),
): {
  code: string;
  name: string;
  codeResolution: "explicit" | "known_alias" | "name_fallback";
  market?: string;
  currency?: Currency;
} {
  const text = clean(item);
  const aliasKey = securityAliasKey(text);
  const alias = documentAliases.get(aliasKey) ?? KNOWN_SECURITY_ALIASES[aliasKey];
  if (alias) {
    return { ...alias, codeResolution: "known_alias" };
  }

  const [code = "", ...nameParts] = text.split(" ");
  if (isSecurityCodeCandidate(code)) {
    const codeAlias = documentAliases.get(securityAliasKey(code)) ?? KNOWN_SECURITY_ALIASES[securityAliasKey(code)];
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

function isBuySide(value: string) {
  const text = canonicalText(value).toUpperCase();
  return text.includes("买") || text === "BUY";
}

function isSellSide(value: string) {
  const text = canonicalText(value).toUpperCase();
  return text.includes("卖") || text === "SELL";
}

function inferTradeMarket(item: string, security: ReturnType<typeof splitSecurity>) {
  if (security.market && security.currency) {
    return { market: security.market, currency: security.currency };
  }
  if (/^\d{3,6}$/.test(security.code) || /^HK\d{6,}$/i.test(security.code)) {
    return { market: "香港市场", currency: "HKD" as const };
  }
  if (hasHongKongNameSuffix(item)) {
    return { market: "香港市场", currency: "HKD" as const };
  }
  if (/[A-Za-z]/.test(item) || /^[A-Z]{1,6}$/.test(security.code)) {
    return { market: "美国市场", currency: "USD" as const };
  }
  return { market: "香港市场", currency: "HKD" as const };
}

function parseInlineStockTradeFields(line: TextLine): StockTradeFields | null {
  const amountPattern = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
  const match = canonicalText(line.text).match(
    new RegExp(
      String.raw`^(20\d{2}\.\d{2}\.\d{2})\s+` +
        String.raw`(20\d{2}\.\d{2}\.\d{2})\s+` +
        String.raw`(OS\d+)\s+` +
        String.raw`(\S+)\s+` +
        String.raw`(.+?)\s+` +
        `(${amountPattern})\\s+` +
        `(${amountPattern})\\s+` +
        `(${amountPattern})\\s+` +
        `(${amountPattern})$`,
    ),
  );
  if (!match) return null;
  return {
    tradeDate: match[1],
    settleDate: match[2],
    orderId: match[3],
    side: match[4],
    item: clean(match[5]),
    quantity: match[6],
    avgPrice: match[7],
    tradeAmount: match[8],
    cashChange: match[9],
  };
}

function isNumericCell(value: string) {
  return /^[+-]?\d[\d,]*(?:\.\d+)?$/.test(canonicalText(value).trim());
}

function hasCompleteStockTradeFields(fields: StockTradeFields) {
  return (
    DATE_RE.test(fields.tradeDate) &&
    DATE_RE.test(fields.settleDate) &&
    /^OS\d+/.test(fields.orderId) &&
    (isBuySide(fields.side) || isSellSide(fields.side)) &&
    Boolean(fields.item) &&
    isNumericCell(fields.quantity) &&
    isNumericCell(fields.avgPrice) &&
    isNumericCell(fields.tradeAmount) &&
    isNumericCell(fields.cashChange)
  );
}

function parseInlinePortfolioFields(line: TextLine): PortfolioFields | null {
  const amountPattern = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
  const optionalAmountPattern = String.raw`(?:${amountPattern}|N/A)`;
  const match = canonicalText(line.text).match(
    new RegExp(
      String.raw`^(.+?)\s+` +
        `(${amountPattern})\\s+` +
        `(${amountPattern})\\s+` +
        `(${amountPattern})\\s+` +
        `(${amountPattern})\\s+` +
        `(${amountPattern})\\s+` +
        `(${optionalAmountPattern})\\s+` +
        `(${optionalAmountPattern})(?:\\s+.*)?$`,
    ),
  );
  if (!match) return null;
  return {
    item: clean(match[1]),
    beginQty: match[2],
    changeQty: match[3],
    endQty: match[4],
    price: match[5],
    marketValue: match[6],
    avgCost: match[7],
    unrealizedGainLoss: match[8],
  };
}

function isNotAvailableCell(value: string) {
  return /^(N\/A|NA|-{1,2})$/i.test(canonicalText(value).trim());
}

function isPortfolioCostOrPnlCell(value: string) {
  return isNumericCell(value) || isNotAvailableCell(value);
}

function hasCompletePortfolioFields(fields: PortfolioFields) {
  const hasCoreFields =
    Boolean(fields.item) &&
    isNumericCell(fields.beginQty) &&
    isNumericCell(fields.changeQty) &&
    isNumericCell(fields.endQty) &&
    isNumericCell(fields.price) &&
    isNumericCell(fields.marketValue);

  if (!hasCoreFields) return false;

  if (parseNumber(fields.endQty) <= 0) {
    return isPortfolioCostOrPnlCell(fields.avgCost) && isPortfolioCostOrPnlCell(fields.unrealizedGainLoss);
  }

  return (
    isNumericCell(fields.avgCost) &&
    isNumericCell(fields.unrealizedGainLoss)
  );
}

async function extractPdfLines(fileName: string, data: ArrayBuffer, password?: string) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const isBrowser = typeof window !== "undefined";
  if (isBrowser) {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    password,
    disableWorker: !isBrowser,
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
  documentAliases: Map<string, SecurityAlias>,
): StockTradeRecord | null {
  if (!hasDateAtStart(line)) return null;
  const cellFields: StockTradeFields = {
    tradeDate: lineCell(line, 0, 76),
    settleDate: lineCell(line, 76, 137),
    orderId: lineCell(line, 137, 220),
    side: canonicalLineCell(line, 220, 252),
    item: lineCell(line, 252, 358),
    quantity: lineCell(line, 358, 402),
    avgPrice: lineCell(line, 402, 455),
    tradeAmount: lineCell(line, 455, 525),
    cashChange: lineCell(line, 525, 610),
  };
  const fields = hasCompleteStockTradeFields(cellFields) ? cellFields : parseInlineStockTradeFields(line);

  if (!fields || !DATE_RE.test(fields.tradeDate) || !DATE_RE.test(fields.settleDate) || !/^OS\d+/.test(fields.orderId)) {
    return null;
  }
  if (!isBuySide(fields.side) && !isSellSide(fields.side)) return null;

  const security = splitSecurity(fields.item, documentAliases);
  if (!security.code || !fields.quantity || !fields.avgPrice || !fields.tradeAmount || !fields.cashChange) return null;
  const inferredMarket = inferTradeMarket(fields.item, security);

  return {
    sourcePdf,
    page: line.page,
    market: market || inferredMarket.market,
    currency: market ? currency : inferredMarket.currency,
    tradeDate: fields.tradeDate,
    settleDate: fields.settleDate,
    orderId: fields.orderId,
    side: fields.side,
    code: security.code,
    name: security.name,
    quantity: parseNumber(fields.quantity),
    avgPrice: parseNumber(fields.avgPrice),
    tradeAmount: parseNumber(fields.tradeAmount),
    cashChange: parseNumber(fields.cashChange),
    sequence,
    codeResolution: security.codeResolution,
  };
}

interface CashFlowFields {
  date: string;
  flowType: string;
  note: string;
  amount: string;
}

const ENGLISH_CASH_FLOW_TYPES = [
  "Currency Conversion (Credit)",
  "Currency Conversion (Debit)",
  "Reward Redemption Stock Cash Coupon",
  "Reward Redemption Cash Coupon",
  "Cash Withdrawal",
  "Cash Deposit",
  "Debit Interest",
  "Cash Dividend",
  "Withholding Tax/Dividend Fee",
  "Company Action Other Fee",
  "Company Action",
];

function isTaxInvoiceDetailLine(text: string) {
  return /^20\d{2}\.\d{2}\.\d{2}\s+\d{5,}\b/.test(text) && (text.includes("%") || text.includes("(Exempted)"));
}

function parseInlineCashFlowFields(line: TextLine): CashFlowFields | null {
  const amountPattern = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
  const text = canonicalText(line.text);
  if (isTaxInvoiceDetailLine(text)) return null;
  const match = text.match(new RegExp(String.raw`^(20\d{2}\.\d{2}\.\d{2})\s+(.+?)\s+(${amountPattern})$`));
  if (!match || /\bOS\d+\b/.test(match[2])) return null;

  const detail = clean(match[2]);
  const englishType = ENGLISH_CASH_FLOW_TYPES.find((type) => detail.toLowerCase().startsWith(type.toLowerCase()));
  if (englishType) {
    return {
      date: match[1],
      flowType: englishType,
      note: clean(detail.slice(englishType.length)),
      amount: match[3],
    };
  }

  const [flowType = "", ...noteParts] = detail.split(" ");
  return {
    date: match[1],
    flowType,
    note: clean(noteParts.join(" ")),
    amount: match[3],
  };
}

function isCurrencySummaryItem(value: string) {
  return /^(HKD|USD|CNY|SGD)$/i.test(clean(value));
}

function inferCashFlowCurrency(fields: CashFlowFields, fallback: Currency) {
  const text = canonicalText(`${fields.flowType} ${fields.note}`).toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("CNY") || text.includes("RMB") || text.includes("人民币")) return "CNY";
  if (text.includes("HKD") || text.includes("港币")) return "HKD";
  return fallback;
}

function parseCashFlowLine(
  sourcePdf: string,
  line: TextLine,
  currency: Currency,
): CashFlowRecord | null {
  if (!hasDateAtStart(line)) return null;
  const cellFields: CashFlowFields = {
    date: lineCell(line, 0, 105),
    flowType: lineCell(line, 105, 260),
    note: lineCell(line, 260, 520),
    amount: lineCell(line, 520, 610),
  };
  const fields =
    DATE_RE.test(cellFields.date) && cellFields.flowType && isNumericCell(cellFields.amount)
      ? cellFields
      : parseInlineCashFlowFields(line);

  if (!fields || !DATE_RE.test(fields.date) || !fields.flowType || !fields.amount) return null;

  return {
    sourcePdf,
    page: line.page,
    currency: inferCashFlowCurrency(fields, currency),
    date: fields.date,
    flowType: fields.flowType,
    note: fields.note,
    amount: parseNumber(fields.amount),
    evidence: {
      page: line.page,
      text: line.text,
      bounds: line.bounds,
    },
  };
}

function isStandaloneCashFlowCandidate(cashFlow: CashFlowRecord) {
  const flowType = canonicalText(cashFlow.flowType);
  const note = canonicalText(cashFlow.note);
  const text = `${flowType} ${note}`.toLowerCase();
  return (
    flowType.includes("现金分红") ||
    flowType.includes("公司行动") ||
    flowType.includes("转入余额通") ||
    flowType.includes("余额通转出") ||
    flowType.includes("新股") ||
    text.includes("cash dividend") ||
    text.includes("withholding tax/dividend fee") ||
    ENGLISH_CASH_FLOW_TYPES.some((type) => text.startsWith(type.toLowerCase()))
  );
}

function parsePositionMoveLine(
  sourcePdf: string,
  line: TextLine,
  market: string,
  documentAliases: Map<string, SecurityAlias>,
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
  const security = splitSecurity(item, documentAliases);

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
  statementMonth: string,
  market: string,
  currency: Currency,
  documentAliases: Map<string, SecurityAlias>,
): PortfolioRecord | null {
  const cellFields: PortfolioFields = {
    item: lineCell(line, 0, 120),
    beginQty: lineCell(line, 120, 170),
    changeQty: lineCell(line, 170, 225),
    endQty: lineCell(line, 225, 275),
    price: lineCell(line, 275, 318),
    marketValue: lineCell(line, 318, 370),
    avgCost: lineCell(line, 370, 414),
    unrealizedGainLoss: lineCell(line, 414, 470),
  };
  const fields = hasCompletePortfolioFields(cellFields) ? cellFields : parseInlinePortfolioFields(line);
  if (!fields) return null;

  const canonicalItem = canonicalText(fields.item);
  if (
    !fields.item ||
    canonicalItem.startsWith("汇总") ||
    canonicalItem.startsWith("股票") ||
    canonicalItem.startsWith("余额通") ||
    isCurrencySummaryItem(canonicalItem)
  ) {
    return null;
  }

  if (!hasCompletePortfolioFields(fields)) {
    return null;
  }

  const security = splitSecurity(fields.item, documentAliases);
  if (!market && security.codeResolution === "name_fallback") return null;
  if (!security.code) return null;
  const inferredMarket = inferTradeMarket(fields.item, security);

  return {
    sourcePdf,
    page: line.page,
    statementMonth: statementMonth || undefined,
    market: market || inferredMarket.market,
    currency: market ? currency : inferredMarket.currency,
    code: security.code,
    name: security.name,
    beginQty: parseNumber(fields.beginQty),
    changeQty: parseNumber(fields.changeQty),
    endQty: parseNumber(fields.endQty),
    price: parseNumber(fields.price),
    marketValue: parseNumber(fields.marketValue),
    avgCost: parseNumber(fields.avgCost),
    unrealizedGainLoss: parseNumber(fields.unrealizedGainLoss),
  };
}

function addDocumentSecurityAlias(
  aliases: Map<string, SecurityAlias>,
  security: { code: string; name: string; market?: string; currency?: Currency },
) {
  if (!security.code || security.code.startsWith("UNRESOLVED-")) return;
  const nameKey = securityAliasKey(security.name);
  const codeKey = securityAliasKey(security.code);
  if (!nameKey || nameKey === codeKey) return;
  aliases.set(nameKey, {
    code: security.code,
    name: security.name,
    market: security.market,
    currency: security.currency,
  });
}

function manualSecurityAliasMap(manualAliases: ManualSecurityAliasInput[] = []) {
  const aliases = new Map<string, SecurityAlias>();
  for (const item of manualAliases) {
    const name = clean(canonicalText(item.name ?? ""));
    const symbol = normalizeCode(clean(canonicalText(item.symbol ?? "")));
    if (!name || !symbol || symbol.startsWith("UNRESOLVED-")) continue;
    aliases.set(securityAliasKey(name), {
      code: symbol,
      name,
      market: item.market,
      currency: item.currency,
    });
  }
  return aliases;
}

function parseLongbridgeLines(
  sourcePdf: string,
  lines: TextLine[],
  manualAliases: ManualSecurityAliasInput[] = [],
): LongbridgeRawData {
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
  let statementMonth = "";
  let sequence = 0;
  const fallbackSecurityNames = new Map<string, string>();
  const documentSecurityAliases = manualSecurityAliasMap(manualAliases);
  let lastTradeForTime: StockTradeRecord | null = null;
  let readingTradeTimes = false;

  for (const line of lines) {
    const text = canonicalText(line.text);
    if (isLongbridgeMonthlyStatement(text)) {
      raw.statementDetected = true;
    }
    const statementMonthMatch = text.match(/^(20\d{2})\.(0[1-9]|1[0-2])$/);
    if (statementMonthMatch) {
      statementMonth = `${statementMonthMatch[1]}-${statementMonthMatch[2]}`;
    }
    if (
      /^Order Time\s+Transaction Time\s+Quantity\s+Price$/i.test(text) ||
      (text.includes("下单时间") && text.includes("成交时间") && text.includes("数量") && text.includes("平均价格"))
    ) {
      readingTradeTimes = true;
      continue;
    }
    if (readingTradeTimes) {
      const tradeTimeMatch = text.match(/^\d{2}:\d{2}:\d{2}\s+\S+\s+(\d{2}:\d{2}:\d{2})\s+\S+/);
      if (tradeTimeMatch && lastTradeForTime) {
        lastTradeForTime.tradeTime =
          lastTradeForTime.tradeTime && lastTradeForTime.tradeTime < tradeTimeMatch[1]
            ? lastTradeForTime.tradeTime
            : tradeTimeMatch[1];
        continue;
      }
      readingTradeTimes = false;
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

    if (activeTable !== "stock_trade" && activeTable !== "cash_flow" && activeTable !== "position_move") {
      const cashFlow = parseCashFlowLine(sourcePdf, line, cashCurrency);
      if (cashFlow && isStandaloneCashFlowCandidate(cashFlow)) {
        raw.cashFlows.push(cashFlow);
        continue;
      }
    }

    if (activeTable === "stock_trade" || /\bOS\d+/.test(text)) {
      const trade = parseStockTradeLine(sourcePdf, line, tradeMarket, tradeCurrency, sequence, documentSecurityAliases);
      if (trade) {
        activeTable = "stock_trade";
        raw.trades.push(trade);
        lastTradeForTime = trade;
        addDocumentSecurityAlias(documentSecurityAliases, {
          code: trade.code,
          name: trade.name,
          market: trade.market,
          currency: trade.currency,
        });
        if (trade.codeResolution === "name_fallback") {
          fallbackSecurityNames.set(trade.code, trade.name);
        }
        sequence += 1;
        continue;
      }
      const cashFlow = parseCashFlowLine(sourcePdf, line, cashCurrency);
      if (cashFlow) {
        activeTable = "cash_flow";
        raw.cashFlows.push(cashFlow);
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
      const move = parsePositionMoveLine(sourcePdf, line, moveMarket, documentSecurityAliases);
      if (move) raw.moves.push(move);
      continue;
    }

    if (activeTable === "none") {
      const position = parsePortfolioLine(sourcePdf, line, statementMonth, portfolioMarket, portfolioCurrency, documentSecurityAliases);
      if (position) {
        raw.positions.push(position);
        addDocumentSecurityAlias(documentSecurityAliases, position);
        continue;
      }
    }

    if (activeTable === "portfolio") {
      const position = parsePortfolioLine(sourcePdf, line, statementMonth, portfolioMarket, portfolioCurrency, documentSecurityAliases);
      if (position) {
        raw.positions.push(position);
        addDocumentSecurityAlias(documentSecurityAliases, position);
      }
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

const US_SECURITY_NOTE_RE = /\b([A-Z]{1,5})(?:\.US|\([A-Z]{2}[A-Z0-9]{8,12}\))/i;
const US_DIVIDEND_NOTE_RE = /\b([A-Z]{1,5})(?:\.US|\([A-Z]{2}[A-Z0-9]{8,12}\))\s+Cash Dividend/i;

function dividendSymbolFromNote(note: string) {
  return canonicalText(note).match(US_DIVIDEND_NOTE_RE)?.[1].toUpperCase() ?? null;
}

function usSymbolFromNote(note: string) {
  return canonicalText(note).match(US_SECURITY_NOTE_RE)?.[1].toUpperCase() ?? null;
}

function isUsDividendCashFlow(cashFlow: CashFlowRecord) {
  const flowType = canonicalText(cashFlow.flowType).toLowerCase();
  const note = canonicalText(cashFlow.note).toLowerCase();
  const isDividend = flowType.includes("分红") || flowType.includes("cash dividend") || note.includes("cash dividend");
  return isDividend && Boolean(dividendSymbolFromNote(cashFlow.note)) && cashFlow.amount > 0;
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
  const pendingFees = new Map<string, number>();
  const symbolsByDate = new Map<string, Set<string>>();

  for (const cashFlow of cashFlows) {
    const symbol = usSymbolFromNote(cashFlow.note);
    if (!symbol) continue;
    const symbols = symbolsByDate.get(cashFlow.date) ?? new Set<string>();
    symbols.add(symbol);
    symbolsByDate.set(cashFlow.date, symbols);
  }

  const singleSymbolForDate = (date: string) => {
    const symbols = symbolsByDate.get(date);
    return symbols?.size === 1 ? Array.from(symbols)[0] : null;
  };

  for (const cashFlow of cashFlows) {
    const flowType = canonicalText(cashFlow.flowType);
    const note = canonicalText(cashFlow.note);
    const dividendSymbol = dividendSymbolFromNote(cashFlow.note) ?? singleSymbolForDate(cashFlow.date);
    const lowerFlowType = flowType.toLowerCase();
    const lowerNote = note.toLowerCase();
    if (
      (flowType.includes("分红") || lowerFlowType.includes("cash dividend") || lowerNote.includes("cash dividend")) &&
      dividendSymbol &&
      cashFlow.amount > 0
    ) {
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
        fee: pendingFees.get(key) ?? 0,
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
      pendingFees.delete(key);
      continue;
    }

    if (flowType.includes("公司行动") && note.includes("Handling Fee")) {
      const symbol = usSymbolFromNote(cashFlow.note);
      if (!symbol) continue;
      const key = `${cashFlow.date}-${symbol}`;
      const existing = dividends.find((dividend) => dividend.date === normalizeDate(cashFlow.date) && dividend.symbol === symbol);
      if (existing) {
        existing.fee += Math.abs(cashFlow.amount);
      } else {
        pendingFees.set(key, (pendingFees.get(key) ?? 0) + Math.abs(cashFlow.amount));
      }
      continue;
    }

    if (
      note.includes("Withholding Tax/Dividend Fee") ||
      lowerFlowType.includes("withholding tax/dividend fee") ||
      (flowType.includes("公司行动其他费用") && note.includes("Cash Dividend"))
    ) {
      const symbol = dividendSymbolFromNote(cashFlow.note) ?? singleSymbolForDate(cashFlow.date);
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

function stockSplitActionLabel(ratio: number) {
  return ratio >= 1 ? "拆股" : "合股";
}

function formatQuantity(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function isStockSplitMove(move: PositionMoveRecord) {
  const moveType = canonicalText(move.moveType);
  const note = canonicalText(move.note).toLowerCase();
  return moveType.includes("公司行动") && moveType.includes("股票") && note.includes("stock split");
}

function stockSplitMoveKey(move: PositionMoveRecord) {
  return [
    move.sourcePdf,
    move.date,
    normalizeCode(move.code),
    canonicalText(move.note).toLowerCase().replace(/\s+/g, " "),
  ].join("::");
}

function stockSplitRatioFromNote(note: string) {
  const match = canonicalText(note).match(/Stock Split Amount:\s*([\d.]+)\s*for\s*([\d.]+)/i);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || numerator <= 0 || denominator <= 0) return null;
  return numerator / denominator;
}

function stockSplitSymbolFromNote(note: string) {
  const text = canonicalText(note).toUpperCase();
  const equityMatch = text.match(/\b([A-Z]{1,6})\s+US\s+EQUITY\b/);
  if (equityMatch) return normalizeCode(equityMatch[1]);
  const dottedMatch = text.match(/\b([A-Z]{1,6})\.US\b/);
  if (dottedMatch) return normalizeCode(dottedMatch[1]);
  return null;
}

function stockSplitCashForMove(cashFlows: CashFlowRecord[], move: PositionMoveRecord) {
  const code = normalizeCode(move.code);
  const moveDate = normalizeDate(move.date);
  return cashFlows
    .filter((cashFlow) => {
      const note = canonicalText(cashFlow.note).toLowerCase();
      return (
        cashFlow.amount > 0 &&
        normalizeDate(cashFlow.date) >= moveDate &&
        note.includes("stock split") &&
        stockSplitSymbolFromNote(cashFlow.note) === code
      );
    })
    .sort((a, b) => normalizeDate(a.date).localeCompare(normalizeDate(b.date)))[0];
}

function inferStockSplitEffectiveDate(raw: LongbridgeRawData, move: PositionMoveRecord, ratio: number) {
  const moveDate = normalizeDate(move.date);
  const code = normalizeCode(move.code);
  const expectedPriceRatio = ratio > 0 ? 1 / ratio : 0;
  if (!Number.isFinite(expectedPriceRatio) || expectedPriceRatio <= 0) return moveDate;

  const sameSymbolTrades = raw.trades
    .filter((trade) => normalizeCode(trade.code) === code && normalizeDate(trade.tradeDate) <= moveDate)
    .sort((a, b) => {
      return (
        normalizeDate(a.tradeDate).localeCompare(normalizeDate(b.tradeDate)) ||
        (a.tradeTime ?? "99:99:99").localeCompare(b.tradeTime ?? "99:99:99") ||
        a.sequence - b.sequence
      );
    });

  let previous: StockTradeRecord | null = null;
  for (const trade of sameSymbolTrades) {
    if (previous && previous.avgPrice > 0 && trade.avgPrice > 0) {
      const actualPriceRatio = trade.avgPrice / previous.avgPrice;
      const threshold = Math.sqrt(expectedPriceRatio);
      if (expectedPriceRatio >= 2 && actualPriceRatio >= threshold) return normalizeDate(trade.tradeDate);
      if (expectedPriceRatio <= 0.5 && actualPriceRatio <= threshold) return normalizeDate(trade.tradeDate);
    }
    previous = trade;
  }

  return moveDate;
}

function buildStockSplitEvents(raw: LongbridgeRawData, startSequence: number) {
  const groups = new Map<string, PositionMoveRecord[]>();
  for (const move of raw.moves) {
    if (!isStockSplitMove(move)) continue;
    const group = groups.get(stockSplitMoveKey(move)) ?? [];
    group.push(move);
    groups.set(stockSplitMoveKey(move), group);
  }

  const events: EventRecord[] = [];
  const issues: ReviewIssue[] = [];
  const consumed = new Set<PositionMoveRecord>();
  let sequence = startSequence;

  for (const moves of groups.values()) {
    const outMove = moves.find((move) => move.quantity < 0 || canonicalText(move.moveType).includes("出账"));
    const inMove = moves.find((move) => move.quantity > 0 || canonicalText(move.moveType).includes("进账"));
    if (!outMove || !inMove) continue;

    consumed.add(outMove);
    consumed.add(inMove);

    const splitFromQuantity = Math.abs(outMove.quantity);
    const splitToQuantity = Math.abs(inMove.quantity);
    if (splitFromQuantity <= 0 || splitToQuantity <= 0) continue;

    const inferred = inferTradeMarket(inMove.code, {
      code: inMove.code,
      name: inMove.name,
      codeResolution: "explicit",
    });
    const splitRatio = stockSplitRatioFromNote(inMove.note || outMove.note) ?? splitToQuantity / splitFromQuantity;
    const cashFlow = stockSplitCashForMove(raw.cashFlows, inMove);
    const actionLabel = stockSplitActionLabel(splitRatio);

    events.push({
      kind: "stock_split",
      date: inferStockSplitEffectiveDate(raw, inMove, splitRatio),
      rank: 1.5,
      sequence,
      market: inMove.market || outMove.market || inferred.market,
      currency: inferred.currency,
      code: inMove.code,
      name: inMove.name,
      quantity: splitToQuantity,
      splitRatio,
      splitFromQuantity,
      splitToQuantity,
      cashInLieu: cashFlow?.amount,
      source: "公司行动股票出入账",
      note: `${actionLabel}：${formatQuantity(splitFromQuantity)} 股 -> ${formatQuantity(splitToQuantity)} 股${
        cashFlow ? `；碎股现金 ${inferred.currency} ${formatQuantity(cashFlow.amount)}` : ""
      }；${inMove.note || outMove.note}`,
    });
    issues.push({
      id: `${inMove.sourcePdf}-${inMove.code}-${inMove.date}-stock-split`,
      severity: "info",
      title: `${displayCode(inMove.code)} 已识别${actionLabel}`,
      detail: `已按公司行动将 ${formatQuantity(splitFromQuantity)} 股折算为 ${formatQuantity(splitToQuantity)} 股，并保留原持仓总成本。${
        cashFlow
          ? `检测到碎股现金 ${inferred.currency} ${formatQuantity(cashFlow.amount)}；当拆合股前持仓成本可追踪时，系统会按碎股处置收入参与成本重放。`
          : ""
      }`,
      source: inMove.sourcePdf,
    });
    sequence += 1;
  }

  return { events, issues, consumed, nextSequence: sequence };
}

function activityAmount(event: EventRecord) {
  if ("cash" in event) return event.kind === "buy" ? -event.cash : event.cash;
  if (event.kind === "transfer_out" || event.kind === "stock_split") return 0;
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
    splitRatio: "splitRatio" in event ? event.splitRatio : undefined,
    splitFromQuantity: "splitFromQuantity" in event ? event.splitFromQuantity : undefined,
    splitToQuantity: "splitToQuantity" in event ? event.splitToQuantity : undefined,
    cashInLieu: "cashInLieu" in event ? event.cashInLieu : undefined,
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

  const stockSplitEvents = buildStockSplitEvents(raw, sequence);
  events.push(...stockSplitEvents.events);
  issues.push(...stockSplitEvents.issues);
  sequence = stockSplitEvents.nextSequence;

  for (const move of raw.moves) {
    if (stockSplitEvents.consumed.has(move)) continue;
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
    const isBuy = isBuySide(trade.side);
    const isSell = isSellSide(trade.side);
    if (!isBuy && !isSell) continue;
    events.push({
      kind: isBuy ? "buy" : "sell",
      date: normalizeDate(trade.tradeDate),
      rank: 2,
      sequence: trade.sequence + sequence,
      time: trade.tradeTime ?? ORDER_TIME_OVERRIDE[trade.orderId] ?? "99:99:99",
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

    if (event.kind === "stock_split") {
      state.quantity *= event.splitRatio;
      const fractionalQuantity = Math.max(0, state.quantity - event.splitToQuantity);
      if (fractionalQuantity > 1e-8 && event.cashInLieu && event.cashInLieu > 0) {
        const costBasis = fractionalQuantity * stateAvgCost(state);
        if (targetYear === undefined || event.date.startsWith(String(targetYear))) {
          realizedTrades.push({
            id: `longbridge-${event.date}-${event.sequence}-${event.code}-stock-split-cash-in-lieu`,
            broker: "长桥",
            sellDate: event.date,
            sequence: event.sequence,
            market: event.market,
            currency: event.currency,
            symbol: displayCode(event.code),
            securityName: event.name,
            quantity: fractionalQuantity,
            proceeds: event.cashInLieu,
            costBasis,
            gainLoss: event.cashInLieu - costBasis,
            source: event.source,
            note: `${event.note}；拆合股碎股现金结算。`,
          });
        }
        state.quantity -= fractionalQuantity;
        state.costBasis -= costBasis;
      }
      if (Math.abs(state.quantity - event.splitToQuantity) <= 1e-6) {
        state.quantity = event.splitToQuantity;
      }
    } else if (event.kind === "acquire" || event.kind === "transfer_in") {
      state.quantity += event.quantity;
      state.costBasis += event.cost;
    } else if (event.kind === "buy") {
      state.quantity += event.quantity;
      state.costBasis += -event.cash;
    } else if (event.kind === "sell") {
      if (state.quantity + 1e-7 < event.quantity) {
        if (targetYear === undefined || event.date.startsWith(String(targetYear))) {
          const symbol = displayCode(event.code);
          const missingKey = `${key}::${event.date}::${event.sequence}`;
          const requestId = `longbridge-cost-${targetYear ?? "unknown"}-${event.currency}-${symbol}-${event.date}-${event.sequence}`;
          missingCost.set(missingKey, {
            id: requestId,
            broker: "长桥",
            sellDate: event.date,
            market: event.market,
            currency: event.currency,
            symbol,
            securityName: event.name,
            quantity: event.quantity,
            proceeds: event.cash,
            trackedQuantity: state.quantity,
            source: event.source,
            note: "手动补录这笔成本后计入资本利得",
            sales: [
              {
                date: event.date,
                time: event.time,
                sequence: event.sequence,
                market: event.market,
                currency: event.currency,
                symbol,
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
        time: event.time,
        sequence: event.sequence,
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
          time: sale.time,
          sequence: sale.sequence,
          market: sale.market,
          currency: sale.currency,
          symbol: sale.symbol,
          securityName: sale.securityName,
          quantity: sale.quantity,
          proceeds: sale.proceeds,
          costBasis,
          gainLoss: sale.proceeds - costBasis,
          source: sale.source,
          note: `用户手动补录这笔卖出总成本：${manualCostBasis}`,
          useBrokerReportedGainLoss: true,
        });
      });
      continue;
    }

    costBasisRequests.push({
      id: item.id,
      broker: item.broker,
      sellDate: item.sellDate,
      time: item.sales[0]?.time,
      sequence: item.sales[0]?.sequence,
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
      id: `${item.id}-cost-gap`,
      severity: "warning",
      title: `${item.symbol} 历史成本缺失`,
      detail: `${item.sellDate} 卖出 ${item.quantity} 股，但上传文件中最多只追踪到 ${item.trackedQuantity} 股成本；这笔卖出未计入资本利得，需要补充更早年度记录或手动在 **盈亏明细-待补成本** 中添加成本。`,
      source: item.source,
    });
  }

  return { trades: realizedTrades, issues, activities: buildTradeActivities(events), costBasisRequests };
}

function portfolioStatementMonth(position: PortfolioRecord) {
  const statementMonth = position.sourcePdf.match(/(20\d{2})[-_年.]?(0[1-9]|1[0-2])/);
  return position.statementMonth ?? (statementMonth ? `${statementMonth[1]}-${statementMonth[2]}` : "");
}

function buildOpenPositions(raw: LongbridgeRawData): OpenPosition[] {
  const latestByCode = new Map<string, PortfolioRecord>();
  for (const position of raw.positions) {
    const market = canonicalText(position.market);
    if (market !== "香港市场" && market !== "美国市场") continue;
    const key = `${position.currency}::${position.code}`;
    const existing = latestByCode.get(key);
    if (!existing || portfolioStatementMonth(position) >= portfolioStatementMonth(existing)) {
      latestByCode.set(key, position);
    }
  }

  return Array.from(latestByCode.values())
    .filter((position) => position.endQty > 0)
    .map((position) => {
      const statementMonth = position.sourcePdf.match(/(20\d{2})[-_年.]?(0[1-9]|1[0-2])/);
      const asOfMonth = position.statementMonth ?? (statementMonth ? `${statementMonth[1]}-${statementMonth[2]}` : "");
      return {
        id: `longbridge-open-${position.currency}-${position.code}`,
        broker: "长桥",
        asOf: asOfMonth ? `${asOfMonth}-末` : "",
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
  options: { targetYear?: number; manualCosts?: ManualCostInput[]; securityAliases?: ManualSecurityAliasInput[] } = {},
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
      const fileRaw = parseLongbridgeLines(file.name, lines, options.securityAliases ?? []);
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
