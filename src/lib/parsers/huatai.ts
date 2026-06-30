import { emptyParsedInput } from "@/lib/tax/calculator";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import { normalizeSymbol } from "./common";
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

interface HuataiFileInput {
  name: string;
  data: ArrayBuffer;
}

interface TextToken {
  text: string;
  x: number;
  y: number;
}

interface TextLine {
  page: number;
  text: string;
  tokens: TextToken[];
}

interface PdfTextItemLike {
  str?: unknown;
  transform?: unknown;
}

interface TradeRecord {
  sourcePdf: string;
  page: number;
  ref: string;
  tradeDate: string;
  settleDate?: string;
  sequence: number;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  side: TradeActivity["side"];
  rawSide: string;
  quantity: number;
  unitPrice: number;
  grossAmount: number;
  fee: number;
  amount: number;
  text: string;
}

interface AccountMovementRecord {
  sourcePdf: string;
  page: number;
  ref: string;
  date: string;
  settleDate: string;
  tradeDate?: string;
  type: string;
  currency: Currency;
  amount: number | null;
  text: string;
}

interface PositionRecord {
  sourcePdf: string;
  page: number;
  statementMonth: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  price: number;
  marketValue: number;
  text: string;
}

interface HuataiRawData {
  trades: TradeRecord[];
  movements: AccountMovementRecord[];
  positions: PositionRecord[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

interface SecurityInfo {
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
}

interface MissingCostRecord {
  id: string;
  sellDate: string;
  sequence?: number;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  trackedQuantity: number;
  proceeds: number;
  source: string;
  note?: string;
}

export interface ManualCostInput {
  id: string;
  costBasis: number;
}

const HUATAI_BROKER = "华泰";
const NUMERIC_PATTERN = /\(?-?\d[\d,]*(?:\.\d+)?\)?/g;
const TRADE_LINE_PATTERN =
  /^\s*([A-Z0-9]{8,16})\s+(20\d{2}-\d{2}-\d{2})\s+(买入开仓|卖出平仓|买入|沽出|卖出)\s+([A-Z0-9]{1,16}(?::(?:HK|US|FUND))?)\s+(\d+(?:\.\d+)?)\s+(\(?[\d,]+(?:\.\d+)?\)?)\s+(\(?[\d,]+(?:\.\d+)?\)?)\s+(\(?[\d,]+(?:\.\d+)?\)?)\s+(\(?[\d,]+(?:\.\d+)?\)?)/;
const BROKEN_TRADE_LINE_PATTERN =
  /^\s*([A-Z0-9]{8,16})\s+(20\d{2}-\d{2}-\d{2})\s+(买入开仓|卖出平仓|买入|沽出|卖出)\s+([A-Z0-9]{1,16}(?::(?:HK|US|FUND))?)\s+(\d+(?:\.\d+)?)\s+(\(\d[\d,]*\.)\s+(\d[\d,]*(?:\.\d+)?)\s+(\(?[\d,]+(?:\.\d+)?\)?)\s+(\(?[\d,]+(?:\.\d+)?\)?)/;

const KNOWN_FUND_CURRENCIES: Record<string, Currency> = {
  HK0000846532: "USD",
  HK0000951506: "HKD",
  HK0000951548: "USD",
};

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return clean(value)
    .normalize("NFKC")
    .replaceAll("：", ":")
    .replaceAll("（", "(")
    .replaceAll("）", ")")
    .replaceAll("－", "-")
    .replaceAll("–", "-")
    .replaceAll("—", "-")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("戶", "户")
    .replaceAll("賬", "账")
    .replaceAll("帳", "账")
    .replaceAll("結", "结")
    .replaceAll("餘", "余")
    .replaceAll("現", "现")
    .replaceAll("貨", "货")
    .replaceAll("資", "资")
    .replaceAll("產", "产")
    .replaceAll("強", "强");
}

function parseNumber(value: string | undefined) {
  const text = canonicalText(value ?? "").replace(/,/g, "");
  if (!text || text === "--") return 0;
  const negative = text.startsWith("(") && text.endsWith(")");
  const parsed = Number(text.replace(/[()]/g, ""));
  if (!Number.isFinite(parsed)) return 0;
  return negative ? -parsed : parsed;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeDate(value: string | undefined) {
  return canonicalText(value ?? "").replace(/\//g, "-");
}

function isDate(value: string | undefined) {
  return /^20\d{2}-\d{2}-\d{2}$/.test(normalizeDate(value));
}

function moneyText(value: number, currency?: Currency) {
  return `${currency ? `${currency} ` : ""}${roundMoney(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function marketForProduct(product: string, currency: Currency) {
  const text = product.toUpperCase();
  if (text.endsWith(":US")) return "美国市场";
  if (text.endsWith(":HK")) return "香港市场";
  if (text.endsWith(":FUND")) return "基金";
  return currency === "USD" ? "美国市场" : "香港市场";
}

function currencyFromName(symbol: string, name: string): Currency {
  const known = KNOWN_FUND_CURRENCIES[symbol.toUpperCase()];
  if (known) return known;
  const text = canonicalText(name).toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("CNY") || text.includes("人民币")) return "CNY";
  return "HKD";
}

function securityFromProduct(product: string, name = ""): SecurityInfo {
  const normalizedProduct = canonicalText(product).toUpperCase();
  const [rawSymbol, suffix = ""] = normalizedProduct.split(":");
  const symbol = suffix === "FUND" ? rawSymbol : normalizeSymbol(rawSymbol.replace(/^HK0*(?=\d)/, ""));
  const currency: Currency = suffix === "US" ? "USD" : suffix === "FUND" ? currencyFromName(symbol, name) : "HKD";
  const securityName = clean(name).replace(/\b(?:HKD|USD|CNY)\b$/i, "").trim() || symbol;
  return {
    market: marketForProduct(normalizedProduct, currency),
    currency,
    symbol,
    securityName,
  };
}

function securityFromCode(code: string, name: string, currency: Currency = "HKD"): SecurityInfo {
  const symbol = normalizeSymbol(code);
  return {
    market: /^\d+$/.test(code) ? "香港市场" : marketForProduct(code, currency),
    currency,
    symbol,
    securityName: clean(name) || symbol,
  };
}

async function extractPdfLines(fileName: string, data: ArrayBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    disableFontFace: true,
    disableWorker: typeof window === "undefined",
    isEvalSupported: false,
    ...(typeof window === "undefined" && typeof process !== "undefined"
      ? { standardFontDataUrl: `${process.cwd()}/node_modules/pdfjs-dist/standard_fonts/` }
      : {}),
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const document = await loadingTask.promise;
  const pages: TextLine[][] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
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

    pages.push(
      groups
        .sort((a, b) => b.y - a.y)
        .map((group) => {
          const sortedTokens = group.tokens.sort((a, b) => a.x - b.x);
          return {
            page: pageNumber,
            text: clean(sortedTokens.map((token) => token.text).join(" ")),
            tokens: sortedTokens,
          };
        }),
    );
  }

  if (pages.length === 0) {
    throw new Error(`${fileName} 没有可解析页面`);
  }

  return pages.flat();
}

function statementMonthFromLines(lines: TextLine[]) {
  const text = lines
    .slice(0, 80)
    .map((line) => canonicalText(line.text))
    .join(" ");
  const match = text.match(/月结单\s*\((20\d{2})-(0[1-9]|1[0-2])\)/);
  return match ? `${match[1]}-${match[2]}` : "";
}

function isHuataiStatement(text: string) {
  const normalized = canonicalText(text).toLowerCase();
  return normalized.includes("华泰金融控股") || normalized.includes("huatai financial holdings");
}

function isMovementStart(text: string) {
  return /^[A-Z0-9]{6,16}\s+20\d{2}-\d{2}-\d{2}(?:\s+20\d{2}-\d{2}-\d{2})?\s+(资金存入|资金提取|现金存款|现金提款|产品存入|现货存入|产品提取|现货提取|买卖交易)\b/.test(
    canonicalText(text),
  );
}

function isSectionOrHeader(text: string) {
  const normalized = canonicalText(text);
  return (
    normalized.includes("投资组合总览") ||
    normalized.includes("成交单据") ||
    normalized.includes("户口变动") ||
    normalized.includes("持货结存") ||
    normalized.includes("股票借贷资料") ||
    normalized.includes("股息/红股/公司行动") ||
    normalized.includes("Private and Confidential") ||
    normalized.startsWith("参考编号") ||
    normalized.startsWith("代码 ") ||
    normalized.startsWith("* =")
  );
}

function movementContext(lines: TextLine[], index: number) {
  const parts = [canonicalText(lines[index].text)];
  for (let offset = 1; offset <= 5 && index + offset < lines.length; offset += 1) {
    const next = canonicalText(lines[index + offset].text);
    if (!next) continue;
    if (isMovementStart(next) || TRADE_LINE_PATTERN.test(next) || BROKEN_TRADE_LINE_PATTERN.test(next) || isSectionOrHeader(next)) break;
    parts.push(next);
  }
  return clean(parts.join(" "));
}

function tradeContinuationText(lines: TextLine[], index: number) {
  const parts: string[] = [];
  for (let offset = 1; offset <= 4 && index + offset < lines.length; offset += 1) {
    const next = canonicalText(lines[index + offset].text);
    if (!next) continue;
    if (TRADE_LINE_PATTERN.test(next) || BROKEN_TRADE_LINE_PATTERN.test(next) || isMovementStart(next) || isSectionOrHeader(next)) break;
    parts.push(next);
  }
  return clean(parts.join(" "));
}

function tradeNameFromContinuation(product: string, continuation: string) {
  const productText = product.toUpperCase();
  const pieces = continuation
    .split(/\s{2,}| \((?:互联网|流动电话)\) |\(互联网\)|\(流动电话\)/)
    .map((part) =>
      clean(part)
        .replace(/^[A-Z0-9]{6,16}\s+/, "")
        .replace(/^20\d{2}-\d{2}-\d{2}\s*/, "")
        .replace(/^(开仓|平仓)\s*/, "")
        .replace(/\b(?:0\.00|HKD|USD|CNY)\b/g, "")
        .replace(NUMERIC_PATTERN, "")
        .trim(),
    )
    .filter(Boolean);
  const candidates = pieces.filter((piece) => {
    const text = piece.toUpperCase();
    if (text === productText || text === "FUND") return false;
    if (text.includes("PRIVATE AND CONFIDENTIAL")) return false;
    if (text.includes("市场费用") || text.includes("佣金") || text.includes("净金额")) return false;
    return /[A-Za-z\u4e00-\u9fff]/.test(piece);
  });
  return clean(candidates.join(" ")) || product.replace(/:(?:HK|US|FUND)$/i, "");
}

function tradeSideFromRawSide(rawSide: string): TradeActivity["side"] {
  if (rawSide.includes("买入开仓")) return "long_open";
  if (rawSide.includes("卖出开仓") || rawSide.includes("沽出开仓")) return "short_open";
  if (rawSide.includes("买入平仓")) return "short_close";
  if (rawSide.includes("沽") || rawSide.includes("卖")) return "sell";
  return "buy";
}

function parseTradeLine(sourcePdf: string, lines: TextLine[], index: number, sequence: number): TradeRecord | null {
  const line = lines[index];
  const text = canonicalText(line.text);
  let match = text.match(TRADE_LINE_PATTERN);
  let quantityText = match?.[6];

  if (!match) {
    const broken = text.match(BROKEN_TRADE_LINE_PATTERN);
    if (!broken) return null;
    const continuation = tradeContinuationText(lines, index);
    const quantityTail = continuation.match(/\b(\d{2,8}\))\b/)?.[1];
    if (!quantityTail) return null;
    match = broken;
    quantityText = `${broken[6]}${quantityTail}`;
  }

  const continuation = tradeContinuationText(lines, index);
  const rawSide = canonicalText(match[3]);
  const product = canonicalText(match[4]);
  const name = tradeNameFromContinuation(product, continuation);
  const security = securityFromProduct(product, name);
  const side = tradeSideFromRawSide(rawSide);
  const quantity = Math.abs(parseNumber(quantityText));
  const grossAmount = Math.abs(parseNumber(match[7]));
  const netAmount = Math.abs(parseNumber(match[9]));
  const fee = Math.max(0, roundMoney(Math.abs(netAmount - grossAmount)) || Math.abs(parseNumber(match[8])));
  const settleDate = continuation.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];

  if (!quantity || !netAmount) return null;

  return {
    sourcePdf,
    page: line.page,
    ref: match[1],
    tradeDate: normalizeDate(match[2]),
    settleDate: isDate(settleDate) ? settleDate : undefined,
    sequence,
    market: security.market,
    currency: security.currency,
    symbol: security.symbol,
    securityName: security.securityName,
    side,
    rawSide,
    quantity,
    unitPrice: parseNumber(match[5]),
    grossAmount,
    fee,
    amount: netAmount,
    text: clean(`${text} ${continuation}`),
  };
}

function movementTradeSide(text: string): { side: TradeActivity["side"]; rawSide: string } | null {
  const normalized = canonicalText(text);
  if (normalized.includes(":FUND")) return null;
  if (normalized.includes("买入开仓")) return { side: "long_open", rawSide: "买入开仓" };
  if (normalized.includes("卖出开仓") || normalized.includes("沽出开仓")) return { side: "short_open", rawSide: "卖出开仓" };
  if (normalized.includes("买入平仓")) return { side: "short_close", rawSide: "买入平仓" };
  if (normalized.includes("卖出平仓") || normalized.includes("沽出平仓")) return { side: "sell", rawSide: "卖出平仓" };
  return null;
}

function movementTradeSidesByRef(movements: AccountMovementRecord[]) {
  const sides = new Map<string, { side: TradeActivity["side"]; rawSide: string }>();
  for (const movement of movements) {
    if (movement.type !== "买卖交易") continue;
    const side = movementTradeSide(movement.text);
    if (side) sides.set(movement.ref, side);
  }
  return sides;
}

function parseMovementAmount(remainder: string) {
  const numbers = Array.from(remainder.matchAll(NUMERIC_PATTERN)).map((match) => match[0]);
  if (numbers.length >= 2) return parseNumber(numbers[numbers.length - 2]);
  if (numbers.length === 1) return parseNumber(numbers[0]);
  return null;
}

function parseMovementLine(sourcePdf: string, lines: TextLine[], index: number, activeCurrency: Currency): AccountMovementRecord | null {
  const line = lines[index];
  const text = canonicalText(line.text);
  const match = text.match(
    /^([A-Z0-9]{6,16})\s+(20\d{2}-\d{2}-\d{2})(?:\s+(20\d{2}-\d{2}-\d{2}))?\s+(资金存入|资金提取|现金存款|现金提款|产品存入|现货存入|产品提取|现货提取|买卖交易)\s+(.+)$/,
  );
  if (!match) return null;

  const context = movementContext(lines, index);
  return {
    sourcePdf,
    page: line.page,
    ref: match[1],
    settleDate: normalizeDate(match[2]),
    tradeDate: match[3] ? normalizeDate(match[3]) : undefined,
    date: normalizeDate(match[3] ?? match[2]),
    type: match[4],
    currency: activeCurrency,
    amount: parseMovementAmount(match[5]),
    text: context,
  };
}

function approximatelyEqual(a: number, b: number, tolerance = 0.02) {
  return Math.abs(a - b) <= tolerance;
}

function positionNumbers(numbers: number[]) {
  if (numbers.length >= 8) {
    const standard = {
      quantity: numbers[1],
      price: numbers[4],
      marketValue: numbers[5],
    };
    const shifted = {
      quantity: numbers[2],
      price: numbers[3],
      marketValue: numbers[4],
    };
    if (
      (!Number.isFinite(standard.quantity) ||
        standard.quantity <= 0 ||
        !approximatelyEqual(standard.quantity * standard.price, standard.marketValue)) &&
      Number.isFinite(shifted.quantity) &&
      shifted.quantity > 0 &&
      approximatelyEqual(shifted.quantity * shifted.price, shifted.marketValue)
    ) {
      return shifted;
    }
    return standard;
  }
  return {
    quantity: numbers[0],
    price: numbers[2],
    marketValue: numbers[3],
  };
}

function activeCashCurrencyFromLine(text: string, current: Currency): Currency {
  const normalized = canonicalText(text).toUpperCase();
  if (normalized.includes("承上结余") || normalized.includes("承上结馀")) {
    if (/\bUSD\b/.test(normalized)) return "USD";
    if (/\bCNY\b/.test(normalized) || normalized.includes("人民币")) return "CNY";
    if (/\bHKD\b/.test(normalized)) return "HKD";
  }
  return current;
}

function parsePositionLine(sourcePdf: string, lines: TextLine[], index: number, statementMonth: string, market: string, currency: Currency) {
  const line = lines[index];
  let text = canonicalText(line.text);
  if (!text || text.startsWith("* =") || /^(HKD|USD|CNY)\b/.test(text)) return null;

  let splitCodeSuffix = "";
  let splitNameSuffix = "";
  const splitCode = text.match(/^(HK\d{6})\s+(.+)$/i);
  if (splitCode && index + 1 < lines.length) {
    const next = canonicalText(lines[index + 1].text);
    const nextMatch = next.match(/^(\d{4})\s+(.+)$/);
    if (nextMatch && !NUMERIC_PATTERN.test(nextMatch[2])) {
      splitCodeSuffix = nextMatch[1];
      splitNameSuffix = nextMatch[2];
    }
  }

  const match = text.match(/^([A-Z]{1,4}\d{4,12}|\d{5}|[A-Z]{1,8})\s+(.+)$/);
  if (!match) return null;
  let symbol = match[1];
  let rest = match[2];
  if (splitCodeSuffix) {
    symbol = `${symbol}${splitCodeSuffix}`;
    rest = `${rest} ${splitNameSuffix}`;
  }

  const numericMatches = Array.from(rest.matchAll(NUMERIC_PATTERN));
  if (numericMatches.length < 4) return null;
  const firstNumberIndex = numericMatches[0].index ?? 0;
  const securityName = clean(rest.slice(0, firstNumberIndex));
  const numbers = numericMatches.map((item) => parseNumber(item[0]));
  const { quantity, price, marketValue } = positionNumbers(numbers);

  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(marketValue)) return null;
  const normalizedSymbol = symbol.startsWith("HK") ? symbol.toUpperCase() : normalizeSymbol(symbol);
  return {
    sourcePdf,
    page: line.page,
    statementMonth,
    market,
    currency,
    symbol: normalizedSymbol,
    securityName: securityName || normalizedSymbol,
    quantity,
    price,
    marketValue,
    text,
  } satisfies PositionRecord;
}

function parseMarketGroup(text: string): { market: string; currency: Currency } | null {
  const match = canonicalText(text).match(/^([A-Z]+)\s+-\s+.+\((HKD|USD|CNY)\)$/i);
  if (!match) return null;
  const rawMarket = match[1].toUpperCase();
  const currency = match[2].toUpperCase() as Currency;
  if (rawMarket === "US") return { market: "美国市场", currency };
  if (rawMarket === "HK") return { market: "香港市场", currency };
  return { market: "基金", currency };
}

function parseHuataiLines(sourcePdf: string, lines: TextLine[]): HuataiRawData {
  const raw: HuataiRawData = {
    trades: [],
    movements: [],
    positions: [],
    issues: [],
    statementDetected: false,
  };
  const statementMonth = statementMonthFromLines(lines);
  let sequence = 0;
  let activeCashCurrency: Currency = "HKD";
  let activePositionGroup: { market: string; currency: Currency } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const text = canonicalText(line.text);
    if (isHuataiStatement(text)) raw.statementDetected = true;

    activeCashCurrency = activeCashCurrencyFromLine(text, activeCashCurrency);

    const trade = parseTradeLine(sourcePdf, lines, index, sequence);
    if (trade) {
      raw.trades.push(trade);
      sequence += 1;
      continue;
    }

    const movement = parseMovementLine(sourcePdf, lines, index, activeCashCurrency);
    if (movement) {
      raw.movements.push(movement);
      sequence += 1;
      continue;
    }

    const group = parseMarketGroup(text);
    if (group) {
      activePositionGroup = group;
      continue;
    }

    if (activePositionGroup && statementMonth) {
      const position = parsePositionLine(
        sourcePdf,
        lines,
        index,
        statementMonth,
        activePositionGroup.market,
        activePositionGroup.currency,
      );
      if (position) raw.positions.push(position);
    }
  }

  if (!statementMonth && raw.statementDetected) {
    raw.issues.push({
      id: `huatai-${sourcePdf}-missing-month`,
      severity: "warning",
      title: "未识别华泰月结单月份",
      detail: "已识别为华泰月结单，但没有读取到“月结单 (YYYY-MM)”月份；期末持仓可能缺少月份归属。",
      source: sourcePdf,
    });
  }

  return raw;
}

function tradeActivityFromTrade(trade: TradeRecord, movementSides: Map<string, { side: TradeActivity["side"]; rawSide: string }> = new Map()): TradeActivity {
  const movementSide = movementSides.get(trade.ref);
  const side = movementSide?.side ?? trade.side;
  const rawSide = movementSide?.rawSide ?? trade.rawSide;
  return {
    id: `huatai-trade-${trade.tradeDate}-${trade.sequence}-${trade.currency}-${trade.symbol}-${trade.ref}`,
    broker: HUATAI_BROKER,
    date: trade.tradeDate,
    sequence: trade.sequence,
    market: trade.market,
    currency: trade.currency,
    symbol: trade.symbol,
    securityName: trade.securityName,
    side,
    quantity: trade.quantity,
    unitPrice: trade.unitPrice,
    grossAmount: trade.grossAmount,
    fee: trade.fee,
    amount: trade.amount,
    source: "华泰成交单据",
    note: `${trade.ref} ${rawSide}${trade.settleDate ? `；交收日 ${trade.settleDate}` : ""}；${trade.sourcePdf} 第 ${trade.page} 页`,
  };
}

function movementCode(text: string) {
  const normalized = canonicalText(text);
  const withMarket = normalized.match(/\b(\d{5}):HK\b/);
  if (withMarket) return normalizeSymbol(withMarket[1]);
  const successful = normalized.match(/(?:产品存入|现货存入)\s+(\d{5})\b/);
  if (successful) return normalizeSymbol(successful[1]);
  return null;
}

function buildIpoCostData(movements: AccountMovementRecord[]) {
  const prices = new Map<string, number>();
  for (const movement of movements) {
    const text = canonicalText(movement.text);
    if (!text.includes("IPO")) continue;
    const code = movementCode(text);
    if (!code) continue;
    const priceMatch = text.match(/Alloted:\s*[\d,]+(?:\.\d+)?\s*@\s*(\d+(?:\.\d+)?)/i) ?? text.match(/Qty:\s*[\d,]+(?:\.\d+)?\s*@\s*(\d+(?:\.\d+)?)/i);
    if (priceMatch) {
      const price = parseNumber(priceMatch[1]);
      if (price > 0) prices.set(code, price);
    }
  }
  return { prices };
}

function parseSuccessfulIpo(movement: AccountMovementRecord, costData: ReturnType<typeof buildIpoCostData>): TradeActivity | null {
  if (movement.type !== "产品存入" && movement.type !== "现货存入") return null;
  const text = canonicalText(movement.text);
  const match = text.match(
    /(?:产品存入|现货存入)\s+(\d{5})\s+(.+?)\s+Successful IPO(?:\s*@\s*(\d+(?:\.\d+)?))?\s+([\d,]+(?:\.\d+)?)/i,
  );
  if (!match) return null;

  const code = normalizeSymbol(match[1]);
  const price = parseNumber(match[3]) || costData.prices.get(code) || 0;
  const quantity = parseNumber(match[4]);
  if (quantity <= 0) return null;

  const costBasis = price > 0 ? quantity * price : 0;
  const security = securityFromCode(code, match[2], "HKD");
  return {
    id: `huatai-ipo-${movement.date}-${code}-${movement.ref}`,
    broker: HUATAI_BROKER,
    date: movement.date,
    sequence: -20,
    market: security.market,
    currency: security.currency,
    symbol: security.symbol,
    securityName: security.securityName,
    side: "acquire",
    quantity,
    unitPrice: price || undefined,
    grossAmount: price > 0 ? quantity * price : undefined,
    amount: roundMoney(costBasis),
    source: "华泰户口变动",
    note: `IPO 中签入账；${movement.ref}；按发行价 × 中签数量确认成本，IPO 融资/退款现金流水不并入证券成本；${movement.sourcePdf} 第 ${movement.page} 页`,
  };
}

function parseGiftDeposit(movement: AccountMovementRecord): TradeActivity | null {
  if (movement.type !== "产品存入" && movement.type !== "现货存入") return null;
  const text = canonicalText(movement.text);
  if (!/(?:产品存入|现货存入)/.test(text)) return null;
  if (text.includes("Successful IPO") || text.includes("分红")) return null;
  const match = text.match(/(?:产品存入|现货存入)\s+(\d{5})\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s+[\d,]+(?:\.\d+)?$/);
  if (!match) return null;
  const quantity = parseNumber(match[3]);
  if (quantity <= 0) return null;
  const security = securityFromCode(match[1], match[2].replace(/\bCPN.+$/i, ""), movement.currency);
  return {
    id: `huatai-gift-${movement.date}-${security.symbol}-${movement.ref}`,
    broker: HUATAI_BROKER,
    date: movement.date,
    sequence: -10,
    market: security.market,
    currency: security.currency,
    symbol: security.symbol,
    securityName: security.securityName,
    side: "acquire",
    quantity,
    amount: 0,
    source: "华泰户口变动",
    note: `产品存入/新人礼入账，系统按零成本带入；${movement.ref}；${movement.sourcePdf} 第 ${movement.page} 页`,
  };
}

function parseFundDistribution(movement: AccountMovementRecord): { activity: TradeActivity; dividend: DividendIncome } | null {
  if (movement.type !== "产品存入" && movement.type !== "现货存入") return null;
  const text = canonicalText(movement.text);
  if (!/(?:产品存入|现货存入)/.test(text) || !text.includes("分红")) return null;
  const match = text.match(/(?:产品存入|现货存入)\s+(HK\d{6,12})\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s+\(?[\d,]+(?:\.\d+)?\)?(?:\s|$)/i);
  if (!match) return null;
  const symbol = match[1].toUpperCase();
  const quantity = parseNumber(match[3]);
  if (quantity <= 0) return null;
  const currency = currencyFromName(symbol, match[2]);
  const security = securityFromProduct(`${symbol}:FUND`, match[2]);
  const estimatedAmount = roundMoney(quantity);
  const activity: TradeActivity = {
    id: `huatai-fund-distribution-${movement.date}-${symbol}-${movement.ref}`,
    broker: HUATAI_BROKER,
    date: movement.date,
    sequence: -5,
    market: security.market,
    currency,
    symbol,
    securityName: security.securityName,
    side: "acquire",
    quantity,
    unitPrice: 1,
    grossAmount: estimatedAmount,
    amount: estimatedAmount,
    source: "华泰户口变动",
    note: `基金分红再投资份额，按单位净值 1 暂估成本；${movement.ref}；${movement.sourcePdf} 第 ${movement.page} 页`,
  };
  const dividend: DividendIncome = {
    id: `huatai-fund-dividend-${movement.date}-${symbol}-${movement.ref}`,
    broker: HUATAI_BROKER,
    date: movement.date,
    currency,
    symbol,
    securityName: security.securityName,
    grossAmount: estimatedAmount,
    taxWithheld: 0,
    fee: 0,
    source: movement.sourcePdf,
    note: "华泰货币基金分红以基金份额入账；金额按份额 × 1 暂估，正式申报前建议复核基金分红明细。",
    evidence: {
      page: movement.page,
      text: movement.text,
    },
  };
  return { activity, dividend };
}

function dividendSymbolFromText(text: string) {
  const normalized = canonicalText(text);
  const match =
    normalized.match(
      /(?:Dividend\/Cash|US DIVIDEND TAX|DIVIDEND CHARGES|Dividend Collection Fee(?:\s*\(USD\))?)\s+(?:\(TW\)\s+)?([A-Z]{1,8}|\d{5})(?::(US|HK))?/i,
    ) || normalized.match(/\b([A-Z]{1,8}|\d{5})(?::(?:US|HK))\b/);
  if (!match) return null;
  const raw = match[1].toUpperCase();
  return /^\d+$/.test(raw) ? normalizeSymbol(raw) : raw;
}

function buildCashDividends(movements: AccountMovementRecord[]) {
  const aggregates = new Map<
    string,
    {
      date: string;
      currency: Currency;
      symbol: string;
      grossAmount: number;
      taxWithheld: number;
      fee: number;
      source: string;
      page: number;
      text: string;
    }
  >();

  for (const movement of movements) {
    const text = canonicalText(movement.text);
    const isCashDividend = text.includes("Dividend/Cash");
    const isDividendTax = text.includes("US DIVIDEND TAX");
    const isDividendFee = text.includes("DIVIDEND CHARGES") || text.includes("Dividend Collection Fee");
    if (!isCashDividend && !isDividendTax && !isDividendFee) continue;
    const symbol = dividendSymbolFromText(text);
    if (!symbol || movement.amount === null) continue;
    const key = `${movement.date}-${movement.currency}-${symbol}`;
    const aggregate =
      aggregates.get(key) ??
      ({
        date: movement.date,
        currency: movement.currency,
        symbol,
        grossAmount: 0,
        taxWithheld: 0,
        fee: 0,
        source: movement.sourcePdf,
        page: movement.page,
        text: movement.text,
      } satisfies {
        date: string;
        currency: Currency;
        symbol: string;
        grossAmount: number;
        taxWithheld: number;
        fee: number;
        source: string;
        page: number;
        text: string;
      });

    if (isCashDividend && movement.amount > 0) {
      aggregate.grossAmount += movement.amount;
      aggregate.text = movement.text;
    } else if (isDividendTax && movement.amount < 0) {
      aggregate.taxWithheld += Math.abs(movement.amount);
    } else if (isDividendFee && movement.amount < 0) {
      aggregate.fee += Math.abs(movement.amount);
    }
    aggregates.set(key, aggregate);
  }

  return Array.from(aggregates.values())
    .filter((item) => item.grossAmount > 0)
    .map((item) => ({
      id: `huatai-dividend-${item.date}-${item.currency}-${item.symbol}`,
      broker: HUATAI_BROKER,
      date: item.date,
      currency: item.currency,
      symbol: item.symbol,
      securityName: item.symbol,
      grossAmount: roundMoney(item.grossAmount),
      taxWithheld: roundMoney(item.taxWithheld),
      fee: roundMoney(item.fee),
      source: item.source,
      note: "华泰户口变动 Dividend/Cash 入账；US DIVIDEND TAX 计入境外已纳税额，DIVIDEND CHARGES / Dividend Collection Fee 作为费用列示。",
      evidence: {
        page: item.page,
        text: item.text,
      },
    }));
}

function buildCashInterestDividends(movements: AccountMovementRecord[]): DividendIncome[] {
  return movements
    .filter((movement) => canonicalText(movement.text).includes("现金增值收益分配") && (movement.amount ?? 0) > 0)
    .map((movement) => ({
      id: `huatai-cash-interest-${movement.date}-${movement.ref}`,
      broker: HUATAI_BROKER,
      date: movement.date,
      currency: movement.currency,
      symbol: "CASH-INTEREST",
      securityName: "现金增值收益分配",
      grossAmount: roundMoney(movement.amount ?? 0),
      taxWithheld: 0,
      fee: 0,
      source: movement.sourcePdf,
      note: "华泰户口变动现金增值收益分配，按利息/股息类收入列示。",
      evidence: {
        page: movement.page,
        text: movement.text,
      },
    }));
}

function buildMovementActivitiesAndDividends(movements: AccountMovementRecord[]) {
  const activities: TradeActivity[] = [];
  const dividends: DividendIncome[] = [];
  const costData = buildIpoCostData(movements);
  for (const movement of movements) {
    const ipo = parseSuccessfulIpo(movement, costData);
    if (ipo) {
      activities.push(ipo);
      continue;
    }
    const fundDistribution = parseFundDistribution(movement);
    if (fundDistribution) {
      activities.push(fundDistribution.activity);
      dividends.push(fundDistribution.dividend);
      continue;
    }
    const gift = parseGiftDeposit(movement);
    if (gift) activities.push(gift);
  }
  dividends.push(...buildCashDividends(movements), ...buildCashInterestDividends(movements));
  return { activities, dividends };
}

function sortActivities(activities: TradeActivity[]) {
  const rank: Record<TradeActivity["side"], number> = {
    acquire: 1,
    transfer_in: 1,
    stock_split: 1.5,
    buy: 2,
    long_open: 2,
    short_open: 2,
    short_close: 2,
    sell: 3,
    transfer_out: 4,
  };
  return [...activities].sort((a, b) => {
    return a.date.localeCompare(b.date) || rank[a.side] - rank[b.side] || (a.sequence ?? 0) - (b.sequence ?? 0) || a.id.localeCompare(b.id);
  });
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

function buildMissingCostRequests(
  activities: TradeActivity[],
  targetYear?: number,
  manualCosts: ManualCostInput[] = [],
): { realizedTrades: RealizedTrade[]; costBasisRequests: CostBasisRequest[]; issues: ReviewIssue[] } {
  const quantities = new Map<string, number>();
  const realizedTrades: RealizedTrade[] = [];
  const costBasisRequests: CostBasisRequest[] = [];
  const issues: ReviewIssue[] = [];
  const manualCostsById = manualCostMap(manualCosts);

  for (const activity of sortActivities(activities)) {
    if (activity.excludedFromTaxReplay) continue;
    const key = `${activity.broker}::${activity.currency}::${normalizeSymbol(activity.symbol)}`;
    const currentQuantity = quantities.get(key) ?? 0;
    if (activity.side === "buy" || activity.side === "long_open" || activity.side === "acquire" || activity.side === "transfer_in") {
      quantities.set(key, currentQuantity + activity.quantity);
      continue;
    }
    if (activity.side !== "sell") continue;

    if (currentQuantity + 1e-7 >= activity.quantity) {
      quantities.set(key, currentQuantity - activity.quantity);
      continue;
    }

    if (targetYear !== undefined && !activity.date.startsWith(String(targetYear))) {
      quantities.set(key, 0);
      continue;
    }

    const requestId = `huatai-cost-${targetYear ?? "unknown"}-${activity.currency}-${activity.symbol}-${activity.date}-${activity.sequence ?? 0}`;
    const manualCost = manualCostsById.get(requestId);
    if (manualCost !== undefined) {
      realizedTrades.push({
        id: `${requestId}-manual`,
        broker: HUATAI_BROKER,
        sellDate: activity.date,
        sequence: activity.sequence,
        market: activity.market,
        currency: activity.currency,
        symbol: activity.symbol,
        securityName: activity.securityName,
        quantity: activity.quantity,
        proceeds: activity.amount,
        costBasis: manualCost,
        gainLoss: activity.amount - manualCost,
        source: activity.source,
        note: `用户手动补录这笔卖出总成本：${manualCost}`,
        useBrokerReportedGainLoss: true,
      });
    } else {
      const item: MissingCostRecord = {
        id: requestId,
        sellDate: activity.date,
        sequence: activity.sequence,
        market: activity.market,
        currency: activity.currency,
        symbol: activity.symbol,
        securityName: activity.securityName,
        quantity: activity.quantity,
        trackedQuantity: Math.max(0, currentQuantity),
        proceeds: activity.amount,
        source: activity.source,
        note: "手动补录这笔成本后计入资本利得",
      };
      costBasisRequests.push({
        id: item.id,
        broker: HUATAI_BROKER,
        sellDate: item.sellDate,
        sequence: item.sequence,
        market: item.market,
        currency: item.currency,
        symbol: item.symbol,
        securityName: item.securityName,
        quantity: item.quantity,
        trackedQuantity: item.trackedQuantity,
        proceeds: item.proceeds,
        source: item.source,
        note: item.note,
      });
      issues.push({
        id: `${item.id}-cost-gap`,
        severity: "warning",
        title: `${item.symbol} 历史成本缺失`,
        detail: `${item.sellDate} 卖出 ${item.quantity} 股，但上传的华泰月结单中最多只追踪到 ${item.trackedQuantity} 股成本。请补充更早月份月结单，或在待补成本中手动填写这笔成本。`,
        source: item.source,
      });
    }
    quantities.set(key, 0);
  }

  return { realizedTrades, costBasisRequests, issues };
}

function latestYearEndPositions(positions: PositionRecord[]) {
  const latest = new Map<string, PositionRecord>();
  for (const position of positions) {
    const year = position.statementMonth.slice(0, 4);
    const key = `${year}::${position.currency}::${position.symbol}`;
    const existing = latest.get(key);
    if (!existing || position.statementMonth.localeCompare(existing.statementMonth) >= 0) latest.set(key, position);
  }
  return Array.from(latest.values()).sort(
    (a, b) => a.statementMonth.localeCompare(b.statementMonth) || a.currency.localeCompare(b.currency) || a.symbol.localeCompare(b.symbol),
  );
}

function openPositionFromRecord(position: PositionRecord): OpenPosition {
  return {
    id: `huatai-open-${position.statementMonth}-${position.currency}-${position.symbol}`,
    broker: HUATAI_BROKER,
    asOf: `${position.statementMonth}-末`,
    market: position.market,
    currency: position.currency,
    symbol: position.symbol,
    securityName: position.securityName,
    quantity: position.quantity,
    marketValue: position.marketValue,
    source: position.sourcePdf,
    note: `华泰月结单期末持仓；收市价 ${position.price}，未实现盈亏不计入资本利得。`,
  };
}

function aggregateIssue(raw: HuataiRawData): ReviewIssue {
  const buyCount = raw.trades.filter((trade) => trade.side === "buy" || trade.side === "long_open").length;
  const sellRows = raw.trades.filter((trade) => trade.side === "sell");
  const sellByCurrency = new Map<Currency, number>();
  for (const sell of sellRows) {
    sellByCurrency.set(sell.currency, (sellByCurrency.get(sell.currency) ?? 0) + sell.amount);
  }
  const proceedsText = Array.from(sellByCurrency.entries())
    .map(([currency, amount]) => moneyText(amount, currency))
    .join("、");
  const sources = Array.from(
    new Set([
      ...raw.trades.map((trade) => trade.sourcePdf),
      ...raw.movements.map((movement) => movement.sourcePdf),
      ...raw.positions.map((position) => position.sourcePdf),
    ]),
  );
  return {
    id: `huatai-${sources.length}-files-parsed`,
    severity: "info",
    title: "已解析华泰月结单",
    detail: `已读取 ${sources.length} 份华泰月结单：成交买入 ${buyCount} 笔、卖出 ${sellRows.length} 笔${proceedsText ? `，卖出收入 ${proceedsText}` : ""}，户口变动 ${raw.movements.length} 条，期末持仓 ${raw.positions.length} 条。系统会按成交日期重放成本，持仓和未卖出记录不参与本期已实现盈亏。`,
    source: sources[0],
  };
}

export async function parseHuataiPdfs(
  files: HuataiFileInput[],
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: HuataiRawData = {
    trades: [],
    movements: [],
    positions: [],
    issues: [],
    statementDetected: false,
  };

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      const fileRaw = parseHuataiLines(file.name, lines);
      raw.trades.push(...fileRaw.trades);
      raw.movements.push(...fileRaw.movements);
      raw.positions.push(...fileRaw.positions);
      raw.issues.push(...fileRaw.issues);
      raw.statementDetected = raw.statementDetected || fileRaw.statementDetected;
    } catch (error) {
      raw.issues.push({
        id: `huatai-${file.name}-pdf-error`,
        severity: "blocking",
        title: "华泰PDF解析失败",
        detail: error instanceof Error ? error.message : "未知PDF解析错误。",
        source: file.name,
      });
    }
  }

  const movementSides = movementTradeSidesByRef(raw.movements);
  const tradeActivities = raw.trades.map((trade) => tradeActivityFromTrade(trade, movementSides));
  const movementData = buildMovementActivitiesAndDividends(raw.movements);
  const activities = sortActivities([...tradeActivities, ...movementData.activities]);
  const missing = buildMissingCostRequests(activities, options.targetYear, options.manualCosts ?? []);

  parsed.tradeActivities.push(...activities);
  parsed.realizedTrades.push(...missing.realizedTrades);
  parsed.dividends.push(...movementData.dividends);
  parsed.openPositions.push(...latestYearEndPositions(raw.positions).map(openPositionFromRecord));
  parsed.costBasisRequests.push(...missing.costBasisRequests);
  parsed.issues.push(...raw.issues, ...missing.issues);

  const hasParsedRows = raw.trades.length > 0 || raw.movements.length > 0 || raw.positions.length > 0;
  if (hasParsedRows) {
    parsed.issues.push(aggregateIssue(raw));
  } else if (!raw.statementDetected && files.length > 0) {
    parsed.issues.push({
      id: "huatai-invalid-format",
      severity: "blocking",
      title: "华泰文件格式不符合要求",
      detail: "当前文件没有识别到华泰金融控股月结单的成交单据、户口变动或持货结存，请确认上传的是华泰 PDF 月结单。",
    });
  } else if (raw.trades.length === 0) {
    parsed.issues.push({
      id: "huatai-no-stock-activity",
      severity: "info",
      title: "本月没有华泰股票交易",
      detail: "已识别为华泰月结单，但没有读取到成交单据；系统会继续读取户口变动和期末持仓用于核对。",
    });
  }

  return parsed;
}
