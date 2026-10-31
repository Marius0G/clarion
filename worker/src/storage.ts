import { Engine } from '../../backend/src/engine.js';
import { engineRuntime } from '../../backend/src/runtime.js';

// Bridge the engine's synchronous file seam without importing Node or mutating
// process.env. Runtime replacement lasts only one synchronous stack frame;
// asynchronous requests/other DO instances cannot observe another tower's store.
export function createStoredEngine(
  saved: unknown,
  write: (store: unknown) => void,
  options: ConstructorParameters<typeof Engine>[0],
): Engine {
  function scoped<T>(work: () => T): T {
    const previous = { ...engineRuntime };
    engineRuntime.exists = () => saved !== undefined;
    engineRuntime.read = () => saved;
    engineRuntime.write = (_file, store) => write(store);
    try { return work(); }
    finally { Object.assign(engineRuntime, previous); }
  }
  const engine = scoped(() => new Engine({ ...options, file: 'durable-object' }));
  const persist = engine.persist.bind(engine);
  engine.persist = () => scoped(persist);
  return engine;
}
