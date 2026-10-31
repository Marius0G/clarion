# Verification

[SPEC-v2](../docs/SPEC-v2.md) is the current contract. Run backend `npm run build` and `npm test`; worker `npm run typecheck` and `npm test`; app `npm run lint`, `npm run build`, `npx vitest run` and `npm test` (Playwright).

Retained suites cover camera estimates versus truth, forecasts, lanes, ops acknowledgements, sim transport and bounds, passenger messaging, reports, WhatsApp signatures and receipts, Wallet signing and budgets, flight data, authentication, hibernation and dashboard/join/passenger browser behavior. Providers use synthetic fixtures; these checks do not establish live handset delivery or deployment.
