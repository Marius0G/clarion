import { describe, it, expect, vi, afterEach } from "vitest";
import { Telegram } from "../src/channels/telegram.js";
import { sms } from "../src/channels/sms.js";
import { whatsapp } from "../src/channels/whatsapp.js";
import { Wallet } from "../src/channels/wallet.js";
import { aircraftNearLrcv, schedule } from "../src/data/flights.js";
import type { Outbound } from "../src/channels/types.js";
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
  it("uses Bot API and acknowledgement button; HTTP success alone is insufficient", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false })));
    vi.stubGlobal("fetch", fetcher);
    const t = new Telegram("test");
    expect((await t.send(message)).delivered).toBe(true);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body.reply_markup.inline_keyboard[0][0]).toEqual({
      text: "Am înțeles / Got it",
      callback_data: "read:r",
    });
    await expect(t.send(message)).rejects.toThrow();
  });
  it("long-polls start payloads and callbacks and advances past invalid updates", async () => {
    const t = new Telegram("test");
    const onStart = vi
      .fn()
      .mockRejectedValueOnce(new Error("invalid role"))
      .mockResolvedValue(undefined);
    const onRead = vi.fn(),
      onOffset = vi.fn();
    const call = vi.spyOn(t, "call").mockImplementation(async (method) => {
      if (method === "getUpdates") {
        t.stop();
        return [
          {
            update_id: 1,
            message: {
              text: "/start invalid__",
              chat: { id: 100, type: "private" },
            },
          },
          {
            update_id: 2,
            message: {
              text: "/start taxi__W63412",
              chat: { id: 100, type: "private" },
            },
          },
          {
            update_id: 3,
            callback_query: {
              id: "q",
              data: "read:r",
              from: { id: 100 },
              message: { chat: { id: 100 } },
            },
          },
        ];
      }
      return true;
    });
    await t.poll(0, onStart, onRead, onOffset);
    expect(onStart).toHaveBeenCalledWith("100", "taxi__W63412");
    expect(onRead).toHaveBeenCalledWith("r", "100");
    expect(onOffset).toHaveBeenLastCalledWith(4);
    expect(call).toHaveBeenCalledWith(
      "answerCallbackQuery",
      expect.objectContaining({ callback_query_id: "q" }),
    );
  });
  it("dry-run Telegram does not claim delivery", async () => {
    expect(await new Telegram("").send(message)).toEqual({
      delivered: false,
      simulated: true,
    });
  });
  it("validates SMSLink acknowledgement, rejects errors and SMS URLs", async () => {
    vi.stubEnv("SMSLINK_CONNECTION_ID", "id");
    vi.stubEnv("SMSLINK_PASSWORD", "password");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("MESSAGE;1;Message sent;10,0723123456,SMSLink.ro"),
        )
        .mockResolvedValueOnce(new Response("ERROR;1;Rejected")),
    );
    expect((await sms(message)).delivered).toBe(true);
    expect((await sms(message)).delivered).toBe(false);
    await expect(
      sms({ ...message, text: "https://example.com" }),
    ).rejects.toThrow();
  });
  it("keeps WhatsApp off unless all configuration is supplied", async () => {
    vi.stubEnv("WA_TOKEN", "");
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
