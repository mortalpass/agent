import { formatDate } from "./date/format-date";

export function label(iso: string): string {
  return `date: ${formatDate(iso)}`;
}
