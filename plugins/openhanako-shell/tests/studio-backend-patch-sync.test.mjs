import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const live = fs.readFileSync(
  path.join(root, 'ui/desktop/src/react/studio-backend/studio-backend-bridge.ts'),
  'utf8',
);
const patch = fs.readFileSync(
  path.join(root, 'patches/studio-backend/studio-backend-bridge.ts'),
  'utf8',
);

if (live !== patch) {
  throw new Error('studio-backend bridge patch is out of sync with the live bridge source');
}

console.log('studio backend patch sync: ok');
