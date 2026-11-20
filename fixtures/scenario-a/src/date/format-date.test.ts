import { formatDate } from "./format-date";

test("formatDate renders YYYY-MM-DD", () => {
  expect(formatDate("2024-01-02")).toBe("2024-01-02");
});
