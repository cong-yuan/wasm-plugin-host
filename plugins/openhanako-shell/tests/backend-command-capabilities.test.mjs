import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const apiSource = fs.readFileSync(path.join(root, 'js/lib/api.js'), 'utf8');
const pluginSource = fs.readFileSync(path.join(root, 'src/lib.rs'), 'utf8');

const invoked = new Set();
for (const prefix of ["tauri.invoke('", "invokeNative('"]) {
  for (const chunk of apiSource.split(prefix).slice(1)) {
    const end = chunk.indexOf("'");
    if (end > 0) invoked.add(chunk.slice(0, end));
  }
}

const commandStart = pluginSource.indexOf('let backend_commands = [');
const commandEnd = pluginSource.indexOf('    ];', commandStart);
const declaredBlock = commandStart >= 0 && commandEnd >= 0
  ? pluginSource.slice(commandStart, commandEnd)
  : '';
const declared = new Set();
for (const match of declaredBlock.matchAll(/"([^"]+)"/g)) declared.add(match[1]);

const missing = [...invoked].filter((command) => !declared.has(command)).sort();
if (missing.length) {
  throw new Error('backend command capability declaration is missing: ' + missing.join(', '));
}

const requiredNative = [
  'upload_blob',
  'send_message_with_images',
  'complete_session_todos',
  'fresh_compact_session',
  'continue_deleted_agent_session',
  'get_session_summary',
  'get_session_folder_scope',
  'patch_session_authorized_folders',
  'workbench_list_files',
  'workbench_read_file',
  'workbench_write_file',
  'workbench_search_files',
];
const undeclaredNative = requiredNative.filter((command) => !declared.has(command));
if (undeclaredNative.length) {
  throw new Error('native Studio command capability declaration is missing: ' + undeclaredNative.join(', '));
}

console.log('backend command capabilities: ok (' + declared.size + ' declared, ' + invoked.size + ' native calls declared)');