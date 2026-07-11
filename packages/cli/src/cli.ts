import { runCli } from './app.js';

// Swallow Node's `node:sqlite` ExperimentalWarning. It prints two noisy
// lines to stdout before the Ink REPL mounts, which both looks bad and
// throws off the TUI's bottom-pin height math (those lines sit above
// Ink's frame and eat rows we can't measure). Other warnings pass through.
const originalEmitWarning = process.emitWarning.bind(process);
// @ts-expect-error - overloaded signature; we forward the same args.
process.emitWarning = (warning, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (/SQLite is an experimental feature/i.test(text)) return;
  // @ts-expect-error - forward through to the real implementation.
  return originalEmitWarning(warning, ...args);
};

runCli(process.argv).catch((err: Error) => {
  // eslint-disable-next-line no-console
  console.error(err.stack ?? err.message);
  process.exit(1);
});
