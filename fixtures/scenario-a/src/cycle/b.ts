import { pingA } from "./a";

export function pingB(): string {
  return pingA();
}
