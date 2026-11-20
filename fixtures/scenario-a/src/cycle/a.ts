import { pingB } from "./b";

export function pingA(): string {
  return pingB();
}
