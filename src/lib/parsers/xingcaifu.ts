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

// 星财富（复星国际证券）月结单解析器。
// 现金账户与保证金账户版式一致，差异仅在持仓表多出按贷列、利息总结多出融资利率，
// 两类月结单共用本解析器，账户类型从表头识别后计入来源备注。

interface XingcaifuFileInput {
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

export interface ManualCostInput {
  id: string;
  costBasis: number;
}

interface TradeRecord {
  sourcePdf: string;
  page: number;
  accountNo: string;
  sequence: number;
  ref: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  side: "buy" | "sell";
  quantity: number;
  unitPrice: number;
  cashChange: number;
  fee: number;
  tradeDate: string;
  settleDate: string;
  pendingSettlement: boolean;
}

interface CashFlowRecord {
  sourcePdf: string;
  page: number;
  currency: Currency;
  date: string;
  ref: string;
  description: string;
  amount: number;
}

interface StockMoveEntry {
  sourcePdf: string;
  page: number;
  market: string;
  currency: Currency;
  date: string;
  ref: string;
  quantity: number;
  description: string;
}

interface PositionRecord {
  sourcePdf: string;
  page: number;
  accountNo: string;
  market: string;
  currency: Currency;
  symbol: string;
  securityName: string;
  quantity: number;
  price: number;
  marketValue: number;
}

interface StatementContext {
  accountNo: string;
  accountType: string;
  periodStart: string;
  periodEnd: string;
  detected: boolean;
}

const XINGCAIFU_BROKER = "星财富";

const FEE_LINE_PATTERN =
  /(Commission|Regulation Fee|Transaction Activity Fee|Settlement Fee|Platform Fee|Other Fee|Foreign Fee)/;

const TRADE_ROW_PATTERN =
  /^(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{5,8}-\d{3})\s+([BS])\s+(.*?)\s*(Agent|Principal)(?:\s+([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d+))?\s+(-?[\d,]+\.\d+)$/;

const UNSETTLED_ROW_PATTERN =
  /^(\d{4}\/\d{2}\/\d{2})\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{5,8}-\d{3})\s+([BS])\s+(.*?)\s+([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d+)\s+(-?[\d,]+\.\d+)$/;

const LOT_LINE_PATTERN = /^([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d+)$/;

const MARKET_GROUP_PATTERN = /^([A-Z][A-Z ]*)-(HKD|USD|CNY):$/;

const CASH_GROUP_PATTERN = /^(HKD|USD|CNY):$/;

const CASH_ROW_PATTERN = /^(\d{4}\/\d{2}\/\d{2})\s+(\d+)\s+(.+?)\s+(-?[\d,]+\.\d{2})$/;

// 证券提存条目为单行：日期 编号 摘要 数量，摘要过长时下一行续接
const STOCK_MOVE_ROW_PATTERN = /^(\d{4}\/\d{2}\/\d{2})\s+(\d+)\s+(.+)\s+(-?[\d,]+(?:\.\d+)?)$/;

// 持仓数字行：承上月结余 变更股数 结存股数 待结算/冻结 收市价 持股市值 按贷率 可按贷值
const POSITION_NUMBERS_PATTERN =
  /(?:^|\s)(-?[\d,]+(?:\.\d+)?)\s+(-?[\d,]+(?:\.\d+)?)\s+(-?[\d,]+(?:\.\d+)?)\s+([\d,]+(?:\.\d+)?)\/([\d,]+(?:\.\d+)?)\s+([\d,]+\.\d+)\s+(-?[\d,]+\.\d+)\s+(N\/A|-?[\d,]+(?:\.\d+)?)\s+(-?[\d,]+\.\d+)$/;

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parseNumber(value: string) {
  const text = String(value ?? "").replace(/,/g, "").replace(/[()]/g, "").trim();
  if (!text || text === "--" || text === "N/A") return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeDate(value: string) {
  return value.replace(/\//g, "-");
}

function marketName(group: string, currency: Currency) {
  if (group.includes("USA")) return "美国市场";
  if (group.includes("MUTUAL FUND")) return "货币市场基金";
  if (group.includes("HK")) return "香港市场";
  return currency === "USD" ? "美国市场" : "香港市场";
}

function isPageFooter(text: string) {
  return /^\d+\s*\/\s*\d+$/.test(text);
}

function isHeaderLine(text: string) {
  return (
    text.startsWith("日期 ") ||
    text.startsWith("Date ") ||
    text.startsWith("交易日 ") ||
    text.startsWith("Trade Date ") ||
    text.startsWith("幣種 ") ||
    text.startsWith("Currency ") ||
    text.startsWith("股票代號及名稱") ||
    text.startsWith("Stock Code") ||
    text.startsWith("債券代碼") ||
    text.startsWith("Product Code") ||
    text.startsWith("Hold Qty") ||
    text.startsWith("待結算") ||
    text.startsWith("維持保證") ||
    text.startsWith("金比率") ||
    text.startsWith("Margin%") ||
    isPageFooter(text)
  );
}

// 从内联内容或前置名称行提取证券代码。
// 内联形式为「代码+中文名+英文名」粘连（如 METAMeta Meta、AAPL蘋果 Apple、FIGFigma Figma），
// 依次尝试：中文边界切割、大小写边界切割、纯 ASCII 首词。
function extractLeadingSymbol(description: string) {
  const text = clean(description);
  if (!text) return "";
  const cjkCut = text.match(/^([A-Za-z0-9]{2,12}?)(?=[一-鿿])/);
  if (cjkCut) return cjkCut[1].toUpperCase();
  const caseCut = text.match(/^([A-Z]{2,5})(?=[A-Z][a-z])/);
  if (caseCut) return caseCut[1];
  const firstToken = text.split(" ")[0];
  if (/^[A-Za-z0-9.]{2,12}$/.test(firstToken)) return firstToken.toUpperCase();
  return "";
}

function rightmostNumber(line: TextLine) {
  for (let index = line.tokens.length - 1; index >= 0; index -= 1) {
    const text = line.tokens[index].text;
    if (/^[+-]?\d[\d,]*(?:\.\d+)?$/.test(text)) return parseNumber(text);
  }
  return 0;
}

async function extractPdfLines(fileName: string, data: ArrayBuffer, password?: string): Promise<TextLine[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    password,
    disableFontFace: true,
    disableWorker: typeof window === "undefined",
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

function parseStatementContext(lines: TextLine[]): StatementContext {
  const context: StatementContext = {
    accountNo: "",
    accountType: "",
    periodStart: "",
    periodEnd: "",
    detected: false,
  };
  for (const line of lines) {
    const text = line.text;
    if (text.includes("FOSUN INTERNATIONAL") || text.includes("月結單(Monthly Statement)")) {
      context.detected = true;
    }
    const accountMatch = text.match(/賬戶編號[:：]?\s*(\d{6,})/);
    if (accountMatch) context.accountNo = accountMatch[1];
    const typeMatch = text.match(/Account Type\s+賬戶類別[:：]?\s*(.+)$/);
    if (typeMatch) {
      const value = clean(typeMatch[1]);
      context.accountType = value.toLowerCase().includes("margin") ? "保证金账户" : "现金账户";
    }
    const periodMatch = text.match(/結單日期[:：]?\s*(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})/);
    if (periodMatch) {
      context.periodStart = periodMatch[1];
      context.periodEnd = periodMatch[2];
    }
  }
  return context;
}

interface PendingTrade {
  sourcePdf: string;
  page: number;
  accountNo: string;
  sequence: number;
  ref: string;
  market: string;
  currency: Currency;
  description: string;
  side: "buy" | "sell";
  quantity?: number;
  unitPrice?: number;
  cashChange: number;
  tradeDate: string;
  settleDate: string;
  fee: number;
  feesStarted: boolean;
  preLots: Array<{ quantity: number; price: number }>;
  postLots: Array<{ quantity: number; price: number }>;
}

function finalizeTrade(pending: PendingTrade, issues: ReviewIssue[]): TradeRecord | null {
  // 股数/单价优先级：费用块前最后一条小计行 > 交易行内联值（多小单合并时内联值只是第一笔小单）
  const totalLot = pending.postLots[pending.postLots.length - 1] ?? pending.preLots[pending.preLots.length - 1];
  const quantity = totalLot?.quantity ?? pending.quantity;
  const unitPrice = totalLot?.price ?? pending.unitPrice;
  if (quantity === undefined || unitPrice === undefined) {
    issues.push({
      id: `xingcaifu-trade-no-qty-${pending.sourcePdf}-${pending.ref}`,
      severity: "warning",
      title: "星财富交易缺少股数",
      detail: `${pending.tradeDate} 编号 ${pending.ref} 的交易行没有识别到股数和成交单价，该笔交易已跳过，请核对原月结单。`,
      source: pending.sourcePdf,
    });
    return null;
  }
  const symbol = extractLeadingSymbol(pending.description);
  if (!symbol) {
    issues.push({
      id: `xingcaifu-trade-no-symbol-${pending.sourcePdf}-${pending.ref}`,
      severity: "warning",
      title: "星财富交易缺少证券代码",
      detail: `${pending.tradeDate} 编号 ${pending.ref} 的交易没有识别到证券代码，该笔交易已跳过，请核对原月结单。`,
      source: pending.sourcePdf,
    });
    return null;
  }
  const grossAmount = roundMoney(quantity * unitPrice);
  const expectedCash = pending.side === "buy" ? -(grossAmount + pending.fee) : grossAmount - pending.fee;
  const feeFromCash = roundMoney(Math.abs(Math.abs(pending.cashChange) - grossAmount));
  // 清算金额已含全部费用，费用行仅作展示；以清算金额与成交金额之差为准
  const fee = feeFromCash >= 0 ? feeFromCash : pending.fee;
  if (Math.abs(pending.cashChange - expectedCash) > 0.02 && Math.abs(Math.abs(pending.cashChange) - grossAmount - feeFromCash) > 0.02) {
    issues.push({
      id: `xingcaifu-trade-mismatch-${pending.sourcePdf}-${pending.ref}`,
      severity: "info",
      title: "星财富交易金额与费用不一致",
      detail: `${pending.tradeDate} 编号 ${pending.ref}：股数×单价=${grossAmount}，清算金额=${pending.cashChange}，费用合计=${pending.fee}，请核对。`,
      source: pending.sourcePdf,
    });
  }
  return {
    sourcePdf: pending.sourcePdf,
    page: pending.page,
    accountNo: pending.accountNo,
    sequence: pending.sequence,
    ref: pending.ref,
    market: pending.market,
    currency: pending.currency,
    symbol: normalizeSymbol(symbol),
    securityName: clean(pending.description) || symbol,
    side: pending.side,
    quantity,
    unitPrice,
    cashChange: pending.cashChange,
    fee,
    tradeDate: pending.tradeDate,
    settleDate: pending.settleDate,
    pendingSettlement: false,
  };
}

interface FileRawData {
  context: StatementContext;
  trades: TradeRecord[];
  unsettledTrades: TradeRecord[];
  cashFlows: CashFlowRecord[];
  stockMoves: StockMoveEntry[];
  positions: PositionRecord[];
  issues: ReviewIssue[];
}

type Section = "none" | "positions" | "bond" | "cash" | "stockMove" | "trades" | "unsettled" | "interest";

function parseFileLines(sourcePdf: string, lines: TextLine[]): FileRawData {
  const raw: FileRawData = {
    context: parseStatementContext(lines),
    trades: [],
    unsettledTrades: [],
    cashFlows: [],
    stockMoves: [],
    positions: [],
    issues: [],
  };

  let section: Section = "none";
  let market = "";
  let currency: Currency = "HKD";
  let sequence = 0;
  let pendingNameParts: string[] = [];
  let pendingTrade: PendingTrade | null = null;
  let preLots: Array<{ quantity: number; price: number }> = [];
  let pendingCash: CashFlowRecord | null = null;
  let pendingMove: StockMoveEntry | null = null;
  let positionNameBuffer: string[] = [];

  const settlePendingTrade = () => {
    if (!pendingTrade) return;
    const trade = finalizeTrade(pendingTrade, raw.issues);
    if (trade) raw.trades.push(trade);
    pendingTrade = null;
    preLots = [];
  };

  const settlePendingCash = () => {
    if (pendingCash) raw.cashFlows.push(pendingCash);
    pendingCash = null;
  };

  const settlePendingMove = () => {
    if (pendingMove) raw.stockMoves.push(pendingMove);
    pendingMove = null;
  };

  const switchSection = (next: Section) => {
    settlePendingTrade();
    settlePendingCash();
    settlePendingMove();
    pendingNameParts = [];
    positionNameBuffer = [];
    section = next;
  };

  for (const line of lines) {
    const text = line.text;
    if (!text) continue;

    if (text.includes("證券組合(Securities Position")) {
      switchSection("positions");
      continue;
    }
    if (text.includes("債券組合(Bond")) {
      switchSection("bond");
      continue;
    }
    if (text.includes("當月資金提存交易(")) {
      switchSection("cash");
      continue;
    }
    if (text.includes("當月證券提存交易(")) {
      switchSection("stockMove");
      continue;
    }
    if (text.includes("成交信息(Transaction Details)")) {
      switchSection("trades");
      continue;
    }
    if (text.includes("未交收證券交易(Unsettled")) {
      switchSection("unsettled");
      continue;
    }
    if (text.includes("利息總結(Interest Summary)") || text.includes("重要提示")) {
      switchSection("interest");
      continue;
    }
    if (section === "none" || section === "interest" || section === "bond") continue;

    const marketGroup = text.match(MARKET_GROUP_PATTERN);
    if (marketGroup && (section === "trades" || section === "unsettled" || section === "stockMove" || section === "positions")) {
      settlePendingTrade();
      settlePendingMove();
      market = marketName(marketGroup[1], marketGroup[2] as Currency);
      currency = marketGroup[2] as Currency;
      continue;
    }
    if (section === "cash" && CASH_GROUP_PATTERN.test(text)) {
      settlePendingCash();
      currency = text.slice(0, 3) as Currency;
      continue;
    }
    if (text.startsWith("合計Total") || text.startsWith("無")) {
      settlePendingCash();
      settlePendingMove();
      continue;
    }
    if (isHeaderLine(text)) continue;

    if (section === "trades") {
      const tradeMatch = text.match(TRADE_ROW_PATTERN);
      if (tradeMatch) {
        settlePendingTrade();
        pendingTrade = {
          sourcePdf,
          page: line.page,
          accountNo: raw.context.accountNo,
          sequence: sequence++,
          ref: tradeMatch[3],
          market,
          currency,
          description: clean(tradeMatch[5]),
          side: tradeMatch[4] === "B" ? "buy" : "sell",
          quantity: tradeMatch[7] !== undefined ? parseNumber(tradeMatch[7]) : undefined,
          unitPrice: tradeMatch[8] !== undefined ? parseNumber(tradeMatch[8]) : undefined,
          cashChange: parseNumber(tradeMatch[9]),
          tradeDate: normalizeDate(tradeMatch[1]),
          settleDate: normalizeDate(tradeMatch[2]),
          fee: 0,
          feesStarted: false,
          preLots,
          postLots: [],
        };
        preLots = [];
        if (!pendingTrade.description && pendingNameParts.length > 0) {
          pendingTrade.description = clean(pendingNameParts.join(" "));
        }
        pendingNameParts = [];
        continue;
      }

      const lotMatch = text.match(LOT_LINE_PATTERN);
      if (lotMatch) {
        const lot = { quantity: parseNumber(lotMatch[1]), price: parseNumber(lotMatch[2]) };
        if (pendingTrade && !pendingTrade.feesStarted) {
          pendingTrade.postLots.push(lot);
        } else if (!pendingTrade) {
          preLots.push(lot);
        }
        continue;
      }

      if (FEE_LINE_PATTERN.test(text)) {
        if (pendingTrade) {
          pendingTrade.feesStarted = true;
          pendingTrade.fee = roundMoney(pendingTrade.fee + rightmostNumber(line));
        }
        continue;
      }

      // 其余文本行：交易行之前的是证券名称，交易行之后费用块之前的是名称续行
      if (pendingTrade) {
        if (pendingTrade.feesStarted) {
          settlePendingTrade();
          pendingNameParts = [text];
        }
        // 名称续行（如 "Technology"），忽略
        continue;
      }
      pendingNameParts.push(text);
      continue;
    }

    if (section === "unsettled") {
      const match = text.match(UNSETTLED_ROW_PATTERN);
      if (!match) continue;
      const symbol = extractLeadingSymbol(match[5]);
      if (!symbol) continue;
      const quantity = parseNumber(match[6]);
      const unitPrice = parseNumber(match[7]);
      const cashChange = parseNumber(match[8]);
      raw.unsettledTrades.push({
        sourcePdf,
        page: line.page,
        accountNo: raw.context.accountNo,
        sequence: sequence++,
        ref: match[3],
        market,
        currency,
        symbol: normalizeSymbol(symbol),
        securityName: clean(match[5]),
        side: match[4] === "B" ? "buy" : "sell",
        quantity,
        unitPrice,
        cashChange,
        fee: roundMoney(Math.abs(Math.abs(cashChange) - roundMoney(quantity * unitPrice))),
        tradeDate: normalizeDate(match[1]),
        settleDate: normalizeDate(match[2]),
        pendingSettlement: true,
      });
      continue;
    }

    if (section === "cash") {
      const cashMatch = text.match(CASH_ROW_PATTERN);
      if (cashMatch) {
        settlePendingCash();
        pendingCash = {
          sourcePdf,
          page: line.page,
          currency,
          date: normalizeDate(cashMatch[1]),
          ref: cashMatch[2],
          description: clean(cashMatch[3]),
          amount: parseNumber(cashMatch[4]),
        };
        continue;
      }
      // 摘要换行续接（如 ReferenceId=... 或名称尾部）
      if (pendingCash) {
        pendingCash.description = clean(`${pendingCash.description} ${text}`);
      }
      continue;
    }

    if (section === "stockMove") {
      const moveMatch = text.match(STOCK_MOVE_ROW_PATTERN);
      if (moveMatch) {
        settlePendingMove();
        pendingMove = {
          sourcePdf,
          page: line.page,
          market,
          currency,
          date: normalizeDate(moveMatch[1]),
          ref: moveMatch[2],
          quantity: parseNumber(moveMatch[4]),
          description: clean(moveMatch[3]),
        };
        continue;
      }
      // 摘要换行续接（如 ReferenceId=... 或名称尾部）
      if (pendingMove) {
        pendingMove.description = clean(`${pendingMove.description} ${text}`);
      }
      continue;
    }

    if (section === "positions") {
      const numbersMatch = text.match(POSITION_NUMBERS_PATTERN);
      if (numbersMatch) {
        const inlineName = clean(text.slice(0, numbersMatch.index ?? 0));
        let nameLine = inlineName;
        if (!nameLine) {
          // 名称在数字行之前，取缓冲中最后一条以代码开头的行
          for (let index = positionNameBuffer.length - 1; index >= 0; index -= 1) {
            const candidate = positionNameBuffer[index];
            const firstToken = candidate.split(" ")[0];
            if (/^([A-Z]{1,5}|[A-Z]{2}\d{6,}|\d{4,6})$/.test(firstToken)) {
              nameLine = candidate;
              break;
            }
          }
        }
        const symbol = nameLine ? nameLine.split(" ")[0] : "";
        const quantity = parseNumber(numbersMatch[3]);
        if (symbol && quantity > 0) {
          raw.positions.push({
            sourcePdf,
            page: line.page,
            accountNo: raw.context.accountNo,
            market,
            currency,
            symbol: normalizeSymbol(symbol.toUpperCase()),
            securityName: clean(nameLine),
            quantity,
            price: parseNumber(numbersMatch[6]),
            marketValue: parseNumber(numbersMatch[7]),
          });
        }
        positionNameBuffer = [];
        continue;
      }
      positionNameBuffer.push(text);
      continue;
    }
  }

  switchSection("none");
  return raw;
}

// 红利/利息相关资金流的代码提取
function dividendSymbolFromText(description: string): { symbol: string; securityName: string } | null {
  const named = description.match(/#([^#()]+)\(([A-Za-z0-9.]+)\)/);
  if (named) return { symbol: named[2].toUpperCase(), securityName: clean(named[1]) };
  const bracketed = description.match(/#\[([A-Za-z0-9]+)(?:\.[A-Za-z]+)?\]/);
  if (bracketed) return { symbol: bracketed[1].toUpperCase(), securityName: bracketed[1].toUpperCase() };
  const divOf = description.match(/Div of #([A-Za-z0-9.]+)/i);
  if (divOf) return { symbol: divOf[1].toUpperCase(), securityName: divOf[1].toUpperCase() };
  const taxFor = description.match(/Withholding Tax for #([A-Za-z0-9.]+)/i);
  if (taxFor) return { symbol: taxFor[1].toUpperCase(), securityName: taxFor[1].toUpperCase() };
  const handling = description.match(/HANDING CHARGE FOR #([^#()]+)\(([A-Za-z0-9.]+)\)/i);
  if (handling) return { symbol: handling[2].toUpperCase(), securityName: clean(handling[1]) };
  return null;
}

interface FundCashRecord {
  code: string;
  referenceId: string;
  amount: number;
  currency: Currency;
  date: string;
}

function fundCashFromDescription(flow: CashFlowRecord): FundCashRecord | null {
  if (!flow.description.includes("Fund Subscription For") && !flow.description.includes("Fund Redemption For")) {
    return null;
  }
  const code = flow.description.match(/Fund (?:Subscription|Redemption) For ([A-Z0-9]+) FUND/);
  const reference = flow.description.match(/ReferenceId=(\d+)/);
  if (!code || !reference) return null;
  return {
    code: code[1],
    referenceId: reference[1],
    amount: Math.abs(flow.amount),
    currency: flow.currency,
    date: flow.date,
  };
}

function buildDividends(cashFlows: CashFlowRecord[], accountNo: string): { dividends: DividendIncome[]; ignoredCashNote: string[] } {
  interface Aggregate {
    date: string;
    currency: Currency;
    symbol: string;
    securityName: string;
    grossAmount: number;
    taxWithheld: number;
    fee: number;
    source: string;
    note: string;
    isInterest: boolean;
  }
  const aggregates = new Map<string, Aggregate>();
  const ignoredCashNote: string[] = [];

  for (const flow of cashFlows) {
    const description = flow.description;

    if (description.includes("Interest Payment for")) {
      const fundCode = description.match(/Interest Payment for ([A-Z0-9]+)/)?.[1] ?? "UNKNOWN";
      const key = `interest-${flow.date}-${flow.currency}-${fundCode}`;
      const aggregate = aggregates.get(key) ?? {
        date: flow.date,
        currency: flow.currency,
        symbol: fundCode,
        securityName: `货币市场基金利息(${fundCode})`,
        grossAmount: 0,
        taxWithheld: 0,
        fee: 0,
        source: flow.sourcePdf,
        note: "货币基金现金利息",
        isInterest: true,
      };
      aggregate.grossAmount = roundMoney(aggregate.grossAmount + flow.amount);
      aggregates.set(key, aggregate);
      continue;
    }

    const isGross =
      description.includes("紅利入帳") ||
      description.includes("Corporate action dividend total cash in") ||
      /Div of #/i.test(description);
    const isTax =
      description.includes("股息稅") ||
      description.includes("Corporate action dividend tax cash out") ||
      /Withholding Tax for #/i.test(description);
    const isFee = description.includes("紅利手續費");
    if (!isGross && !isTax && !isFee) {
      if (!fundCashFromDescription(flow)) ignoredCashNote.push(`${flow.date} ${description} ${flow.amount}`);
      continue;
    }

    const parsedSymbol = dividendSymbolFromText(description);
    if (!parsedSymbol) continue;
    const symbol = normalizeSymbol(parsedSymbol.symbol);
    const key = `${flow.date}-${flow.currency}-${symbol}`;
    const aggregate = aggregates.get(key) ?? {
      date: flow.date,
      currency: flow.currency,
      symbol,
      securityName: parsedSymbol.securityName,
      grossAmount: 0,
      taxWithheld: 0,
      fee: 0,
      source: flow.sourcePdf,
      note: "",
      isInterest: false,
    };
    if (isGross) {
      aggregate.grossAmount = roundMoney(aggregate.grossAmount + Math.abs(flow.amount));
      aggregate.note = description;
    } else if (isTax) {
      aggregate.taxWithheld = roundMoney(aggregate.taxWithheld + Math.abs(flow.amount));
    } else {
      aggregate.fee = roundMoney(aggregate.fee + Math.abs(flow.amount));
    }
    aggregates.set(key, aggregate);
  }

  const dividends = Array.from(aggregates.values())
    .filter((item) => item.grossAmount > 0)
    .map((item) => ({
      id: `xingcaifu-${item.isInterest ? "interest" : "dividend"}-${accountNo}-${item.date}-${item.currency}-${item.symbol}`,
      broker: XINGCAIFU_BROKER,
      date: item.date,
      currency: item.currency,
      symbol: item.symbol,
      securityName: item.securityName,
      grossAmount: item.grossAmount,
      taxWithheld: item.taxWithheld,
      fee: item.fee,
      source: item.source,
      note: item.note || item.securityName,
    }));
  return { dividends, ignoredCashNote };
}

interface TransferRecord {
  date: string;
  currency: Currency;
  symbol: string;
  quantity: number;
  entry: StockMoveEntry;
}

function buildActivities(
  raws: FileRawData[],
  targetYear: number | undefined,
  manualCosts: ManualCostInput[],
): {
  activities: TradeActivity[];
  realizedTrades: RealizedTrade[];
  costBasisRequests: CostBasisRequest[];
  issues: ReviewIssue[];
} {
  const issues: ReviewIssue[] = [];
  const activities: TradeActivity[] = [];

  // 已交收交易 + 未交收交易（按编号去重，未交收的交易与成交信息里的重复时以成交信息为准）
  const seenRefs = new Set<string>();
  const allTrades: TradeRecord[] = [];
  for (const raw of raws) {
    for (const trade of raw.trades) {
      seenRefs.add(`${trade.accountNo}-${trade.ref}`);
      allTrades.push(trade);
    }
  }
  for (const raw of raws) {
    for (const trade of raw.unsettledTrades) {
      if (seenRefs.has(`${trade.accountNo}-${trade.ref}`)) continue;
      allTrades.push(trade);
    }
  }

  for (const trade of allTrades) {
    activities.push({
      id: `xingcaifu-activity-${trade.accountNo}-${trade.ref}`,
      broker: XINGCAIFU_BROKER,
      date: trade.tradeDate,
      sequence: trade.sequence,
      market: trade.market,
      currency: trade.currency,
      symbol: trade.symbol,
      securityName: trade.securityName,
      side: trade.side,
      quantity: trade.quantity,
      unitPrice: trade.unitPrice,
      grossAmount: roundMoney(trade.quantity * trade.unitPrice),
      fee: trade.fee,
      amount: roundMoney(Math.abs(trade.cashChange)),
      source: trade.sourcePdf,
      note: `编号 ${trade.ref}；交收日 ${trade.settleDate}；${trade.pendingSettlement ? "待结算交易；" : ""}${trade.sourcePdf} 第 ${trade.page} 页`,
    });
  }

  // 基金申赎：证券提存给出份额，资金提存给出金额，按 ReferenceId 配对
  const fundCashByReference = new Map<string, FundCashRecord>();
  for (const raw of raws) {
    for (const flow of raw.cashFlows) {
      const fundCash = fundCashFromDescription(flow);
      if (fundCash) fundCashByReference.set(`${raw.context.accountNo}-${fundCash.referenceId}`, fundCash);
    }
  }

  const transfers: TransferRecord[] = [];

  for (const raw of raws) {
    for (const move of raw.stockMoves) {
      const description = move.description;

      const subscription = description.match(/證券存入\s*([A-Z0-9]+)\.FUND/);
      const redemption = description.match(/證券提取\s*([A-Z0-9]+)\.FUND/);
      if (subscription || redemption) {
        const code = (subscription ?? redemption)?.[1] ?? "";
        const referenceId = description.match(/ReferenceId=(\d+)/)?.[1] ?? "";
        const fundCash = fundCashByReference.get(`${raw.context.accountNo}-${referenceId}`);
        if (!fundCash) {
          issues.push({
            id: `xingcaifu-fund-no-cash-${raw.context.accountNo}-${move.ref}`,
            severity: "warning",
            title: "基金申赎缺少对应资金记录",
            detail: `${move.date} ${code} 的${subscription ? "申购" : "赎回"}份额 ${move.quantity} 没有找到同月资金流水（ReferenceId=${referenceId}），成本/收入按 0 处理，请补充对应月份的资金记录或手动订正。`,
            source: move.sourcePdf,
          });
        }
        const amount = fundCash ? fundCash.amount : 0;
        const quantity = Math.abs(move.quantity);
        activities.push({
          id: `xingcaifu-fund-${raw.context.accountNo}-${move.ref}`,
          broker: XINGCAIFU_BROKER,
          date: move.date,
          market: move.market,
          currency: fundCash?.currency ?? move.currency,
          symbol: normalizeSymbol(code),
          securityName: code,
          side: subscription ? "acquire" : "sell",
          quantity,
          unitPrice: quantity > 0 ? roundMoney(amount / quantity) : undefined,
          fee: 0,
          amount: roundMoney(amount),
          source: move.sourcePdf,
          note: `${subscription ? "基金申购" : "基金赎回"}；ReferenceId=${referenceId}；${move.sourcePdf} 第 ${move.page} 页`,
        });
        continue;
      }

      if (description.includes("客戶轉倉")) {
        // 账户间转仓：数量为正为转入本账户，为负为转出本账户；代码取最后一个 #CODE 或 CODE.US
        const hashMatches = Array.from(description.matchAll(/#([A-Za-z0-9]+)/g));
        const usMatches = Array.from(description.matchAll(/([A-Za-z0-9]{2,10})\.US(?![a-z])/g));
        const rawCode =
          hashMatches.length > 0
            ? hashMatches[hashMatches.length - 1][1]
            : usMatches.length > 0
              ? usMatches[usMatches.length - 1][1]
              : "";
        if (!rawCode || !move.date) continue;
        transfers.push({
          date: move.date,
          currency: move.currency,
          symbol: normalizeSymbol(rawCode.toUpperCase()),
          quantity: move.quantity,
          entry: move,
        });
        continue;
      }

      if (move.date) {
        issues.push({
          id: `xingcaifu-move-unknown-${raw.context.accountNo}-${move.ref}`,
          severity: "info",
          title: "未识别的证券提存记录",
          detail: `${move.date} ${description}（数量 ${move.quantity}），未计入计算，请人工核对。`,
          source: move.sourcePdf,
        });
      }
    }
  }

  // 同一日期、同一证券、数量绝对值相等的转入转出互为配对（现金账户 ↔ 保证金账户），
  // 配对后两条都剔除，避免转出清掉成本、转入以 0 成本补回导致成本丢失
  const pairedOut = new Set<number>();
  const pairedIn = new Set<number>();
  const outs = transfers.map((transfer, index) => ({ transfer, index })).filter((item) => item.transfer.quantity < 0);
  const ins = transfers.map((transfer, index) => ({ transfer, index })).filter((item) => item.transfer.quantity > 0);
  for (const outItem of outs) {
    const match = ins.find(
      (inItem) =>
        !pairedIn.has(inItem.index) &&
        inItem.transfer.date === outItem.transfer.date &&
        inItem.transfer.symbol === outItem.transfer.symbol &&
        inItem.transfer.currency === outItem.transfer.currency &&
        Math.abs(inItem.transfer.quantity + outItem.transfer.quantity) < 1e-6,
    );
    if (match) {
      pairedOut.add(outItem.index);
      pairedIn.add(match.index);
    }
  }

  transfers.forEach((transfer, index) => {
    if (pairedOut.has(index) || pairedIn.has(index)) return;
    const isIn = transfer.quantity > 0;
    activities.push({
      id: `xingcaifu-transfer-${transfer.entry.sourcePdf}-${transfer.entry.ref}`,
      broker: XINGCAIFU_BROKER,
      date: transfer.date,
      market: transfer.entry.market,
      currency: transfer.currency,
      symbol: transfer.symbol,
      securityName: transfer.symbol,
      side: isIn ? "transfer_in" : "transfer_out",
      quantity: Math.abs(transfer.quantity),
      fee: 0,
      amount: 0,
      source: transfer.entry.sourcePdf,
      note: isIn
        ? "账户间转仓转入（未找到配对转出），转入成本需用原账户成本凭证复核"
        : "账户间转仓转出（未找到配对转入）",
    });
    if (isIn) {
      issues.push({
        id: `xingcaifu-transfer-in-${transfer.entry.sourcePdf}-${transfer.entry.ref}`,
        severity: "info",
        title: `${transfer.symbol} 账户间转仓转入未配对`,
        detail: `${transfer.date} 转入 ${Math.abs(transfer.quantity)} 股，未在上传材料中找到对应的转出记录。若该证券后续卖出，请在待补成本中补录原始成本。`,
        source: transfer.entry.sourcePdf,
      });
    }
  });

  // 待补成本：按数量重放，卖出超出已跟踪买入/转入的部分提示补录
  const rank: Record<TradeActivity["side"], number> = {
    acquire: 1,
    transfer_in: 1,
    buy: 2,
    long_open: 2,
    short_open: 2,
    short_close: 2,
    sell: 2,
    transfer_out: 3,
    stock_split: 2,
  };
  const sorted = [...activities].sort(
    (a, b) => a.date.localeCompare(b.date) || rank[a.side] - rank[b.side] || (a.sequence ?? 0) - (b.sequence ?? 0),
  );
  const quantities = new Map<string, number>();
  const manualCostById = new Map(manualCosts.filter((item) => item.id && item.costBasis >= 0).map((item) => [item.id, item.costBasis]));
  const realizedTrades: RealizedTrade[] = [];
  const costBasisRequests: CostBasisRequest[] = [];

  for (const activity of sorted) {
    const key = `${activity.currency}::${activity.symbol}`;
    const quantity = quantities.get(key) ?? 0;
    if (activity.side === "buy" || activity.side === "acquire" || activity.side === "transfer_in") {
      quantities.set(key, quantity + activity.quantity);
      continue;
    }
    if (activity.side !== "sell") {
      quantities.set(key, Math.max(0, quantity - activity.quantity));
      continue;
    }
    if (quantity + 1e-7 >= activity.quantity) {
      quantities.set(key, quantity - activity.quantity);
      continue;
    }
    quantities.set(key, 0);
    if (targetYear !== undefined && !activity.date.startsWith(String(targetYear))) continue;
    const requestId = `xingcaifu-cost-${activity.currency}-${activity.symbol}-${activity.date}-${activity.id.slice(-12)}`;
    const manualCost = manualCostById.get(requestId);
    if (manualCost !== undefined) {
      realizedTrades.push({
        id: `${requestId}-manual`,
        broker: XINGCAIFU_BROKER,
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
        note: "用户手动补录这笔卖出总成本",
        useBrokerReportedGainLoss: true,
      });
      continue;
    }
    costBasisRequests.push({
      id: requestId,
      broker: XINGCAIFU_BROKER,
      sellDate: activity.date,
      sequence: activity.sequence,
      market: activity.market,
      currency: activity.currency,
      symbol: activity.symbol,
      securityName: activity.securityName,
      quantity: activity.quantity,
      trackedQuantity: quantity,
      proceeds: activity.amount,
      source: activity.source,
      note: "手动补录这笔成本后计入资本利得",
    });
    issues.push({
      id: `${requestId}-cost-gap`,
      severity: "warning",
      title: `${activity.symbol} 历史成本缺失`,
      detail: `${activity.date} 卖出 ${activity.quantity} 股，但上传的星财富月结单没有足够的买入/转入记录匹配成本。请补充更早月份月结单，或在待补成本中手动填写这笔成本。`,
      source: activity.source,
    });
  }

  return { activities: sorted, realizedTrades, costBasisRequests, issues };
}

function buildOpenPositions(raws: FileRawData[]): OpenPosition[] {
  // 月结单列示全部持仓，空仓证券不再出现；每个账户只保留其最新一份结单的持仓
  const latestPeriodByAccount = new Map<string, string>();
  for (const raw of raws) {
    const existing = latestPeriodByAccount.get(raw.context.accountNo);
    if (!existing || raw.context.periodEnd > existing) {
      latestPeriodByAccount.set(raw.context.accountNo, raw.context.periodEnd);
    }
  }
  const positions: OpenPosition[] = [];
  for (const raw of raws) {
    if (raw.context.periodEnd !== latestPeriodByAccount.get(raw.context.accountNo)) continue;
    for (const position of raw.positions) {
      positions.push({
        id: `xingcaifu-open-${position.accountNo}-${raw.context.periodEnd}-${position.currency}-${position.symbol}`,
        broker: XINGCAIFU_BROKER,
        asOf: raw.context.periodEnd,
        market: position.market,
        currency: position.currency,
        symbol: position.symbol,
        securityName: position.securityName,
        quantity: position.quantity,
        marketValue: position.marketValue,
        source: position.sourcePdf,
        note: `${position.sourcePdf} 第 ${position.page} 页；收市价 ${position.price}`,
      });
    }
  }
  return positions;
}

export async function parseXingcaifuPdfs(
  files: XingcaifuFileInput[],
  password?: string,
  options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raws: FileRawData[] = [];

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data, password);
      raws.push(parseFileLines(file.name, lines));
    } catch (error) {
      parsed.issues.push({
        id: `${file.name}-pdf-error`,
        severity: "blocking",
        title: "星财富PDF解析失败",
        detail: error instanceof Error ? error.message : "未知PDF解析错误。请确认文件是否完整。",
        source: file.name,
      });
    }
  }

  const detected = raws.some((raw) => raw.context.detected);
  if (!detected && files.length > 0) {
    parsed.issues.push({
      id: "xingcaifu-invalid-format",
      severity: "blocking",
      title: "星财富文件格式不符合要求",
      detail: "星财富解析器只支持复星国际证券 PDF 月结单（现金账户或保证金账户）。当前文件没有识别到复星国际证券月结单特征，请确认上传文件。",
    });
    return parsed;
  }

  const activityResult = buildActivities(raws, options.targetYear, options.manualCosts ?? []);
  parsed.tradeActivities.push(...activityResult.activities);
  parsed.realizedTrades.push(...activityResult.realizedTrades);
  parsed.costBasisRequests.push(...activityResult.costBasisRequests);
  parsed.issues.push(...activityResult.issues);
  parsed.openPositions.push(...buildOpenPositions(raws));

  let ignoredCashTotal = 0;
  for (const raw of raws) {
    const { dividends, ignoredCashNote } = buildDividends(raw.cashFlows, raw.context.accountNo);
    parsed.dividends.push(...dividends);
    ignoredCashTotal += ignoredCashNote.length;
  }

  const tradeCount = parsed.tradeActivities.filter((activity) => activity.side === "buy" || activity.side === "sell").length;
  const acquireCount = parsed.tradeActivities.filter((activity) => activity.side === "acquire").length;
  if (raws.length > 0) {
    parsed.issues.push({
      id: "xingcaifu-parse-summary",
      severity: "info",
      title: "星财富月结单解析完成",
      detail: `已读取 ${raws.length} 份月结单：股票交易 ${tradeCount} 笔，基金申购 ${acquireCount} 笔，分红/利息 ${parsed.dividends.length} 条，月末持仓 ${parsed.openPositions.length} 条。普通存取款、换汇、佣金返还等 ${ignoredCashTotal} 条资金流水不属于应税项目，未计入。`,
    });
  }

  return parsed;
}
