import { dryRun, type Outbound, type Delivery } from "./types.js";
// Demo pass only. No access to third-party boarding passes.
export class Wallet {
  private counts = new Map<string, number>();
  async send(m: Outbound): Promise<Delivery> {
    const key = `${new Date().toISOString().slice(0, 10)}:${m.destination ?? "demo"}`;
    const count = this.counts.get(key) ?? 0;
    if (count >= 3) return { delivered: false, simulated: true };
    this.counts.set(key, count + 1);
    return dryRun("wallet-stub", m);
  }
}
