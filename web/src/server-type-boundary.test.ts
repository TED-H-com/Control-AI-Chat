import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {checkServerTypeBoundary} from './server-type-boundary.js';

test('web type graph does not depend on files outside server/src',()=>{
  const webDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const offenders=checkServerTypeBoundary(webDir);
  assert.deepEqual(offenders,[],`The web build runs without server/node_modules in Docker. Every server file in the web type graph must be under server/src. Offending file(s):\n${offenders.join('\n')}`);
});
