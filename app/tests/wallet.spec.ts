import { expect, test } from '@playwright/test';
test.use({ viewport: { width: 390, height: 844 } });

async function mount(page: import('@playwright/test').Page, subscriptionId = 'wallet-sub') {
  await page.route('**/api/state', route => route.fulfill({ json: { flights: [] } }));
  await page.goto('/join');
  // Mount the standalone component through Vite without changing Join or routing.
  await page.evaluate(async id => {
    const reactUrl = '/node_modules/.vite/deps/react.js';
    const domUrl = '/node_modules/.vite/deps/react-dom_client.js';
    const componentUrl = '/src/join/WalletButton.tsx';
    const [{ default: React }, { default: ReactDOM }, { default: WalletButton }] = await Promise.all([
      import(/* @vite-ignore */ reactUrl), import(/* @vite-ignore */ domUrl), import(/* @vite-ignore */ componentUrl),
    ]);
    const container = document.createElement('div');
    container.id = 'wallet-test';
    container.style.cssText = 'background:white;padding:24px;position:fixed;inset:0;z-index:9999';
    document.body.append(container);
    ReactDOM.createRoot(container).render(React.createElement(WalletButton, { subscriptionId: id }));
  }, subscriptionId);
}
test('opens the save URL in a reserved tab and posts only the subscription ID', async ({ page, context }) => {
  let body: unknown;
  await page.route('**/api/wallet/pass', async route => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { saveUrl: '/join/wallet-demo?sub=wallet-sub', demo: true } });
  });
  await context.route('**/join/wallet-demo?sub=*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Demo pass</h1>' }));
  await mount(page);
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Adaugă în Google Wallet' }).click();
  const tab = await popup;
  await expect(tab).toHaveURL(/\/join\/wallet-demo\?sub=wallet-sub$/);
  expect(body).toEqual({ subscriptionId: 'wallet-sub' });
  await expect(page.getByRole('status')).toContainText('Mod demo');
  await expect(page.getByRole('button', { name: 'Adaugă în Google Wallet' })).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await tab.close();
});
test('closes the reserved tab on failure and permits retry; rejects unsafe save URLs', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/wallet/pass', route => {
    attempts++;
    return route.fulfill(attempts === 1 ? { status: 503, json: { error: 'Unavailable' } }
      : { json: { saveUrl: 'javascript:alert(1)', demo: false } });
  });
  await mount(page);
  const button = page.getByRole('button', { name: 'Adaugă în Google Wallet' });
  const first = page.waitForEvent('popup');
  await button.click();
  const tab = await first;
  await expect.poll(() => tab.isClosed()).toBe(true);
  await expect(page.getByRole('alert')).toContainText('Încearcă din nou');
  await expect(button).toBeEnabled();
  const second = page.waitForEvent('popup');
  await button.click();
  const retry = await second;
  await expect.poll(() => retry.isClosed()).toBe(true);
  await expect(button).toBeEnabled();
  expect(attempts).toBe(2);
});
