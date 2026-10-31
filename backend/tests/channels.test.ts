import { afterEach,describe,expect,it,vi } from "vitest";
import type { Outbound } from "../src/channels/types.js";
import { Wallet } from "../src/channels/wallet.js";
import { whatsapp } from "../src/channels/whatsapp.js";
import { aircraftNearLrcv,schedule } from "../src/data/flights.js";
const message: Outbound = {
  messageId: "m",
  receiptId: "r",
  role: "taxi",
  lang: "ro",
  destination: "123",
  text: "Zboruri oprite. Actualizare la 04:00.",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("channel adapters", () => {
  it("keeps WhatsApp off unless all configuration is supplied", async () => {
    vi.stubEnv("WHATSAPP_TOKEN", "");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect((await whatsapp(message)).simulated).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("limits demo Wallet to three notifications per pass per day", async () => {
    const log = vi.spyOn(console, "log");
    const wallet = new Wallet();
    for (let i = 0; i < 4; i++) await wallet.send(message);
    expect(log).toHaveBeenCalledTimes(3);
  });
});
describe("flight data", () => {
  it("has three fixture departures per operating day plus matching arrivals", () => {
    const flights = schedule();
    expect(flights.filter((f) => f.dir === "dep")).toHaveLength(3);
    expect(flights.filter((f) => f.dir === "arr")).toHaveLength(3);
  });
  it("uses a three-second OpenSky timeout and empty fallback", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetcher);
    expect(await aircraftNearLrcv()).toEqual([]);
    expect(fetcher.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });
});
