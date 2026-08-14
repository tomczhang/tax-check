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
  TaxStatementSummary,
  TradeActivity,
} from "@/lib/tax/types";

interface CmbWingLungFileInput {
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

interface CurrencyIncomeRow {
  sourcePdf: string;
  page: number;
  rawCurrency: string;
  currency?: Currency;
  balance: number;
  dividends: number;
  interest: number;
  grossProceeds: number;
  text: string;
}

interface MonthlyTradeRecord {
  sourcePdf: string;
  page: number;
  tradeDate: string;
  settleDate: string;
  ref: string;
  side: "buy" | "sell";
  rawSide: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  fee: number;
  sequence: number;
  text: string;
}

interface MonthlyDividendRecord {
  sourcePdf: string;
  page: number;
  date: string;
  settleDate: string;
  ref: string;
  currency: Currency;
  symbol: string;
  grossAmount: number;
  text: string;
}

interface MonthlyPositionRecord {
  sourcePdf: string;
  page: number;
  statementDate: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  unitPrice: number;
  marketValue: number;
  text: string;
}

interface MonthlyRawData {
  trades: MonthlyTradeRecord[];
  dividends: MonthlyDividendRecord[];
  positions: MonthlyPositionRecord[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

interface PositionState {
  market: string;
  currency: Currency;
  name: string;
  quantity: number;
  costBasis: number;
}

interface MissingCostSale {
  date: string;
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

export interface ManualCostInput {
  id: string;
  costBasis: number;
}

const CMB_WING_LUNG_BROKER = "招商永隆";

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function canonicalText(value: string) {
  return value
    .normalize("NFKC")
    .replaceAll("報", "报")
    .replaceAll("客戶", "客户")
    .replaceAll("貨幣", "货币")
    .replaceAll("結餘", "结余")
    .replaceAll("賬戶", "账户")
    .replaceAll("號碼", "号码")
    .replaceAll("證券", "证券")
    .replaceAll("銀行", "银行")
    .replaceAll("單", "单")
    .replaceAll("買", "买")
    .replaceAll("賣", "卖")
    .replaceAll("臺", "台")
    .replaceAll("亞", "亚")
    .replaceAll("–", "-")
    .replaceAll("—", "-")
    .replaceAll("−", "-");
}

function parseNumber(value: string) {
  const parsed = Number(value.replace(/,/g, "").replace(/[()]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCurrency(value: string): Currency | undefined {
  const text = value.toUpperCase();
  if (text === "USD" || text === "HKD" || text === "CNY") return text;
  return undefined;
}

function isSupportedCurrency(value: string): value is Currency {
  return value === "USD" || value === "HKD" || value === "CNY";
}

function moneyText(value: number, currency?: string) {
  return `${currency ? `${currency} ` : ""}${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function normalizeDate(year: string, month: string, day: string) {
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function parseReportingPeriod(lines: TextLine[]) {
  const text = canonicalText(lines.slice(0, 20).map((line) => line.text).join("\n"));
  const chinese = text.match(
    /报告期间[:：]\s*(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日\s*至\s*(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/,
  );
  if (chinese) {
    return {
      periodStart: normalizeDate(chinese[1], chinese[2], chinese[3]),
      periodEnd: normalizeDate(chinese[4], chinese[5], chinese[6]),
    };
  }

  const english = text.match(/Reporting Period:\s*(\d{1,2})\s+([A-Za-z]{3})\s+(20\d{2})\s*-\s*(\d{1,2})\s+([A-Za-z]{3})\s+(20\d{2})/i);
  if (!english) return {};

  const monthMap: Record<string, string> = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    may: "05",
    jun: "06",
    jul: "07",
    aug: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  const startMonth = monthMap[english[2].toLowerCase()];
  const endMonth = monthMap[english[5].toLowerCase()];
  if (!startMonth || !endMonth) return {};
  return {
    periodStart: normalizeDate(english[3], startMonth, english[1]),
    periodEnd: normalizeDate(english[6], endMonth, english[4]),
  };
}

function parseStatementDate(lines: TextLine[]) {
  const text = lines.slice(0, 30).map((line) => canonicalText(line.text)).join("\n");
  const match = text.match(/结单日期\s*:\s*(\d{1,2})\/(\d{1,2})\/(20\d{2})/);
  return match ? normalizeDate(match[3], match[2], match[1]) : undefined;
}

function normalizeSlashDate(value: string) {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return value;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return normalizeDate(year, match[2], match[1]);
}

function normalizeSymbol(value: string) {
  const text = canonicalText(value).replace(/[()（）]/g, "").trim().toUpperCase();
  if (/^\d{3,5}$/.test(text)) return text.padStart(5, "0");
  return text;
}

function marketFromText(value: string, currency: Currency) {
  const text = canonicalText(value).toUpperCase();
  if (text.includes("美国") || text.includes("US")) return "美国市场";
  if (text.includes("香港") || text.includes("HK")) return "香港市场";
  return currency === "USD" ? "美国市场" : "香港市场";
}

function stateAvgCost(state: PositionState) {
  return state.quantity === 0 ? 0 : state.costBasis / state.quantity;
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

function isCmbWingLungAnnualIncomeReport(lines: TextLine[]) {
  const text = canonicalText(lines.slice(0, 30).map((line) => line.text).join("\n")).toLowerCase();
  return (
    (text.includes("全年收入报告") && text.includes("annual income report")) ||
    text.includes("annual income report")
  );
}

function isCmbWingLungMonthlyStatement(lines: TextLine[]) {
  const text = canonicalText(lines.slice(0, 60).map((line) => line.text).join("\n"));
  return text.includes("证券账户月结单") && text.includes("证券账户号码");
}

function isCmbWingLungWealthMgmtStatement(lines: TextLine[]) {
  // 用 NFKC + 全字符替换做一次"完全简化的版本"用于检测
  // 注意：CMB WING LUNG BANK 这种字样可能出现在 page 2 重要事项中，要扫描整份文件
  const text = lines
    .map((line) => line.text)
    .join("\n")
    .normalize("NFKC")
    .replace(/[一-鿿]/g, (ch) => {
      const TRAD_TO_SIMP: Record<string, string> = {
        報: "报", 客: "客", 戶: "户", 貨: "货", 幣: "币",
        結: "结", 餘: "余", 賬: "账", 號: "号",
        碼: "码", 證: "证", 銀: "银", 行: "行", 單: "单",
        買: "买", 賣: "卖", 臺: "台", 亞: "亚",
        財: "财", 帳: "账", 綜: "综", 合: "合", 月: "月",
        理: "理",
      };
      return TRAD_TO_SIMP[ch] ?? ch;
    });
  return (
    text.includes("理财账户") &&
    (text.includes("综合月结单") || text.includes("综合月結單")) &&
    text.includes("CMB WING LUNG") &&
    text.includes("STATEMENT DATE")
  );
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
            text: canonicalText(candidate.str),
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

function parseCurrencyIncomeRows(fileName: string, lines: TextLine[]): CurrencyIncomeRow[] {
  const accountHeaderIndex = lines.findIndex((line) => canonicalText(line.text).includes("账户类型") && line.text.includes("Account Type"));
  const summaryLines = accountHeaderIndex >= 0 ? lines.slice(0, accountHeaderIndex) : lines;
  return summaryLines.flatMap((line) => {
    const match = canonicalText(line.text).match(/^([A-Z]{3})\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+([+-]?\d[\d,]*(?:\.\d+)?)$/);
    if (!match) return [];
    return [
      {
        sourcePdf: fileName,
        page: line.page,
        rawCurrency: match[1],
        currency: parseCurrency(match[1]),
        balance: parseNumber(match[2]),
        dividends: parseNumber(match[3]),
        interest: parseNumber(match[4]),
        grossProceeds: parseNumber(match[5]),
        text: line.text,
      },
    ];
  });
}

function splitSecurity(value: string) {
  const text = clean(canonicalText(value));
  const [rawSymbol = "", ...nameParts] = text.split(" ");
  const symbol = normalizeSymbol(rawSymbol);
  return {
    symbol,
    securityName: clean(nameParts.join(" ")) || symbol,
  };
}

function parseMonthlyTradeLine(fileName: string, line: TextLine, sequence: number): MonthlyTradeRecord | null {
  const text = canonicalText(line.text);
  const match = text.match(
    /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\S+)\s+(买入|卖出|沽出)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+股\s+(.+?)\s+价格\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+([A-Z]{3})\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+(DR|CR)\s*(.*)$/,
  );
  if (!match) return null;
  const currency = parseCurrency(match[8]);
  if (!currency) return null;
  const side = match[4] === "买入" ? "buy" : "sell";
  const quantity = parseNumber(match[5]);
  const unitPrice = parseNumber(match[7]);
  const amount = parseNumber(match[9]);
  const grossAmount = quantity * unitPrice;
  const fee = Math.abs(grossAmount - amount);
  const security = splitSecurity(match[6]);
  return {
    sourcePdf: fileName,
    page: line.page,
    tradeDate: normalizeSlashDate(match[1]),
    settleDate: normalizeSlashDate(match[2]),
    ref: match[3],
    side,
    rawSide: match[4],
    market: marketFromText(match[11], currency),
    currency,
    symbol: security.symbol,
    securityName: security.securityName,
    quantity,
    unitPrice,
    amount,
    fee,
    sequence,
    text: line.text,
  };
}

function parseMonthlyDividendLine(fileName: string, line: TextLine): MonthlyDividendRecord | null {
  const text = canonicalText(line.text);
  const match = text.match(
    /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\S+)\s+([A-Z0-9.]+)\s+股息每股\s*[A-Z]{3}[+-]?\d[\d,]*(?:\.\d+)?\s+([A-Z]{3})\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+CR/,
  );
  if (!match) return null;
  const currency = parseCurrency(match[5]);
  if (!currency) return null;
  return {
    sourcePdf: fileName,
    page: line.page,
    date: normalizeSlashDate(match[1]),
    settleDate: normalizeSlashDate(match[2]),
    ref: match[3],
    currency,
    symbol: normalizeSymbol(match[4]),
    grossAmount: parseNumber(match[6]),
    text: line.text,
  };
}

function parseMonthlyPositionLine(fileName: string, line: TextLine, statementDate: string | undefined, market: string): MonthlyPositionRecord | null {
  if (!statementDate) return null;
  const text = canonicalText(line.text);
  const match = text.match(
    /^([A-Z0-9.]+)\s+(.+?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+(HKD|USD|CNY)\s+([+-]?\d[\d,]*(?:\.\d+)?)\s+([+-]?\d[\d,]*(?:\.\d+)?)(?:\s|$)/,
  );
  if (!match) return null;
  if (!isSupportedCurrency(match[5])) return null;
  return {
    sourcePdf: fileName,
    page: line.page,
    statementDate,
    market,
    currency: match[5],
    symbol: normalizeSymbol(match[1]),
    securityName: clean(match[2]),
    quantity: parseNumber(match[3]),
    unitPrice: parseNumber(match[6]),
    marketValue: parseNumber(match[7]),
    text: line.text,
  };
}

// ─── 理财账户综合月结单解析 ─────────────────────────────────────────────────

interface WealthMgmtTradeRecord {
  sourcePdf: string;
  page: number;
  tradeDate: string;
  ref: string;
  fundNameEn: string;
  currency: Currency;
  type: string; // SUB/RDM/DIV/SW/S/SW/R/TR/I/TR/O
  quantity: number;
  unitPrice: number;
  settlementAmount: number;
  text: string;
}

function parseWealthMgmtTradeLine(fileName: string, line: TextLine): WealthMgmtTradeRecord | null {
  const text = canonicalText(line.text);
  // 格式: TRAN DATE REF NO. FUND NAME TYPE NO. OF UNITS UNIT PRICE SETTLEMENT AMT(#)
  // 示例: 20240304 SS00272919 E FUND (HK) US DOLLAR MONEY MARK SUB 53.3674 USD 112.4280 USD 6,000.00
  // SW/S 和 SW/R 里的 / 需要用 RegExp 构造避免被当作字符类结束符
  const tradeRx = new RegExp(
    String.raw`^(\d{8})\s+(\S+)\s+(.+?)\s+(SUB|RDM|DIV|SW/S|SW/R|TR/I|TR/O|BUY|SELL)\s+([\d,]+\.?\d*)\s+([A-Z]{3})\s+([\d,]+\.?\d*)\s+([A-Z]{3})\s+([\d,]+\.?\d*)$`,
  );
  const match = text.match(tradeRx);
  if (!match) return null;
  const currency = parseCurrency(match[6]);
  if (!currency) return null;
  return {
    sourcePdf: fileName,
    page: line.page,
    tradeDate: `${match[1].slice(0, 4)}-${match[1].slice(4, 6)}-${match[1].slice(6, 8)}`,
    ref: match[2],
    fundNameEn: match[3].trim(),
    currency,
    type: match[4],
    quantity: parseNumber(match[5]),
    unitPrice: parseNumber(match[7]),
    settlementAmount: parseNumber(match[9]),
    text: line.text,
  };
}

function parseMonthlyStatement(fileName: string, lines: TextLine[]): MonthlyRawData {
  const statementDate = parseStatementDate(lines);
  const raw: MonthlyRawData = {
    trades: [],
    dividends: [],
    positions: [],
    issues: [],
    statementDetected: isCmbWingLungMonthlyStatement(lines),
  };
  let currentMarket = "";
  let sequence = 0;

  for (const line of lines) {
    const text = canonicalText(line.text);
    const marketMatch = text.match(/^市场\s*:\s*(香港|美国)/);
    if (marketMatch) {
      currentMarket = marketFromText(marketMatch[1], marketMatch[1] === "美国" ? "USD" : "HKD");
      continue;
    }

    const trade = parseMonthlyTradeLine(fileName, line, sequence);
    if (trade) {
      raw.trades.push(trade);
      sequence += 1;
      continue;
    }

    const dividend = parseMonthlyDividendLine(fileName, line);
    if (dividend) {
      raw.dividends.push(dividend);
      continue;
    }

    if (currentMarket) {
      const position = parseMonthlyPositionLine(fileName, line, statementDate, currentMarket);
      if (position && position.quantity > 0) {
        raw.positions.push(position);
      }
    }
  }

  if (!statementDate && raw.statementDetected) {
    raw.issues.push({
      id: `cmb-wing-lung-${fileName}-missing-statement-date`,
      severity: "warning",
      title: "未识别月结单日期",
      detail: "已识别为招商永隆证券账户月结单，但没有读取到结单日期；持仓记录会缺少月份归属。",
      source: fileName,
    });
  }

  return raw;
}

function wealthMgmtActivityFromTrade(trade: WealthMgmtTradeRecord): TradeActivity {
  const type = trade.type;
  // SUB/TR/I/SW/R/BUY = buy；RDM/TR/O/SW/S/SELL = sell；DIV 不产生交易
  const isBuy = ["SUB", "TR/I", "SW/R", "BUY"].includes(type);
  const isSell = ["RDM", "TR/O", "SW/S", "SELL"].includes(type);
  if (!isBuy && !isSell) return null!; // DIV 不作为交易
  return {
    id: `cmb-wing-lung-wm-trade-${trade.tradeDate}-${trade.ref}-${trade.fundNameEn.replace(/\s+/g, "-")}-${isBuy ? "buy" : "sell"}`,
    broker: CMB_WING_LUNG_BROKER,
    date: trade.tradeDate,
    sequence: 0,
    market: "香港市场",
    currency: trade.currency,
    symbol: `CMBWM${djb2Hash(trade.fundNameEn)}`,
    securityName: trade.fundNameEn,
    side: isBuy ? "buy" : "sell",
    quantity: trade.quantity,
    unitPrice: trade.unitPrice,
    grossAmount: trade.quantity * trade.unitPrice,
    fee: Math.abs(trade.quantity * trade.unitPrice - trade.settlementAmount),
    amount: trade.settlementAmount,
    source: trade.sourcePdf,
    note: `${trade.ref} ${trade.type}；招商永隆理财账户综合月结单`,
  };
}

function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(hash).toString(36).toUpperCase().slice(0, 8);
}


function parseWealthMgmtStatement(fileName: string, lines: TextLine[]): {
  trades: WealthMgmtTradeRecord[];
  issues: ReviewIssue[];
} {
  // 提取结单日期: STATEMENT DATE 20240328
  const text = canonicalText(lines.slice(0, 30).map((l) => l.text).join("\n"));
  const dateMatch = text.match(/STATEMENT DATE\s+(\d{4})(\d{2})(\d{2})/);
  const statementDate = dateMatch ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` : undefined;

  const trades: WealthMgmtTradeRecord[] = [];
  const issues: ReviewIssue[] = [];

  // 交易区域: 找交易日 + 参考号 表头行（unique，不与父节标题冲突）
  const txStart = lines.findIndex((l) => {
    const t = canonicalText(l.text);
    return (t.includes("交易日") && t.includes("參考號碼")) ||
           (t.includes("交易日") && t.includes("參考号码"));
  });
  // 持仓区域: 找"持有单位"或"持有單位"HOLDINGS表头行（unique，不与父节冲突）
  const holdingsStart = lines.findIndex((l) => {
    const t = canonicalText(l.text);
    return (t.includes("持有单位") || t.includes("持有單位")) && t.includes("HOLDINGS");
  });



  if (txStart >= 0) {
    const txEnd = holdingsStart >= 0 ? holdingsStart : lines.length;
    for (let i = txStart; i < txEnd; i++) {
      const trade = parseWealthMgmtTradeLine(fileName, lines[i]);
      if (trade) trades.push(trade);
    }
  }

  if (!statementDate) {
    issues.push({
      id: `cmb-wing-lung-wm-${fileName}-missing-date`,
      severity: "warning",
      title: "未识别理财账户月结单日期",
      detail: "已识别为招商永隆理财账户综合月结单，但没有读取到结单日期。",
      source: fileName,
    });
  }

  return { trades, issues };
}

function monthlyActivityFromTrade(trade: MonthlyTradeRecord): TradeActivity {
  return {
    id: `cmb-wing-lung-activity-${trade.tradeDate}-${trade.ref}-${trade.symbol}-${trade.side}`,
    broker: CMB_WING_LUNG_BROKER,
    date: trade.tradeDate,
    sequence: trade.sequence,
    market: trade.market,
    currency: trade.currency,
    symbol: trade.symbol,
    securityName: trade.securityName,
    side: trade.side,
    quantity: trade.quantity,
    unitPrice: trade.unitPrice,
    grossAmount: trade.quantity * trade.unitPrice,
    fee: trade.fee,
    amount: trade.amount,
    source: trade.sourcePdf,
    note: `${trade.ref} ${trade.rawSide}；招商永隆证券账户月结单`,
  };
}

function monthlyDividendIncome(dividend: MonthlyDividendRecord): DividendIncome {
  return {
    id: `cmb-wing-lung-dividend-${dividend.date}-${dividend.ref}-${dividend.symbol}`,
    broker: CMB_WING_LUNG_BROKER,
    date: dividend.date,
    currency: dividend.currency,
    symbol: dividend.symbol,
    securityName: dividend.symbol,
    grossAmount: dividend.grossAmount,
    taxWithheld: 0,
    fee: 0,
    source: dividend.sourcePdf,
    note: "招商永隆月结单股息入账金额；如需精确税前金额和预扣税，请以年度收入报告或扣税明细复核。",
    evidence: {
      page: dividend.page,
      text: dividend.text,
    },
  };
}

function monthlyOpenPosition(position: MonthlyPositionRecord): OpenPosition {
  return {
    id: `cmb-wing-lung-open-${position.statementDate}-${position.currency}-${position.symbol}`,
    broker: CMB_WING_LUNG_BROKER,
    asOf: position.statementDate,
    market: position.market,
    currency: position.currency,
    symbol: position.symbol,
    securityName: position.securityName,
    quantity: position.quantity,
    marketValue: position.marketValue,
    source: position.sourcePdf,
    note: "招商永隆证券账户月结单月末持仓；未实现盈亏不计入资本利得。",
  };
}

function buildMonthlyMissingCostData(
  trades: MonthlyTradeRecord[],
  targetYear: number | undefined,
  manualCosts: ManualCostInput[] = [],
): { trades: RealizedTrade[]; issues: ReviewIssue[]; costBasisRequests: CostBasisRequest[] } {
  const states = new Map<string, PositionState>();
  const missingCost = new Map<string, MissingCostAggregate>();
  const realizedTrades: RealizedTrade[] = [];
  const issues: ReviewIssue[] = [];
  const manualCostsById = manualCostMap(manualCosts);

  const orderedTrades = [...trades].sort((a, b) => a.tradeDate.localeCompare(b.tradeDate) || a.sequence - b.sequence);
  for (const trade of orderedTrades) {
    const key = `${trade.currency}::${trade.symbol}`;
    const state =
      states.get(key) ??
      ({
        market: trade.market,
        currency: trade.currency,
        name: trade.securityName,
        quantity: 0,
        costBasis: 0,
      } satisfies PositionState);
    state.market = trade.market || state.market;
    state.currency = trade.currency || state.currency;
    state.name = trade.securityName || state.name;

    if (trade.side === "buy") {
      state.quantity += trade.quantity;
      state.costBasis += trade.amount;
    } else if (trade.side === "sell") {
      if (state.quantity + 1e-7 < trade.quantity) {
        if (targetYear === undefined || trade.tradeDate.startsWith(String(targetYear))) {
          const missingKey = `${key}::${trade.tradeDate}::${trade.sourcePdf}::${trade.sequence}`;
          const requestId = `cmb-wing-lung-cost-${targetYear ?? "unknown"}-${trade.currency}-${trade.symbol}-${trade.tradeDate}-${trade.sourcePdf}-${trade.sequence}`;
          missingCost.set(missingKey, {
            id: requestId,
            broker: CMB_WING_LUNG_BROKER,
            sellDate: trade.tradeDate,
            market: trade.market,
            currency: trade.currency,
            symbol: trade.symbol,
            securityName: trade.securityName,
            quantity: trade.quantity,
            proceeds: trade.amount,
            trackedQuantity: state.quantity,
            source: trade.sourcePdf,
            note: "手动补录这笔成本后计入资本利得",
            sales: [
              {
                date: trade.tradeDate,
                sequence: trade.sequence,
                market: trade.market,
                currency: trade.currency,
                symbol: trade.symbol,
                securityName: trade.securityName,
                quantity: trade.quantity,
                proceeds: trade.amount,
                source: trade.sourcePdf,
                note: trade.ref,
              },
            ],
          });
        }
        state.quantity = 0;
        state.costBasis = 0;
        states.set(key, state);
        continue;
      }

      const costBasis = trade.quantity * stateAvgCost(state);
      if (targetYear === undefined || trade.tradeDate.startsWith(String(targetYear))) {
        realizedTrades.push({
          id: `cmb-wing-lung-${trade.tradeDate}-${trade.sequence}-${trade.symbol}-${trade.ref}`,
          broker: CMB_WING_LUNG_BROKER,
          sellDate: trade.tradeDate,
          market: trade.market,
          currency: trade.currency,
          symbol: trade.symbol,
          securityName: trade.securityName,
          quantity: trade.quantity,
          proceeds: trade.amount,
          costBasis,
          gainLoss: trade.amount - costBasis,
          source: trade.sourcePdf,
          note: trade.ref,
        });
      }

      state.quantity -= trade.quantity;
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
      sequence: item.sales[0]?.sequence,
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
      detail: `${item.sellDate} 卖出 ${item.quantity} 股，但上传的招商永隆月结单中最多只追踪到 ${item.trackedQuantity} 股成本。请补充更早月份月结单，或在盈亏明细的待补成本中手动填写这笔成本。`,
      source: item.source,
    });
  }

  return { trades: realizedTrades, issues, costBasisRequests };
}

function monthlyAggregateIssue(raw: MonthlyRawData): ReviewIssue {
  const buyCount = raw.trades.filter((trade) => trade.side === "buy").length;
  const sellRows = raw.trades.filter((trade) => trade.side === "sell");
  const sellCount = sellRows.length;
  const proceedsByCurrency = new Map<Currency, number>();
  for (const trade of sellRows) {
    proceedsByCurrency.set(trade.currency, (proceedsByCurrency.get(trade.currency) ?? 0) + trade.amount);
  }
  const proceedsText = Array.from(proceedsByCurrency.entries())
    .map(([currency, amount]) => moneyText(amount, currency))
    .join("、");
  const sources = Array.from(
    new Set([
      ...raw.trades.map((trade) => trade.sourcePdf),
      ...raw.dividends.map((dividend) => dividend.sourcePdf),
      ...raw.positions.map((position) => position.sourcePdf),
    ]),
  );
  return {
    id: `cmb-wing-lung-monthly-${sources.join("-")}-parsed`,
    severity: "info",
    title: "已解析招商永隆证券月结单",
    detail: `已读取 ${sources.length} 份月结单：买入 ${buyCount} 笔，卖出 ${sellCount} 笔${proceedsText ? `，卖出收入 ${proceedsText}` : ""}，股息 ${raw.dividends.length} 笔，月末持仓 ${raw.positions.length} 条。多个月结单会按成交日顺序重放成本来计算真实已实现盈亏。`,
    source: sources[0],
  };
}

function latestMonthlyPositions(positions: MonthlyPositionRecord[]) {
  const latest = new Map<string, MonthlyPositionRecord>();
  for (const position of positions) {
    const key = `${position.currency}::${position.symbol}`;
    const existing = latest.get(key);
    if (!existing || position.statementDate.localeCompare(existing.statementDate) >= 0) {
      latest.set(key, position);
    }
  }
  return Array.from(latest.values()).sort((a, b) => a.currency.localeCompare(b.currency) || a.symbol.localeCompare(b.symbol));
}

function incomeRecord(row: CurrencyIncomeRow, kind: "dividend" | "interest", date: string, sequence: number): DividendIncome {
  const isDividend = kind === "dividend";
  const amount = isDividend ? row.dividends : row.interest;
  return {
    id: `cmb-wing-lung-${kind}-${date}-${row.currency}-${sequence}`,
    broker: CMB_WING_LUNG_BROKER,
    date,
    currency: row.currency!,
    symbol: isDividend ? "DIVIDEND-SUMMARY" : "INTEREST-SUMMARY",
    securityName: isDividend ? "招商永隆年度股息汇总" : "招商永隆年度利息汇总",
    grossAmount: amount,
    taxWithheld: 0,
    fee: 0,
    source: row.sourcePdf,
    note: `招商永隆全年收入报告按 ${row.rawCurrency} 币种汇总的${isDividend ? "股息" : "利息"}。`,
    evidence: {
      page: row.page,
      text: row.text,
    },
  };
}

function taxStatementSummary(row: CurrencyIncomeRow, period: ReturnType<typeof parseReportingPeriod>, sequence: number): TaxStatementSummary {
  return {
    id: `cmb-wing-lung-summary-${period.periodEnd ?? "unknown"}-${row.currency}-${sequence}`,
    broker: CMB_WING_LUNG_BROKER,
    source: row.sourcePdf,
    currency: row.currency!,
    ...period,
    grossProceeds: row.grossProceeds,
    realizedGainLoss: 0,
    cashDividends: 0,
    dividendTaxWithheld: 0,
    interest: 0,
  };
}

function aggregateIssue(fileName: string, supportedRows: CurrencyIncomeRow[], period: ReturnType<typeof parseReportingPeriod>): ReviewIssue {
  const grossProceedsRows = supportedRows.filter((row) => row.grossProceeds > 0);
  const periodText = period.periodStart && period.periodEnd ? `，期间 ${period.periodStart} 至 ${period.periodEnd}` : "";
  const rowText = supportedRows
    .map(
      (row) =>
        `${row.rawCurrency}: 股息 ${moneyText(row.dividends)}，利息 ${moneyText(row.interest)}，全年收入 ${moneyText(row.grossProceeds)}`,
    )
    .join("；");
  const proceedsText =
    grossProceedsRows.length > 0
      ? `报告另列全年收入 ${grossProceedsRows.map((row) => moneyText(row.grossProceeds, row.rawCurrency)).join("、")}，该金额是卖出/赎回等收入，不含成本或已实现盈亏，系统仅用于提示核对，未直接计入财产转让所得。`
      : "报告未列出正数全年收入。";

  return {
    id: `cmb-wing-lung-${fileName}-income-summary`,
    severity: grossProceedsRows.length > 0 ? "warning" : "info",
    title: "已读取招商永隆全年收入报告",
    detail: `已读取 ${fileName}${periodText} 的按币种汇总：${rowText}。股息和利息已计入利息、股息、红利所得。${proceedsText}`,
    source: fileName,
  };
}

function unsupportedCurrencyIssues(fileName: string, rows: CurrencyIncomeRow[]): ReviewIssue[] {
  return rows
    .filter((row) => !row.currency && (row.dividends > 0 || row.interest > 0 || row.grossProceeds > 0))
    .map((row) => ({
      id: `cmb-wing-lung-${fileName}-${row.rawCurrency}-unsupported-currency`,
      severity: "warning" as const,
      title: "招商永隆报告包含未支持币种",
      detail: `${row.rawCurrency} 有非零收入：股息 ${moneyText(row.dividends, row.rawCurrency)}，利息 ${moneyText(row.interest, row.rawCurrency)}，全年收入 ${moneyText(row.grossProceeds, row.rawCurrency)}。当前汇率表只支持 HKD、USD、CNY，请手动核对这部分金额。`,
      source: fileName,
    }));
}

export async function parseCmbWingLungPdfs(
  files: CmbWingLungFileInput[],
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const monthlyRaw: MonthlyRawData = {
    trades: [],
    dividends: [],
    positions: [],
    issues: [],
    statementDetected: false,
  };
  const annualSummaries: TaxStatementSummary[] = [];
  const annualDividends: DividendIncome[] = [];
  const annualIssues: ReviewIssue[] = [];

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      if (isCmbWingLungMonthlyStatement(lines)) {
        const monthly = parseMonthlyStatement(file.name, lines);
        monthlyRaw.trades.push(...monthly.trades);
        monthlyRaw.dividends.push(...monthly.dividends);
        monthlyRaw.positions.push(...monthly.positions);
        monthlyRaw.issues.push(...monthly.issues);
        monthlyRaw.statementDetected = monthlyRaw.statementDetected || monthly.statementDetected;
        continue;
      }

      if (isCmbWingLungWealthMgmtStatement(lines)) {
        const wm = parseWealthMgmtStatement(file.name, lines);
        // 交易 → tradeActivities
        for (const trade of wm.trades) {
          const activity = wealthMgmtActivityFromTrade(trade);
          if (activity) parsed.tradeActivities.push(activity);
        }
        parsed.issues.push(...wm.issues);
        if (wm.trades.length > 0) {
          const buyCount = wm.trades.filter((t) => ["SUB", "TR/I", "SW/R", "BUY"].includes(t.type)).length;
          const sellCount = wm.trades.filter((t) => ["RDM", "TR/O", "SW/S", "SELL"].includes(t.type)).length;
          parsed.issues.push({
            id: `cmb-wing-lung-wm-${file.name}-parsed`,
            severity: "info",
            title: "已解析招商永隆理财账户综合月结单",
            detail: `已读取 ${file.name}：买入 ${buyCount} 笔，卖出 ${sellCount} 笔。`,
            source: file.name,
          });
        }
        continue;
      }

      if (!isCmbWingLungAnnualIncomeReport(lines)) {
        parsed.issues.push({
          id: `cmb-wing-lung-${file.name}-unsupported`,
          severity: "blocking",
          title: "招商永隆文件格式不符合要求",
          detail: "当前仅支持招商永隆银行 Annual Income Report / 全年收入报告 PDF、证券账户月结单 PDF，或理财账户综合月结单 PDF。",
          source: file.name,
        });
        continue;
      }

      const rows = parseCurrencyIncomeRows(file.name, lines);
      const supportedRows = rows.filter((row) => row.currency);
      const incomeRows = supportedRows.filter((row) => row.dividends > 0 || row.interest > 0 || row.grossProceeds > 0);
      if (rows.length === 0 || incomeRows.length === 0) {
        annualIssues.push({
          id: `cmb-wing-lung-${file.name}-empty`,
          severity: "info",
          title: "招商永隆报告没有可计入收入",
          detail: "已识别为招商永隆全年收入报告，但未读取到 HKD/USD/CNY 的股息、利息或全年收入金额。",
          source: file.name,
        });
        continue;
      }

      const period = parseReportingPeriod(lines);
      const incomeDate = period.periodEnd ?? `${new Date().getFullYear()}-12-31`;
      incomeRows.forEach((row, index) => {
        if (row.dividends > 0) annualDividends.push(incomeRecord(row, "dividend", incomeDate, index));
        if (row.interest > 0) annualDividends.push(incomeRecord(row, "interest", incomeDate, index));
        annualSummaries.push(taxStatementSummary(row, period, index));
      });
      annualIssues.push(aggregateIssue(file.name, incomeRows, period), ...unsupportedCurrencyIssues(file.name, rows));
    } catch (error) {
      parsed.issues.push({
        id: `cmb-wing-lung-${file.name}-pdf-error`,
        severity: "blocking",
        title: "招商永隆PDF解析失败",
        detail: error instanceof Error ? error.message : "未知PDF解析错误。",
        source: file.name,
      });
    }
  }

  const hasMonthlyData =
    monthlyRaw.trades.length > 0 || monthlyRaw.dividends.length > 0 || monthlyRaw.positions.length > 0 || monthlyRaw.statementDetected;
  if (hasMonthlyData) {
    parsed.tradeActivities.push(...monthlyRaw.trades.map(monthlyActivityFromTrade));
    parsed.dividends.push(...monthlyRaw.dividends.map(monthlyDividendIncome));
    parsed.openPositions.push(...latestMonthlyPositions(monthlyRaw.positions).map(monthlyOpenPosition));
    const monthlyRealized = buildMonthlyMissingCostData(monthlyRaw.trades, options.targetYear, options.manualCosts ?? []);
    parsed.realizedTrades.push(...monthlyRealized.trades);
    parsed.costBasisRequests.push(...monthlyRealized.costBasisRequests);
    parsed.issues.push(...monthlyRaw.issues, ...monthlyRealized.issues);
    if (monthlyRaw.trades.length > 0 || monthlyRaw.dividends.length > 0 || monthlyRaw.positions.length > 0) {
      parsed.issues.push(monthlyAggregateIssue(monthlyRaw));
    }
    if (annualSummaries.length > 0) {
      parsed.issues.push({
        id: "cmb-wing-lung-monthly-detail-preferred",
        severity: "info",
        title: "已优先使用招商永隆月结单明细",
        detail: "同时识别到招商永隆全年收入报告和证券月结单。系统会优先用月结单逐笔交易重放成本，全年收入报告仅用于人工核对，不重复计入计算。",
      });
    }
  } else {
    parsed.dividends.push(...annualDividends);
    parsed.taxStatementSummaries.push(...annualSummaries);
    parsed.issues.push(...annualIssues);
  }

  return parsed;
}
