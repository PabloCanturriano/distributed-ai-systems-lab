const { execFileSync } = require('node:child_process');
test('runtime library selection refuses unresolved or unexpected loader paths', () => {
  const script = `import {parseSharedLibraries} from './infra/docker/prepare-runtime.mjs';const valid=parseSharedLibraries('linux-vdso.so.1 (0x1)\\n libstdc++.so.6 => /lib/aarch64-linux-gnu/libstdc++.so.6 (0x2)\\n /lib/ld-linux-aarch64.so.1 (0x3)');const rejected=[];for(const value of ['libx.so => not found','libx.so => /tmp/unreviewed.so (0x1)','unexpected loader output']){try{parseSharedLibraries(value);rejected.push(false)}catch{rejected.push(true)}}console.log(JSON.stringify({valid,rejected}));`;
  const result = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    }),
  );
  expect(result.valid).toEqual([
    '/lib/aarch64-linux-gnu/libstdc++.so.6',
    '/lib/ld-linux-aarch64.so.1',
  ]);
  expect(result.rejected).toEqual([true, true, true]);
});
