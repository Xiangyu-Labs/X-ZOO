/** `"10.00"` → `"10"`, `"9.50"` → `"9.5"`: an amount as a coupon prints it. */
export function shortMoney(amount: string): string {
  return amount.includes('.') ? amount.replace(/\.?0+$/, '') : amount;
}

/** 满 100 可用, or 无门槛 when there is no minimum spend. */
export function couponCondition(minSpend: string): string {
  return Number(minSpend) > 0 ? `满${shortMoney(minSpend)}可用` : '无门槛';
}
