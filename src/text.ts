// Token metadata and revert strings come from contracts anyone can deploy, so they
// are untrusted data: strip control/format characters and cap the length.
export function untrustedText(value: string, max: number): string {
  const cleaned = value.normalize("NFKC").replace(/\p{C}/gu, "").replace(/\s+/g, " ").trim();
  return Array.from(cleaned).slice(0, max).join("");
}

// Narrower form for quoting inside the plain-text summary.
export function quotable(value: string, max: number): string {
  return untrustedText(value, max).replace(/[^A-Za-z0-9 _:.,\-()/'%#]/g, "");
}

export function round1(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

// Percentage lost between what a quote promised and what arrived, floored at zero.
export function taxPct(received: bigint, expected: bigint | null): number | null {
  if (expected === null || expected <= 0n) return null;
  const ratio = Number((received * 1_000_000n) / expected) / 1_000_000;
  return round1(Math.max(0, 1 - ratio) * 100);
}

// Signed: negative means the round trip returned more ETH than went in.
export function lossPct(out: bigint, input: bigint): number | null {
  if (input <= 0n) return null;
  const ratio = Number((out * 1_000_000n) / input) / 1_000_000;
  return round1((1 - ratio) * 100);
}

export function pct(value: number | null): string {
  return value === null ? "n/a" : `${value}%`;
}
