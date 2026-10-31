import { expect, test } from "@playwright/test";
test.use({ viewport: { width: 390, height: 844 } });
const state = {
  flights: [
    { flight: "W6 3412", city: "Bergamo", sched: "2026-10-31T23:55:00Z" },
  ],
};
test("jury role, consent, WhatsApp and passenger share", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript(() => Object.defineProperty(navigator, "share", { value: undefined, configurable: true }));
  await page.route("**/api/state", route => route.fulfill({ json: state }));
  await page.route("**/api/join", route => route.fulfill({ json: { token: "share-token", waLink: "https://wa.me/15556318672?text=START%20W6%203412%20share-token" } }));
  await page.goto("/join?src=jury");
  await expect(page.getByRole("button", { name: "Continuă în WhatsApp" })).toBeDisabled();
  await page.getByRole("button", { name: "Pasager", exact: true }).click();
  await page.getByLabel("Număr zbor").fill("W6 3412");
  await expect(page.locator("#join-flights option")).toHaveAttribute("value", "W6 3412");
  await expect(page.getByRole("button", { name: "Continuă în WhatsApp" })).toBeDisabled();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continuă în WhatsApp" }).click();
  await expect(page.getByRole("link", { name: "Deschide WhatsApp" })).toBeVisible();
  await page.getByRole("button", { name: "Trimite celui care te așteaptă" }).click();
  await expect(page.getByRole("status")).toHaveText("Mesaj copiat.");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("role=relative_arrivals&flight=W6+3412");
});
test("relative prefill, English and consent", async ({ page }) => {
  await page.route("**/api/state", route => route.fulfill({ json: state }));
  await page.goto("/join?role=relative_arrivals&flight=W6%203412");
  await expect(page.getByRole("button", { name: "Rudă la sosiri" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Număr zbor")).toHaveValue("W6 3412");
  await page.getByRole("button", { name: "Switch to English" }).click();
  await expect(page.getByRole("button", { name: "Continue in WhatsApp" })).toBeDisabled();
  await page.getByRole("checkbox").check();
  await expect(page.getByRole("button", { name: "Continue in WhatsApp" })).toBeEnabled();
});
test("QR and scanner fallback", async ({ page }) => {
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
  ).toBeVisible();
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
  let requestBody: unknown;
  await page.route("**/api/join", route => {
    requestBody = route.request().postDataJSON();
    return route.fulfill({ json: { token: "scan-token", waLink: "https://wa.me/15556318672?text=START%20W6%203412%20scan-token" } });
  });
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
  await page.getByRole("button", { name: "Continuă în WhatsApp" }).click();
  const href = await page.getByRole("link", { name: "Deschide WhatsApp" }).getAttribute("href");
  expect(new URL(href!).searchParams.get("text")).toBe("START W6 3412 scan-token");
  expect(requestBody).toEqual({ flight: "W6 3412" });
  expect(JSON.stringify(requestBody)).not.toMatch(/PRIVATE|PASSENGER|SECRET7/);
  expect(href).not.toMatch(/PRIVATE|PASSENGER|SECRET7/);
});

test('WhatsApp join uses the public token endpoint and shows the WhatsApp and Wallet buttons', async ({ page }) => {
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  let requestBody: unknown;
  const waLink = 'https://wa.me/15556318672?text=START%20W6%203412%20abcd1234';
  await page.route('**/api/join', route => {
    requestBody = route.request().postDataJSON();
    return route.fulfill({ json: { token: 'abcd1234', waLink } });
  });
  await page.goto('/join');
  await expect(page.getByRole('button', { name: 'Continuă în WhatsApp' })).toBeDisabled();
  await page.getByRole('button', { name: 'Pasager', exact: true }).click();
  await page.getByLabel('Număr zbor').fill('W6 3412');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continuă în WhatsApp' }).click();
  await expect(page.getByRole('link', { name: 'Deschide WhatsApp' })).toHaveAttribute('href', waLink);
  await expect(page.getByRole('button', { name: 'Adaugă în Google Wallet' })).toBeVisible();
  expect(requestBody).toEqual({ flight: 'W6 3412' });
  let walletBody: unknown;
  await page.route('**/api/wallet/pass', route => {
    walletBody = route.request().postDataJSON();
    return route.fulfill({ status: 503, json: {} });
  });
  await page.getByRole('button', { name: 'Adaugă în Google Wallet' }).click();
  await expect(page.getByRole('alert')).toContainText('Pass-ul nu a putut fi deschis');
  expect(walletBody).toEqual({ joinToken: 'abcd1234' });
});

test('unknown flight shows a Romanian error and lets the passenger retry', async ({ page }) => {
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/join', route => route.fulfill({ status: 404, json: { error: 'Unknown flight' } }));
  await page.goto('/join');
  await page.getByRole('button', { name: 'Pasager', exact: true }).click();
  await page.getByLabel('Număr zbor').fill('XX 9999');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continuă în WhatsApp' }).click();
  await expect(page.getByRole('alert')).toContainText('Zborul nu este în orarul de azi');
  await expect(page.getByRole('button', { name: 'Continuă în WhatsApp' })).toBeEnabled();
});
