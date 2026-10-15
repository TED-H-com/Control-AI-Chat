import { register } from 'node:module';

const source = `export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) return {format:'module', source:'export default {};', shortCircuit:true};
  return nextLoad(url, context);
}
`;

/** Registers a CSS loader from a data URL so server-rendered tests write nothing to disk. */
export async function registerCssImports(): Promise<void> {
  await register('data:text/javascript,' + encodeURIComponent(source));
}
