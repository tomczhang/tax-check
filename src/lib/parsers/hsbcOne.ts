import { emptyParsedInput } from "@/lib/tax/calculator";
import type {
  Currency,
  DividendIncome,
  ParsedInput,
  ReviewIssue,
} from "@/lib/tax/types";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

interface HsbcOneFileInput {
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

interface HsbcOneInterest {
  sourcePdf: string;
  page: number;
  date: string;
  currency: Currency;
  amount: number;
  description: string;
  sequence: number;
}

interface HsbcOneRawData {
  statementDate: string;
  interests: HsbcOneInterest[];
  issues: ReviewIssue[];
  statementDetected: boolean;
}

const HSBC_ONE_BROKER = "汇丰香港";

function clean(value: string) {
  return value.replace(/ /g, "").replace(/\s+/g, " ").trim();
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

function parseHsbcOneDate(value: string, statementDate: string) {
  // Format: "27 Jun" — convert to YYYY-MM-DD based on statement month
  const m = clean(value).match(/^(\d{1,2})\s*([A-Za-z]{3,})$/);
  if (!m) return "";
  const day = m[1].padStart(2, "0");
  const monthMap: Record<string, string> = {
    JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
    JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const month = monthMap[m[2]] ?? "01";
  // statementDate 是 "YYYY-MM-DD"，取 YYYY-MM
  const stmtMatch = statementDate.match(/^(\d{4})-(\d{2})/);
  const stmtYear = stmtMatch ? stmtMatch[1] : new Date().getFullYear().toString();
  const stmtMonth = stmtMatch ? Number(stmtMatch[2]) : 12;
  const txMonth = Number(month);
  // 如果交易月份 > 结单月份，说明是上一年（如 2026-01 结单的 "27 Dec" 实际是 2025-12）
  const txYear = txMonth > stmtMonth ? String(Number(stmtYear) - 1) : stmtYear;
  return `${txYear}-${month}-${day}`;
}

function parseStatementDate(lines: TextLine[]): string {
  // clean() 移除了空格，所以原始 token 之间的空格也不存在；按 token 顺序重组
  for (const line of lines.slice(0, 30)) {
    // 找包含 4 位年份的 token，前后拼接
    for (let i = 0; i < line.tokens.length; i++) {
      const tok = line.tokens[i];
      const m = tok.text.match(/^(\d{1,2})\s*([A-Za-z]+)\s*(\d{4})$/);
      if (m) {
        const monthMap: Record<string, string> = {
          january: "01", february: "02", march: "03", april: "04",
          may: "05", june: "06", july: "07", august: "08",
          september: "09", october: "10", november: "11", december: "12",
        };
        const month = monthMap[m[2].toLowerCase()] ?? "01";
        return `${m[3]}-${month}-${m[1].padStart(2, "0")}`;
      }
    }
  }
  return "";
}

function statementYear(statementDate: string): string {
  return statementDate.slice(0, 4) || new Date().getFullYear().toString();
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

function isHsbcOneStatement(lines: TextLine[]) {
  const text = lines.slice(0, 30).map((l) => l.text).join("\n");
  // 原始 text 已经被 clean() 处理过（首部 replace 把空格去掉），所以要用去空格的形态
  return /HSBCOnePortfolio|HSBCOneAccountTransactionHistory|HSBCOne-Deposits|HSBCOne-Investments|IPSSTM/i.test(text);
}

function parseInterestLine(line: TextLine, defaultCurrency: Currency, statementDate: string): HsbcOneInterest | null {
  // Match: [79]27 Jun [99]  [116]CREDIT INTEREST [174]  [362]0.01 [375]  [499]1,377.95
  // Or:    [73]USD [79]27 Jun [99]  [116]CREDIT INTEREST ...
  const interestToken = line.tokens.find((t) => /interest/i.test(t.text));
  if (!interestToken) return null;

  // Date: scan tokens before interestToken for "DD Mon" pattern
  let dateStr = "";
  for (const token of line.tokens) {
    if (token.x >= interestToken.x) break;
    if (/^\d{1,2}\s*[A-Za-z]{3,}$/.test(token.text)) {
      dateStr = token.text;
      break;
    }
  }
  if (!dateStr) return null;

  // Currency: scan tokens before interestToken for USD/HKD/CNY
  let currency = defaultCurrency;
  for (const token of line.tokens) {
    if (token.x >= interestToken.x) break;
    if (/^(USD|HKD|CNY|RMB)$/i.test(clean(token.text))) {
      currency = mapCurrency(token.text);
      break;
    }
  }

  // Amount: first number token after interestToken
  let amount = 0;
  for (const token of line.tokens) {
    if (token.x <= interestToken.x) continue;
    if (isNumberToken(token.text)) {
      amount = parseNumber(token.text);
      break;
    }
  }
  if (amount <= 0) return null;

  return {
    sourcePdf: "",
    page: line.page,
    date: parseHsbcOneDate(dateStr, statementDate),
    currency,
    amount,
    description: "CREDIT INTEREST",
    sequence: 0,
  };
}

function parseHsbcOneLines(sourcePdf: string, lines: TextLine[], baseSequence: number): HsbcOneRawData {
  const raw: HsbcOneRawData = {
    statementDate: parseStatementDate(lines),
    interests: [],
    issues: [],
    statementDetected: isHsbcOneStatement(lines),
  };
  let sequence = baseSequence;
  let defaultCurrency: Currency = "HKD";

  for (const line of lines) {
    // Track current section currency (HKD Savings / Foreign Currency Savings)
    if (/HKD Savings/i.test(line.text)) defaultCurrency = "HKD";
    if (/Foreign Currency Savings/i.test(line.text)) defaultCurrency = "USD";

    // Inline currency hint on the same line (e.g., "USD ... CREDIT INTEREST")
    for (const token of line.tokens) {
      if (/^(USD|HKD|CNY|RMB)$/i.test(clean(token.text))) {
        defaultCurrency = mapCurrency(token.text);
      }
    }

    const interest = parseInterestLine(line, defaultCurrency, raw.statementDate);
    if (interest) {
      interest.sequence = sequence++;
      interest.sourcePdf = sourcePdf;
      raw.interests.push(interest);
    }
  }
  return raw;
}

function interestFromRecord(record: HsbcOneInterest): DividendIncome {
  return {
    id: `hsbc-one-int-${record.date}-${record.sequence}-${record.currency}`,
    broker: HSBC_ONE_BROKER,
    date: record.date,
    currency: record.currency,
    symbol: "CASH-INTEREST",
    securityName: "汇丰 One 账户存款利息",
    grossAmount: roundMoney(record.amount),
    taxWithheld: 0,
    fee: 0,
    source: record.sourcePdf,
    note: `${record.description}；HSBC One 月结单第 ${record.page} 页`,
    evidence: {
      page: record.page,
      text: `${record.date} ${record.description} ${record.currency} ${record.amount.toFixed(2)}`,
    },
  };
}

function aggregateIssue(raw: HsbcOneRawData): ReviewIssue {
  return {
    id: `hsbc-one-${raw.statementDate}-parsed`,
    severity: "info",
    title: "已解析汇丰 One 账户月结单利息",
    detail: `已读取 HSBC One 月结单（日期 ${raw.statementDate}）：存款利息 ${raw.interests.length} 笔。`,
    source: raw.interests[0]?.sourcePdf ?? "",
  };
}

export async function parseHsbcOnePdfs(files: HsbcOneFileInput[]): Promise<ParsedInput> {
  const parsed = emptyParsedInput();

  for (const file of files) {
    try {
      const lines = await extractPdfLines(file.name, file.data);
      const raw = parseHsbcOneLines(file.name, lines, 0);

      if (!raw.statementDetected) {
        // 不是 ONE 月结单 — 静默忽略（让其它解析器有机会处理）
        continue;
      }

      for (const interest of raw.interests) {
        parsed.dividends.push(interestFromRecord(interest));
      }

      if (raw.interests.length > 0) {
        parsed.issues.push(aggregateIssue(raw));
      }

      parsed.issues.push(...raw.issues);
    } catch (error) {
      parsed.issues.push({
        id: `hsbc-one-${file.name}-pdf-error`,
        severity: "warning",
        title: "汇丰 One 月结单解析失败",
        detail: error instanceof Error ? error.message : "未知 PDF 解析错误。",
        source: file.name,
      });
    }
  }

  return parsed;
}