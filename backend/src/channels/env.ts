export const environment = (): Record<string, string | undefined> => (globalThis as any).process?.env ?? {};
