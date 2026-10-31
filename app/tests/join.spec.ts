import { expect, test } from "@playwright/test";
test.use({ viewport: { width: 390, height: 844 } });
const state = {
  flights: [
    { flight: "W6 3412", city: "Bergamo", sched: "2026-10-31T23:55:00Z" },
  ],
};
test("jury role, consent, subscribe, Telegram and passenger share", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "share", {
      value: undefined,
      configurable: true,
    });
  });
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  let requestBody: unknown;
  await page.route("**/api/subscribe", async (route) => {
    requestBody = route.request().postDataJSON();
    await route.fulfill({
      json: {
        subscriptionId: "jury-1",
        telegramLink:
          "https://t.me/controltower_test_bot?start=passenger_home__W63412",
      },
    });
  });
  await context.route("https://t.me/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Telegram test bot</h1>",
    }),
  );
  await page.goto("/join?src=jury");
  await expect(
    page.getByRole("button", { name: "Continuă în Telegram" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Pasager", exact: true }).click();
  await page.getByLabel("Număr zbor").fill("W6 3412");
  await expect(page.locator("#join-flights option")).toHaveAttribute(
    "value",
    "W6 3412",
  );
  await expect(page.getByRole("button", { name: /SMS/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /WhatsApp/ })).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Continuă în Telegram" }),
  ).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.screenshot({ path: "PM/screens/w4-join.png" });
  const popup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Continuă în Telegram" }).click();
  const telegram = await popup;
  await expect(telegram).toHaveURL(/https:\/\/t.me\/controltower_test_bot/);
  expect(requestBody).toEqual({
    role: "passenger_home",
    flight: "W6 3412",
    channel: "telegram",
    lang: "ro",
    consent: true,
  });
  await telegram.close();
  await expect(
    page.getByRole("link", { name: "Deschide Telegram" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Trimite celui care te așteaptă" })
    .click();
  await expect(page.getByRole("status")).toHaveText("Mesaj copiat.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "role=relative_arrivals&flight=W6+3412",
  );
});
test("relative prefill, EN, consent reset and recoverable failure", async ({
  page,
}) => {
  await page.route("**/api/state", (route) =>
    route.fulfill({ json: { ...state, channels: { sms: { enabled: true } } } }),
  );
  await page.route("**/api/subscribe", (route) =>
    route.fulfill({ status: 503, json: { error: "Unavailable" } }),
  );
  await page.goto("/join?role=relative_arrivals&flight=W6%203412");
  await expect(
    page.getByRole("button", { name: "Rudă la sosiri" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Număr zbor")).toHaveValue("W6 3412");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "SMS", exact: true }).click();
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByRole("button", { name: "Switch to English" }).click();
  await page.getByRole("checkbox").check();
  await page.getByLabel("Phone number with country code").fill("+40722123456");
  await page.getByRole("button", { name: "Subscribe", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Could not subscribe");
  await expect(
    page.getByRole("button", { name: "Subscribe", exact: true }),
  ).toBeEnabled();
});
test("QR and unsupported scanner", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "BarcodeDetector", {
      value: undefined,
      configurable: true,
    });
  });
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.goto("/join/qr");
  await expect(
    page.getByRole("img", { name: "Cod QR pentru abonare" }),
  ).toBeVisible();
  await expect(page.locator(".join-qr a")).toHaveAttribute(
    "href",
    /\/join\?src=jury$/,
  );
  await page.goto("/join");
  await expect(
    page.getByRole("button", { name: "Scanează boarding pass" }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("screenshot scan sends only flight metadata, never name or PNR", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "BarcodeDetector", {
      configurable: true,
      value: class {
        static async getSupportedFormats() {
          return ["pdf417", "aztec"];
        }
        async detect() {
          return [
            {
              rawValue:
                "M1" +
                "PRIVATE/PASSENGER".padEnd(20) +
                "E" +
                "SECRET7" +
                "CRA" +
                "BGY" +
                "W6 " +
                "03412" +
                "304" +
                "Y" +
                "012A" +
                "00001" +
                "1" +
                "00",
            },
          ];
        }
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: () => Promise.reject(new Error("No test camera")),
      },
    });
  });
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.route("**/api/subscribe", (route) =>
    route.fulfill({ json: { subscriptionId: "scanned" } }),
  );
  await page.goto("/join");
  await page.getByRole("button", { name: "Pasager", exact: true }).click();
  await page.getByRole("button", { name: "Scanează boarding pass" }).click();
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "pass.png",
      mimeType: "image/png",
      buffer: await page.screenshot(),
    });
  await expect(page.getByLabel("Număr zbor")).toHaveValue("W6 3412");
  await expect(page.getByLabel("Data zborului")).toBeVisible();
  await page.getByRole("checkbox").check();
  const request = page.waitForRequest("**/api/subscribe");
  await page.getByRole("button", { name: "Continuă în Telegram" }).click();
  const body = (await request).postDataJSON();
  expect(body.flight).toBe("W6 3412");
  expect(body.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(Object.keys(body).sort()).toEqual([
    "channel",
    "consent",
    "date",
    "flight",
    "lang",
    "role",
  ]);
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE|PASSENGER|SECRET7/);
});
