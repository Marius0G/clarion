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
    page.getByRole("img", { name: "Cod QR pentru WhatsApp" }),
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
  expect(requestBody).toEqual({ flight: "W6 3412", lang: "ro" });
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
  expect(requestBody).toEqual({ flight: 'W6 3412', lang: 'ro' });
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

test('language switch drives join and demo requests and all success copy', async ({ page }) => {
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  let request: unknown;
  await page.route('**/api/join', route => {
    request = route.request().postDataJSON();
    return route.fulfill({ json: { token: 'english-token', waLink: 'https://wa.me/15556318672?text=START' } });
  });
  let demo: unknown;
  await page.route('**/api/join/demo', route => {
    demo = route.request().postDataJSON();
    return route.fulfill({ status: 500, json: {} });
  });
  await page.goto('/join');
  await page.getByRole('button', { name: 'Switch to English' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.getByRole('button', { name: 'Demo boarding pass', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The demo boarding pass could not be created');
  expect(demo).toEqual({ lang: 'en' });
  await page.getByRole('button', { name: 'Passenger', exact: true }).click();
  await page.getByLabel('Flight number').fill('W6 3412');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue in WhatsApp' }).click();
  await expect(page.getByRole('heading', { name: 'Send the message in WhatsApp.' })).toBeVisible();
  expect(request).toEqual({ flight: 'W6 3412', lang: 'en' });
  await expect(page.getByRole('button', { name: 'Add to Google Wallet' })).toBeVisible();
});


test('sign-in buttons stay readable through login, hover and disabled states', async ({ page }) => {
  await page.route('**/api/state', route => route.fulfill({ json: state }));
  await page.route('**/api/auth/otp', route => route.fulfill({ json: { sent: true } }));
  await page.route('**/api/auth/verify', route => route.fulfill({ json: { session: 'test-session' } }));
  await page.route('**/api/auth/me', route => route.fulfill({ json: { phone: '+40712345678', role: 'passenger' } }));
  let finishLogout!: () => void;
  const logout = new Promise<void>(resolve => { finishLogout = resolve; });
  await page.route('**/api/auth/logout', async route => { await logout; await route.fulfill({ json: {} }); });
  await page.goto('/join');
  const auth = page.getByRole('region', { name: 'Conectare', exact: true });
  const receive = auth.getByRole('button', { name: 'Primește cod' });
  await expect(receive).toHaveCSS('background-color', 'rgb(31, 41, 55)');
  await expect(receive).toHaveCSS('color', 'rgb(255, 255, 255)');
  await receive.hover();
  await expect(receive).toHaveCSS('background-color', 'rgb(15, 23, 42)');
  await expect(receive).toHaveCSS('color', 'rgb(255, 255, 255)');
  await auth.getByLabel('Telefon').fill('0712345678');
  await receive.click();
  await expect(auth.getByRole('button', { name: 'Alt număr' })).toHaveCSS('color', 'rgb(255, 255, 255)');
  await auth.getByLabel('Cod', { exact: true }).fill('123456');
  await auth.getByRole('button', { name: 'Verifică' }).click();
  const disconnect = auth.getByRole('button', { name: 'Deconectare' });
  await expect(disconnect).toHaveCSS('color', 'rgb(255, 255, 255)');
  await disconnect.click();
  await expect(disconnect).toBeDisabled();
  await expect(disconnect).toHaveCSS('background-color', 'rgb(226, 232, 240)');
  await expect(disconnect).toHaveCSS('color', 'rgb(71, 85, 105)');
  await expect(disconnect).toHaveCSS('opacity', '1');
  finishLogout();
  await expect(receive).toBeVisible();
  await page.route('**/api/auth/login-code', route => route.fulfill({ json: { code: '123456', waLink: 'https://wa.me/15556318672', pollToken: 'test' } }));
  await page.route('**/api/auth/login-code/test', route => route.fulfill({ json: { status: 'pending' } }));
  await auth.getByRole('button', { name: 'Conectează-te cu WhatsApp' }).click();
  await expect(auth.getByRole('button', { name: 'Anulare', exact: true })).toHaveCSS('color', 'rgb(255, 255, 255)');
});
