import moment from "moment";

export function formatDate(iso: string): string {
  const m = moment(iso);
  return m.format("YYYY-MM-DD");
}
