// Node installs file support at its entry point; Workers persist the public engine fields.
export const engineRuntime = {
  exists: (_file: string): boolean => false,
  read: (_file: string): any => { throw new Error("Install Node storage before using file"); },
  write: (_file: string, _store: unknown): void => { throw new Error("Install Node storage before using file"); },
};
