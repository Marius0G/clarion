import { expect, test } from '@playwright/test';
import { demoBoardingPass } from '../../backend/src/bcbp';
const pass = demoBoardingPass({ flight: 'W6 3751', destination: 'LTN', localDeparture: '2026-10-31T09:40:00' });
const result = { bcbp: pass.bcbp, token: 'a'.repeat(48), waLink: 'https://wa.me/15556318672?text=START',
  walletUrl: 'https://pay.google.com/gp/v/save/test-jwt' };
test.use({ viewport: { width: 390, height: 844 } });
test('demo draws a readable PDF417 and the scanner uses it in the normal join flow', async ({ page }) => {
  await page.route('**/api/state', route => route.fulfill({ json: { flights: [] } }));
  let demoBody: unknown;
  await page.route('**/api/join/demo', route => {
    demoBody = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: result });
  });
  let joinBody: unknown;
  await page.route('**/api/join', route => {
    joinBody = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: result });
  });
  // Exercise the JS PDF417 decoder used when native BarcodeDetector is unavailable.
  await page.addInitScript(() => { Object.defineProperty(window, 'BarcodeDetector', { value: undefined }); });
  await page.goto('/join');
  await page.getByRole('button', { name: 'Boarding pass demo', exact: true }).click();
  const barcode = page.getByRole('img', { name: 'Cod de bare PDF417 boarding pass demo' });
  await expect(barcode).toBeVisible();
  expect(demoBody).toEqual({ lang: 'ro' });
  await expect(page.getByRole('link', { name: 'Adaugă în Google Wallet' })).toHaveAttribute('href', result.walletUrl);
  await expect(page.getByRole('link', { name: 'Deschide WhatsApp' })).toHaveAttribute('href', result.waLink);
  await expect(page.getByText('POPESCU/ION')).toBeVisible();
  // Use the actual rendered pixels, rather than a stubbed decoder response.
  const png = await barcode.evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL('image/png'));
  const bytes = Buffer.from(png.split(',')[1], 'base64');
  await page.getByRole('button', { name: 'Scanează boarding pass', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'boarding.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.getByLabel('Număr zbor')).toHaveValue('W6 3751');
  await page.getByRole('button', { name: 'Pasager', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continuă în WhatsApp' }).click();
  await expect(page.getByRole('heading', { name: 'Trimite mesajul în WhatsApp.' })).toBeVisible();
  expect(joinBody).toEqual({ flight: 'W6 3751', lang: 'ro' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test('demo request failure allows retry and rejects unsafe links', async ({ page }) => {
  await page.route('**/api/state', route => route.fulfill({ json: { flights: [] } }));
  let attempts = 0;
  await page.route('**/api/join/demo', route => route.fulfill(++attempts === 1
    ? { status: 503, json: {} } : { json: { ...result, walletUrl: 'javascript:alert(1)' } }));
  await page.goto('/join');
  const button = page.getByRole('button', { name: 'Boarding pass demo', exact: true });
  await button.click();
  await expect(page.getByRole('alert')).toContainText('Încearcă din nou');
  await button.click();
  await expect(button).toBeEnabled();
  await expect(page.getByRole('link', { name: 'Adaugă în Google Wallet' })).toHaveCount(0);
  expect(attempts).toBe(2);
});
