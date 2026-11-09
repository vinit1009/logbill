// Shared AG Grid setup: the Logbill theme and the small cell renderers the grids reuse.

import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';

ModuleRegistry.registerModules([AllCommunityModule]);

export const gridTheme = themeQuartz.withParams({
  fontFamily: 'inherit',
  fontSize: 14,
  headerFontWeight: 600,
  headerFontSize: 13,
  accentColor: '#0b63ce',
  foregroundColor: '#14213d',
  backgroundColor: '#ffffff',
  headerBackgroundColor: '#f4efe6',
  oddRowBackgroundColor: '#fcfaf6',
  borderColor: '#e6dfd2',
  rowBorder: { color: '#efe9dd' },
  wrapperBorderRadius: 10,
  spacing: 7,
  rowHeight: 42,
  headerHeight: 40,
  cellHorizontalPadding: 12
});

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft', SENT: 'Sent', SCHEDULED: 'Scheduled', PAID: 'Paid', MARKED_AS_PAID: 'Paid (recorded)', CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded', PARTIALLY_PAID: 'Part paid', PARTIALLY_REFUNDED: 'Part refunded', MARKED_AS_REFUNDED: 'Refunded', UNPAID: 'Unpaid', PAYMENT_PENDING: 'Payment pending'
};
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;
export const statusTone = (s: string, overdue: number | null): string =>
  ['PAID', 'MARKED_AS_PAID'].includes(s) ? 'paid'
  : ['CANCELLED', 'REFUNDED', 'MARKED_AS_REFUNDED', 'PARTIALLY_REFUNDED'].includes(s) ? 'muted'
  : s === 'PAYMENT_PENDING' ? 'pending'
  : overdue !== null && overdue > 0 ? 'late'
  : 'open';

export function StatusChip({ status, overdue }: { status: string; overdue: number | null }) {
  const tone = statusTone(status, overdue);
  return <span className={`chip chip-${tone}`}>{tone === 'late' ? 'Overdue' : statusLabel(status)}</span>;
}

export const usd = (cents: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
export const usdText = (value: string | number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) || 0);
export const shortDate = (iso: string): string => {
  if (!iso) return '';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
