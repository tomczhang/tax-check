import type { Currency } from "@/lib/tax/types";

export class ParserValidationError extends Error {
  constructor(
    message: string,
    public readonly source?: string,
  ) {
    super(message);
    this.name = "ParserValidationError";
  }
}

export function asCurrency(value: unknown): Currency {
  const text = String(value ?? "").toUpperCase();
  if (text.includes("USD") || text.includes("美元")) return "USD";
  if (text.includes("CNY") || text.includes("人民币")) return "CNY";
  return "HKD";
}

export function asNumber(value: unknown): number {
  if (typeof value === "number") return value;
  const text = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[()]/g, "")
    .trim();
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

const SECURITY_SYMBOL_ALIASES: Record<string, string> = {
  // DiDi traded as DIDI on NYSE, then as DIDIY after moving to OTC.
  DIDIY: "DIDI",
};

export function normalizeSymbol(value: unknown) {
  const text = String(value ?? "").trim().toUpperCase();
  const normalized = /^\d+$/.test(text) ? text.padStart(5, "0") : text;
  return SECURITY_SYMBOL_ALIASES[normalized] ?? normalized;
}

export function sourceId(fileName: string, row: number) {
  return `${fileName}#row-${row}`;
}
