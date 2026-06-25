import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Calculator,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  CreditCard,
  DollarSign,
  Download,
  FileText,
  Info,
  Megaphone,
  MessageCircle,
  Monitor,
  Pencil,
  Printer,
  RotateCcw,
  Search,
  ShieldCheck,
  Smartphone,
  Square,
  Table2,
  Trash2,
  TrendingUp,
  Upload,
  X,
} from "lucide-react";
import {
  BROKER_FILES,
  COST_METHODS,
  DIVIDEND_RMB,
  DIVIDENDS,
  EXCLUDED_RECORDS,
  FLOW_STOCKS,
  FX,
  fxForTaxYear,
  PNL_ROWS,
  POSITIONS,
  TAX_RATE,
  TAX_YEAR,
} from "./data";
import { initAnalytics, trackReportGenerated } from "./lib/analytics";
import { analyzeUploadedFiles, costCorrectionKeyForRealizedTradeId, recomputeAnalyses } from "./lib/clientAnalyze";
import { ParserValidationError } from "./lib/parsers/common";

const RAW_TOTAL = PNL_ROWS.reduce((sum, row) => sum + row.pnlOriginal * FX[row.market], 0);
const FIFO_TARGET_RMB = 52899.51;
const BASE_RMB = PNL_ROWS.map((row) => row.pnlOriginal * FX[row.market] * (FIFO_TARGET_RMB / RAW_TOTAL));

function fmt(n, digits = 2) {
  return Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtUnit(n) {
  return Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtPrice(n) {
  return Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function signed(n, digits = 2) {
  return `${n >= 0 ? "+" : "-"}${fmt(n, digits)}`;
}

function cnSigned(n, digits = 2) {
  return `${n >= 0 ? "+" : "-"}${fmt(n, digits)}`;
}

function floatingPnlLabel(value) {
  return `${value >= 0 ? "浮盈" : "浮亏"} ${cnSigned(value)}`;
}

function methodById(methodId) {
  return COST_METHODS.find((method) => method.id === methodId) ?? COST_METHODS[0];
}

function multiplierFor(methodId, idx) {
  const method = methodById(methodId);
  if (method.id === "fifo") return 1;
  return method.factor * (1 + ((((idx * 7) % 5) - 2) * 0.012));
}

function computeRows(methodId) {
  return PNL_ROWS.map((row, idx) => {
    const rmb = BASE_RMB[idx] * multiplierFor(methodId, idx);
    return {
      ...row,
      key: `${row.market}-${row.code}`,
      pnlOriginal: rmb / FX[row.market],
      rmb,
    };
  });
}

function summarize(rows) {
  const capitalGain = rows.reduce((sum, row) => sum + row.rmb, 0);
  const capitalTaxBase = Math.max(capitalGain, 0);
  const taxable = capitalTaxBase + DIVIDEND_RMB;
  return {
    capitalGain,
    capitalTaxBase,
    dividend: DIVIDEND_RMB,
    dividendTaxBase: DIVIDEND_RMB,
    dividendWithholdingCredit: 0,
    usDividendTaxBase: 0,
    usDividendWithholdingCredit: 0,
    usDividendNet: 0,
    taxable,
    tax: taxable * TAX_RATE,
    includedCount: rows.length,
  };
}

function emptySummary() {
  return {
    capitalGain: 0,
    capitalTaxBase: 0,
    dividend: 0,
    dividendTaxBase: 0,
    dividendWithholdingCredit: 0,
    usDividendTaxBase: 0,
    usDividendWithholdingCredit: 0,
    usDividendNet: 0,
    taxable: 0,
    tax: 0,
    includedCount: 0,
  };
}

function fxForCurrency(currency, fx = FX) {
  if (currency === "USD") return fx.US;
  if (currency === "HKD") return fx.HK;
  return 1;
}

function dividendNetRmbFromDividends(dividends, fx = FX) {
  return (dividends ?? []).reduce((sum, dividend) => {
    return sum + (dividend.grossAmount - dividend.taxWithheld - dividend.fee) * fxForCurrency(dividend.currency, fx);
  }, 0);
}

function dividendTaxBaseRmbFromDividends(dividends, fx = FX, predicate = () => true) {
  return (dividends ?? []).reduce((sum, dividend) => {
    if (!predicate(dividend)) return sum;
    return sum + dividend.grossAmount * fxForCurrency(dividend.currency, fx);
  }, 0);
}

function dividendWithholdingRmbFromDividends(dividends, fx = FX, predicate = () => true) {
  return (dividends ?? []).reduce((sum, dividend) => {
    if (!predicate(dividend)) return sum;
    return sum + dividend.taxWithheld * fxForCurrency(dividend.currency, fx);
  }, 0);
}

function isUsDividend(dividend) {
  return currencyToMarket(dividend.currency) === "US";
}

function summaryFromAnalysis(analysis, fx = FX) {
  if (!analysis) return emptySummary();
  const usDividendTaxBase = dividendTaxBaseRmbFromDividends(analysis.dividends, fx, isUsDividend);
  const usDividendWithholdingCredit = dividendWithholdingRmbFromDividends(analysis.dividends, fx, isUsDividend);
  return {
    capitalGain: analysis.summary.capitalGainRmb,
    capitalTaxBase: analysis.summary.capitalTaxBaseRmb,
    dividend: dividendNetRmbFromDividends(analysis.dividends, fx),
    dividendTaxBase: analysis.summary.dividend.taxableBaseRmb,
    dividendWithholdingCredit: analysis.summary.dividend.withholdingCreditRmb,
    usDividendTaxBase,
    usDividendWithholdingCredit,
    usDividendNet: dividendNetRmbFromDividends(analysis.dividends.filter(isUsDividend), fx),
    taxable: analysis.summary.capitalTaxBaseRmb + analysis.summary.dividend.taxableBaseRmb,
    tax: analysis.summary.totalEstimatedTaxRmb,
    includedCount: analysis.symbols.length,
  };
}

function marketCodeFromText(market) {
  const text = String(market ?? "").toUpperCase();
  if (text.includes("美国") || text.includes("US")) return "US";
  return "HK";
}

function currencyToMarket(currency, market) {
  if (currency === "USD") return "US";
  if (currency === "HKD") return "HK";
  return marketCodeFromText(market);
}

function isUnresolvedSymbol(symbol) {
  return String(symbol ?? "").startsWith("UNRESOLVED-");
}

function displayRowCode(code) {
  return isUnresolvedSymbol(code) ? "待补代码" : code;
}

function securityAliasStateKey(row) {
  return `${row.broker}::${row.currency}::${row.name}`;
}

function normalizeSecuritySymbolInput(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function securityAliasInputsFromState(securityAliases) {
  return Object.values(securityAliases ?? {})
    .map((item) => ({
      name: String(item.name ?? "").trim(),
      symbol: normalizeSecuritySymbolInput(item.symbol),
      market: item.market,
      currency: item.currency,
    }))
    .filter((item) => item.name && item.symbol);
}

function rowsFromAnalysis(analysis) {
  if (!analysis) return [];
  const rows = analysis.symbols.map((symbol) => {
    const market = currencyToMarket(symbol.currency, symbol.market);
    const trades = analysis.realizedTrades.filter(
      (trade) => trade.broker === symbol.broker && trade.currency === symbol.currency && trade.symbol === symbol.symbol,
    );
    return {
      key: `${symbol.broker}::${symbol.currency}::${symbol.symbol}`,
      broker: symbol.broker,
      market,
      code: symbol.symbol,
      name: symbol.securityName,
      currency: symbol.currency,
      quantity: symbol.quantity,
      proceeds: symbol.proceeds,
      costBasis: symbol.costBasis,
      pnlOriginal: symbol.gainLoss,
      rmb: symbol.gainLossRmb,
      transactions: trades,
    };
  });
  const existingKeys = new Set(rows.map((row) => row.key));
  const missingRows = (analysis.costBasisRequests ?? [])
    .map((request) => {
      const key = `${request.broker}::${request.currency}::${request.symbol}`;
      if (existingKeys.has(key)) return null;
      const market = currencyToMarket(request.currency, request.market);
      return {
        key,
        broker: request.broker,
        market,
        code: request.symbol,
        name: request.securityName,
        currency: request.currency,
        quantity: request.quantity,
        proceeds: request.proceeds,
        costBasis: null,
        pnlOriginal: null,
        rmb: null,
        missingCost: true,
        missingCostRequest: request,
        transactions: [],
      };
    })
    .filter(Boolean);
  const positionRows = (analysis.openPositions ?? [])
    .map((position) => {
      const baseKey = `${position.broker}::${position.currency}::${position.symbol}`;
      const market = currencyToMarket(position.currency, position.market);
      const unrealized = Number.isFinite(position.unrealizedGainLoss) ? position.unrealizedGainLoss : null;
      return {
        key: `${baseKey}::position`,
        broker: position.broker,
        market,
        code: position.symbol,
        name: position.securityName,
        currency: position.currency,
        quantity: position.quantity,
        proceeds: position.marketValue,
        costBasis: position.costBasis ?? null,
        pnlOriginal: unrealized,
        rmb: unrealized === null ? null : unrealized * (analysis.config.fxRates[position.currency] ?? 1),
        positionOnly: true,
        position,
        transactions: [],
      };
    })
    .filter(Boolean);
  return [...missingRows, ...rows, ...positionRows];
}

function dividendsFromAnalysis(analysis) {
  return analysis?.dividends ?? [];
}

function openPositionsFromAnalysis(analysis) {
  return analysis?.openPositions ?? [];
}

function tradeActivitiesFromAnalysis(analysis) {
  return analysis?.tradeActivities ?? [];
}

function isTransferActivity(activity) {
  return ["acquire", "transfer_in", "transfer_out"].includes(activity.side);
}

function transferSideLabel(activity) {
  if (activity.side === "transfer_out") return "转出";
  if (activity.side === "transfer_in") return "转入";
  if (String(activity.note ?? "").includes("IPO")) return "IPO中签";
  return "成本带入";
}

function transferRecordsFromActivities(activities) {
  return (activities ?? [])
    .filter(isTransferActivity)
    .map((activity) => {
      const market = currencyToMarket(activity.currency, activity.market);
      const amount = activity.side === "transfer_out" ? null : Math.abs(activity.amount ?? 0);
      return {
        id: activity.id,
        date: activity.date,
        broker: activity.broker,
        market,
        code: activity.symbol,
        name: activity.securityName,
        currency: activity.currency,
        side: transferSideLabel(activity),
        rawSide: activity.side,
        quantity: activity.quantity,
        amount,
        source: activity.source,
        note: activity.note,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code) || a.side.localeCompare(b.side));
}

function coverageMonths(year, files, tradeActivities, dividends, realizedTrades, openPositions) {
  const activeMonths = new Set();
  const addDate = (date) => {
    const text = String(date ?? "");
    if (!text.startsWith(`${year}-`)) return;
    const month = text.slice(5, 7);
    if (/^\d{2}$/.test(month)) activeMonths.add(month);
  };
  const addAllMonths = () => {
    for (let month = 1; month <= 12; month += 1) activeMonths.add(String(month).padStart(2, "0"));
  };

  (files ?? []).forEach((file) => {
    const name = String(file.name ?? "");
    if (file.type === "年度清单" || name.includes("年度")) {
      addAllMonths();
      return;
    }
    const compactMonth = name.match(new RegExp(`${year}[-_年.]?(0[1-9]|1[0-2])`))?.[1];
    const chineseMonth = name.match(/(?:^|[^0-9])(0?[1-9]|1[0-2])月/)?.[1];
    const month = compactMonth ?? (chineseMonth ? chineseMonth.padStart(2, "0") : null);
    if (month) activeMonths.add(month);
  });

  (tradeActivities ?? []).forEach((activity) => addDate(activity.date));
  (dividends ?? []).forEach((dividend) => addDate(dividend.date));
  (realizedTrades ?? []).forEach((trade) => addDate(trade.sellDate));
  (openPositions ?? []).forEach((position) => addDate(position.asOf));

  return Array.from({ length: 12 }, (_, index) => {
    const month = String(index + 1).padStart(2, "0");
    return [month, activeMonths.has(month) ? "ok" : "gap"];
  });
}

function methodReportFromAnalysis(analysis, fx = FX) {
  const byMarket = { HK: 0, US: 0 };
  for (const symbol of analysis?.symbols ?? []) {
    byMarket[currencyToMarket(symbol.currency)] += symbol.gainLossRmb;
  }
  const summary = summaryFromAnalysis(analysis, fx);
  return {
    ...summary,
    byMarket,
  };
}

function bestCostMethod(methodSummaries) {
  const fifo = methodSummaries.fifo;
  const acb = methodSummaries.acb;
  const fifoMethod = { id: "fifo", label: "自然年 FIFO", short: "FIFO", summary: fifo };
  const acbMethod = { id: "acb", label: "自然年 ACB", short: "ACB", summary: acb };
  const isTie = Math.abs(fifo.tax - acb.tax) < 0.01;
  const best = fifo.tax <= acb.tax ? fifoMethod : acbMethod;
  const other = best.id === "fifo" ? acbMethod : fifoMethod;
  return {
    best,
    other,
    isTie,
    saving: Math.max(Math.abs(fifo.tax - acb.tax), 0),
  };
}

function classForNumber(n) {
  return n >= 0 ? "pos" : "neg";
}

function parseManualCostValue(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\s,，_]/g, "");
  if (!/^\+?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(normalized)) return null;
  const numericValue = Number(normalized);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
}

function isValidManualCostValue(value) {
  return parseManualCostValue(value) !== null;
}

function costInputToTotalCost(value, mode, quantity) {
  const numericValue = parseManualCostValue(value);
  if (numericValue === null) return null;
  if (mode === "unit" && (!Number.isFinite(quantity) || quantity <= 0)) return null;
  const totalCost = mode === "unit" ? numericValue * quantity : numericValue;
  return Number(totalCost.toFixed(2));
}

function totalCostToInputValue(totalCost, mode, quantity) {
  const numericValue = parseManualCostValue(totalCost);
  if (numericValue === null) return "";
  if (mode === "unit" && Number.isFinite(quantity) && quantity > 0) return (numericValue / quantity).toFixed(2);
  return String(numericValue);
}

function switchCostInputMode(value, currentMode, nextMode, quantity) {
  const totalCost = costInputToTotalCost(value, currentMode, quantity);
  if (totalCost === null) return value;
  return nextMode === "unit" ? totalCostToInputValue(totalCost, "unit", quantity) : String(totalCost);
}

function limitDecimalPlaces(value, digits = 2) {
  const text = String(value ?? "");
  if (!text) return "";
  if (/[eE]/.test(text)) return text.replace(/[^\d.eE+\-,，]/g, "");
  const cleaned = text.replace(/[^\d.]/g, "");
  const dotIndex = cleaned.indexOf(".");
  if (dotIndex === -1) return cleaned;
  const integer = cleaned.slice(0, dotIndex) || "0";
  const fraction = cleaned.slice(dotIndex + 1).replaceAll(".", "").slice(0, digits);
  return `${integer}.${fraction}`;
}

function normalizeCostInput(value, mode) {
  return mode === "unit" ? limitDecimalPlaces(value, 2) : value;
}

function costInputLabel(currency, mode) {
  return `${mode === "unit" ? "每股成本" : "总成本"}（${currency}）`;
}

function costInputPlaceholder(mode) {
  return mode === "unit" ? "例如 427.05" : "例如 298935";
}

function costCorrectionInputsFromState(costCorrections) {
  return Object.entries(costCorrections)
    .map(([id, value]) => ({ id, costBasis: parseManualCostValue(value) }))
    .filter((item) => item.costBasis !== null);
}

function needsBrokerPdfPassword(files) {
  return files.some((file) => file.file && ["longbridge", "zircon"].includes(file.broker) && /\.pdf$/i.test(file.name));
}

function detectMobileDevice() {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const mobileUa = /Android|webOS|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
  const coarsePointer = window.matchMedia?.("(hover: none) and (pointer: coarse)")?.matches ?? false;
  const narrowViewport = Math.min(window.innerWidth, window.innerHeight) < 820;
  return mobileUa || (coarsePointer && narrowViewport);
}

function useIsMobileDevice() {
  const [isMobileDevice, setIsMobileDevice] = useState(false);

  useEffect(() => {
    function update() {
      setIsMobileDevice(detectMobileDevice());
    }

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  return isMobileDevice;
}

function brokerLabel(broker) {
  if (broker === "tiger") return "老虎";
  if (broker === "longbridge") return "长桥";
  if (broker === "zircon") return "卓锐";
  return "富途";
}

const BROKER_OPTIONS = [
  { value: "futu", label: "富途" },
  { value: "longbridge", label: "长桥" },
  { value: "zircon", label: "卓锐" },
  { value: "tiger", label: "老虎" },
];
const TAX_YEAR_OPTIONS = [2021, 2022, 2023, 2024, 2025];
const PUBLISHER_NAME = "汤姆喵的奇妙旅行";
const ASSET_BASE = import.meta.env.BASE_URL;
const TAX_FORM_GUIDES = {
  capital: [
    {
      src: `${ASSET_BASE}tax-form-guides/capital-transfer.jpg`,
      alt: "个人所得税网站财产转让所得应纳税所得额填写位置",
    },
  ],
  dividend: [
    {
      src: `${ASSET_BASE}tax-form-guides/dividend-income.jpg`,
      alt: "个人所得税网站利息股息红利所得应纳税所得额填写位置",
    },
  ],
  usDividend: [
    {
      src: `${ASSET_BASE}tax-form-guides/foreign-credit-summary.jpg`,
      alt: "个人所得税网站境外所得已纳所得税抵免额位置",
    },
    {
      src: `${ASSET_BASE}tax-form-guides/foreign-income-detail.jpg`,
      alt: "个人所得税网站本年度各国可抵免明细其他分类所得填写位置",
    },
  ],
  foreignTaxPaid: [
    {
      src: `${ASSET_BASE}tax-form-guides/foreign-tax-paid-edit.jpg`,
      alt: "个人所得税网站本年境外已纳税额填写位置",
    },
  ],
};

const FUTU_SHEET_MARKERS = ["账户信息", "证券-持仓总览", "证券-交易流水", "证券-资产进出", "证券-资金进出"];
const FUTU_TEXT_MARKERS = ["富途", "futu", "moomoo", "牛牛号", "账户号码"];
const LONGBRIDGE_TEXT_MARKERS = [
  "长桥",
  "長橋",
  "⻑橋",
  "综合账户月结单",
  "綜合賬戶月結單",
  "longbridge",
  "long bridge",
  "long bridge hk",
  "long bridge securities",
  "lbhk",
];
const TIGER_TEXT_MARKERS = ["Tiger Brokers", "Tiger Brokers (NZ)", "老虎", "活动报表", "Tax Form Record", "Key Tax Figures"];
const ZIRCON_TEXT_MARKERS = ["卓锐", "卓銳", "Zircon Securities"];

function brokerConfidenceLabel(confidence) {
  if (confidence === "manual") return "手动选择";
  if (confidence === "high") return "已自动识别";
  if (confidence === "medium") return "默认判断";
  if (confidence === "pending") return "识别中";
  return "待确认";
}

function issueSeverityLabel(severity) {
  if (severity === "blocking") return "无法继续";
  if (severity === "warning") return "需要确认";
  return "提示";
}

function isCostGapIssue(issue) {
  const text = `${issue?.id ?? ""} ${issue?.title ?? ""} ${issue?.detail ?? ""}`;
  return text.includes("cost-gap") || text.includes("历史成本缺失") || text.includes("待补成本");
}

function fallbackFileFingerprint(file) {
  return `file:${file.name}:${file.size}:${file.lastModified}`;
}

async function fileFingerprint(file) {
  if (window.crypto?.subtle) {
    const buffer = await file.arrayBuffer();
    const hash = await window.crypto.subtle.digest("SHA-256", buffer);
    return `sha256:${Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return fallbackFileFingerprint(file);
}

function hasAnyMarker(text, markers) {
  const normalized = String(text ?? "").toLowerCase();
  return markers.some((marker) => normalized.includes(marker.toLowerCase()));
}

function lowerFileName(fileName) {
  return String(fileName ?? "").toLowerCase();
}

function isExcelFile(fileName) {
  return /\.(xlsx|xls)$/i.test(fileName);
}

function isPdfFile(fileName) {
  return /\.pdf$/i.test(fileName);
}

function baseBrokerGuess(fileName) {
  const lower = lowerFileName(fileName);
  if (fileName.includes("富途") || lower.includes("futu") || lower.includes("moomoo")) {
    return {
      broker: "futu",
      confidence: "high",
      reason: "文件名包含富途特征，已默认选择富途。",
    };
  }
  if (fileName.includes("长桥") || lower.includes("longbridge") || lower.includes("long bridge")) {
    return {
      broker: "longbridge",
      confidence: "high",
      reason: "文件名包含长桥特征，已默认选择长桥。",
    };
  }
  if (fileName.includes("卓锐") || fileName.includes("卓銳") || lower.includes("zircon")) {
    return {
      broker: "zircon",
      confidence: "high",
      reason: "文件名包含卓锐/Zircon 特征，已默认选择卓锐。",
    };
  }
  if (fileName.includes("老虎") || lower.includes("tiger")) {
    return {
      broker: "tiger",
      confidence: "high",
      reason: "文件名包含老虎/Tiger 特征，已默认选择老虎。",
    };
  }
  if (isPdfFile(fileName)) {
    return {
      broker: "longbridge",
      confidence: "medium",
      reason: "PDF 文件会默认按长桥月结单处理；如为老虎报表，系统会继续尝试从内容自动识别。",
    };
  }
  if (isExcelFile(fileName)) {
    return {
      broker: "futu",
      confidence: "medium",
      reason: "Excel 文件会默认按富途年度报表处理，请确认券商是否正确。",
    };
  }
  return {
    broker: "futu",
    confidence: "low",
    reason: "未从文件名或格式识别券商，请在下拉框确认后再解析。",
  };
}

function workbookPreviewText(workbook) {
  return workbook.SheetNames.slice(0, 4)
    .map((sheetName) => {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName], {
        FS: " ",
        RS: " ",
        blankrows: false,
      });
      return `${sheetName} ${csv.slice(0, 1800)}`;
    })
    .join(" ");
}

async function detectBrokerFromFile(file) {
  const fallback = baseBrokerGuess(file.name);
  try {
    if (isExcelFile(file.name)) {
      const workbook = XLSX.read(await file.arrayBuffer(), {
        type: "array",
        sheetRows: 20,
        cellDates: false,
      });
      const sheetHits = FUTU_SHEET_MARKERS.filter((sheetName) => workbook.Sheets[sheetName]);
      if (sheetHits.length >= 3) {
        return {
          broker: "futu",
          confidence: "high",
          reason: `识别到富途年度报表工作表：${sheetHits.slice(0, 3).join("、")}。`,
        };
      }
      const preview = workbookPreviewText(workbook);
      if (hasAnyMarker(preview, FUTU_TEXT_MARKERS)) {
        return {
          broker: "futu",
          confidence: "high",
          reason: "文件内容包含富途账户/报表特征，已默认选择富途。",
        };
      }
      if (hasAnyMarker(preview, LONGBRIDGE_TEXT_MARKERS)) {
        return {
          broker: "longbridge",
          confidence: "medium",
          reason: "文件内容包含长桥特征；当前长桥解析器主要支持 PDF 月结单，请解析前确认文件格式。",
        };
      }
      if (hasAnyMarker(preview, TIGER_TEXT_MARKERS)) {
        return {
          broker: "tiger",
          confidence: "medium",
          reason: "文件内容包含老虎/Tiger 特征；当前老虎解析器支持 PDF 税表汇总和活动报表。",
        };
      }
      if (hasAnyMarker(preview, ZIRCON_TEXT_MARKERS)) {
        return {
          broker: "zircon",
          confidence: "medium",
          reason: "文件内容包含卓锐/Zircon 特征；当前卓锐解析器支持 PDF 月结单，请解析前确认文件格式。",
        };
      }
    }

    if (isPdfFile(file.name)) {
      const preview = await file.slice(0, Math.min(file.size, 512 * 1024)).text();
      if (hasAnyMarker(preview, TIGER_TEXT_MARKERS)) {
        return {
          broker: "tiger",
          confidence: "high",
          reason: "PDF 内容包含老虎/Tiger 报表特征，已默认选择老虎。",
        };
      }
      if (hasAnyMarker(preview, LONGBRIDGE_TEXT_MARKERS)) {
        return {
          broker: "longbridge",
          confidence: "high",
          reason: "PDF 内容包含长桥特征，已默认选择长桥。",
        };
      }
      if (hasAnyMarker(preview, ZIRCON_TEXT_MARKERS)) {
        return {
          broker: "zircon",
          confidence: "high",
          reason: "PDF 内容包含卓锐/Zircon 月结单特征，已默认选择卓锐。",
        };
      }
      if (hasAnyMarker(preview, FUTU_TEXT_MARKERS)) {
        return {
          broker: "futu",
          confidence: "low",
          reason: "PDF 内容包含富途特征，但当前富途解析器只接受 Excel 年度报表，请确认文件。",
        };
      }
    }
  } catch {
    return {
      ...fallback,
      confidence: fallback.confidence === "high" ? "medium" : fallback.confidence,
      reason: `${fallback.reason} 文件内容读取失败，已按文件名/格式判断。`,
    };
  }
  return fallback;
}

function guessFileType(fileName) {
  const lower = fileName.toLowerCase();
  if (fileName.includes("月结") || lower.includes("monthly") || lower.endsWith(".pdf")) return "月结单";
  if (fileName.includes("年度") || lower.includes("annual") || lower.includes("year")) return "年度清单";
  return "待识别";
}

function buildFlows() {
  const dates = ["01-08", "02-19", "03-25", "04-11", "05-20", "06-17", "08-05", "09-12", "10-21", "11-08", "12-16", "12-27"];
  const flows = [];
  FLOW_STOCKS.forEach((stock, i) => {
    const [market, code, name, currency] = stock;
    const base = market === "HK" ? 20 + ((i * 47) % 380) : 95 + ((i * 61) % 720);
    const lot = market === "HK" ? [200, 400, 500, 800, 1000][i % 5] : [10, 20, 30, 50, 80][i % 5];
    [
      ["买入", 0.94, 0],
      ["买入", 1.03, 2],
      ["卖出", 1.12, 5],
    ].forEach(([side, rate, offset], j) => {
      const price = Number((base * rate).toFixed(2));
      const qty = j === 1 ? Math.round(lot * 0.6) : lot;
      const amount = price * qty;
      const fee = Number((amount * 0.0008 + (market === "HK" ? 15 : 1)).toFixed(2));
      flows.push({
        date: `${TAX_YEAR}-${dates[(i + offset) % 12]}`,
        market,
        code,
        name,
        currency,
        side,
        qty,
        price,
        amount,
        fee,
        query: `${code} ${name}`.toLowerCase(),
      });
    });
  });
  return flows.sort((a, b) => a.date.localeCompare(b.date));
}

function txnsFor(idx, row) {
  const s = idx + 1;
  const base = row.market === "HK" ? 40 + ((s * 37) % 360) : 90 + ((s * 53) % 700);
  const lot = row.market === "HK" ? [200, 400, 500, 800, 1000][s % 5] : [10, 20, 30, 50, 80][s % 5];
  const up = row.rmb >= 0;
  const dates = ["02-14", "04-08", "06-21", "09-30", "11-12"];
  return [
    { date: `${TAX_YEAR}-${dates[s % 5]}`, side: "买入", qty: lot, price: Number((base * 0.92).toFixed(2)) },
    { date: `${TAX_YEAR}-${dates[(s + 2) % 5]}`, side: "买入", qty: Math.round(lot * 0.6), price: Number((base * 1.05).toFixed(2)) },
    { date: `${TAX_YEAR}-${dates[(s + 4) % 5]}`, side: "卖出", qty: lot, price: Number((base * (up ? 1.16 : 0.84)).toFixed(2)) },
  ];
}

function Market({ market }) {
  return (
    <span className="mkt">
      <span className={`pin ${market === "HK" ? "hk" : "us"}`} />
      {market}
    </span>
  );
}

function TaxCheckMark({ className = "" }) {
  return (
    <span className={`taxcheck-mark ${className}`} aria-hidden="true">
      <ShieldCheck />
    </span>
  );
}

function PublisherCredit({ className = "" }) {
  return (
    <div className={`publisher-credit ${className}`} aria-label={`由公众号：${PUBLISHER_NAME}制作`}>
      <span className="publisher-credit-icon" aria-hidden="true">
        <Megaphone />
      </span>
      <span>
        由公众号：<b>{PUBLISHER_NAME}</b>制作
      </span>
    </div>
  );
}

function Segmented({ value, options, onChange, className = "", tourId }) {
  return (
    <div className={`seg ${className}`} data-tour-id={tourId}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "on" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function CostModeToggle({ value, onChange, quantity, inputValue, className = "" }) {
  function changeMode(nextMode) {
    if (nextMode === value) return;
    onChange(nextMode, switchCostInputMode(inputValue, value, nextMode, quantity));
  }

  return (
    <div className={`cost-mode-toggle ${className}`} role="group" aria-label="成本录入方式">
      <button type="button" className={value === "total" ? "on" : ""} onClick={() => changeMode("total")}>
        总成本
      </button>
      <button type="button" className={value === "unit" ? "on" : ""} onClick={() => changeMode("unit")}>
        每股成本
      </button>
    </div>
  );
}

function TopBar({ activePage, onNavigate }) {
  const nav = [
    ["workbench", "税务工作台"],
    ["holdings", "持仓与流水"],
    ["report", "申报报告"],
  ];

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <TaxCheckMark className="brand-mark" />
          <b>TaxCheck</b>
          <span className="sub">海外证券资本利得税</span>
        </div>
        <nav className="topnav" aria-label="主导航">
          {nav.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={activePage === key ? "on" : ""}
              onClick={() => onNavigate(key)}
              data-tour-id={key === "report" ? "report-nav" : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
        <PublisherCredit className="topbar-publisher" />
      </div>
    </header>
  );
}

function ContextBar({ year, setYear, methodId, setMethodId, files, symbolCount }) {
  const method = methodById(methodId);
  return (
    <div className="context">
      <div className="context-inner">
        <span className="ctx-label">纳税年度</span>
        <div className="yearpick">
          <select value={year} onChange={(event) => setYear(Number(event.target.value))} aria-label="纳税年度">
            {TAX_YEAR_OPTIONS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <span className="ctx-label context-method-label">计算口径</span>
        <Segmented
          className="method-seg"
          value={methodId}
          options={COST_METHODS.map((item) => ({ value: item.id, label: item.label }))}
          onChange={setMethodId}
          tourId="method-selector"
        />
        <span className="ctx-chip">
          <span className="dot accent-dot" />
          <b>{method.tag}</b> {method.description}
        </span>
        <span className="ctx-chip">
          <span className="dot" />
          已导入 <b>{files.length}</b> 份券商文件
        </span>
        <span className="ctx-chip">
          覆盖标的 <b>{symbolCount}</b> 只
        </span>
      </div>
    </div>
  );
}

function TaxFormGuideTip({ title, note, images }) {
  return (
    <span className="tax-form-guide">
      <button className="tax-form-guide-trigger" type="button" aria-label={`${title}填写位置`}>
        <Info />
      </button>
      <span className="tax-form-guide-panel" role="tooltip">
        <span className="tax-form-guide-copy">
          <b>{title}</b>
          <span>{note}</span>
        </span>
        <span className="tax-form-guide-images">
          {images.map((image) => (
            <img key={image.src} src={image.src} alt={image.alt} loading="lazy" />
          ))}
        </span>
      </span>
    </span>
  );
}

function Kpis({ summary }) {
  const taxBeforeCredit = (summary.capitalTaxBase + summary.dividendTaxBase) * TAX_RATE;
  return (
    <section className="kpis">
      <div className="kpi kpi-capital">
        <div className="k-top">
          <span className="k-label-with-guide">
            <span className="k-label">财产转让所得应纳税所得额</span>
            <TaxFormGuideTip
              title="财产转让所得应纳税所得额"
              note="在个人所得税网站「财产转让所得应纳税额」模块，填写项目「财产转让所得应纳税所得额」。"
              images={TAX_FORM_GUIDES.capital}
            />
          </span>
          <span className="k-ic">
            <TrendingUp />
          </span>
        </div>
        <div className="k-val">{fmt(summary.capitalTaxBase)}</div>
        <div className="k-foot">
          <span className="tag up">已折算 RMB</span>实际盈亏 {cnSigned(summary.capitalGain)}，亏损按 0 计税
        </div>
      </div>

      <div className="kpi kpi-income">
        <div className="k-top">
          <span className="k-label-with-guide">
            <span className="k-label">利息、股息、红利所得应纳税所得额</span>
            <TaxFormGuideTip
              title="利息、股息、红利所得应纳税所得额"
              note="在个人所得税网站「利息、股息、红利所得应纳税额」模块，填写项目「利息、股息、红利所得应纳税所得额」。"
              images={TAX_FORM_GUIDES.dividend}
            />
          </span>
          <span className="k-ic">
            <Square />
          </span>
        </div>
        <div className="k-val">{fmt(summary.dividendTaxBase)}</div>
        <div className="k-foot">
          其中美股分红 {fmt(summary.usDividendTaxBase)}，海外已纳税额 {fmt(summary.dividendWithholdingCredit)}
        </div>
      </div>

      <div className="kpi kpi-us-dividend">
        <div className="k-top">
          <span className="k-label-with-guide">
            <span className="k-label">美股分红应纳税所得额</span>
            <TaxFormGuideTip
              title="美股分红应纳税所得额"
              note="在「境外所得抵扣」中进入「其他分类所得」，新增美国记录，所得项目选择「利息、股息、红利所得」，填入美股分红应纳税所得额。"
              images={TAX_FORM_GUIDES.usDividend}
            />
          </span>
          <span className="k-ic">
            <CreditCard />
          </span>
        </div>
        <div className="k-val">{fmt(summary.usDividendTaxBase)}</div>
        <div className="k-foot">
          <span className="k-foot-guide-text">海外已纳税额 {fmt(summary.usDividendWithholdingCredit)}</span>
          <TaxFormGuideTip
            title="海外已纳税额"
            note="在抵免额编辑弹窗中，填写「本年境外已纳税额」；系统会自动带出「本年抵免额」。"
            images={TAX_FORM_GUIDES.foreignTaxPaid}
          />
        </div>
      </div>

      <div className="kpi kpi-tax-due">
        <div className="k-top">
          <span className="k-label">预估应补税额</span>
          <span className="k-ic">
            <DollarSign />
          </span>
        </div>
        <div className="k-val">
          <span className="cur">RMB</span>
          {fmt(summary.tax)}
        </div>
        <div className="k-foot">
          <span className="tag rate">税率 20%</span>
          分类税额合计 {fmt(taxBeforeCredit)} - 海外已纳税额 {fmt(summary.dividendWithholdingCredit)}
        </div>
      </div>
    </section>
  );
}

function Sidebar({
  year,
  files,
  onUpload,
  onRemoveFile,
  onBrokerChange,
  onAnalyze,
  analysisStatus,
  password,
  onPasswordChange,
}) {
  return (
    <aside>
      <div className="panel" data-tour-id="broker-files-panel">
        <div className="panel-h">
          <h3>
            <FileText /> 券商文件
          </h3>
          <span className="count">{files.length}</span>
        </div>
        <div className="panel-b">
          <button className="drop" type="button" onClick={onUpload} data-tour-id="upload-card">
            <span className="di">
              <Upload />
            </span>
            <p>拖入或点击上传券商文件</p>
            <span>支持富途 Excel / 长桥 PDF / 卓锐 PDF / 老虎 PDF · .xlsx .xls .pdf</span>
          </button>
          <ul className="filelist">
            {files.map((file) => (
              <li className="file" key={file.id}>
                <span className="fi">
                  <FileText />
                </span>
                <span className="meta">
                  <b>{file.name}</b>
                  <span className="file-summary">
                    <span>{brokerLabel(file.broker)} · {file.type} · {typeof file.rows === "number" ? `${file.rows} 行` : file.rows}</span>
                    <span className={`broker-confidence ${file.brokerConfidence ?? "low"}`} title={file.brokerReason}>
                      {brokerConfidenceLabel(file.brokerConfidence)}
                    </span>
                  </span>
                  <select className="broker-select" value={file.broker} onChange={(event) => onBrokerChange(file.id, event.target.value)}>
                    {BROKER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <span className="broker-reason">{file.brokerReason}</span>
                </span>
                <button className="file-remove" type="button" title="删除文件" onClick={() => onRemoveFile(file.id)}>
                  <Trash2 />
                </button>
                {file.status === "已解析" ? <Check className="ok" /> : null}
              </li>
            ))}
          </ul>
          <label className="field-label">
            <span>PDF 月结单密码</span>
            <input className="plain-input" value={password} onChange={(event) => onPasswordChange(event.target.value)} placeholder="长桥/卓锐 PDF 密码" />
          </label>
          <button className="btn primary full-btn" type="button" onClick={() => onAnalyze()} disabled={analysisStatus === "running"} data-tour-id="analyze-button">
            <Calculator /> {analysisStatus === "running" ? "解析中…" : "解析并计算"}
          </button>
          {analysisStatus === "done" ? <div className="status-message ok-msg">已按 {year} 自然年生成 FIFO / ACB 两套结果。</div> : null}
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">
          <h3>
            <Info /> 计算口径说明
          </h3>
        </div>
        <div className="panel-b">
          <p className="note-card">
            本工具按 <b>个人所得税「财产转让所得」和「利息、股息、红利所得」20% 税率</b> 预估。盈亏与分红以 <b>成交日 / 派息日</b> 原币计入，并统一折算为人民币。
            年度边界仅保留 <b>自然年 1/1-12/31</b>，成本法可在 FIFO 与 ACB 之间切换。结果仅供申报参考，不构成税务意见。
          </p>
        </div>
      </div>
    </aside>
  );
}

function PnlTable({
  rows,
  methodId,
  summary,
  manualCosts,
  costCorrections,
  securityAliases,
  onSubmitManualCost,
  onSubmitSecurityAlias,
  onSubmitCostCorrection,
  onClearCostCorrection,
  analysisStatus,
  fx,
  tradeActivities = [],
  pendingCostFlashToken,
  hasLongbridgeNoStockActivity = false,
  hasTaxSummaryNoTradeDetail = false,
}) {
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("all");
  const [openRow, setOpenRow] = useState(null);
  const [lockedRowOrder, setLockedRowOrder] = useState(null);
  const method = methodById(methodId);
  const displayRows = useMemo(() => {
    if (!openRow || !lockedRowOrder) return rows;
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const orderedRows = lockedRowOrder.map((key) => byKey.get(key)).filter(Boolean);
    const orderedKeys = new Set(lockedRowOrder);
    const newRows = rows.filter((row) => !orderedKeys.has(row.key));
    return [...orderedRows, ...newRows];
  }, [lockedRowOrder, openRow, rows]);
  const filteredRows = displayRows.filter((row) => {
    const okQuery = !query || `${row.code} ${row.name}`.toLowerCase().includes(query.trim().toLowerCase());
    const okMarket = market === "all" || row.market === market;
    return okQuery && okMarket;
  });
  const buyActivityCount = tradeActivities.filter((activity) => activity.side === "buy" || activity.side === "acquire" || activity.side === "transfer_in").length;
  const sellActivityCount = tradeActivities.filter((activity) => activity.side === "sell").length;

  useEffect(() => {
    if (!openRow) {
      setLockedRowOrder(null);
      return;
    }
    setLockedRowOrder((current) => current ?? rows.map((row) => row.key));
  }, [openRow, rows]);

  return (
    <>
      <div className="toolbar">
        <label className="search">
          <Search />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索股票代码 / 名称…" />
        </label>
        <Segmented
          value={market}
          options={[
            { value: "all", label: "全部市场" },
            { value: "HK", label: "港股" },
            { value: "US", label: "美股" },
          ]}
          onChange={(next) => {
            setMarket(next);
            setOpenRow(null);
          }}
        />
        <span className="hint-chip">
          <Info /> 转仓标的可展开具体行订正成本
        </span>
        <div className="tool-spacer" />
        <span className="tcount">
          计入计算 <b>{summary.includedCount}</b> / {rows.length} 只
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>市场</th>
              <th>代码</th>
              <th>名称</th>
              <th className="c">币种</th>
              <th className="r">盈亏（原币）</th>
              <th className="r">年末汇率</th>
              <th className="r">盈亏（RMB）</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan="7">
                  <div className="empty-state pnl-empty-state">
                    {rows.length === 0 && hasTaxSummaryNoTradeDetail ? (
                      <>
                        <b>已读取税表汇总，缺少逐笔交易明细</b>
                        <span>可以读取汇总金额，文件中的数据已经统计进总体数据，但在盈亏明细中无法展示。</span>
                      </>
                    ) : rows.length === 0 && tradeActivities.length > 0 ? (
                      <>
                        <b>当前材料没有形成已实现盈亏</b>
                        <span>
                          已识别 {tradeActivities.length} 笔成交流水，其中买入 / 转入 {buyActivityCount} 笔、卖出 {sellActivityCount} 笔。盈亏明细只展示卖出后形成的已实现盈亏；买入流水会作为后续月份卖出时的成本材料。
                        </span>
                      </>
                    ) : rows.length === 0 && hasLongbridgeNoStockActivity ? (
                      <>
                        <b>本月没有股票买卖记录</b>
                        <span>已识别到长桥月结单，但没有股票买卖记录；现金入金、出金或账户余额变化不会形成已实现资本利得。</span>
                      </>
                    ) : rows.length === 0 ? (
                      <>
                        <b>暂未识别到盈亏明细</b>
                        <span>请确认已上传目标纳税年度包含卖出记录的券商材料；只有买入或持仓估值不会形成已实现盈亏。</span>
                      </>
                    ) : (
                      <>
                        <b>没有符合筛选条件的标的</b>
                        <span>可以清空搜索关键词，或切换市场筛选后再查看。</span>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ) : filteredRows.map((row, idx) => {
              const isOpen = openRow === row.key;
              return (
                <React.Fragment key={row.key}>
                  <tr
                    key={row.key}
                    className={`stock-row ${isOpen ? "open" : ""} ${row.positionOnly ? "position-only-row" : ""}`}
                    onClick={() => setOpenRow(isOpen ? null : row.key)}
                  >
                    <td>
                      <Market market={row.market} />
                    </td>
                    <td className="code-cell">{displayRowCode(row.code)}</td>
                    <td className="stock-nm">
                      <ChevronRight className="caret" />
                      {row.name}
                      {row.positionOnly ? <span className="row-state-badge">期末持仓</span> : null}
                      {isUnresolvedSymbol(row.code) ? <span className="row-state-badge warn">代码待复核</span> : null}
                    </td>
                    <td className="c">
                      <span className="ccy">{row.currency}</span>
                    </td>
                    <td className={`r num pnl ${row.missingCost || row.positionOnly ? "" : classForNumber(row.pnlOriginal)}`}>
                      {row.missingCost
                        ? `市值 ${fmt(row.proceeds)}`
                        : row.positionOnly
                          ? row.pnlOriginal === null
                            ? `市值 ${fmt(row.proceeds)}`
                            : floatingPnlLabel(row.pnlOriginal)
                          : cnSigned(row.pnlOriginal)}
                    </td>
                    <td className="r num muted">{(fx[row.market] ?? 1).toFixed(4)}</td>
                    <td className={`r num pnl ${row.missingCost || row.positionOnly ? "pending-text" : classForNumber(row.rmb)}`}>
                      {row.missingCost ? (
                        <span key={`${row.key}-${pendingCostFlashToken}`} className={`pending-cost-label ${pendingCostFlashToken ? "pending-flash" : ""}`}>
                          待补成本
                        </span>
                      ) : row.positionOnly ? (
                        "不参与计算"
                      ) : (
                        cnSigned(row.rmb)
                      )}
                    </td>
                  </tr>
                  {isOpen ? (
                    <PnlDetailRow
                      row={row}
                      idx={idx}
                      method={method}
                      manualCosts={manualCosts}
                      costCorrections={costCorrections}
                      securityAliases={securityAliases}
                      onSubmitManualCost={onSubmitManualCost}
                      onSubmitSecurityAlias={onSubmitSecurityAlias}
                      onSubmitCostCorrection={onSubmitCostCorrection}
                      onClearCostCorrection={onClearCostCorrection}
                      analysisStatus={analysisStatus}
                    />
                  ) : null}
                </React.Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="6" className="r">
                已实现盈亏合计
              </td>
              <td className={`r num pnl ${classForNumber(summary.capitalGain)}`}>{cnSigned(summary.capitalGain)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

function SymbolAliasForm({ row, securityAliases = {}, onSubmitSecurityAlias, analysisStatus }) {
  const aliasKey = securityAliasStateKey(row);
  const savedSymbol = securityAliases[aliasKey]?.symbol ?? "";
  const [draftSymbol, setDraftSymbol] = useState(savedSymbol);
  const needsAlias = isUnresolvedSymbol(row.code);

  useEffect(() => {
    setDraftSymbol(savedSymbol);
  }, [aliasKey, savedSymbol]);

  if (!needsAlias) return null;

  const normalized = normalizeSecuritySymbolInput(draftSymbol);
  const canSubmit = Boolean(normalized) && analysisStatus !== "running";
  return (
    <form
      className="symbol-alias-form"
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit) onSubmitSecurityAlias?.(row, normalized);
      }}
    >
      <label>
        <span>股票代码</span>
        <input
          className="plain-input"
          value={draftSymbol}
          onChange={(event) => setDraftSymbol(normalizeSecuritySymbolInput(event.target.value))}
          placeholder="例如 NVDA / PDD / 09988"
          aria-label={`${row.name} 股票代码`}
        />
      </label>
      <button className="btn primary" type="submit" disabled={!canSubmit}>
        <Check /> 保存并重算
      </button>
      <span className="dh-note">PDF 文本层没有可读代码时，可在这里补充；后续会按该代码重新归集买卖、持仓和待补成本。</span>
    </form>
  );
}

function PnlDetailRow({
  row,
  idx,
  method,
  manualCosts,
  costCorrections = {},
  securityAliases = {},
  onSubmitManualCost,
  onSubmitSecurityAlias,
  onSubmitCostCorrection,
  onClearCostCorrection,
  analysisStatus,
}) {
  const [editingCostKey, setEditingCostKey] = useState(null);
  const [draftCost, setDraftCost] = useState("");
  const [correctionCostMode, setCorrectionCostMode] = useState("unit");
  const [missingCostMode, setMissingCostMode] = useState("unit");
  const [missingCostDraft, setMissingCostDraft] = useState(null);

  if (row.missingCost) {
    const request = row.missingCostRequest;
    const rawValue = missingCostDraft ?? totalCostToInputValue(manualCosts[request.id], missingCostMode, request.quantity);
    const totalCost = costInputToTotalCost(rawValue, missingCostMode, request.quantity);
    const canSubmit = totalCost !== null && analysisStatus !== "running";
    return (
      <tr className="detail-row">
        <td colSpan="7">
          <div className="detail-wrap">
            <div className="detail-head">
              <b>
                {displayRowCode(row.code)} · {row.name}
              </b>{" "}
              成本缺失，暂未进入应税盈亏
              <span className="dh-note">
                已识别 {request.sellDate} 卖出 {request.quantity.toLocaleString()} 股，收入 {request.currency} {fmt(request.proceeds)}。补入这批卖出对应的总成本或每股成本后，会重新生成 FIFO / ACB 结果。
              </span>
            </div>
            <SymbolAliasForm
              row={row}
              securityAliases={securityAliases}
              onSubmitSecurityAlias={onSubmitSecurityAlias}
              analysisStatus={analysisStatus}
            />
            <div className="inline-cost">
              <label>
                <span>{costInputLabel(request.currency, missingCostMode)}</span>
                <CostModeToggle
                  value={missingCostMode}
                  inputValue={rawValue}
                  quantity={request.quantity}
                  onChange={(nextMode, nextValue) => {
                    setMissingCostMode(nextMode);
                    setMissingCostDraft(nextValue);
                  }}
                />
                <input
                  className="plain-input"
                  value={rawValue}
                  onChange={(event) => setMissingCostDraft(normalizeCostInput(event.target.value, missingCostMode))}
                  placeholder={costInputPlaceholder(missingCostMode)}
                  inputMode="decimal"
                  onClick={(event) => event.stopPropagation()}
                />
                {missingCostMode === "unit" && totalCost !== null ? (
                  <span className="cost-total-preview">
                    折算总成本：{request.currency} {fmt(totalCost)}
                    <small>买入手续费需已摊入每股成本</small>
                  </span>
                ) : null}
              </label>
              <button
                className="btn primary"
                type="button"
                disabled={!canSubmit}
                onClick={(event) => {
                  event.stopPropagation();
                  if (totalCost !== null) onSubmitManualCost(request.id, String(totalCost));
                }}
              >
                <Calculator /> 确认并重算
              </button>
            </div>
          </div>
        </td>
      </tr>
    );
  }
  if (row.positionOnly) {
    const position = row.position;
    const avgCost = position?.quantity && Number.isFinite(position.costBasis) ? position.costBasis / position.quantity : null;
    const lastPrice = position?.quantity ? position.marketValue / position.quantity : null;
    return (
      <tr className="detail-row">
        <td colSpan="7">
          <div className="detail-wrap">
            <div className="detail-head">
              <b>
                {displayRowCode(row.code)} · {row.name}
              </b>{" "}
              期末持仓，不参与已实现盈亏计算
              <span className="dh-note">该行只展示期末持仓或未实现盈亏；卖出发生后才会进入财产转让所得计算。</span>
            </div>
            <SymbolAliasForm
              row={row}
              securityAliases={securityAliases}
              onSubmitSecurityAlias={onSubmitSecurityAlias}
              analysisStatus={analysisStatus}
            />
            <div className="position-detail-grid">
              <div>
                <span>持仓数量</span>
                <b>{position.quantity.toLocaleString()}</b>
              </div>
              <div>
                <span>期末市值</span>
                <b>
                  {row.currency} {fmt(position.marketValue)}
                </b>
              </div>
              <div>
                <span>平均成本</span>
                <b>{avgCost === null ? "N/A" : fmtUnit(avgCost)}</b>
              </div>
              <div>
                <span>期末价格</span>
                <b>{lastPrice === null ? "N/A" : fmtPrice(lastPrice)}</b>
              </div>
              <div>
                <span>未实现盈亏</span>
                <b className={row.pnlOriginal === null ? "" : classForNumber(row.pnlOriginal)}>
                  {row.pnlOriginal === null ? "N/A" : floatingPnlLabel(row.pnlOriginal)}
                </b>
              </div>
              <div>
                <span>材料来源</span>
                <b>{position.source}</b>
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  }
  const txns = row.transactions?.length ? row.transactions : txnsFor(idx, row);
  const isReal = Boolean(row.transactions?.length);
  return (
    <tr className="detail-row">
      <td colSpan="7">
        <div className="detail-wrap">
          <div className="detail-head">
            <b>
              {displayRowCode(row.code)} · {row.name}
            </b>{" "}
            买卖流水（{row.currency}）
            <span className="dh-note">流水为各口径通用的原始材料；已实现盈亏按当前口径（{method.tag}）匹配成本后得出</span>
          </div>
          <SymbolAliasForm
            row={row}
            securityAliases={securityAliases}
            onSubmitSecurityAlias={onSubmitSecurityAlias}
            analysisStatus={analysisStatus}
          />
          <table className="txn-table">
            <thead>
              <tr>
                <th>成交日期</th>
                <th>{isReal ? "来源" : "方向"}</th>
                <th className="r">数量</th>
                <th className="r" title={isReal ? "按卖出收入 / 数量计算" : undefined}>
                  {isReal ? "卖出价格" : "成交价"}
                </th>
                <th className="r">{isReal ? "成本" : "成交额"}</th>
                <th className="r">{isReal ? `收益（${row.currency}）` : "参考"}</th>
                <th className="c">订正</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((txn) => {
                const correctionKey = isReal ? costCorrectionKeyForRealizedTradeId(txn.id) : null;
                const correctionValue = correctionKey ? costCorrections[correctionKey] : undefined;
                const isCorrected = isValidManualCostValue(correctionValue);
                const isEditing = correctionKey && editingCostKey === correctionKey;
                const quantity = txn.quantity ?? txn.qty;
                const sellPrice = quantity > 0 ? (isReal ? txn.proceeds / quantity : txn.price) : 0;
                const costValue = isReal ? txn.costBasis : quantity * txn.price;
                const unitCost = quantity > 0 ? costValue / quantity : null;
                const totalCorrectionCost = costInputToTotalCost(draftCost, correctionCostMode, quantity);
                const canSubmitCorrection = totalCorrectionCost !== null && analysisStatus !== "running";

                return (
                  <tr key={txn.id ?? `${txn.date}-${txn.side}-${txn.qty}`}>
                    <td className="num">{txn.sellDate ?? txn.date}</td>
                    <td>
                      <span className={`side ${isReal ? "se" : txn.side === "买入" ? "bi" : "se"}`}>{isReal ? txn.source : txn.side}</span>
                    </td>
                    <td className="r num">{quantity.toLocaleString()}</td>
                    <td className="r num price-cell">{fmtPrice(sellPrice)}</td>
                    <td className="r num cost-cell">
                      {isEditing ? (
                        <span className="cost-edit-stack">
                          <span className="cost-edit-caption">录入方式</span>
                          <CostModeToggle
                            className="compact"
                            value={correctionCostMode}
                            inputValue={draftCost}
                            quantity={quantity}
                            onChange={(nextMode, nextValue) => {
                              setCorrectionCostMode(nextMode);
                              setDraftCost(nextValue);
                            }}
                          />
                          <input
                            className="cost-edit-input"
                            value={draftCost}
                            onChange={(event) => setDraftCost(normalizeCostInput(event.target.value, correctionCostMode))}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                setEditingCostKey(null);
                                setDraftCost("");
                              }
                              if (event.key === "Enter" && canSubmitCorrection && totalCorrectionCost !== null) {
                                onSubmitCostCorrection(correctionKey, String(totalCorrectionCost));
                                setEditingCostKey(null);
                                setDraftCost("");
                              }
                            }}
                            inputMode="decimal"
                            aria-label={costInputLabel(row.currency, correctionCostMode)}
                            placeholder={costInputPlaceholder(correctionCostMode)}
                            autoFocus
                          />
                          {correctionCostMode === "unit" && totalCorrectionCost !== null ? (
                            <span className="cost-total-preview compact">
                              总成本 {fmt(totalCorrectionCost)}
                              <small>买入手续费需已摊入每股成本</small>
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        <span className="cost-cell-content">
                          <span className="cost-total-line">{fmt(costValue)}</span>
                          {unitCost !== null ? <span className="cost-unit-line">每股 {fmtUnit(unitCost)}</span> : null}
                          {isCorrected ? <span className="cost-correction-badge">已订正</span> : null}
                        </span>
                      )}
                    </td>
                    <td className={`r num ${isReal ? classForNumber(txn.gainLoss) : "muted"}`}>{isReal ? fmt(txn.gainLoss) : "-"}</td>
                    <td className="c">
                      {isReal ? (
                        <span className="cost-actions">
                          {isEditing ? (
                            <>
                              <button
                                className="icon-mini-btn"
                                type="button"
                                title="确认订正"
                                aria-label="确认订正"
                                disabled={!canSubmitCorrection}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  if (!canSubmitCorrection) return;
                                  if (totalCorrectionCost === null) return;
                                  onSubmitCostCorrection(correctionKey, String(totalCorrectionCost));
                                  setEditingCostKey(null);
                                  setDraftCost("");
                                }}
                              >
                                <Check />
                              </button>
                              <button
                                className="icon-mini-btn"
                                type="button"
                                title="取消"
                                aria-label="取消"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setEditingCostKey(null);
                                  setDraftCost("");
                                }}
                              >
                                <X />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                className="icon-mini-btn"
                                type="button"
                                title="订正成本"
                                aria-label="订正成本"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setEditingCostKey(correctionKey);
                                  setCorrectionCostMode("unit");
                                  setDraftCost(totalCostToInputValue(isCorrected ? correctionValue : costValue, "unit", quantity));
                                }}
                              >
                                <Pencil />
                              </button>
                              {isCorrected ? (
                                <button
                                  className="icon-mini-btn"
                                  type="button"
                                  title="撤销订正"
                                  aria-label="撤销订正"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    onClearCostCorrection(correctionKey);
                                  }}
                                >
                                  <RotateCcw />
                                </button>
                              ) : null}
                            </>
                          )}
                        </span>
                      ) : (
                        <span className="muted">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan="5" className="r">
                  当前口径已实现盈亏（{row.currency}）
                </td>
                <td className={`r num ${classForNumber(row.pnlOriginal)}`}>{cnSigned(row.pnlOriginal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      </td>
    </tr>
  );
}

function DividendsTable({ dividends, fx }) {
  const rows = (dividends ?? []).map((dividend) => ({
    id: dividend.id,
    market: currencyToMarket(dividend.currency),
    code: dividend.symbol,
    name: dividend.securityName,
    withholding: dividend.taxWithheld ? `${fmt((dividend.taxWithheld / Math.max(dividend.grossAmount, 1)) * 100)}%` : "0%",
    grossOriginal: `${dividend.currency} ${fmt(dividend.grossAmount)}`,
    withholdingOriginal: `${dividend.currency} ${fmt(dividend.taxWithheld)}`,
    taxableRmb: dividend.grossAmount * (fx[currencyToMarket(dividend.currency)] ?? 1),
    withholdingRmb: dividend.taxWithheld * (fx[currencyToMarket(dividend.currency)] ?? 1),
    source: dividend.source,
    evidence: dividend.evidence,
  }));
  const totalTaxable = rows.reduce((sum, row) => sum + row.taxableRmb, 0);
  const totalWithholding = rows.reduce((sum, row) => sum + row.withholdingRmb, 0);
  const usTaxable = rows.filter((row) => row.market === "US").reduce((sum, row) => sum + row.taxableRmb, 0);
  const usWithholding = rows.filter((row) => row.market === "US").reduce((sum, row) => sum + row.withholdingRmb, 0);
  return (
    <>
      <div className="toolbar">
        <span className="tcount">
          共 <b>{rows.length}</b> 笔派息记录 · 利息、股息、红利所得应纳税所得额 <b>{fmt(totalTaxable)}</b> · 其中美股分红{" "}
          <b>{fmt(usTaxable)}</b> · 海外已纳税额 <b>{fmt(totalWithholding)}</b>
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>市场</th>
              <th>代码</th>
              <th>名称</th>
              <th className="r">税前分红（原币）</th>
              <th className="r">预提税率</th>
              <th className="r">预提税（原币）</th>
              <th className="r">应纳税所得额 RMB</th>
              <th className="r">海外已纳税额 RMB</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <React.Fragment key={row.id}>
                <tr>
                  <td>
                    <Market market={row.market} />
                  </td>
                  <td className="code-cell">{row.code}</td>
                  <td className="stock-nm">{row.name}</td>
                  <td className="r num">{row.grossOriginal}</td>
                  <td className="r num">{row.withholding}</td>
                  <td className="r num">{row.withholdingOriginal}</td>
                  <td className="r num">{fmt(row.taxableRmb)}</td>
                  <td className="r num">{fmt(row.withholdingRmb)}</td>
                </tr>
                {row.evidence?.imageDataUrl || row.evidence?.text ? (
                  <tr className="dividend-evidence-row">
                    <td colSpan="8">
                      <div className="dividend-evidence">
                        <div className="dividend-evidence-head">
                          <Info />
                          <span>
                            PDF 原文位置 · {row.source}
                            {row.evidence?.page ? ` · 第 ${row.evidence.page} 页` : ""}
                          </span>
                        </div>
                        {row.evidence?.imageDataUrl ? (
                          <img src={row.evidence.imageDataUrl} alt={`${row.code} 分红在券商 PDF 中的位置截图`} />
                        ) : (
                          <code>{row.evidence?.text}</code>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="6" className="r">
                利息、股息、红利所得应纳税所得额合计
              </td>
              <td className="r num">{fmt(totalTaxable)}</td>
              <td className="r num">{fmt(totalWithholding)}</td>
            </tr>
            <tr>
              <td colSpan="6" className="r">
                其中：美股分红应纳税所得额 / 海外已纳税额
              </td>
              <td className="r num">{fmt(usTaxable)}</td>
              <td className="r num">{fmt(usWithholding)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}

function TransferRecordsTable({ records }) {
  return (
    <>
      <div className="toolbar transfer-toolbar">
        <span className="tcount">
          共 <b>{records.length}</b> 条转仓 / 成本带入记录
        </span>
        <span className="transfer-note">
          转出不等于卖出；若转出后在其他券商卖出，请继续上传该券商材料，帮助补齐成本和卖出链路。
        </span>
      </div>
      {records.length === 0 ? (
        <div className="empty-state">
          <b>暂未识别到转仓记录</b>
          <span>如果存在跨券商转入、转出或其他成本承接记录，可以继续上传对应券商数据后重新解析。</span>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>市场</th>
                <th>代码</th>
                <th>名称</th>
                <th className="c">方向</th>
                <th>券商</th>
                <th className="c">币种</th>
                <th className="r">数量</th>
                <th className="r">成本 / 参考金额</th>
                <th>来源 / 提示</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td className="num muted">{record.date}</td>
                  <td>
                    <Market market={record.market} />
                  </td>
                  <td className="code-cell">{record.code}</td>
                  <td className="stock-nm">{record.name}</td>
                  <td className="c">
                    <span className={`side ${record.rawSide === "transfer_out" ? "se" : "bi"}`}>{record.side}</span>
                  </td>
                  <td>{record.broker}</td>
                  <td className="c">
                    <span className="ccy">{record.currency}</span>
                  </td>
                  <td className="r num">{record.quantity.toLocaleString()}</td>
                  <td className="r num">{record.amount === null ? "-" : `${record.currency} ${fmt(record.amount)}`}</td>
                  <td className="muted transfer-source">{record.note || record.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function TaxSummary({ summary, fx }) {
  const total = Math.abs(summary.capitalTaxBase) + Math.abs(summary.dividendTaxBase);
  const gainPct = total ? (Math.abs(summary.capitalTaxBase) / total) * 100 : 0;
  const dividendPct = 100 - gainPct;
  const taxBeforeCredit = (summary.capitalTaxBase + summary.dividendTaxBase) * TAX_RATE;

  return (
    <div className="tax-grid">
      <div className="tax-flow">
        <div className="flow-row">
          <div className="lab">
            <b>财产转让所得应纳税所得额</b>
            <span>买卖价差按年末汇率折算；年度亏损时按 0 计税</span>
          </div>
          <div className="v">{fmt(summary.capitalTaxBase)}</div>
        </div>
        <div className="flow-row">
          <div className="lab">
            <b>财产转让所得实际盈亏</b>
            <span>用于核对买卖流水；亏损不抵减利息、股息、红利所得</span>
          </div>
          <div className={`v ${classForNumber(summary.capitalGain)}`}>{cnSigned(summary.capitalGain)}</div>
        </div>
        <div className="flow-row">
          <div className="lab">
            <b>利息、股息、红利所得应纳税所得额</b>
            <span>按税前分红基数折算人民币；不与财产转让所得合并抵扣</span>
          </div>
          <div className="v">{fmt(summary.dividendTaxBase)}</div>
        </div>
        <div className="flow-row">
          <div className="lab">
            <b>其中：美股分红应纳税所得额</b>
            <span>美股分红税前金额 × 年末 USD/CNY 汇率</span>
          </div>
          <div className="v">{fmt(summary.usDividendTaxBase)}</div>
        </div>
        <div className="flow-row">
          <div className="lab">
            <b>美股分红海外已纳税额</b>
            <span>券商已扣的美股分红预提税，折算人民币后用于抵免</span>
          </div>
          <div className="v neg">-¥{fmt(summary.usDividendWithholdingCredit)}</div>
        </div>
        <div className="flow-row">
          <div className="lab">
            <b>抵免前税额</b>
            <span>财产转让所得与利息、股息、红利所得分别按 20% 预估后合计</span>
          </div>
          <div className="v">¥{fmt(taxBeforeCredit)}</div>
        </div>
        <div className="flow-row">
          <div className="lab">
            <b>海外已纳税额</b>
            <span>券商已扣缴的境外预提税，按当前口径折算抵免</span>
          </div>
          <div className="v neg">-¥{fmt(summary.dividendWithholdingCredit)}</div>
        </div>
        <div className="flow-row total">
          <div className="lab">
            <b>预估应补税额</b>
            <span>分类税额合计 - 海外已纳税额</span>
          </div>
          <div className="v">¥{fmt(summary.tax)}</div>
        </div>
      </div>
      <div className="tax-side">
        <h4>所得构成</h4>
        <div className="meter">
          <i style={{ width: `${gainPct.toFixed(1)}%`, background: "var(--gain)" }} />
          <i style={{ width: `${dividendPct.toFixed(1)}%`, background: "var(--accent)" }} />
        </div>
        <div className="legend">
          <div>
            <span className="sq gain-sq" />
            财产转让所得 <b>{gainPct.toFixed(1)}%</b>
          </div>
          <div>
            <span className="sq accent-sq" />
            利息、股息、红利所得 <b>{dividendPct.toFixed(1)}%</b>
          </div>
        </div>
        <h4 className="fx-title">折算汇率（年末中间价）</h4>
        <div className="legend">
          <div>
            <span className="sq hk-sq" />
            USD / CNY <b>{fx.US.toFixed(4)}</b>
          </div>
          <div>
            <span className="sq us-sq" />
            HKD / CNY <b>{fx.HK.toFixed(4)}</b>
          </div>
        </div>
      </div>
    </div>
  );
}

function FxTable({ fx }) {
  return (
    <>
      <div className="toolbar">
        <span className="tcount">
          汇率来源 · <b>{fx.source}</b> · 年末口径 {fx.date}
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>货币对</th>
              <th>用途</th>
              <th className="r">年末中间价</th>
              <th className="r">年内均价</th>
              <th className="c">应用范围</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="code-cell">USD / CNY</td>
              <td>美股盈亏 · 分红折算</td>
              <td className="r num">{fx.US.toFixed(4)}</td>
              <td className="r num">7.1957</td>
              <td className="c">
                <span className="ccy">年末口径</span>
              </td>
            </tr>
            <tr>
              <td className="code-cell">HKD / CNY</td>
              <td>港股盈亏 · 分红折算</td>
              <td className="r num">{fx.HK.toFixed(4)}</td>
              <td className="r num">0.9216</td>
              <td className="c">
                <span className="ccy">年末口径</span>
              </td>
            </tr>
            <tr>
              <td className="code-cell">CNH 离岸</td>
              <td>对照参考（不参与计算）</td>
              <td className="r num">7.2986</td>
              <td className="r num">7.2034</td>
              <td className="c">
                <span className="ccy">仅参考</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}

function Workbench({
  year,
  setYear,
  methodId,
  setMethodId,
  rows,
  summary,
  files,
  onUpload,
  onRemoveFile,
  onBrokerChange,
  onAnalyze,
  analysisStatus,
  password,
  onPasswordChange,
  manualCosts,
  costCorrections,
  securityAliases,
  onSubmitManualCost,
  onSubmitSecurityAlias,
  onSubmitCostCorrection,
  onClearCostCorrection,
  dividends,
  tradeActivities,
  fx,
  pendingCostFlashToken,
  hasLongbridgeNoStockActivity,
  hasTaxSummaryNoTradeDetail,
}) {
  const [tab, setTab] = useState("pnl");
  const transferRecords = useMemo(() => transferRecordsFromActivities(tradeActivities), [tradeActivities]);
  const tabs = [
    ["pnl", "盈亏明细", rows.length],
    ["div", "分红记录", dividends.length],
    ["transfer", "转仓记录", transferRecords.length],
    ["tax", "税务汇总", null],
    ["fx", "汇率参数", null],
  ];

  return (
    <>
      <ContextBar year={year} setYear={setYear} methodId={methodId} setMethodId={setMethodId} files={files} symbolCount={rows.length} />
      <main className="wrap">
        <Kpis summary={summary} />
        <div className="grid">
          <Sidebar
            year={year}
            files={files}
            onUpload={onUpload}
            onRemoveFile={onRemoveFile}
            onBrokerChange={onBrokerChange}
            onAnalyze={onAnalyze}
            analysisStatus={analysisStatus}
            password={password}
            onPasswordChange={onPasswordChange}
          />
          <section className="panel content-panel" data-tour-id={tab === "pnl" ? "pnl-details-section" : undefined}>
            <div className="tabs">
              {tabs.map(([key, label, count]) => (
                <button key={key} type="button" className={tab === key ? "on" : ""} onClick={() => setTab(key)}>
                  {label}
                  {count !== null ? <span className="badge">{count}</span> : null}
                </button>
              ))}
            </div>
            {tab === "pnl" ? (
              <PnlTable
                rows={rows}
                methodId={methodId}
                summary={summary}
                manualCosts={manualCosts}
                costCorrections={costCorrections}
                securityAliases={securityAliases}
                onSubmitManualCost={onSubmitManualCost}
                onSubmitSecurityAlias={onSubmitSecurityAlias}
                onSubmitCostCorrection={onSubmitCostCorrection}
                onClearCostCorrection={onClearCostCorrection}
                analysisStatus={analysisStatus}
                fx={fx}
                tradeActivities={tradeActivities}
                pendingCostFlashToken={pendingCostFlashToken}
                hasLongbridgeNoStockActivity={hasLongbridgeNoStockActivity}
                hasTaxSummaryNoTradeDetail={hasTaxSummaryNoTradeDetail}
              />
            ) : null}
            {tab === "div" ? <DividendsTable dividends={dividends} fx={fx} /> : null}
            {tab === "transfer" ? <TransferRecordsTable records={transferRecords} /> : null}
            {tab === "tax" ? <TaxSummary summary={summary} fx={fx} /> : null}
            {tab === "fx" ? <FxTable fx={fx} /> : null}
          </section>
        </div>
      </main>
    </>
  );
}

function HoldingsPage({ year, openPositions, tradeActivities, realizedTrades, dividends, files, fx }) {
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState("all");
  const [side, setSide] = useState("all");
  const [showPositions, setShowPositions] = useState(false);
  const months = useMemo(
    () => coverageMonths(year, files, tradeActivities, dividends, realizedTrades, openPositions),
    [dividends, files, openPositions, realizedTrades, tradeActivities, year],
  );
  const flows = useMemo(() => {
    if (tradeActivities?.length) {
      return tradeActivities.map((activity) => ({
        date: activity.date,
        market: currencyToMarket(activity.currency, activity.market),
        code: activity.symbol,
        name: activity.securityName,
        currency: activity.currency,
        side: activity.side === "sell" ? "卖出" : activity.side === "buy" ? "买入" : activity.side === "transfer_out" ? "转出" : "转入",
        qty: activity.quantity,
        price: activity.unitPrice ?? (activity.quantity ? Math.abs(activity.amount / activity.quantity) : 0),
        amount: activity.grossAmount ?? Math.abs(activity.amount),
        fee: activity.fee ?? 0,
        query: `${activity.symbol} ${activity.securityName}`.toLowerCase(),
      }));
    }
    return [];
  }, [tradeActivities]);
  const positions = useMemo(() => {
    if (openPositions?.length) {
      const enriched = openPositions.map((item) => {
        const market = currencyToMarket(item.currency, item.market);
        const hasCostBasis = Number.isFinite(item.costBasis);
        const hasUnrealized = Number.isFinite(item.unrealizedGainLoss);
        const costBasis = hasCostBasis ? item.costBasis : hasUnrealized ? item.marketValue - item.unrealizedGainLoss : null;
        const last = item.quantity ? item.marketValue / item.quantity : 0;
        const cost = item.quantity && costBasis !== null ? costBasis / item.quantity : null;
        const unrealized = hasUnrealized ? item.unrealizedGainLoss : costBasis !== null ? item.marketValue - costBasis : null;
        const rmb = unrealized === null ? null : unrealized * (fx[market] ?? 1);
        const marketValue = item.marketValue * (fx[market] ?? 1);
        return {
          market,
          code: item.symbol,
          name: item.securityName,
          currency: item.currency,
          qty: item.quantity,
          cost,
          last,
          unrealized,
          rmb,
          marketValue,
        };
      });
      const totalMarketValue = enriched.reduce((sum, item) => sum + item.marketValue, 0);
      return enriched.map((item) => ({ ...item, weight: totalMarketValue ? (item.marketValue / totalMarketValue) * 100 : 0 }));
    }
    return [];
  }, [fx, openPositions]);
  const hasPositionPnl = positions.some((item) => item.rmb !== null);
  const posTotal = positions.reduce((sum, item) => sum + (item.rmb ?? 0), 0);
  const filteredFlows = flows.filter((flow) => {
    const okQuery = !query || flow.query.includes(query.trim().toLowerCase());
    const okMarket = market === "all" || flow.market === market;
    const okSide = side === "all" || flow.side === side;
    return okQuery && okMarket && okSide;
  });

  return (
    <main className="wrap">
      <div className="recon">
        <span className="rtitle">
          <CheckCircle2 /> {year} 数据覆盖
        </span>
        <div className="months">
          {months.map(([month, status]) => (
            <span key={month} className={`mo ${status}`}>
              {month}
            </span>
          ))}
        </div>
        <span className="rnote">
          {files.length} 份文件 · {flows.length} 行流水 · <b>按上传材料生成</b>
        </span>
      </div>

      <div className="sec-h collapsible-h">
        <button className={`section-toggle ${showPositions ? "open" : ""}`} type="button" onClick={() => setShowPositions((value) => !value)}>
          <ChevronRight />
          <span>年末持仓</span>
        </button>
        <span className="pill">
          <AlertCircle /> 未实现盈亏 · 不计入资本利得税
        </span>
        <span className="hint">{showPositions ? "年末估值参考，仅在卖出后才进入应税计算" : `${positions.length} 只持仓，默认收起`}</span>
      </div>
      {showPositions ? (
        <div className="panel">
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>市场</th>
                  <th>代码</th>
                  <th>名称</th>
                  <th className="r">持仓数量</th>
                  <th className="r">平均成本</th>
                  <th className="r">年末价</th>
                  <th className="r">浮动盈亏（原币）</th>
                  <th className="r">浮动盈亏（RMB）</th>
                  <th className="r">仓位占比</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={`${position.market}-${position.code}`}>
                    <td>
                      <Market market={position.market} />
                    </td>
                    <td className="code-cell">{position.code}</td>
                    <td className="stock-nm">{position.name}</td>
                    <td className="r num">{position.qty.toLocaleString()}</td>
                    <td className="r num muted">{position.cost === null ? "-" : position.cost.toFixed(2)}</td>
                    <td className="r num">{position.last.toFixed(2)}</td>
                    <td className={`r num ${position.unrealized === null ? "muted" : classForNumber(position.unrealized)}`}>
                      {position.unrealized === null ? "-" : cnSigned(position.unrealized)}
                    </td>
                    <td className={`r num ${position.rmb === null ? "muted" : classForNumber(position.rmb)}`}>{position.rmb === null ? "-" : cnSigned(position.rmb)}</td>
                    <td className="r num">
                      {position.weight.toFixed(1)}%
                      <span className="bar">
                        <i style={{ width: `${Math.max(position.weight, 3).toFixed(0)}%` }} />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan="7" className="r">
                    未实现浮盈合计（RMB）
                  </td>
                  <td className={`r num ${hasPositionPnl ? classForNumber(posTotal) : "muted"}`}>{hasPositionPnl ? cnSigned(posTotal) : "-"}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      ) : null}

      <div className="sec-h">
        <h2>全量成交流水</h2>
        <span className="hint">各计算口径通用的原始材料 · 核对券商导入是否完整</span>
      </div>
      <div className="panel">
        <div className="toolbar">
          <label className="search">
            <Search />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索代码 / 名称…" />
          </label>
          <Segmented
            value={market}
            options={[
              { value: "all", label: "全部市场" },
              { value: "HK", label: "港股" },
              { value: "US", label: "美股" },
            ]}
            onChange={setMarket}
          />
          <Segmented
            value={side}
            options={[
              { value: "all", label: "买卖" },
              { value: "买入", label: "买入" },
              { value: "卖出", label: "卖出" },
            ]}
            onChange={setSide}
          />
          <div className="tool-spacer" />
          <span className="tcount">
            显示 <b>{filteredFlows.length}</b> 笔
          </span>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>成交日期</th>
                <th>市场</th>
                <th>代码</th>
                <th>名称</th>
                <th className="c">方向</th>
                <th className="c">币种</th>
                <th className="r">数量</th>
                <th className="r">成交价</th>
                <th className="r">成交额（原币）</th>
                <th className="r">手续费</th>
              </tr>
            </thead>
            <tbody>
              {filteredFlows.map((flow) => (
                <tr key={`${flow.date}-${flow.code}-${flow.side}-${flow.qty}`}>
                  <td className="num muted">{flow.date}</td>
                  <td>
                    <Market market={flow.market} />
                  </td>
                  <td className="code-cell">{flow.code}</td>
                  <td className="stock-nm">{flow.name}</td>
                  <td className="c">
                    <span className={`side ${flow.side === "买入" ? "bi" : "se"}`}>{flow.side}</span>
                  </td>
                  <td className="c">
                    <span className="ccy">{flow.currency}</span>
                  </td>
                  <td className="r num">{flow.qty.toLocaleString()}</td>
                  <td className="r num">{flow.price.toFixed(2)}</td>
                  <td className="r num">{fmt(flow.amount)}</td>
                  <td className="r num muted">{flow.fee.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function ReportPage({ year, methodSummaries, files, dividends, onCopyReport, onExportCsv, onExportPdf, copied, fx }) {
  const fifo = methodSummaries.fifo;
  const acb = methodSummaries.acb;
  const { best, other, isTie, saving } = bestCostMethod(methodSummaries);
  const dividendRows = (dividends ?? []).map((dividend) => {
    const market = currencyToMarket(dividend.currency);
    return {
      ...dividend,
      market,
      taxableRmb: dividend.grossAmount * (fx[market] ?? 1),
      withholdingRmb: dividend.taxWithheld * (fx[market] ?? 1),
    };
  });
  const dividendTaxBaseRmb = dividendRows.reduce((sum, dividend) => sum + dividend.taxableRmb, 0);
  const dividendWithholdingRmb = dividendRows.reduce((sum, dividend) => sum + dividend.withholdingRmb, 0);
  const usDividendTaxBaseRmb = dividendRows.filter((dividend) => dividend.market === "US").reduce((sum, dividend) => sum + dividend.taxableRmb, 0);
  const usDividendWithholdingRmb = dividendRows.filter((dividend) => dividend.market === "US").reduce((sum, dividend) => sum + dividend.withholdingRmb, 0);
  const usDividendEvidenceRows = dividendRows.filter((dividend) => dividend.market === "US" && (dividend.evidence?.imageDataUrl || dividend.evidence?.text));
  const hasForeignCreditMaterials = usDividendTaxBaseRmb > 0 || usDividendWithholdingRmb > 0 || usDividendEvidenceRows.length > 0;
  const foreignCreditOffset = hasForeignCreditMaterials ? 1 : 0;
  const bestColClass = (id) => (!isTie && best.id === id ? "best" : "");
  const bestBadge = (id) => (!isTie && best.id === id ? <span className="badge">推荐</span> : null);

  return (
    <div className="stage">
      <div className="report-actions">
        <button className="btn" type="button" onClick={onExportCsv}>
          <Download /> 导出 CSV
        </button>
        <button className="btn" type="button" onClick={onCopyReport}>
          <Copy /> {copied ? "已复制申报数字" : "复制申报数字"}
        </button>
        <button className="btn primary" type="button" onClick={onExportPdf} title="打开打印面板后，目标打印机选择「另存为 PDF」保存">
          <Printer /> 保存为 PDF
        </button>
      </div>
      <div className="sheet">
        <PublisherCredit className="report-publisher-top" />
        <div className="doc-head">
          <div>
            <h1>海外证券资本利得税 · 申报底稿</h1>
            <div className="dh-sub">个人所得税「财产转让所得」和「利息、股息、红利所得」口径预估 · 供自行申报参考</div>
          </div>
          <div className="meta">
            纳税年度 <b>{year}</b>
            <br />
            生成日期 <b>2026-06-22</b>
          </div>
        </div>

        <div className="sum">
          <div className="cell">
            <div className="lab">财产转让所得应纳税所得额</div>
            <div className="val">{fmt(best.summary.capitalTaxBase)}</div>
          </div>
          <div className="cell">
            <div className="lab">利息、股息、红利所得应纳税所得额</div>
            <div className="val">
              <span className="cur">¥</span>
              {fmt(best.summary.dividendTaxBase)}
            </div>
          </div>
          <div className="cell">
            <div className="lab">其中：美股分红应纳税所得额</div>
            <div className="val">
              <span className="cur">¥</span>
              {fmt(best.summary.usDividendTaxBase)}
            </div>
          </div>
          <div className="cell lead">
            <div className="lab">预估应补税额（推荐口径）</div>
            <div className="val">
              <span className="cur">RMB</span>
              {fmt(best.summary.tax)}
            </div>
            <span className="tag">
              {best.label} · {isTie ? "税额一致" : "税负最优"}
            </span>
          </div>
        </div>

        <h2 className="sh">
          <span className="idx">1</span>计算口径对比 · 同一份材料，两种成本法
        </h2>
        <table className="cmp">
          <thead>
            <tr>
              <th>项目（人民币）</th>
              <th className={`col ${bestColClass("fifo")}`}>
                自然年 · FIFO{bestBadge("fifo")}
              </th>
              <th className={`col ${bestColClass("acb")}`}>
                自然年 · ACB{bestBadge("acb")}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="rowlab">
                <b>财产转让所得应纳税所得额</b>
                <br />
                已实现盈亏小于 0 时按 0 计税；亏损不抵减利息、股息、红利所得
              </td>
              <td className={`col ${bestColClass("fifo")}`}>{fmt(fifo.capitalTaxBase)}</td>
              <td className={`col ${bestColClass("acb")}`}>{fmt(acb.capitalTaxBase)}</td>
            </tr>
            <tr>
              <td className="rowlab">
                <b>财产转让所得实际盈亏</b>
                <br />
                用于核对买卖流水，非申报应纳税所得额
              </td>
              <td className={`col ${bestColClass("fifo")}`}>{cnSigned(fifo.capitalGain)}</td>
              <td className={`col ${bestColClass("acb")}`}>{cnSigned(acb.capitalGain)}</td>
            </tr>
            <tr>
              <td className="rowlab">
                <b>利息、股息、红利所得应纳税所得额</b>
                <br />
                按税前分红基数折算人民币，独立于财产转让所得计算
              </td>
              <td className={`col ${bestColClass("fifo")}`}>{fmt(fifo.dividendTaxBase)}</td>
              <td className={`col ${bestColClass("acb")}`}>{fmt(acb.dividendTaxBase)}</td>
            </tr>
            <tr>
              <td className="rowlab">
                <b>其中：美股分红应纳税所得额</b>
                <br />
                美股分红税前金额 × 年末 USD/CNY 汇率
              </td>
              <td className={`col ${bestColClass("fifo")}`}>{fmt(fifo.usDividendTaxBase)}</td>
              <td className={`col ${bestColClass("acb")}`}>{fmt(acb.usDividendTaxBase)}</td>
            </tr>
            <tr>
              <td className="rowlab">
                <b>海外已纳税额</b>
                <br />
                券商已扣缴的境外预提税
              </td>
              <td className={`col ${bestColClass("fifo")}`}>-¥{fmt(fifo.dividendWithholdingCredit)}</td>
              <td className={`col ${bestColClass("acb")}`}>-¥{fmt(acb.dividendWithholdingCredit)}</td>
            </tr>
            <tr>
              <td className="rowlab">
                <b>其中：美股分红海外已纳税额</b>
                <br />
                美股分红已扣税额 × 年末 USD/CNY 汇率
              </td>
              <td className={`col ${bestColClass("fifo")}`}>-¥{fmt(fifo.usDividendWithholdingCredit)}</td>
              <td className={`col ${bestColClass("acb")}`}>-¥{fmt(acb.usDividendWithholdingCredit)}</td>
            </tr>
            <tr>
              <td className="rowlab">
                <b>适用税率</b>
              </td>
              <td className={`col ${bestColClass("fifo")}`}>20%</td>
              <td className={`col ${bestColClass("acb")}`}>20%</td>
            </tr>
            <tr className="total">
              <td>预估应补税额</td>
              <td className={`col ${bestColClass("fifo")}`}>¥{fmt(fifo.tax)}</td>
              <td className={`col ${bestColClass("acb")}`}>¥{fmt(acb.tax)}</td>
            </tr>
          </tbody>
        </table>
        <div className="save-note">
          <Check />
          <div className="save-note-body">
            <p>
              {isTie ? (
                <>两种成本法税额一致。两种口径使用完全相同的成交流水，仅成本基准不同。</>
              ) : (
                <>
                  本次报告建议采用 <b>{best.label}</b>，较 {other.label} 少缴 <b>¥{fmt(saving)}</b>。两种口径使用完全相同的成交流水，仅成本基准不同。
                </>
              )}
            </p>
            <p className="method-warning">
              报税口径提醒：申报时请统一使用同一种报税口径，不能今年用 FIFO、明年用 ACB，否则可能引起税务核查。
            </p>
          </div>
        </div>

        <h2 className="sh">
          <span className="idx">2</span>财产转让所得分项（按市场）
        </h2>
        <table className="lined">
          <thead>
            <tr>
              <th>市场</th>
              <th className={`r ${bestColClass("fifo")}`}>FIFO 口径{bestBadge("fifo")}</th>
              <th className={`r ${bestColClass("acb")}`}>ACB 口径{bestBadge("acb")}</th>
              <th className="r">折算汇率</th>
            </tr>
          </thead>
          <tbody>
            {["HK", "US"].map((market) => (
              <tr key={market}>
                <td>
                  <span className="mkt-tag">{market === "HK" ? "港股 HKD" : "美股 USD"}</span>
                </td>
                <td className={`r num ${classForNumber(fifo.byMarket[market])} ${bestColClass("fifo")}`}>{cnSigned(fifo.byMarket[market])}</td>
                <td className={`r num ${classForNumber(acb.byMarket[market])} ${bestColClass("acb")}`}>{cnSigned(acb.byMarket[market])}</td>
                <td className="r num muted">{fx[market].toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>财产转让所得实际盈亏合计</td>
              <td className={`r num ${classForNumber(fifo.capitalGain)} ${bestColClass("fifo")}`}>{cnSigned(fifo.capitalGain)}</td>
              <td className={`r num ${classForNumber(acb.capitalGain)} ${bestColClass("acb")}`}>{cnSigned(acb.capitalGain)}</td>
              <td />
            </tr>
          </tfoot>
        </table>

        <h2 className="sh">
          <span className="idx">3</span>利息、股息、红利所得分项
        </h2>
        <table className="lined report-dividend-table">
          <colgroup>
            <col className="col-market" />
            <col className="col-security" />
            <col className="col-amount" />
            <col className="col-tax" />
            <col className="col-rmb" />
            <col className="col-rmb" />
          </colgroup>
          <thead>
            <tr>
              <th>市场</th>
              <th>标的</th>
              <th className="r">税前分红</th>
              <th className="r">已纳税额（原币）</th>
              <th className="r">应纳税所得额</th>
              <th className="r">海外已纳税额</th>
            </tr>
          </thead>
          <tbody>
            {dividendRows.map((dividend) => {
              return (
                <tr key={dividend.id}>
                  <td>
                    <span className="mkt-tag">{dividend.market === "HK" ? "港股 HKD" : "美股 USD"}</span>
                  </td>
                  <td className="report-security-cell">
                    <b>{dividend.symbol}</b>
                    <span>{dividend.securityName}</span>
                  </td>
                  <td className="r num">
                    {dividend.currency} {fmt(dividend.grossAmount)}
                  </td>
                  <td className="r num">
                    {dividend.currency} {fmt(dividend.taxWithheld)}
                  </td>
                  <td className="r num">{fmt(dividend.taxableRmb)}</td>
                  <td className="r num">{fmt(dividend.withholdingRmb)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan="4">利息、股息、红利所得应纳税所得额合计</td>
              <td className="r num">{fmt(dividendTaxBaseRmb)}</td>
              <td className="r num">{fmt(dividendWithholdingRmb)}</td>
            </tr>
          </tfoot>
        </table>

        {hasForeignCreditMaterials ? (
          <>
            <h2 className="sh">
              <span className="idx">4</span>境外所得抵扣材料
            </h2>
            <div className="foreign-credit-block">
              <div className="foreign-credit-summary">
                <div>
                  <span>美股分红应纳税所得额</span>
                  <b>¥{fmt(usDividendTaxBaseRmb)}</b>
                </div>
                <div>
                  <span>美股分红海外已纳税额</span>
                  <b>¥{fmt(usDividendWithholdingRmb)}</b>
                </div>
              </div>
              <div className="foreign-credit-note">以下截图为券商 PDF 中美股分红及扣税记录的原文位置，供申报境外所得抵扣时核对。</div>
              {usDividendEvidenceRows.length ? (
                <div className="report-evidence-list">
                  {usDividendEvidenceRows.map((dividend) => (
                    <figure className="report-evidence" key={`${dividend.id}-evidence`}>
                      <figcaption>
                        {dividend.symbol} · {dividend.securityName} · {dividend.source}
                        {dividend.evidence?.page ? ` · 第 ${dividend.evidence.page} 页` : ""} · 应纳税所得额 RMB {fmt(dividend.taxableRmb)} · 海外已纳税额 RMB {fmt(dividend.withholdingRmb)}
                      </figcaption>
                      {dividend.evidence?.imageDataUrl ? (
                        <img src={dividend.evidence.imageDataUrl} alt={`${dividend.symbol} 美股分红 PDF 原文截图`} />
                      ) : (
                        <pre>{dividend.evidence?.text}</pre>
                      )}
                    </figure>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        <h2 className="sh">
          <span className="idx">{4 + foreignCreditOffset}</span>数据来源文件
        </h2>
        <table className="lined">
          <thead>
            <tr>
              <th>文件</th>
              <th>类型</th>
              <th className="r">行数</th>
              <th className="c">状态</th>
            </tr>
          </thead>
          <tbody>
            {files.map((file) => (
              <tr className="file-row" key={file.id}>
                <td className="fn">{file.name}</td>
                <td>{file.type}</td>
                <td className="r num">{typeof file.rows === "number" ? file.rows : "-"}</td>
                <td className="c">
                  <span className="ok-dot" />
                  {file.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="notes">
          <b>计算口径说明.</b> 本底稿按个人所得税「财产转让所得」和「利息、股息、红利所得」<b>20% 税率</b> 预估。年度边界为自然年 1/1-12/31。FIFO 按先进先出匹配成本，ACB
          按持仓平均成本匹配。分红按税前金额作为利息、股息、红利所得应纳税所得额，券商已扣缴的境外预提税作为海外已纳税额列示。
          <div className="disc">免责声明：本工具结果仅供个人申报参考与自查，不构成税务、会计或法律意见。最终申报口径与税额请以主管税务机关要求及专业税务顾问意见为准。</div>
        </div>
        <PublisherCredit className="report-publisher-bottom" />
      </div>
    </div>
  );
}

const TOUR_STEPS = [
  {
    target: "upload-card",
    title: "上传券商材料",
    body: "从这里导入富途 Excel 年度报表、长桥/卓锐 PDF 月结单或老虎 PDF 报表。上传后系统会尝试判断券商和文件类型。",
    images: [
      {
        src: `${ASSET_BASE}tour/futu-annual-report.jpg`,
        alt: "富途 App 年度报表入口示例",
        caption: "富途：账户 > 年度报表",
      },
      {
        src: `${ASSET_BASE}tour/longbridge-monthly-statement.jpg`,
        alt: "长桥 App 月结单入口示例",
        caption: "长桥：全部功能 > 结单查询",
      },
    ],
  },
  {
    target: "analyze-button",
    title: "解析并计算",
    body: "确认材料与 PDF 密码后，点击解析会生成 FIFO 和 ACB 两套结果。若检测到历史成本缺失，可以直接补充或订正成本后重算。",
  },
  {
    target: "report-nav",
    title: "生成申报报告",
    body: "完成核对后进入申报报告页，可复制申报数字，也可以导出 PDF 留存。",
    spotlightPadding: 2,
    spotlightRadius: 10,
  },
];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function MobileUnsupportedOverlay() {
  const [copiedLink, setCopiedLink] = useState(false);

  function copyCurrentLink() {
    if (!navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(window.location.href).then(() => {
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1800);
    });
  }

  return (
    <div className="mobile-unsupported-backdrop" role="presentation">
      <section className="mobile-unsupported-card" role="dialog" aria-modal="true" aria-labelledby="mobile-unsupported-title">
        <div className="mobile-device-icons" aria-hidden="true">
          <span>
            <Smartphone />
          </span>
          <ArrowRight />
          <span className="desktop">
            <Monitor />
          </span>
        </div>
        <h2 id="mobile-unsupported-title">请在电脑上使用 TaxCheck</h2>
        <p>
          TaxCheck 需要上传券商文件、核对大表格、订正成本并生成申报底稿。手机屏幕不适合完成这些流程，当前版本不做手机端适配。
        </p>
        <p className="mobile-unsupported-note">请在电脑浏览器打开当前链接后继续使用。</p>
        <button className="btn primary" type="button" onClick={copyCurrentLink}>
          <Copy /> {copiedLink ? "已复制链接" : "复制当前链接"}
        </button>
      </section>
    </div>
  );
}

function ProjectIntroModal({ onStart, onClose }) {
  return (
    <div className="app-modal-backdrop" role="presentation">
      <section className="intro-modal" role="dialog" aria-modal="true" aria-labelledby="intro-title">
        <button className="modal-close" type="button" aria-label="关闭介绍" onClick={onClose}>
          <X />
        </button>
        <TaxCheckMark className="intro-brand-mark" />
        <h2 id="intro-title">TaxCheck 是什么</h2>
        <p>
          TaxCheck是快速为中国大陆居民打造的免费海外资本利得税计算工具，支持富途、长桥、卓锐、老虎等券商。
          <br />
          <br />
          <b>本工具承诺不保存任何你的财务数据，上传的文件仅在你本地解析使用。</b>
          <br />
          <br />
          本工具由公众号“<b>汤姆喵的奇妙旅行</b>”制作，还有更多的工具在公众号中，欢迎关注。
        </p>
        <div className="intro-points">
          <span>富途 Excel 年度报表</span>
          <span>长桥 PDF 月结单</span>
          <span>卓锐 PDF 月结单</span>
          <span>老虎 PDF 税表/活动报表</span>
          <span>申报数字与 PDF 底稿</span>
        </div>
        <div className="intro-actions">
          <button className="btn" type="button" onClick={onClose}>
            稍后再看
          </button>
          <button className="btn primary" type="button" onClick={onStart}>
            开始引导 <ArrowRight />
          </button>
        </div>
      </section>
    </div>
  );
}

function WechatFeedbackFloat() {
  return (
    <div className="wechat-feedback" aria-label="微信反馈群">
      <button className="wechat-feedback-trigger" type="button" aria-describedby="wechat-feedback-panel">
        <MessageCircle />
        <span>反馈群</span>
      </button>
      <div className="wechat-feedback-panel" id="wechat-feedback-panel" role="tooltip">
        <div className="wechat-feedback-copy">
          <b>微信反馈群</b>
          <span>扫码加入「汤姆喵的小屋」</span>
        </div>
        <img src={`${ASSET_BASE}wechat-feedback-group.jpg`} alt="微信反馈群二维码" />
      </div>
    </div>
  );
}

function FormattedIssueText({ text }) {
  return String(text ?? "")
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, index) => {
      const strong = part.match(/^\*\*([^*]+)\*\*$/);
      return strong ? <b key={index}>{strong[1]}</b> : <React.Fragment key={index}>{part}</React.Fragment>;
    });
}

function AppIssueModal({ issue, onClose }) {
  return (
    <div className="app-modal-backdrop" role="presentation">
      <section className="intro-modal year-issue-modal" role="dialog" aria-modal="true" aria-labelledby="app-issue-title">
        <button className="modal-close" type="button" aria-label="关闭提醒" onClick={onClose}>
          <X />
        </button>
        <div className={`intro-icon ${issue.severity === "info" ? "" : "warning-icon"}`}>
          <AlertCircle />
        </div>
        <span className={`modal-kicker ${issue.severity}`}>{issueSeverityLabel(issue.severity)}</span>
        <h2 id="app-issue-title">{issue.title}</h2>
        <p>
          <FormattedIssueText text={issue.detail} />
        </p>
        <div className="intro-actions">
          <button className="btn" type="button" onClick={onClose}>
            确认
          </button>
        </div>
      </section>
    </div>
  );
}

function CostBasisModal({ request, value, analysisStatus, onSubmit, onClose }) {
  const [mode, setMode] = useState("unit");
  const [inputValue, setInputValue] = useState(totalCostToInputValue(value, "unit", request.quantity));

  useEffect(() => {
    setMode("unit");
    setInputValue(totalCostToInputValue(value, "unit", request.quantity));
  }, [request.id, request.quantity, value]);

  const totalCost = costInputToTotalCost(inputValue, mode, request.quantity);
  const canSubmit = totalCost !== null && analysisStatus !== "running";
  return (
    <div className="app-modal-backdrop" role="presentation">
      <section className="intro-modal cost-basis-modal" role="dialog" aria-modal="true" aria-labelledby="cost-basis-title">
        <button className="modal-close" type="button" aria-label="稍后填写成本" onClick={onClose}>
          <X />
        </button>
        <div className="intro-icon warning-icon">
          <Calculator />
        </div>
        <span className="modal-kicker warning">需要补充</span>
        <h2 id="cost-basis-title">{request.symbol} 历史成本缺失</h2>
        <p>
          系统检测到目标年度卖出 {request.quantity.toLocaleString()} 股 {request.securityName}，但上传材料无法匹配足够买入成本。请输入这批卖出对应的总成本或每股成本，确认后会立即重新计算 FIFO / ACB。
        </p>
        <div className="cost-basis-card">
          <div>
            <span>卖出日期</span>
            <b>{request.sellDate}</b>
          </div>
          <div>
            <span>卖出收入</span>
            <b>
              {request.currency} {fmt(request.proceeds)}
            </b>
          </div>
          <div>
            <span>券商</span>
            <b>{request.broker}</b>
          </div>
        </div>
        <form
          className="cost-basis-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit && totalCost !== null) onSubmit(request.id, String(totalCost));
          }}
        >
          <label>
            <span>{costInputLabel(request.currency, mode)}</span>
            <CostModeToggle
              value={mode}
              inputValue={inputValue}
              quantity={request.quantity}
              onChange={(nextMode, nextValue) => {
                setMode(nextMode);
                setInputValue(nextValue);
              }}
            />
            <input
              className="plain-input"
              value={inputValue}
              onChange={(event) => setInputValue(normalizeCostInput(event.target.value, mode))}
              placeholder={costInputPlaceholder(mode)}
              inputMode="decimal"
              autoFocus
            />
            {mode === "unit" && totalCost !== null ? (
              <span className="cost-total-preview">
                折算总成本：{request.currency} {fmt(totalCost)}
                <small>买入手续费需已摊入每股成本</small>
              </span>
            ) : null}
          </label>
          <div className="intro-actions">
            <button className="btn" type="button" onClick={onClose}>
              稍后填写
            </button>
            <button className="btn primary" type="submit" disabled={!canSubmit}>
              <Calculator /> 确认并重算
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function GuidedTour({ stepIndex, steps, onNext, onBack, onClose }) {
  const step = steps[stepIndex];
  const [layout, setLayout] = useState(null);
  const isLast = stepIndex === steps.length - 1;

  useEffect(() => {
    if (!step) return undefined;

    function updateLayout() {
      const element = document.querySelector(`[data-tour-id="${step.target}"]`);
      if (!element) {
        setLayout({ spotlight: null, card: null });
        return;
      }
      const rect = element.getBoundingClientRect();
      const padding = step.spotlightPadding ?? 8;
      const cardWidth = step.images?.length ? Math.min(640, window.innerWidth - 32) : Math.min(376, window.innerWidth - 32);
      const cardHeight = step.images?.length ? 500 : 210;
      const gap = 18;
      const canRight = rect.right + gap + cardWidth <= window.innerWidth - 16;
      const canLeft = rect.left - gap - cardWidth >= 16;
      const canBelow = rect.bottom + gap + cardHeight <= window.innerHeight - 16;
      const canAbove = rect.top - gap - cardHeight >= 16;
      let top = clamp(rect.top, 16, window.innerHeight - cardHeight - 16);
      let left = clamp(rect.right + gap, 16, window.innerWidth - cardWidth - 16);

      if (canRight) {
        top = clamp(rect.top, 16, window.innerHeight - cardHeight - 16);
        left = rect.right + gap;
      } else if (canLeft) {
        top = clamp(rect.top, 16, window.innerHeight - cardHeight - 16);
        left = rect.left - gap - cardWidth;
      } else if (canBelow) {
        top = rect.bottom + gap;
        left = clamp(rect.left + rect.width / 2 - cardWidth / 2, 16, window.innerWidth - cardWidth - 16);
      } else if (canAbove) {
        top = rect.top - gap - cardHeight;
        left = clamp(rect.left + rect.width / 2 - cardWidth / 2, 16, window.innerWidth - cardWidth - 16);
      } else {
        top = 16;
        left = clamp(rect.right + gap, 16, window.innerWidth - cardWidth - 16);
      }
      const spotlightTop = clamp(rect.top - padding, 8, window.innerHeight - 16);
      const spotlightLeft = clamp(rect.left - padding, 8, window.innerWidth - 16);
      setLayout({
        spotlight: {
          top: spotlightTop,
          left: spotlightLeft,
          width: Math.min(window.innerWidth - spotlightLeft - 8, rect.width + padding * 2),
          height: Math.min(window.innerHeight - spotlightTop - 8, rect.height + padding * 2),
          borderRadius: step.spotlightRadius ?? 12,
        },
        card: {
          top,
          left,
          width: cardWidth,
        },
      });
    }

    updateLayout();
    window.addEventListener("resize", updateLayout);
    window.addEventListener("scroll", updateLayout, true);
    return () => {
      window.removeEventListener("resize", updateLayout);
      window.removeEventListener("scroll", updateLayout, true);
    };
  }, [step]);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!step) return null;

  return (
    <>
      <div className="tour-click-catcher" role="presentation" onClick={onClose} />
      {layout?.spotlight ? <div className="tour-spotlight" style={layout.spotlight} aria-hidden="true" /> : <div className="tour-fallback-scrim" aria-hidden="true" />}
      <section className={`tour-card ${layout?.spotlight ? "" : "center"}`} style={layout?.card ?? undefined} role="dialog" aria-modal="true" aria-label="页面引导">
        <div className="tour-head">
          <span className="tour-step">
            {stepIndex + 1} / {steps.length}
          </span>
          <button className="tour-x" type="button" aria-label="关闭引导" onClick={onClose}>
            <X />
          </button>
        </div>
        <h3>{step.title}</h3>
        <p>
          {step.body}
          {step.emphasis ? (
            <>
              <b>{step.emphasis}</b>
            </>
          ) : null}
        </p>
        {step.images?.length ? (
          <div className="tour-media-grid">
            {step.images.map((image) => (
              <figure className="tour-media" key={image.src}>
                <img src={image.src} alt={image.alt} loading="lazy" />
                <figcaption>{image.caption}</figcaption>
              </figure>
            ))}
          </div>
        ) : null}
        <div className="tour-progress" aria-hidden="true">
          {steps.map((item, index) => (
            <span key={item.target} className={index <= stepIndex ? "on" : ""} />
          ))}
        </div>
        <div className="tour-actions">
          <button className="btn" type="button" onClick={onBack} disabled={stepIndex === 0}>
            <ArrowLeft /> 上一步
          </button>
          <button className="btn primary" type="button" onClick={onNext}>
            {isLast ? "完成" : "下一步"} {!isLast ? <ArrowRight /> : null}
          </button>
        </div>
      </section>
    </>
  );
}

export default function App() {
  const fileInputRef = useRef(null);
  const isMobileDevice = useIsMobileDevice();
  const [page, setPage] = useState("workbench");
  const [year, setYear] = useState(TAX_YEAR);
  const [methodId, setMethodId] = useState("fifo");
  const [files, setFiles] = useState([]);
  const [parsedInput, setParsedInput] = useState(null);
  const [analyses, setAnalyses] = useState(null);
  const [analysisStatus, setAnalysisStatus] = useState("idle");
  const [password, setPassword] = useState("");
  const [manualCosts, setManualCosts] = useState({});
  const [securityAliases, setSecurityAliases] = useState({});
  const [costCorrections, setCostCorrections] = useState({});
  const [copied, setCopied] = useState(false);
  const [showIntro, setShowIntro] = useState(true);
  const [tourStep, setTourStep] = useState(-1);
  const [dismissedIssueIds, setDismissedIssueIds] = useState(new Set());
  const [manualIssues, setManualIssues] = useState([]);
  const [activeIssue, setActiveIssue] = useState(null);
  const [activeCostRequest, setActiveCostRequest] = useState(null);
  const [dismissedCostRequestIds, setDismissedCostRequestIds] = useState(new Set());
  const [pendingCostFlashAfterIssues, setPendingCostFlashAfterIssues] = useState(false);
  const [pendingCostFlashToken, setPendingCostFlashToken] = useState(0);

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    if (!parsedInput) return;
    setAnalyses(recomputeAnalyses(parsedInput, year, costCorrectionInputsFromState(costCorrections)));
  }, [costCorrections, parsedInput, year]);

  const currentAnalysis = analyses?.[methodId] ?? null;
  const fx = useMemo(() => fxForTaxYear(year), [year]);
  const rows = useMemo(() => rowsFromAnalysis(currentAnalysis), [currentAnalysis]);
  const summary = useMemo(() => summaryFromAnalysis(currentAnalysis, fx), [currentAnalysis, fx]);
  const dividends = useMemo(() => dividendsFromAnalysis(currentAnalysis), [currentAnalysis]);
  const openPositions = useMemo(() => openPositionsFromAnalysis(currentAnalysis), [currentAnalysis]);
  const tradeActivities = useMemo(() => tradeActivitiesFromAnalysis(currentAnalysis), [currentAnalysis]);
  const realizedTrades = currentAnalysis?.realizedTrades ?? [];
  const analysisIssues = useMemo(
    () => (currentAnalysis?.issues ?? []).filter((issue) => issue.severity !== "blocking" && !isCostGapIssue(issue)),
    [currentAnalysis],
  );
  const hasLongbridgeNoStockActivity = useMemo(
    () => (currentAnalysis?.issues ?? []).some((issue) => issue.id === "longbridge-no-stock-activity"),
    [currentAnalysis],
  );
  const hasTaxSummaryNoTradeDetail = useMemo(
    () => (currentAnalysis?.issues ?? []).some((issue) => String(issue.id ?? "").includes("-no-trade-detail")),
    [currentAnalysis],
  );
  const costBasisRequests = useMemo(() => currentAnalysis?.costBasisRequests ?? [], [currentAnalysis]);
  const modalIssues = useMemo(
    () => [...manualIssues, ...analysisIssues].filter((issue) => !dismissedIssueIds.has(issue.id)),
    [analysisIssues, dismissedIssueIds, manualIssues],
  );
  const methodSummaries = useMemo(
    () => ({
      fifo: methodReportFromAnalysis(analyses?.fifo, fx),
      acb: methodReportFromAnalysis(analyses?.acb, fx),
    }),
    [analyses, fx],
  );
  useEffect(() => {
    if (activeIssue || activeCostRequest || modalIssues.length === 0) return;
    setActiveIssue(modalIssues[0]);
  }, [activeCostRequest, activeIssue, modalIssues]);

  useEffect(() => {
    if (!activeCostRequest) return;
    if (costBasisRequests.some((request) => request.id === activeCostRequest.id)) return;
    setActiveCostRequest(null);
  }, [activeCostRequest, costBasisRequests]);

  useEffect(() => {
    if (showIntro || activeIssue || activeCostRequest || modalIssues.length > 0 || analysisStatus === "running") return;
    const nextRequest = costBasisRequests.find((request) => {
      return !dismissedCostRequestIds.has(request.id) && !isValidManualCostValue(manualCosts[request.id]);
    });
    if (!nextRequest) return;
    setPage("workbench");
    setActiveCostRequest(nextRequest);
  }, [activeCostRequest, activeIssue, analysisStatus, costBasisRequests, dismissedCostRequestIds, manualCosts, modalIssues.length, showIntro]);

  useEffect(() => {
    if (activeIssue || modalIssues.length > 0 || !pendingCostFlashAfterIssues) return undefined;
    const timer = window.setTimeout(() => {
      setPendingCostFlashToken(Date.now());
      setPendingCostFlashAfterIssues(false);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [activeIssue, modalIssues.length, pendingCostFlashAfterIssues]);

  function pushManualIssue(issue) {
    setManualIssues((current) => [...current.filter((item) => item.id !== issue.id), issue]);
    setDismissedIssueIds((current) => {
      if (!current.has(issue.id)) return current;
      const next = new Set(current);
      next.delete(issue.id);
      return next;
    });
  }

  function triggerUpload() {
    fileInputRef.current?.click();
  }

  async function handleFileInput(event) {
    const incoming = Array.from(event.target.files ?? []);
    if (!incoming.length) return;
    const timestamp = Date.now();
    const scanned = await Promise.all(
      incoming.map(async (file) => ({
        file,
        fingerprint: await fileFingerprint(file),
      })),
    );
    const existingFingerprints = new Set(files.map((file) => file.fingerprint).filter(Boolean));
    const seenFingerprints = new Set();
    const accepted = [];
    const duplicates = [];
    for (const item of scanned) {
      if (existingFingerprints.has(item.fingerprint) || seenFingerprints.has(item.fingerprint)) {
        duplicates.push(item.file.name);
        continue;
      }
      seenFingerprints.add(item.fingerprint);
      accepted.push(item);
    }

    if (duplicates.length > 0) {
      pushManualIssue({
        id: `duplicate-upload-${timestamp}`,
        severity: "warning",
        title: "重复上传同一份报告",
        detail: `以下文件已经在列表中或本次选择中重复出现：${duplicates.join("、")}。系统已跳过重复文件，请保留一份后再解析。`,
        action: "upload",
      });
    }
    if (accepted.length === 0) {
      event.target.value = "";
      return;
    }

    const pendingEntries = accepted.map(({ file, fingerprint }, idx) => {
      const guess = baseBrokerGuess(file.name);
      return {
        id: `${timestamp}-${idx}-${file.name}`,
        name: file.name,
        fingerprint,
        size: file.size,
        lastModified: file.lastModified,
        broker: guess.broker,
        brokerConfidence: "pending",
        brokerReason: "正在根据文件内容确认券商。",
        type: guessFileType(file.name),
        rows: "待解析",
        status: "待解析",
        file,
        brokerTouched: false,
      };
    });
    setFiles((current) => [...current, ...pendingEntries]);
    event.target.value = "";

    const detected = await Promise.all(
      accepted.map(async ({ file }) => ({
        guess: await detectBrokerFromFile(file),
      })),
    );

    setFiles((current) =>
      current.map((entry) => {
        const index = pendingEntries.findIndex((item) => item.id === entry.id);
        if (index === -1 || entry.brokerTouched) return entry;
        const guess = detected[index]?.guess ?? baseBrokerGuess(entry.name);
        return {
          ...entry,
          broker: guess.broker,
          brokerConfidence: guess.confidence,
          brokerReason: guess.reason,
        };
      }),
    );
  }

  function removeFile(fileId) {
    setFiles((current) => current.filter((file) => file.id !== fileId));
  }

  function updateBroker(fileId, broker) {
    setFiles((current) =>
      current.map((file) =>
        file.id === fileId
          ? {
              ...file,
              broker,
              brokerTouched: true,
              brokerConfidence: "manual",
              brokerReason: `已由用户手动选择为${brokerLabel(broker)}；解析时会按该券商处理。`,
              status: file.status === "已解析" ? "待重算" : file.status,
            }
          : file,
      ),
    );
  }

  function submitCostCorrection(id, value) {
    if (!id || !isValidManualCostValue(value)) return;
    setCostCorrections((current) => ({ ...current, [id]: value }));
  }

  function clearCostCorrection(id) {
    setCostCorrections((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, id)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
  }

  async function runAnalysis(manualCostOverrides = {}, securityAliasOverrides = {}) {
    if (needsBrokerPdfPassword(files) && !password.trim()) {
      setPage("workbench");
      setAnalysisStatus("idle");
      pushManualIssue({
        id: "pdf-password-required",
        severity: "warning",
        title: "请填写 PDF 月结单密码",
        detail: "检测到需要密码的 PDF 月结单。请在左侧「PDF 月结单密码」中填写对应券商的 PDF 密码，然后再点击解析并计算。",
        action: "upload",
      });
      return;
    }

    setAnalysisStatus("running");
    try {
      const effectiveManualCosts = { ...manualCosts, ...manualCostOverrides };
      const effectiveSecurityAliases = { ...securityAliases, ...securityAliasOverrides };
      const manualCostInputs = Object.entries(effectiveManualCosts)
        .map(([id, value]) => ({ id, costBasis: parseManualCostValue(value) }))
        .filter((item) => item.costBasis !== null);
      const securityAliasInputs = securityAliasInputsFromState(effectiveSecurityAliases);
      const costCorrectionInputs = costCorrectionInputsFromState(costCorrections);
      const result = await analyzeUploadedFiles({
        files,
        taxYear: year,
        password,
        manualCosts: manualCostInputs,
        securityAliases: securityAliasInputs,
        costCorrections: costCorrectionInputs,
      });
      setParsedInput(result.parsedInput);
      setAnalyses(result.byMethod);
      setFiles((current) =>
        current.map((file) => ({
          ...file,
          rows: file.file ? "已读取" : file.rows,
          status: file.file ? "已解析" : file.status,
        })),
      );
      setAnalysisStatus("done");
    } catch (error) {
      const message =
        error instanceof ParserValidationError || error instanceof Error ? error.message : "解析失败，请检查文件格式和券商选择。";
      setAnalysisStatus("error");
      pushManualIssue({
        id: `analysis-error-${Date.now()}`,
        severity: "blocking",
        title: "解析失败",
        detail: message,
        action: "upload",
      });
    }
  }

  function submitManualCost(id, value) {
    setManualCosts((current) => ({ ...current, [id]: value }));
    setActiveCostRequest(null);
    runAnalysis({ [id]: value });
  }

  function submitSecurityAlias(row, symbol) {
    const normalized = normalizeSecuritySymbolInput(symbol);
    if (!row?.name || !normalized) return;
    const key = securityAliasStateKey(row);
    const nextAlias = {
      name: row.name,
      symbol: normalized,
      market: row.market === "US" ? "美国市场" : row.market === "HK" ? "香港市场" : row.market,
      currency: row.currency,
    };
    setSecurityAliases((current) => ({ ...current, [key]: nextAlias }));
    runAnalysis({}, { [key]: nextAlias });
  }

  function exportCsv() {
    const header = ["市场", "代码", "名称", "币种", "成本法", "盈亏原币", "折算汇率", "盈亏RMB"];
    const body = rows.map((row) => [
      row.market,
      displayRowCode(row.code),
      row.name,
      row.currency,
      methodById(methodId).label,
      row.missingCost
        ? "待补成本"
        : row.positionOnly
          ? row.pnlOriginal === null
            ? `市值 ${row.proceeds.toFixed(2)}（不计入）`
            : `${floatingPnlLabel(row.pnlOriginal)}（不计入）`
          : row.pnlOriginal.toFixed(2),
      (fx[row.market] ?? 1).toFixed(4),
      row.missingCost ? "" : row.positionOnly ? "不参与计算" : row.rmb.toFixed(2),
    ]);
    const csv = [header, ...body].map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(",")).join("\n");
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `TaxCheck_${year}_${methodById(methodId).tag}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyReport() {
    const { best, other, isTie, saving } = bestCostMethod(methodSummaries);
    const text = [
      `海外证券资本利得税申报底稿 · 纳税年度 ${year}`,
      `计算口径：${best.label}${isTie ? "（两种成本法税额一致）" : "（推荐，税负最优）"}`,
      `财产转让所得实际盈亏：RMB ${cnSigned(best.summary.capitalGain)}`,
      `财产转让所得应纳税所得额：¥${fmt(best.summary.capitalTaxBase)}`,
      `利息、股息、红利所得应纳税所得额：¥${fmt(best.summary.dividendTaxBase)}`,
      `其中美股分红应纳税所得额：¥${fmt(best.summary.usDividendTaxBase)}`,
      "适用税率：20%",
      `分类税额合计（抵免前）：¥${fmt((best.summary.capitalTaxBase + best.summary.dividendTaxBase) * TAX_RATE)}`,
      `海外已纳税额：¥${fmt(best.summary.dividendWithholdingCredit)}`,
      `其中美股分红海外已纳税额：¥${fmt(best.summary.usDividendWithholdingCredit)}`,
      `预估应补税额：¥${fmt(best.summary.tax)}`,
      "说明：财产转让所得亏损不抵减利息、股息、红利所得应纳税所得额。",
      isTie ? "自然年 FIFO 与自然年 ACB 税额一致" : `对比${other.label}应缴 ¥${fmt(other.summary.tax)}，可节省 ¥${fmt(saving)}`,
      `年末汇率：USD ${fx.US.toFixed(4)} / HKD ${fx.HK.toFixed(4)}（${fx.date} ${fx.source}）`,
    ].join("\n");
    trackReportGenerated("copy_numbers");
    const markCopied = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    };
    if (!navigator.clipboard?.writeText) {
      markCopied();
      return;
    }
    navigator.clipboard.writeText(text).finally(markCopied);
  }

  function exportPdf() {
    trackReportGenerated("export_pdf");
    window.print();
  }

  function startTour() {
    setShowIntro(false);
    setPage("workbench");
    setTourStep(0);
  }

  function closeTour() {
    setTourStep(-1);
  }

  function closeActiveIssue() {
    const shouldFlashPendingCost =
      String(activeIssue?.id ?? "").includes("cost-gap") || String(activeIssue?.detail ?? "").includes("待补成本");
    if (activeIssue?.id) {
      setDismissedIssueIds((current) => {
        const next = new Set(current);
        next.add(activeIssue.id);
        return next;
      });
    }
    if (shouldFlashPendingCost) {
      setPendingCostFlashAfterIssues(true);
    }
    setActiveIssue(null);
  }

  function closeCostBasisModal() {
    if (activeCostRequest?.id) {
      setDismissedCostRequestIds((current) => {
        const next = new Set(current);
        next.add(activeCostRequest.id);
        return next;
      });
      setPendingCostFlashAfterIssues(true);
    }
    setPage("workbench");
    setActiveCostRequest(null);
  }

  function nextTourStep() {
    setTourStep((current) => (current >= TOUR_STEPS.length - 1 ? -1 : current + 1));
  }

  function previousTourStep() {
    setTourStep((current) => Math.max(0, current - 1));
  }

  return (
    <>
      <input className="hidden-input" ref={fileInputRef} type="file" multiple accept=".xlsx,.xls,.pdf" onChange={handleFileInput} />
      <TopBar activePage={page} onNavigate={setPage} />
      {page === "workbench" ? (
        <Workbench
          year={year}
          setYear={setYear}
          methodId={methodId}
          setMethodId={setMethodId}
          rows={rows}
          summary={summary}
          files={files}
          onUpload={triggerUpload}
          onRemoveFile={removeFile}
          onBrokerChange={updateBroker}
          onAnalyze={runAnalysis}
          analysisStatus={analysisStatus}
          password={password}
          onPasswordChange={setPassword}
          manualCosts={manualCosts}
          costCorrections={costCorrections}
          securityAliases={securityAliases}
          onSubmitManualCost={submitManualCost}
          onSubmitSecurityAlias={submitSecurityAlias}
          onSubmitCostCorrection={submitCostCorrection}
          onClearCostCorrection={clearCostCorrection}
          dividends={dividends}
          tradeActivities={tradeActivities}
          fx={fx}
          pendingCostFlashToken={pendingCostFlashToken}
          hasLongbridgeNoStockActivity={hasLongbridgeNoStockActivity}
          hasTaxSummaryNoTradeDetail={hasTaxSummaryNoTradeDetail}
        />
      ) : null}
      {page === "holdings" ? (
        <HoldingsPage
          year={year}
          openPositions={openPositions}
          tradeActivities={tradeActivities}
          realizedTrades={realizedTrades}
          dividends={dividends}
          files={files}
          fx={fx}
        />
      ) : null}
      {page === "report" ? (
        <ReportPage
          year={year}
          methodSummaries={methodSummaries}
          files={files}
          dividends={dividends}
          onCopyReport={copyReport}
          onExportCsv={exportCsv}
          onExportPdf={exportPdf}
          copied={copied}
          fx={fx}
        />
      ) : null}
      {!showIntro && activeIssue ? <AppIssueModal issue={activeIssue} onClose={closeActiveIssue} /> : null}
      {!showIntro && !activeIssue && activeCostRequest ? (
        <CostBasisModal
          request={activeCostRequest}
          value={manualCosts[activeCostRequest.id] ?? ""}
          analysisStatus={analysisStatus}
          onSubmit={submitManualCost}
          onClose={closeCostBasisModal}
        />
      ) : null}
      {showIntro ? <ProjectIntroModal onStart={startTour} onClose={() => setShowIntro(false)} /> : null}
      {tourStep >= 0 ? <GuidedTour stepIndex={tourStep} steps={TOUR_STEPS} onNext={nextTourStep} onBack={previousTourStep} onClose={closeTour} /> : null}
      {!isMobileDevice ? <WechatFeedbackFloat /> : null}
      {isMobileDevice ? <MobileUnsupportedOverlay /> : null}
    </>
  );
}
