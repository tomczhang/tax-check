import { emptyParsedInput } from "@/lib/tax/calculator";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import type {
  Currency,
  DividendIncome,
  ParsedInput,
  RealizedTrade,
  ReviewIssue,
  TaxStatementSummary,
  TradeActivity,
} from "@/lib/tax/types";

interface TigerFileInput {
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

interface TigerTradeRow {
  product: "fund" | "stock";
  page: number;
  market: string;
  exchange?: string;
  currency: Currency;
  tradeDate: string;
  settleDate: string;
  time?: string;
  side: "buy" | "sell";
  rawSide: string;
  symbol: string;
  securityName: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  fee: number;
  realizedPnl: number;
  source: string;
}

const TIGER_BROKER = "老虎";
const DATE_RE = /^20\d{2}[-.]\d{2}[-.]\d{2}$/;

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return value.normalize("NFKC").replaceAll("−", "-");
}

function parseNumber(value: string) {
  const match = canonicalText(value).match(/[+-]?\d[\d,]*(?:\.\d+)?/);
  if (!match) return 0;
  const parsed = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCurrency(value: string): Currency | null {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("HKD") || text.includes("港币")) return "HKD";
  if (text.includes("CNY") || text.includes("CNH") || text.includes("人民币")) return "CNY";
  return null;
}

function normalizeDate(value: string) {
  return canonicalText(value).replace(/\./g, "-");
}

function normalizeSymbol(value: string) {
  return canonicalText(value)
    .replace(/[()（）]/g, "")
    .trim()
    .toUpperCase();
}

function lineCell(line: TextLine, minX: number, maxX: number) {
  return clean(
    line.tokens
      .filter((token) => token.x >= minX && token.x < maxX)
      .map((token) => token.text)
      .join(" "),
  );
}

function firstDateInLine(line?: TextLine) {
  if (!line) return "";
  const match = canonicalText(line.text).match(/20\d{2}[-.]\d{2}[-.]\d{2}/);
  return match ? normalizeDate(match[0]) : "";
}

function firstTimeInLine(line?: TextLine) {
  if (!line) return "";
  return canonicalText(line.text).match(/\b\d{2}:\d{2}:\d{2}\b/)?.[0] ?? "";
}

function symbolFromLine(line?: TextLine) {
  if (!line) return "";
  const text = canonicalText(line.text);
  const parenthesized = text.match(/[（(]\s*([A-Z0-9.]+)\s*[）)]/i)?.[1];
  if (parenthesized) return normalizeSymbol(parenthesized);
  const hkCode = text.match(/\b(HK\d{6,}\.USD)\b/i)?.[1];
  if (hkCode) return normalizeSymbol(hkCode);
  return "";
}

function nameFromLine(line?: TextLine, maxX = 260) {
  if (!line) return "";
  const text = line.tokens
    .filter((token) => token.x < maxX)
    .map((token) => token.text)
    .join(" ");
  return clean(canonicalText(text).replace(/[（(]\s*[A-Z0-9.]+\s*[）)]/gi, ""));
}

function findNearbyLine(lines: TextLine[], start: number, direction: -1 | 1, predicate: (line: TextLine) => boolean) {
  const page = lines[start]?.page;
  for (let offset = 1; offset <= 3; offset += 1) {
    const candidate = lines[start + direction * offset];
    if (!candidate || candidate.page !== page) break;
    if (predicate(candidate)) return candidate;
  }
  return undefined;
}

async function extractPdfLines(fileName: string, data: ArrayBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    disableFontFace: true,
    isEvalSupported: false,
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

function parsePeriod(lines: TextLine[]) {
  for (const line of lines.slice(0, 20)) {
    const text = canonicalText(line.text);
    const match = text.match(/(20\d{2}[-.]\d{2}[-.]\d{2})\s*[~-]\s*(20\d{2}[-.]\d{2}[-.]\d{2})/);
    if (match) {
      return {
        periodStart: normalizeDate(match[1]),
        periodEnd: normalizeDate(match[2]),
      };
    }
  }
  return {};
}

function numbersOnLine(line: TextLine) {
  return canonicalText(line.text).match(/[+-]?\d[\d,]*(?:\.\d+)?/g)?.map((item) => parseNumber(item)) ?? [];
}

function parseTaxFormSummary(fileName: string, lines: TextLine[]): TaxStatementSummary | null {
  const text = lines.map((line) => line.text).join("\n");
  if (!text.includes("Tax Form Record") || !text.includes("Key Tax Figures")) return null;

  const baseCurrency = parseCurrency(lines.find((line) => canonicalText(line.text).includes("Base Currency"))?.text ?? "") ?? "USD";
  const period = parsePeriod(lines);
  const rowNumber = (label: string, index = 0) => {
    const line = lines.find((candidate) => canonicalText(candidate.text).startsWith(label));
    const values = line ? numbersOnLine(line) : [];
    return values[index] ?? 0;
  };

  const grossProceeds = rowNumber("Gross Proceeds from Sales");
  const realizedGainLoss = rowNumber("Realized Gains/Losses on Sales");
  const cashDividends = rowNumber("Cash Dividends");
  const dividendTaxWithheld = Math.abs(rowNumber("Cash Dividends", 1));
  const interest = rowNumber("Interest/Coupons Received");

  if (!grossProceeds && !realizedGainLoss && !cashDividends && !dividendTaxWithheld && !interest) return null;

  return {
    id: `tiger-tax-summary-${fileName}`,
    broker: TIGER_BROKER,
    source: fileName,
    currency: baseCurrency,
    ...period,
    grossProceeds,
    realizedGainLoss,
    cashDividends,
    dividendTaxWithheld,
    interest,
  };
}

function taxSummaryIssue(summary: TaxStatementSummary): ReviewIssue {
  const periodText =
    summary.periodStart && summary.periodEnd ? `，期间 ${summary.periodStart} 至 ${summary.periodEnd}` : "";
  return {
    id: `${summary.id}-no-trade-detail`,
    severity: "info",
    title: "缺少逐笔交易明细",
    detail: `已读取 ${summary.source}${periodText} 的税表汇总。可以读取汇总金额，但缺少逐笔交易，文件中的数据已经统计进总体数据，但在盈亏明细中无法展示。`,
    source: summary.source,
  };
}

function parseFee(value: string) {
  const matches = canonicalText(value).match(/[+-]?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return Math.abs(matches.map(parseNumber).reduce((sum, item) => sum + item, 0));
}

function parseFundTradeLine(fileName: string, lines: TextLine[], index: number): TigerTradeRow | null {
  const line = lines[index];
  const rawSide = lineCell(line, 340, 430);
  if (!rawSide.includes("买入") && !rawSide.includes("卖出")) return null;
  const currency = parseCurrency(lineCell(line, 1120, 1195));
  if (!currency) return null;

  const nameLine = findNearbyLine(lines, index, -1, (candidate) => Boolean(nameFromLine(candidate, 260)) && Boolean(firstDateInLine(candidate)));
  const symbolLine = findNearbyLine(lines, index, 1, (candidate) => Boolean(symbolFromLine(candidate)));
  const tradeDate = firstDateInLine(nameLine) || firstDateInLine(line);
  if (!DATE_RE.test(tradeDate)) return null;

  const amount = parseNumber(lineCell(line, 585, 675));
  const realizedPnl = parseNumber(lineCell(line, 760, 855));
  const symbol = symbolFromLine(symbolLine) || normalizeSymbol(nameFromLine(nameLine, 260));
  const securityName = nameFromLine(nameLine, 260) || symbol;
  const side = rawSide.includes("卖出") ? "sell" : "buy";

  return {
    product: "fund",
    page: line.page,
    market: lineCell(line, 210, 270) || "HK",
    currency,
    tradeDate,
    settleDate: firstDateInLine({ ...line, text: lineCell(line, 1045, 1130) }),
    time: firstTimeInLine(symbolLine),
    side,
    rawSide,
    symbol,
    securityName,
    quantity: Math.abs(parseNumber(lineCell(line, 420, 500))),
    unitPrice: parseNumber(lineCell(line, 500, 585)),
    amount: Math.abs(amount),
    fee: parseFee(lineCell(line, 675, 760)),
    realizedPnl,
    source: fileName,
  };
}

function parseStockTradeLine(fileName: string, lines: TextLine[], index: number): TigerTradeRow | null {
  const line = lines[index];
  const rawSide = lineCell(line, 260, 330);
  if (!rawSide.includes("开仓") && !rawSide.includes("平仓")) return null;
  const currency = parseCurrency(lineCell(line, 1120, 1195));
  if (!currency) return null;

  const nameLine =
    nameFromLine(line, 150) && firstDateInLine(line)
      ? line
      : findNearbyLine(lines, index, -1, (candidate) => Boolean(nameFromLine(candidate, 150)) && Boolean(firstDateInLine(candidate)));
  const symbolLine = findNearbyLine(lines, index, 1, (candidate) => Boolean(symbolFromLine(candidate)));
  const tradeDate = firstDateInLine(line) || firstDateInLine(nameLine);
  if (!DATE_RE.test(tradeDate)) return null;

  const amount = parseNumber(lineCell(line, 460, 540));
  const realizedPnl = parseNumber(lineCell(line, 760, 860));
  const symbol = symbolFromLine(symbolLine) || normalizeSymbol(nameFromLine(nameLine, 150));
  const securityName = nameFromLine(nameLine, 150) || symbol;
  const side = rawSide.includes("平仓") ? "sell" : "buy";

  return {
    product: "stock",
    page: line.page,
    market: lineCell(line, 150, 200) || "US",
    exchange: lineCell(line, 200, 260),
    currency,
    tradeDate,
    settleDate: firstDateInLine({ ...line, text: lineCell(line, 1045, 1130) }),
    time: firstTimeInLine(symbolLine) || firstTimeInLine(line),
    side,
    rawSide,
    symbol,
    securityName,
    quantity: Math.abs(parseNumber(lineCell(line, 330, 380))),
    unitPrice: parseNumber(lineCell(line, 380, 460)),
    amount: Math.abs(amount),
    fee: parseFee(lineCell(line, 650, 760)),
    realizedPnl,
    source: fileName,
  };
}

function tradeActivityFromRow(row: TigerTradeRow, sequence: number): TradeActivity {
  return {
    id: `tiger-activity-${row.tradeDate}-${sequence}-${row.symbol}-${row.side}`,
    broker: TIGER_BROKER,
    date: row.tradeDate,
    time: row.time || undefined,
    sequence,
    market: row.market,
    currency: row.currency,
    symbol: row.symbol,
    securityName: row.securityName,
    side: row.side,
    quantity: row.quantity,
    unitPrice: row.unitPrice,
    grossAmount: row.amount,
    fee: row.fee,
    amount: row.amount,
    source: `${row.source}#p${row.page}`,
    note: `${row.product === "fund" ? "基金" : "股票"} ${row.rawSide}；券商活动报表逐笔交易`,
    excludedFromTaxReplay: true,
  };
}

function realizedTradeFromRow(row: TigerTradeRow, sequence: number): RealizedTrade | null {
  if (row.side !== "sell") return null;
  return {
    id: `tiger-reported-${row.tradeDate}-${sequence}-${row.symbol}`,
    broker: TIGER_BROKER,
    sellDate: row.tradeDate,
    market: row.market,
    currency: row.currency,
    symbol: row.symbol,
    securityName: row.securityName,
    quantity: row.quantity,
    proceeds: row.amount,
    costBasis: row.amount - row.realizedPnl,
    gainLoss: row.realizedPnl,
    source: `${row.source}#p${row.page}`,
    note: "使用老虎活动报表“已实现的损益”列",
    useBrokerReportedGainLoss: true,
  };
}

function parseDividendLine(fileName: string, lines: TextLine[], index: number, sequence: number): DividendIncome | null {
  const line = lines[index];
  const date = firstDateInLine(line);
  if (!DATE_RE.test(date)) return null;
  const currency = parseCurrency(lineCell(line, 1120, 1195));
  if (!currency) return null;

  const grossAmount = parseNumber(lineCell(line, 760, 860));
  const taxWithheld = Math.abs(parseNumber(lineCell(line, 920, 1035)));
  if (!grossAmount && !taxWithheld) return null;

  const nextNameLine = findNearbyLine(lines, index, 1, (candidate) => Boolean(symbolFromLine(candidate) || nameFromLine(candidate, 360)));
  const prevNameLine = findNearbyLine(lines, index, -1, (candidate) => Boolean(symbolFromLine(candidate) || nameFromLine(candidate, 360)));
  const symbol = symbolFromLine(line) || symbolFromLine(nextNameLine) || symbolFromLine(prevNameLine) || "UNKNOWN";
  const securityName = nameFromLine(prevNameLine, 360) || nameFromLine(nextNameLine, 360) || symbol;

  return {
    id: `tiger-dividend-${date}-${sequence}-${symbol}`,
    broker: TIGER_BROKER,
    date,
    currency,
    symbol,
    securityName,
    grossAmount,
    taxWithheld,
    fee: 0,
    source: `${fileName}#p${line.page}`,
    note: "老虎活动报表股息明细",
  };
}

function parseActivityReport(fileName: string, lines: TextLine[]) {
  const text = lines.map((line) => canonicalText(line.text)).join("\n");
  if (!text.includes("活动报表") || !text.includes("交易明细")) return null;

  const trades: TigerTradeRow[] = [];
  const dividends: DividendIncome[] = [];
  let activeTable: "none" | "trade" | "dividend" = "none";
  let activeProduct: "none" | "fund" | "stock" = "none";
  let dividendSequence = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineText = canonicalText(line.text);
    if (lineText.includes("交易明细")) {
      activeTable = "trade";
      activeProduct = "none";
      continue;
    }
    if (lineText.includes("入金与出金") || lineText.includes("期末持仓") || lineText === "利息" || lineText === "应计利息") {
      activeTable = "none";
      activeProduct = "none";
    }
    if (lineText.includes("股息")) {
      activeTable = "dividend";
      activeProduct = "none";
      continue;
    }
    if (lineText.includes("补贴与奖励") || lineText.includes("Segment转账") || lineText.includes("金融产品信息")) {
      activeTable = "none";
      activeProduct = "none";
      continue;
    }
    if (activeTable === "trade" && lineText === "基金") {
      activeProduct = "fund";
      continue;
    }
    if (activeTable === "trade" && lineText === "股票") {
      activeProduct = "stock";
      continue;
    }
    if (activeTable === "trade" && activeProduct === "fund") {
      const trade = parseFundTradeLine(fileName, lines, index);
      if (trade) trades.push(trade);
      continue;
    }
    if (activeTable === "trade" && activeProduct === "stock") {
      const trade = parseStockTradeLine(fileName, lines, index);
      if (trade) trades.push(trade);
      continue;
    }
    if (activeTable === "dividend") {
      const dividend = parseDividendLine(fileName, lines, index, dividendSequence);
      if (dividend) {
        dividends.push(dividend);
        dividendSequence += 1;
      }
    }
  }

  return { trades, dividends };
}

function aggregateIssue(fileName: string, trades: TigerTradeRow[], dividends: DividendIncome[]): ReviewIssue {
  const productSummary = new Map<string, { buys: number; sells: number; realizedPnl: number }>();
  for (const trade of trades) {
    const key = `${trade.currency} ${trade.market} ${trade.product === "fund" ? "基金" : "股票"}`;
    const existing = productSummary.get(key) ?? { buys: 0, sells: 0, realizedPnl: 0 };
    if (trade.side === "buy") existing.buys += 1;
    if (trade.side === "sell") existing.sells += 1;
    existing.realizedPnl += trade.realizedPnl;
    productSummary.set(key, existing);
  }
  const summaryText = Array.from(productSummary.entries())
    .map(([key, item]) => `${key}: 买入 ${item.buys} 笔，卖出 ${item.sells} 笔，已实现盈亏 ${item.realizedPnl.toFixed(2)}`)
    .join("；");
  const dividendTax = dividends.reduce((sum, dividend) => sum + dividend.taxWithheld, 0);
  return {
    id: `tiger-activity-${fileName}-parsed`,
    severity: "info",
    title: "已解析老虎交易明细",
    detail: `已按币种、市场、产品和买卖方向读取逐笔交易${summaryText ? `：${summaryText}` : ""}。股息 ${dividends.length} 笔，预扣税合计 ${dividendTax.toFixed(2)}。`,
    source: fileName,
  };
}

export async function parseTigerPdfs(files: TigerFileInput[]): Promise<ParsedInput> {
  const parsed = emptyParsedInput();

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      const taxSummary = parseTaxFormSummary(file.name, lines);
      const activity = parseActivityReport(file.name, lines);

      if (taxSummary) {
        parsed.taxStatementSummaries.push(taxSummary);
        parsed.issues.push(taxSummaryIssue(taxSummary));
      }

      if (activity) {
        activity.trades.forEach((trade, index) => {
          parsed.tradeActivities.push(tradeActivityFromRow(trade, index));
          const realizedTrade = realizedTradeFromRow(trade, index);
          if (realizedTrade) parsed.realizedTrades.push(realizedTrade);
        });
        parsed.dividends.push(...activity.dividends);
        parsed.issues.push(aggregateIssue(file.name, activity.trades, activity.dividends));
      }

      if (!taxSummary && !activity) {
        parsed.issues.push({
          id: `tiger-${file.name}-unsupported`,
          severity: "blocking",
          title: "老虎文件格式不符合要求",
          detail: "当前仅支持 Tiger Brokers (NZ) 的 Tax Form Record 税表汇总或中文活动报表 PDF。",
          source: file.name,
        });
      }
    } catch (error) {
      parsed.issues.push({
        id: `tiger-${file.name}-pdf-error`,
        severity: "blocking",
        title: "老虎PDF解析失败",
        detail: error instanceof Error ? error.message : "未知PDF解析错误。",
        source: file.name,
      });
    }
  }

  return parsed;
}
