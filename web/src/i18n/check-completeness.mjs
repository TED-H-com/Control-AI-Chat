// Structural completeness is necessary but nowhere near sufficient: `{...en.admin}` and
// `{...zhTW}` both type-check while shipping English to Japanese readers. This gate also compares
// values, and every exception has
// to be named below rather than inferred.
import ts from 'typescript';
import { readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('./catalogues.ts', import.meta.url));
const localesDirectory=fileURLToPath(new URL('./locales/',import.meta.url));
const localeFiles=readdirSync(localesDirectory,{recursive:true}).filter(name=>typeof name==='string'&&name.endsWith('.ts')).map(name=>resolve(localesDirectory,name));
const checkedFiles=new Set([file,...localeFiles]);
const program = ts.createProgram([...checkedFiles], { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  for (const diagnostic of diagnostics)
    console.error(ts.formatDiagnostic(diagnostic, { getCanonicalFileName: x => x, getCurrentDirectory: process.cwd, getNewLine: () => '\n' }));
  process.exit(1);
}

const checker=program.getTypeChecker(),sourceRoot=dirname(file);
const staticPropertyName=node=>{
  if(ts.isIdentifier(node)||ts.isStringLiteral(node)||ts.isNumericLiteral(node))return node.text;
  if(ts.isComputedPropertyName(node)&&(ts.isStringLiteral(node.expression)||ts.isNumericLiteral(node.expression)))return node.expression.text;
  return null;
};
const spreadHasProperty=(type,name)=>{
  if(checker.getPropertyOfType(type,name))return true;
  if(type.isUnionOrIntersection())return type.types.some(member=>spreadHasProperty(member,name));
  return false;
};
const syntaxFailures=[];
for(const source of program.getSourceFiles().filter(source=>checkedFiles.has(source.fileName))){
  const report=(node,property,message)=>{
    const position=source.getLineAndCharacterOfPosition(node.getStart(source));
    syntaxFailures.push(`${relative(sourceRoot,source.fileName)}:${position.line+1}:${position.character+1}: ${property}: ${message}`);
  };
  const visit=node=>{
    if(ts.isBindingElement(node)&&node.dotDotDotToken)report(node,node.name.getText(source),'rest destructuring is not allowed');
    if(ts.isObjectLiteralExpression(node)){
      const explicit=node.properties.flatMap(property=>ts.isSpreadAssignment(property)?[]:[[property,staticPropertyName(property.name)]]).filter(([,name])=>name!==null);
      for(const spread of node.properties.filter(ts.isSpreadAssignment)){
        const spreadType=checker.getTypeAtLocation(spread.expression);
        for(const [property,name] of explicit)if(spreadHasProperty(spreadType,name))report(property,name,`shadows a property supplied by spread ${spread.expression.getText(source)}`);
      }
    }
    ts.forEachChild(node,visit);
  };
  visit(source);
}
if(syntaxFailures.length){
  for(const failure of syntaxFailures)console.error(failure);
  console.error(`\ni18n source guard: ${syntaxFailures.length} problem(s).`);
  process.exit(1);
}

/** Strings that are correct as English in every locale: the product name and language/model endonyms. */
const ENGLISH_EVERYWHERE = new Set([
  'language.en',
  'chat.message.speaker.assistant',
]);
/** A locale may legitimately reuse one short word across several English words ("All"/"Any"). Boilerplate looks different: one sentence standing in for many distinct sentences. */
const BOILERPLATE_MIN_LENGTH = 12;
const BOILERPLATE_MAX_REUSE = 2;

const { catalogues } = await import('./catalogues.ts');
const flatten = (node, prefix = '') =>
  Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string' ? [[prefix + key, value]]
      : Array.isArray(value) ? value.map((item, index) => [`${prefix}${key}.${index}`, item])
        : flatten(value, `${prefix}${key}.`));
const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(',');

const english = Object.fromEntries(flatten(catalogues.en));
const keys = Object.keys(english);
const failures = [];
for (const locale of Object.keys(catalogues).filter(name => name !== 'en')) {
  const translated = Object.fromEntries(flatten(catalogues[locale]));
  const reuse = new Map();
  for (const key of keys) {
    const value = translated[key];
    if (value === undefined) { failures.push(`${locale}: ${key} is missing`); continue; }
    if (value === english[key] && /[A-Za-z]{4}/.test(english[key]) && !ENGLISH_EVERYWHERE.has(key))
      failures.push(`${locale}: ${key} is still English -- "${value}"`);
    if (placeholders(value) !== placeholders(english[key]))
      failures.push(`${locale}: ${key} placeholders differ -- en "${english[key]}" vs "${value}"`);
    if (value.length >= BOILERPLATE_MIN_LENGTH) reuse.set(value, [...(reuse.get(value) ?? []), key]);
  }
  for (const [value, used] of reuse)
    if (used.length > BOILERPLATE_MAX_REUSE && new Set(used.map(key => english[key])).size > BOILERPLATE_MAX_REUSE)
      failures.push(`${locale}: "${value}" stands in for ${used.length} distinct English strings (${used.slice(0, 4).join(', ')}...)`);
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  console.error(`\ni18n completeness: ${failures.length} problem(s).`);
  process.exit(1);
}
console.log(`i18n completeness: ${keys.length} keys x ${Object.keys(catalogues).length} locales -- structure, translation and placeholders all check out.`);
