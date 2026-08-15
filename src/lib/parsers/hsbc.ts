import { emptyParsedInput } from "@/lib/tax/calculator";
import type {
  Currency,
  OpenPosition,
  ParsedInput,
  ReviewIssue,
  TradeActivity,
} from "@/lib/tax/types";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

interface HsbcFileInput {
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

interface HsbcTrade {
  sourcePdf: string;
  page: number;
  fundId: string;
  fundName: string;
  side: "buy" | "sell";
  tradeDate: string;
  settlementDate: string;
  currency: Currency;
  unitPrice: number;
  quantity: number;
  settlementAmount: number;
  reference: string;
  sequence: number;
}

interface HsbcHolding {
  sourcePdf: string;
  page: number;
  statementDate: string;
  fundId: string;
  fundName: string;
  currency: Currency;
  openingUnits: number;
  closingUnits: number;
  unitPrice: number;
  marketValue: number;
  sequence: number;
}

interface HsbcRawData {
  statementDate: string;
  accountNo: string;
  accountName: string;
  trades: HsbcTrade[];
  holdings: HsbcHolding[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

const HSBC_BROKER = "汇丰香港";

function clean(value: string) {
  return value.replace(/ /g, "").replace(/\s+/g, " ").trim();
}

function isNumberToken(text: string) {
  return /^[+\-]?[\d,]+\.\d+$/.test(text);
}

function parseNumber(value: string) {
  const normalized = clean(value).replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function mapCurrency(text: string): Currency {
  const t = clean(text).toUpperCase();
  if (t.includes("USD")) return "USD";
  if (t.includes("CNY") || t.includes("RMB")) return "CNY";
  return "HKD";
}

function djb2Hash(str: string) {
  let hash = 5381;
  for (let i = 0; i < str.length; i += 1) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function shortFundSymbol(fundId: string, fundName: string) {
  const input = fundId ? `${fundId} ${fundName}` : fundName;
  return `HSBC${djb2Hash(input).toString(36).toUpperCase().padStart(7, "0")}`;
}

function parseDate(value: string) {
  // Format: 24JUL2026 or 24-JUL-2026
  const m = clean(value).match(/(0?[0-9]{2})([A-Z]{3})(20\d{2})/);
  if (!m) return "";
  const day = m[1].padStart(2, "0");
  const monthMap: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
  };
  const month = monthMap[m[2].toUpperCase()] ?? "01";
  return `${m[3]}-${month}-${day}`;
}

async function extractPdfLines(fileName: string, data: ArrayBuffer) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  if (typeof window !== "undefined") pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data.slice(0)),
    disableFontFace: true,
    isEvalSupported: false,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const document = await loadingTask.promise;

  try {
    const lines: TextLine[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const tokens = content.items
          .flatMap((item) => {
            const candidate = item as PdfTextItemLike;
            if (typeof candidate.str !== "string" || candidate.str.trim().length === 0) return [];
            if (!Array.isArray(candidate.transform)) return [];
            return [{
              text: clean(candidate.str),
              x: Number(candidate.transform[4] ?? 0),
              y: Number(candidate.transform[5] ?? 0),
            }];
          })
          .sort((a, b) => b.y - a.y || a.x - b.x);

        const groups: Array<{ y: number; tokens: TextToken[] }> = [];
        for (const token of tokens) {
          let group = groups.find((g) => Math.abs(g.y - token.y) < 2.2);
          if (!group) {
            group = { y: token.y, tokens: [] };
            groups.push(group);
          }
          group.tokens.push(token);
        }

        lines.push(...groups.sort((a, b) => b.y - a.y).map((group) => {
          const sortedTokens = group.tokens.sort((a, b) => a.x - b.x);
          return {
            page: pageNumber,
            text: clean(sortedTokens.map((t) => t.text).join(" ")),
            tokens: sortedTokens,
          };
        }));
      } finally {
        page.cleanup?.();
      }
    }
    if (lines.length === 0) throw new Error(`${fileName} 没有可解析文字层`);
    return lines;
  } finally {
    await document.destroy?.();
  }
}

function tokensInRange(line: TextLine, minX: number, maxX: number) {
  return line.tokens.filter((t) => t.x >= minX && t.x < maxX);
}

function isHsbcStatement(lines: TextLine[]) {
  // Investment services 月结单独有：Portfolio details + Transaction summary
  const text = lines.slice(0, 100).map((l) => l.text).join("\n");
  return /Portfolio\s*details/i.test(text) && /Transaction\s*summary/i.test(text);
}

function parseHsbcLines(sourcePdf: string, lines: TextLine[], baseSequence: number): HsbcRawData {
  const raw: HsbcRawData = {
    statementDate: "",
    accountNo: "",
    accountName: "",
    trades: [],
    holdings: [],
    issues: [],
    statementDetected: false,
  };
  let sequence = baseSequence;

  let inHoldings = false;
  let inTrades = false;
  let currentFundId = "";
  let currentFundName = "";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const text = line.text;
    const lower = text.toLowerCase();

    // Statement header parsing
    if (/Statement Date|結單日期/i.test(text)) {
      const dateMatch = text.match(/(\d{2}[A-Z]{3}\d{4})/);
      if (dateMatch) {
        raw.statementDate = parseDate(dateMatch[1]);
      }
    }
    if (/A\/C no|帳戶號碼/i.test(text)) {
      const noMatch = text.match(/(\d{3}-\d{6}-\d{3})/);
      if (noMatch) raw.accountNo = noMatch[1];
    }
    if (/A\/C name|帳戶名稱/i.test(text)) {
      const nameMatch = text.match(/:\s*([A-Z\s]+)$/);
      if (nameMatch) raw.accountName = clean(nameMatch[1]);
    }

    // Section detection
    if (/Portfolio details/i.test(text)) {
      inHoldings = true;
      inTrades = false;
      continue;
    }
    if (/Transaction summary/i.test(text)) {
      inHoldings = false;
      inTrades = true;
      continue;
    }
    if (/Charges and income summary/i.test(text)) {
      inHoldings = false;
      inTrades = false;
    }

    // Skip column headers
    if (/Risk Level|The opening balance|The closing balance|Market unit price|Market value/i.test(text)) continue;
    if (/Securities description|Transaction date|Settlement date|Unit price|Quantity|Settlement amount/i.test(text)) continue;
    if (/^Securities ID$/i.test(text.trim())) continue;

    if (inHoldings) {
      // Fund ID row: U50004 at x~60, name at x~84
      const idToken = line.tokens.find((t) => /^U\d{5,}$/.test(t.text));
      if (idToken) {
        currentFundId = idToken.text;
        // Find fund name: tokens between ID and (UNT) that aren't numbers/currency
        const idIndex = line.tokens.indexOf(idToken);
        const nameTokens: string[] = [];
        for (let j = idIndex + 1; j < line.tokens.length; j++) {
          const tok = line.tokens[j];
          if (/^(UNT)$/i.test(tok.text)) break;
          if (/^(USD|HKD|CNY|RMB)$/i.test(tok.text)) break;
          if (isNumberToken(tok.text)) break;
          if (/^Risk/i.test(tok.text)) break;
          nameTokens.push(tok.text);
        }
        currentFundName = clean(nameTokens.join(" ")).replace(/\s*\(UNT\)\s*$/i, "");
        continue;
      }

      // Data row with Risk Level and numbers
      const riskToken = line.tokens.find((t) => /^Risk/i.test(t.text));
      if (riskToken) {
        // Parse the data row: opening balance at x~179, closing at x~277, price at x~380, value at x~507
        const openingTokens = tokensInRange(line, 160, 220);
        const closingTokens = tokensInRange(line, 250, 320);
        const priceTokens = tokensInRange(line, 350, 420);
        const valueTokens = tokensInRange(line, 480, 560);

        const openingUnits = openingTokens.find((t) => isNumberToken(t.text));
        const closingUnits = closingTokens.find((t) => isNumberToken(t.text));
        const priceToken = priceTokens.find((t) => isNumberToken(t.text));
        const valueToken = valueTokens.find((t) => isNumberToken(t.text));

        if (closingUnits && parseNumber(closingUnits.text) > 0 && currentFundId) {
          const holding: HsbcHolding = {
            sourcePdf,
            page: line.page,
            statementDate: raw.statementDate,
            fundId: currentFundId,
            fundName: currentFundName,
            currency: mapCurrency(text),
            openingUnits: openingUnits ? parseNumber(openingUnits.text) : 0,
            closingUnits: parseNumber(closingUnits.text),
            unitPrice: priceToken ? parseNumber(priceToken.text) : 0,
            marketValue: valueToken ? parseNumber(valueToken.text) : 0,
            sequence: sequence++,
          };
          raw.holdings.push(holding);
        }
        continue;
      }

      // Pure number rows (Risk row continuation) — skip (data already captured above)
      if (isNumberToken(text)) {
        continue;
      }
    }

    if (inTrades) {
      // Trade row: fund ID at x~60, name at x~84, then transaction info
      // Example:
      // y=372: [60]U50004 [84]  [131]HSBC GL EQ INDEX-HC-HKD [225]  [376](UNT)
      // y=361: [131]29JUN2026 [167]  [187]02JUL2026 [223]  [248]HKD [262]  [298]25.37870 [327]  [398]3.940000 [426]  [452]HKD [466]  [510]100.00
      // y=350: [129]Reference: PURCYL566146001 [227]  [259]Type: PUR [292]  [296]M BUY

      const idToken = line.tokens.find((t) => /^U\d{5,}$/.test(t.text));
      if (idToken) {
        currentFundId = idToken.text;
        const idIndex = line.tokens.indexOf(idToken);
        const nameTokens: string[] = [];
        for (let j = idIndex + 1; j < line.tokens.length; j++) {
          const tok = line.tokens[j];
          if (/^(UNT)$/i.test(tok.text)) break;
          if (/^(USD|HKD|CNY|RMB)$/i.test(tok.text)) break;
          if (isNumberToken(tok.text)) break;
          nameTokens.push(tok.text);
        }
        currentFundName = clean(nameTokens.join(" ")).replace(/\s*\(UNT\)\s*$/i, "");
        continue;
      }

      // Transaction detail row
      if (/Reference|Type:/i.test(text)) {
        const refMatch = text.match(/Reference:\s*(\S+)/);
        const typeMatch = text.match(/Type:\s*(\S+)/);
        const sideMatch = text.match(/(BUY|SELL)/i);

        if (refMatch && currentFundId) {
          const reference = refMatch[1];
          const type = typeMatch ? typeMatch[1] : "";
          const side: "buy" | "sell" = /sell/i.test(type) ? "sell" : "buy";

          // Look back to find the price/qty row (2 lines above typically)
          let priceQtyLine: TextLine | null = null;
          for (let back = i - 1; back >= 0 && back >= i - 3; back -= 1) {
            if (lines[back].tokens.some((t) => isNumberToken(t.text))) {
              priceQtyLine = lines[back];
              break;
            }
          }

          let tradeDate = "";
          let settlementDate = "";
          let unitPrice = 0;
          let quantity = 0;
          let settlementAmount = 0;
          let currency: Currency = "HKD";

          if (priceQtyLine) {
            const priceLineText = priceQtyLine.text;
            const dateMatch = priceLineText.match(/(\d{2}[A-Z]{3}\d{4})/g);
            if (dateMatch && dateMatch.length >= 1) tradeDate = parseDate(dateMatch[0]);
            if (dateMatch && dateMatch.length >= 2) settlementDate = parseDate(dateMatch[1]);

            const numberTokens = priceQtyLine.tokens.filter((t) => isNumberToken(t.text));
            const currencyToken = priceQtyLine.tokens.find((t) => /^(USD|HKD|CNY|RMB)$/i.test(t.text));
            if (currencyToken) currency = mapCurrency(currencyToken.text);

            if (numberTokens.length >= 3) {
              unitPrice = parseNumber(numberTokens[numberTokens.length - 3].text);
              quantity = parseNumber(numberTokens[numberTokens.length - 2].text);
              settlementAmount = parseNumber(numberTokens[numberTokens.length - 1].text);
            }
          }

          if (tradeDate && (quantity > 0 || settlementAmount > 0)) {
            raw.trades.push({
              sourcePdf,
              page: line.page,
              fundId: currentFundId,
              fundName: currentFundName,
              side,
              tradeDate,
              settlementDate,
              currency,
              unitPrice,
              quantity,
              settlementAmount,
              reference,
              sequence: sequence++,
            });
          }
        }
        continue;
      }
    }
  }

  raw.statementDetected = isHsbcStatement(lines);
  return raw;
}

function activityFromTrade(trade: HsbcTrade): TradeActivity {
  return {
    id: `hsbc-${trade.side}-${trade.tradeDate}-${trade.sequence}-${shortFundSymbol(trade.fundId, trade.fundName)}`,
    broker: HSBC_BROKER,
    date: trade.tradeDate,
    sequence: trade.sequence,
    market: "基金",
    currency: trade.currency,
    symbol: shortFundSymbol(trade.fundId, trade.fundName),
    securityName: trade.fundName,
    side: trade.side,
    quantity: trade.quantity,
    unitPrice: trade.unitPrice,
    grossAmount: roundMoney(trade.settlementAmount),
    fee: 0,
    amount: roundMoney(trade.settlementAmount),
    source: trade.sourcePdf,
    note: `汇丰香港基金${trade.side === "buy" ? "认购" : "赎回"}；成交单号 ${trade.reference}，结算日期 ${trade.settlementDate}`,
  };
}

function openPositionFromHolding(holding: HsbcHolding): OpenPosition {
  const symbol = shortFundSymbol(holding.fundId, holding.fundName);
  return {
    id: `hsbc-open-${holding.statementDate}-${holding.currency}-${symbol}`,
    broker: HSBC_BROKER,
    asOf: holding.statementDate,
    market: "基金",
    currency: holding.currency,
    symbol,
    securityName: holding.fundName,
    quantity: holding.closingUnits,
    marketValue: holding.marketValue,
    source: holding.sourcePdf,
    note: `汇丰香港月末基金持仓；参考价 ${holding.unitPrice.toFixed(4)} ${holding.currency}，平均成本由买入记录携带。`,
  };
}

function aggregateIssue(raw: HsbcRawData): ReviewIssue {
  const buys = raw.trades.filter((t) => t.side === "buy").length;
  const sells = raw.trades.filter((t) => t.side === "sell").length;
  return {
    id: `hsbc-${raw.accountNo}-${raw.statementDate}-parsed`,
    severity: "info",
    title: "已解析汇丰香港基金月结单",
    detail: `已读取汇丰香港月结单（户口 ${raw.accountNo}，户名 ${raw.accountName}，日期 ${raw.statementDate}）：基金买入 ${buys} 笔，卖出 ${sells} 笔，月末基金持仓 ${raw.holdings.length} 条。`,
    source: raw.trades[0]?.sourcePdf ?? "",
  };
}

export async function parseHsbcPdfs(
  files: HsbcFileInput[],
  _options: { targetYear?: number } = {},
): Promise<ParsedInput> {
  const parsed = emptyParsedInput();

  let investmentServicesFiles: string[] = [];
  let totalTrades = 0;
  let totalHoldings = 0;
  let buysAcrossFiles = 0;
  let sellsAcrossFiles = 0;
  let firstAccount = "";
  let firstAccountName = "";
  let firstStatementDate = "";

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      const raw = parseHsbcLines(file.name, lines, 0);

      if (!raw.statementDetected) {
        // 不是投资服务月结单（如 HSBC One 账户结单），静默忽略让 ONE 解析器处理
        continue;
      }

      investmentServicesFiles.push(file.name);
      totalTrades += raw.trades.length;
      totalHoldings += raw.holdings.length;
      buysAcrossFiles += raw.trades.filter((t) => t.side === "buy").length;
      sellsAcrossFiles += raw.trades.filter((t) => t.side === "sell").length;
      if (!firstAccount) firstAccount = raw.accountNo;
      if (!firstAccountName) firstAccountName = raw.accountName;
      if (!firstStatementDate) firstStatementDate = raw.statementDate;

      for (const trade of raw.trades) {
        parsed.tradeActivities.push(activityFromTrade(trade));
      }

      // Deduplicate holdings by symbol, keep latest by statement date
      const latestBySymbol = new Map<string, HsbcHolding>();
      for (const h of raw.holdings) {
        const key = `${h.currency}::${shortFundSymbol(h.fundId, h.fundName)}`;
        const existing = latestBySymbol.get(key);
        if (!existing || h.statementDate.localeCompare(existing.statementDate) >= 0) {
          latestBySymbol.set(key, h);
        }
      }
      const latestHoldings = Array.from(latestBySymbol.values());
      for (const holding of latestHoldings) {
        if (holding.closingUnits > 0) {
          parsed.openPositions.push(openPositionFromHolding(holding));
        }
      }

      parsed.issues.push(...raw.issues);
    } catch (error) {
      parsed.issues.push({
        id: `hsbc-${file.name}-pdf-error`,
        severity: "blocking",
        title: "汇丰香港 PDF 解析失败",
        detail: error instanceof Error ? error.message : "未知 PDF 解析错误。",
        source: file.name,
      });
    }
  }

  // 一次性汇总消息：避免每份月结单单独发"本月没有交易"之类的提示
  if (investmentServicesFiles.length > 0 && (totalTrades > 0 || totalHoldings > 0)) {
    parsed.issues.push({
      id: `hsbc-investment-services-summary-${investmentServicesFiles.length}-files`,
      severity: "info",
      title: "已解析汇丰香港投资服务基金月结单",
      detail: `已读取 ${investmentServicesFiles.length} 份月结单（户口 ${firstAccount}，户名 ${firstAccountName}）：基金买入 ${buysAcrossFiles} 笔，卖出 ${sellsAcrossFiles} 笔，月末基金持仓 ${totalHoldings} 条。`,
      source: investmentServicesFiles[0],
    });
  }

  return parsed;
}
