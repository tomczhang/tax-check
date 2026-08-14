import { emptyParsedInput } from "@/lib/tax/calculator";
import type {
  Currency,
  DividendIncome,
  OpenPosition,
  ParsedInput,
  ReviewIssue,
  TradeActivity,
} from "@/lib/tax/types";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

interface ZaFileInput {
  name: string;
  data: ArrayBuffer;
}

export interface ManualCostInput {
  id: string;
  costBasis: number;
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

type ZaSide = "subscribe" | "redeem";

interface ZaTransaction {
  sourcePdf: string;
  page: number;
  fundName: string;
  fundNameZh: string;
  isin: string;
  side: ZaSide;
  orderDate: string;
  dealingDate: string;
  confirmationDate: string;
  currency: Currency;
  amount: number;
  fee: number;
  units: number;
  unitPrice: number;
  reference: string;
  sequence: number;
}

interface ZaRawData {
  transactions: ZaTransaction[];
  holdings: ZaHolding[];
  dividends: ZaDividend[];
  statementDate: string;
  issues: ReviewIssue[];
  statementDetected: boolean;
}

interface ZaHolding {
  sourcePdf: string;
  statementDate: string;
  fundName: string;
  fundNameZh: string;
  currency: Currency;
  openingUnits: number;
  closingUnits: number;
  referencePrice: number;
  marketValueOriginal: number;
  marketValueHkd: number;
  sequence: number;
}

interface ZaDividend {
  sourcePdf: string;
  page: number;
  date: string;
  currency: Currency;
  amount: number;
  description: string;
  sequence: number;
}

const ZA_BROKER = "ZA Bank";

function clean(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function compactText(value: string) {
  return clean(value);
}

function parseNumber(value: string) {
  const normalized = value.replace(/,/g, "").replace(/[()]/g, "").replace(/[^0-9.+-]/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function mapCurrency(value: string): Currency {
  const text = value.toUpperCase();
  if (text.includes("USD")) return "USD";
  if (text.includes("CNY") || text.includes("人民币")) return "CNY";
  return "HKD";
}

function tokensInRange(line: TextLine, minX: number, maxX: number) {
  return line.tokens.filter((token) => token.x >= minX && token.x < maxX);
}

function isZaStatement(lines: TextLine[]) {
  const head = lines.slice(0, 60).map((line) => line.text).join("\n");
  return /ZA\s*Bank|众安銀行|众安银行|bank\.za\.group|Investment\s*Fund\s*Contract\s*Note|基金成交单|Investment\s*Account\s*Monthly\s*Statement|投资账户月结单/.test(head);
}

function isZaMonthlyStatement(lines: TextLine[]) {
  const head = lines.slice(0, 30).map((line) => line.text).join("\n");
  return /Investment\s*Account\s*Monthly\s*Statement|投资账户月结单/.test(head);
}

function normalizeShortDate(value: string, hint: string) {
  // value: "06 Jun 2024"；hint 是该行的上下文（不一定需要）
  const m = clean(value).match(/^(\d{1,2})\s*([A-Za-z]{3,})\s*(\d{4})$/);
  if (!m) return "";
  const months: Record<string, string> = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
  };
  const mm = months[m[2]] ?? "01";
  return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
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

        lines.push(
          ...groups
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

interface LabelLookup {
  [label: string]: string; // 标签 → 下一行（值行）text
}

function buildLabelMap(lines: TextLine[]): LabelLookup {
  // ZA PDF 布局：标签 (x<200) + 值 (x≥200) 在同一行；或标签占一行、值占下一行。
  // 优先取同行右侧值；同行无值时取下一行整行文本。
  const result: LabelLookup = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const compact = compactText(line.text);
    if (!compact) continue;
    const leftTokens = tokensInRange(line, 0, 200);
    if (leftTokens.length === 0) continue;
    const rightTokens = tokensInRange(line, 200, 1000);
    const rightValue = rightTokens.map((t) => t.text).join(" ").trim();
    const nextLine = lines[i + 1];
    const nextValue = nextLine ? nextLine.text.trim() : "";
    for (const token of leftTokens) {
      // label key 用完全去空格的版本（Fund Name → FundName），值保留原文
      const label = token.text.replace(/\s+/g, "").trim();
      if (!label) continue;
      // 优先使用同行右侧值；如果同行右侧为空，则用下一行
      if (rightValue) {
        result[label] = rightValue;
      } else if (nextValue) {
        result[label] = nextValue;
      }
    }
  }
  return result;
}

function pickValueAfter(label: string, labelMap: LabelLookup, searchTokens: string[]) {
  // 在 label 行之后第一个含 searchTokens 之一的行作为值
  // 这里使用更简单的方法：label 行通常是英文，紧跟的下一行是值
  // 已经在 buildLabelMap 配对了
  return labelMap[label] ?? "";
}

function parseDateInText(text: string) {
  const m = clean(text).match(/(\d{1,2})\s*([A-Za-z]{3,})\s*(\d{4})/);
  if (!m) return "";
  return normalizeShortDate(`${m[1]} ${m[2]} ${m[3]}`, text);
}

function parseAmountWithCurrency(text: string) {
  // "USD 5,027.73" 或 "HKD 100,000.00"
  const m = text.match(/(USD|HKD|CNY)\s*([\d,]+\.\d{2})/i);
  if (!m) return { amount: 0, currency: "HKD" as Currency };
  return { amount: parseNumber(m[2]), currency: mapCurrency(m[1]) };
}

function parseFeeWithCurrency(text: string) {
  // "USD 0.00(0.00%)"
  const m = text.match(/(USD|HKD|CNY)\s*([\d,]+\.\d{2})\s*\(\s*([\d.]+)\s*%\s*\)/i);
  if (!m) return { fee: 0, percent: 0 };
  return { fee: parseNumber(m[2]), percent: parseNumber(m[3]) };
}

function parseZaTransaction(sourcePdf: string, lines: TextLine[], baseSequence: number): ZaTransaction | null {
  const labelMap = buildLabelMap(lines);

  // Fund Name
  const fundNameRaw = labelMap["FundName"] ?? "";
  const fundName = compactText(fundNameRaw);
  if (!fundName) return null;

  // 基金中文名（取 "基金名称" 标签下一行）
  const fundNameZh = compactText(labelMap["基金名称"] ?? "");

  // ISIN
  const isinMatch = lines.map((l) => l.text).join("\n").match(/HK\d{10}/);
  const isin = isinMatch ? isinMatch[0] : "";
  if (!isin) return null;

  // Transaction Type
  const txTypeRaw = compactText(labelMap["TransactionType"] ?? labelMap["交易类别"] ?? "");
  let side: ZaSide | null = null;
  if (/Subscription|认购/.test(txTypeRaw)) side = "subscribe";
  else if (/Redemption|赎回/.test(txTypeRaw)) side = "redeem";
  if (!side) return null;

  // Order / Dealing / Confirmation Date
  const orderDate = parseDateInText(labelMap["OrderDate"] ?? labelMap["订单日期"] ?? "");
  const dealingDate = parseDateInText(labelMap["DealingDate"] ?? labelMap["交易日期"] ?? "");
  const confirmationDate = parseDateInText(labelMap["ConfirmationDate"] ?? labelMap["确认日期"] ?? "");
  if (!dealingDate) return null;

  // Amount
  const amountLabel = side === "subscribe" ? "SubscriptionAmount(includingfees)" : "RedemptionAmount";
  const amountRaw = labelMap[amountLabel] ?? (side === "subscribe" ? labelMap["SubscriptionAmount"] ?? "" : "");
  const amountParsed = parseAmountWithCurrency(amountRaw);

  // Fee
  const feeLabel = side === "subscribe" ? "SubscriptionFee" : "RedemptionFee";
  const feeRaw = labelMap[feeLabel] ?? "";
  const feeParsed = parseFeeWithCurrency(feeRaw);

  // Units
  const unitsRaw = labelMap["No.ofUnits"] ?? labelMap["单位数目"] ?? "";
  const units = parseNumber(unitsRaw);

  // Unit Price
  const unitPriceRaw = labelMap["UnitPrice"] ?? labelMap["单位价格"] ?? "";
  const unitPriceParsed = parseAmountWithCurrency(unitPriceRaw);

  // Reference
  const refRaw = labelMap["TransactionReference"] ?? labelMap["交易编号"] ?? "";
  const reference = compactText(refRaw);

  // symbol 用中文基金名（若中文名缺失回退英文名），与月结单交易 symbol 一致，保证跨来源成本链衔接
  const symbol = shortFundKey(fundNameZh || fundName);
  return {
    sourcePdf,
    page: 1,
    fundName,
    fundNameZh,
    isin: symbol,
    side,
    orderDate,
    dealingDate,
    confirmationDate,
    currency: amountParsed.currency,
    amount: amountParsed.amount,
    fee: feeParsed.fee,
    units,
    unitPrice: unitPriceParsed.amount,
    reference,
    sequence: baseSequence,
  };
}

function parseZaPdfs(files: ZaFileInput[], _options: { targetYear?: number; manualCosts?: ManualCostInput[] } = {}): Promise<ParsedInput> {
  const parsed = emptyParsedInput();
  const raw: ZaRawData = {
    transactions: [],
    holdings: [],
    dividends: [],
    statementDate: "",
    issues: [],
    statementDetected: false,
  };
  let sequence = 0;

  return (async () => {
    for (const file of files) {
      try {
        const lines = await extractPdfLines(file.name, file.data);
        if (!isZaStatement(lines)) {
          parsed.issues.push({
            id: `za-${file.name}-not-detected`,
            severity: "warning",
            title: "未识别为 ZA Bank 文件",
            detail: "PDF 缺少 ZA Bank / 众安银行 / Investment Fund Contract Note / 投资账户月结单 特征，请确认券商选择。",
            source: file.name,
          });
          continue;
        }
        raw.statementDetected = true;

        if (isZaMonthlyStatement(lines)) {
          // 月结单：解析持仓 + 已确认交易 + 收益费用
          const result = parseZaMonthlyStatement(file.name, lines, sequence);
          raw.transactions.push(...result.transactions);
          raw.holdings.push(...result.holdings);
          raw.dividends.push(...result.dividends);
          if (result.statementDate) raw.statementDate = result.statementDate;
          sequence += result.transactions.length;
          if (result.issues.length > 0) parsed.issues.push(...result.issues);
        } else {
          // 成交单：解析单笔交易
          const tx = parseZaTransaction(file.name, lines, sequence);
          if (tx) {
            raw.transactions.push(tx);
            sequence += 1;
          } else {
            parsed.issues.push({
              id: `za-${file.name}-parse-failed`,
              severity: "warning",
              title: "ZA Bank 基金成交单解析失败",
              detail: "无法从 PDF 中识别出完整的基金交易字段（基金名/ISIN/交易类型/日期/金额等）。",
              source: file.name,
            });
          }
        }
      } catch (error) {
        parsed.issues.push({
          id: `za-${file.name}-pdf-error`,
          severity: "blocking",
          title: "ZA Bank PDF 解析失败",
          detail: error instanceof Error ? error.message : "未知 PDF 解析错误。",
          source: file.name,
        });
      }
    }

    if (!raw.statementDetected) {
      parsed.issues.push({
        id: "za-unsupported-statement",
        severity: "blocking",
        title: "ZA Bank 文件格式不符合要求",
        detail: "当前没有识别到 ZA Bank / 众安银行 / Investment Fund Contract Note / 投资账户月结单 特征，请确认券商选择和 PDF 文件。",
        source: files[0]?.name,
      });
      return parsed;
    }

    // 去重：月结单优先。成交单交易若与月结单交易重复则丢弃。
  // key 用 (date|side|currency|units|amount) 不依赖 symbol，因为月结单无 ISIN。
  const msTxKeys = new Set<string>();
  for (const tx of raw.transactions) {
    if (tx.sourcePdf.toLowerCase().includes("statement")) {
      msTxKeys.add(zaTxDedupKey(tx));
    }
  }
  const keptTxs = raw.transactions.filter((tx) => {
    if (tx.sourcePdf.toLowerCase().includes("statement")) return true;
    return !msTxKeys.has(zaTxDedupKey(tx));
  });
  if (keptTxs.length < raw.transactions.length) {
    parsed.issues.push({
      id: `za-${files.length}-dedup`,
      severity: "info",
      title: "ZA Bank 月结单与成交单已去重",
      detail: `成交单中 ${raw.transactions.length - keptTxs.length} 笔交易与月结单已确认交易重复，已自动跳过，避免重复计入成本与盈亏。`,
      source: files[0]?.name,
    });
  }

  for (const tx of keptTxs) {
    const isBuy = tx.side === "subscribe";
    const activity: TradeActivity = {
      id: `za-${tx.side}-${tx.dealingDate}-${tx.sequence}-${tx.isin}`,
      broker: ZA_BROKER,
      date: tx.dealingDate,
      sequence: tx.sequence,
      market: "基金",
      currency: tx.currency,
      symbol: tx.isin,
      securityName: tx.fundName,
      side: isBuy ? "buy" : "sell",
      quantity: tx.units,
      unitPrice: tx.unitPrice,
      grossAmount: roundMoney(tx.amount - tx.fee),
      fee: tx.fee,
      amount: tx.amount,
      source: tx.sourcePdf,
      note: tx.sourcePdf.toLowerCase().includes("statement")
        ? `${tx.fundNameZh ? `${tx.fundNameZh} · ` : ""}基金${isBuy ? "认购" : "赎回"}；ZA Bank 投资账户月结单`
        : `${tx.fundNameZh ? `${tx.fundNameZh} · ` : ""}基金${isBuy ? "认购" : "赎回"}（${tx.reference}）；ZA Bank 基金成交单`,
    };
    parsed.tradeActivities.push(activity);
  }

  // 持仓：保留每只基金最新一份（按 asOf 排序）
  const holdingMap = new Map<string, ZaHolding>();
  for (const h of raw.holdings) {
    const key = `${h.currency}::${h.fundName}`;
    const existing = holdingMap.get(key);
    if (!existing || h.statementDate.localeCompare(existing.statementDate) >= 0) {
      holdingMap.set(key, h);
    }
  }
  for (const h of holdingMap.values()) {
    // 期末已清仓（closing=0）的基金不再计入持仓
    if (h.closingUnits <= 0) continue;
    const open: OpenPosition = {
      id: `za-open-${h.statementDate}-${h.currency}-${shortFundKey(h.fundName)}`,
      broker: ZA_BROKER,
      asOf: h.statementDate,
      market: "基金",
      currency: h.currency,
      symbol: shortFundKey(h.fundName),
      securityName: h.fundName,
      quantity: h.closingUnits,
      marketValue: h.marketValueHkd > 0 ? h.marketValueHkd : h.marketValueOriginal,
      costBasis: undefined, // 月结单不提供平均成本
      source: h.sourcePdf,
      note: `${h.fundNameZh ? `${h.fundNameZh} · ` : ""}基金月末持仓；参考价 ${h.referencePrice.toFixed(6)} ${h.currency}，期初 ${h.openingUnits} → 期末 ${h.closingUnits}。`,
    };
    parsed.openPositions.push(open);
  }

    // 收益（派息/费用）：作为 dividend 记录
    for (const d of raw.dividends) {
      const div: DividendIncome = {
        id: `za-div-${d.date}-${d.sequence}-${d.currency}`,
        broker: ZA_BROKER,
        date: d.date,
        currency: d.currency,
        symbol: "ZA-CASH",
        securityName: "ZA Bank 基金收益",
        grossAmount: d.amount,
        taxWithheld: 0,
        fee: 0,
        source: d.sourcePdf,
        note: d.description,
        evidence: { page: d.page, text: `${d.date} ${d.description} ${d.currency} ${d.amount.toFixed(2)}` },
      };
      parsed.dividends.push(div);
    }

    if (raw.transactions.length > 0 || raw.holdings.length > 0 || raw.dividends.length > 0) {
      const subs = raw.transactions.filter((t) => t.side === "subscribe").length;
      const reds = raw.transactions.filter((t) => t.side === "redeem").length;
      const sources = Array.from(new Set([
        ...raw.transactions.map((t) => t.sourcePdf),
        ...raw.holdings.map((h) => h.sourcePdf),
        ...raw.dividends.map((d) => d.sourcePdf),
      ]));
      parsed.issues.push({
        id: `za-${sources.length}-parsed`,
        severity: "info",
        title: "已解析 ZA Bank 文件",
        detail: `已读取 ${sources.length} 份 ZA Bank 文件：基金认购 ${subs} 笔，赎回 ${reds} 笔，月末基金持仓 ${holdingMap.size} 条，收益/费用 ${raw.dividends.length} 笔。月结单与成交单会自动按 (日期+方向+币种+基金+数量+价格) 去重。`,
        source: sources[0],
      });
    }

    parsed.issues.push(...raw.issues);
    return parsed;
  })();
}

// 月结单解析
interface MonthlyStatementResult {
  transactions: ZaTransaction[];
  holdings: ZaHolding[];
  dividends: ZaDividend[];
  statementDate: string;
  issues: ReviewIssue[];
}

function shortFundKey(fundName: string) {
  let hash = 5381;
  for (let i = 0; i < fundName.length; i += 1) {
    hash = ((hash << 5) + hash + fundName.charCodeAt(i)) >>> 0;
  }
  return `ZA${hash.toString(36).toUpperCase().padStart(7, "0")}`;
}

function zaTxDedupKey(tx: ZaTransaction) {
  return [
    tx.dealingDate,
    tx.side,
    tx.currency,
    tx.units.toFixed(4),
    tx.amount.toFixed(2),
  ].join("|");
}

// 持仓数据行判断：右侧 (x≥290) 有多个数字 token 的数字行
function isHoldingDataLine(line: TextLine) {
  const rightNumbers = line.tokens.filter((t) => t.x >= 290 && /^[\d,]+\.\d+$/.test(t.text.trim()));
  return rightNumbers.length >= 2;
}

// 持仓中/交易中的基金名行（左侧无数字，不是列标题）
function isFundNameOnlyLine(line: TextLine) {
  const text = line.text.trim();
  if (!text) return false;
  if (/\d/.test(text)) return false;
  if (/Fund\s*基金|基金名称|Opening|Closing|Currency|Reference|Market\s*Value|期初|期终|币种|参考价|市值|等值|Date\s*Description|日期说明|No\.\s*of\s*Units|单位数目/.test(text)) return false;
  return true;
}

function parseZaMonthlyStatement(
  sourcePdf: string,
  lines: TextLine[],
  baseSequence: number,
): MonthlyStatementResult {
  const result: MonthlyStatementResult = {
    transactions: [],
    holdings: [],
    dividends: [],
    statementDate: "",
    issues: [],
  };
  let sequence = baseSequence;

  // 结单日期
  for (const line of lines) {
    const m = line.text.match(/结单日期\s*[:：]?\s*(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/);
    if (m) {
      result.statementDate = normalizeShortDate(m[1], line.text);
      break;
    }
  }

  let section: "" | "holdings" | "confirmed" | "pending" | "income" = "";

  // 持仓解析状态：中文名行 → 数据行 → 英文名行
  let holdZh = "";
  let holdDataLine: TextLine | null = null;

  // 交易解析状态：等待中文名行（作为 fundNameZh 提示）+ 下一 data 行
  // 预扫所有中文提示行（"认购/赎回 中文基金名"），供交易日期行关联
  const zhHints: Array<{ index: number; zh: string; side: ZaSide }> = [];
  for (let k = 0; k < lines.length; k += 1) {
    const canonical = clean(lines[k].text);
    const m = canonical.match(/(认购|認購|赎回|贖回)\s*([一-鿿][^\d]*?)(?:\s*$)/);
    if (m && /[一-鿿]/.test(m[2])) {
      const zh = clean(m[2]);
      if (zh.length >= 4) {
        zhHints.push({
          index: k,
          zh,
          side: /认购|認購/.test(m[1]) ? "subscribe" : "redeem",
        });
      }
    }
  }
  const usedHint = new Set<number>();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const text = line.text;
    const compact = compactText(text);

    // 段落切换
    if (/Investment\s*Holdings|Investment\s*account\s*position/.test(compact)) {
      section = "holdings";
      holdZh = "";
      holdDataLine = null;
      continue;
    }
    if (/Confirmed\s*Transaction|已确认交易/.test(compact)) {
      section = "confirmed";
      continue;
    }
    if (/Fund\s*Pending\s*Transaction|基金处理中交易/.test(compact)) {
      section = "pending";
      continue;
    }
    if (/Income\s*and\s*Charges|收益及费用/.test(compact)) {
      section = "income";
      continue;
    }
    if (/Holdings\s*Movement|持仓及份额变动/.test(compact)) {
      section = "";
      continue;
    }
    if (/Important\s*Notice|重要提示/.test(compact)) {
      section = "";
      continue;
    }

    // ============ 持仓段 ============
    if (section === "holdings") {
      // 中文基金名行（如 "泰康开泰港元货币 HKD (B Acc)"）
      if (/[一-鿿]/.test(text) && isFundNameOnlyLine(line) && !isHoldingDataLine(line)) {
        holdZh = text.trim();
        holdDataLine = null;
        continue;
      }
      // 英文基金名行（如 "Taikang Kaitai Hong Kong Dollar Money Market HKD (B Acc)"）
      if (!/[一-鿿]/.test(text) && isFundNameOnlyLine(line) && !isHoldingDataLine(line)) {
        if (holdDataLine && holdZh) {
          const h = parseHoldingRow(holdDataLine, holdZh, text.trim(), result.statementDate, sourcePdf, sequence);
          if (h) {
            result.holdings.push(h);
            sequence += 1;
          }
          holdZh = "";
          holdDataLine = null;
        }
        continue;
      }
      // 数据行
      if (isHoldingDataLine(line)) {
        if (holdZh && !holdDataLine) {
          holdDataLine = line;
        }
        continue;
      }
      continue;
    }

    // ============ 交易段 ============
    if (section === "confirmed" || section === "pending") {
      // 数据行：以日期开头
      const dateMatch = text.match(/^(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/);
      if (dateMatch) {
        const dealingDate = normalizeShortDate(dateMatch[1], text);
        const isPending = section === "pending";
        // 用 x 坐标 + currency 相对列解析
        // 列顺序：description(...~350) | units | currency | unitPrice | fee | amount
        const curToken = line.tokens.find(
          (t) => /^[A-Z]{3}$/.test(t.text.trim()) && (t.text.trim() === "USD" || t.text.trim() === "HKD" || t.text.trim() === "CNY"),
        );
        const rightNumbers = curToken
          ? line.tokens.filter((t) => t.x > curToken.x && /^[\d,]+\.\d+$/.test(t.text.trim()))
          : [];
        // currency 右侧：unitPrice, fee, amount（amount 在最右）
        const unitPrice = rightNumbers.length >= 1 ? parseNumber(rightNumbers[0].text) : 0;
        const fee = rightNumbers.length >= 2 ? parseNumber(rightNumbers[1].text) : 0;
        const amount = rightNumbers.length >= 3 ? parseNumber(rightNumbers[rightNumbers.length - 1].text) : 0;
        // units：currency 左侧最近的数字 token
        let units = 0;
        if (curToken) {
          const leftNumbers = line.tokens
            .filter((t) => t.x < curToken.x && /^[\d,]+\.\d+$/.test(t.text.trim()))
            .sort((a, b) => b.x - a.x);
          if (leftNumbers[0]) units = parseNumber(leftNumbers[0].text);
        }
        const currency = curToken ? mapCurrency(curToken.text) : "HKD";

        // 关联最近且未使用的中文提示行（前后 4 行内）确定 fundNameZh 与 side
        let fundNameZh = "";
        let hintSide: ZaSide | null = null;
        let bestHintIdx = -1;
        let bestDist = 99;
        for (let hi = 0; hi < zhHints.length; hi += 1) {
          const hint = zhHints[hi];
          if (usedHint.has(hi)) continue;
          const dist = Math.abs(hint.index - i);
          if (dist <= 4 && dist < bestDist) {
            bestDist = dist;
            bestHintIdx = hi;
            fundNameZh = hint.zh;
            hintSide = hint.side;
          }
        }
        if (bestHintIdx >= 0) usedHint.add(bestHintIdx);

        // 找英文 description 行：在 [i, i+3] 内找含英文 Subscription/Redemption 的行
        let descLineIdx = -1;
        for (let j = i; j <= Math.min(i + 3, lines.length - 1); j += 1) {
          const lt = compactText(lines[j].text);
          if (/(Subscription|Redemption)/.test(lt)) {
            descLineIdx = j;
            break;
          }
        }
        let side: ZaSide | null = hintSide;
        let fundNameEn = "";
        if (descLineIdx >= 0) {
          const descLine = lines[descLineIdx];
          const dtext = descLine.tokens
            .filter((t) => t.x >= 125 && t.x < 360)
            .filter((t) => !/^[\d,]+\.\d+$/.test(t.text.trim()))
            .filter((t) => !/^\d{1,2}\s+[A-Za-z]{3,}\s+\d{4}$/.test(t.text.trim()))
            .map((t) => t.text)
            .join(" ")
            .trim();
          const sm = dtext.match(/^(Subscription|Redemption)\s*/);
          if (sm) {
            fundNameEn = dtext.replace(/^(Subscription|Redemption)\s*/, "").trim();
            const dSide = /Subscription/.test(sm[1]) ? "subscribe" : "redeem";
            if (!side) side = dSide;
          }
          // 英文基金名续行：后续连续的 fund-name-only 英文行
          for (let j = descLineIdx + 1; j <= Math.min(lines.length - 1, descLineIdx + 2); j += 1) {
            const nl = lines[j];
            if (isFundNameOnlyLine(nl) && !/[一-鿿]/.test(nl.text)) {
              fundNameEn = `${fundNameEn} ${nl.text.trim()}`.trim();
            } else {
              break;
            }
          }
        }

        if (side && dealingDate && amount > 0) {
          // symbol 用中文基金名（提示行总是完整），保证同基金买卖 symbol 一致
          const symbol = shortFundKey(fundNameZh || fundNameEn);
          result.transactions.push({
            sourcePdf,
            page: line.page,
            fundName: fundNameEn,
            fundNameZh,
            isin: symbol,
            side,
            orderDate: dealingDate,
            dealingDate,
            confirmationDate: dealingDate,
            currency,
            amount,
            fee,
            units,
            unitPrice,
            reference: isPending ? "pending" : `MS-${dealingDate}-${sequence}`,
            sequence: sequence++,
          });
        }
        continue;
      }
      continue;
    }

    // ============ 收益费用段 ============
    if (section === "income") {
      const dateMatch = text.match(/^(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/);
      if (dateMatch) {
        const date = normalizeShortDate(dateMatch[1], text);
        let currency: Currency = "HKD";
        let amount = 0;
        const curToken = line.tokens.find((t) => t.x >= 400 && t.x < 460 && /^[A-Z]{3}$/.test(t.text.trim()));
        const amtToken = line.tokens.find((t) => t.x >= 460 && /^[\d,]+\.\d+$/.test(t.text));
        if (curToken) currency = mapCurrency(curToken.text);
        if (amtToken) amount = parseNumber(amtToken.text);
        const descText = line.tokens
          .filter((t) => t.x >= 130 && t.x < 400)
          .map((t) => t.text)
          .join(" ")
          .trim()
          .slice(0, 100);
        if (date && amount > 0) {
          result.dividends.push({
            sourcePdf,
            page: line.page,
            date,
            currency,
            amount,
            description: `ZA Bank 月结单收益/费用：${descText}`,
            sequence: sequence++,
          });
        }
      }
      continue;
    }
  }

  return result;
}

// 由持仓数据行生成 ZaHolding
function parseHoldingRow(
  dataLine: TextLine,
  zhName: string,
  enName: string,
  statementDate: string,
  sourcePdf: string,
  sequence: number,
): ZaHolding | null {
  // 数据行格式：open | close | currency | price | mv | mvHKD
  // 列坐标在不同月份有偏移，用 currency token 相对定位
  const curToken = dataLine.tokens.find(
    (t) => t.text.trim() === "USD" || t.text.trim() === "HKD" || t.text.trim() === "CNY",
  );
  if (!curToken) return null;
  const currency = mapCurrency(curToken.text);
  const numbers = dataLine.tokens
    .filter((t) => /^[\d,]+\.\d+$/.test(t.text.trim()))
    .sort((a, b) => a.x - b.x);
  // currency 左侧：close(最近), open(再左)；currency 右侧：price, mv, mvHKD
  const leftNums = numbers.filter((t) => t.x < curToken.x);
  const rightNums = numbers.filter((t) => t.x > curToken.x);
  const openingUnits = leftNums.length >= 2 ? parseNumber(leftNums[leftNums.length - 2].text) : 0;
  const closingUnits = leftNums.length >= 1 ? parseNumber(leftNums[leftNums.length - 1].text) : 0;
  const referencePrice = rightNums.length >= 1 ? parseNumber(rightNums[0].text) : 0;
  const marketValueOriginal = rightNums.length >= 2 ? parseNumber(rightNums[1].text) : 0;
  const marketValueHkd = rightNums.length >= 3 ? parseNumber(rightNums[2].text) : 0;
  // 保留所有合法持仓行（含 closing=0 的清仓月份），后续按 asOf 取最新再过滤
  return {
    sourcePdf,
    statementDate,
    fundName: enName,
    fundNameZh: zhName,
    currency,
    openingUnits,
    closingUnits,
    referencePrice,
    marketValueOriginal,
    marketValueHkd,
    sequence,
  };
}

export { ZA_BROKER, parseZaPdfs };
