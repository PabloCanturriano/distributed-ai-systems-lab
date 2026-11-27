const { execFileSync } = require('node:child_process');
test('corresponding-source descriptors require SHA256 and reject path traversal', () => {
  const code = `import{sourceChecksums}from'./scripts/export-runtime-sources.mjs';const hash='a'.repeat(64);const valid=sourceChecksums('Checksums-Sha256:\\n '+hash+' 12 source.tar.xz\\n');const rejected=[];for(const text of ['Files:\\n x','Checksums-Sha256:\\n '+hash+' 12 ../outside\\n']){try{sourceChecksums(text);rejected.push(false)}catch{rejected.push(true)}}console.log(JSON.stringify({valid,rejected}));`;
  const x = JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
    }),
  );
  expect(x.valid['source.tar.xz']).toEqual({
    sha256: 'a'.repeat(64),
    size: 12,
  });
  expect(x.rejected).toEqual([true, true]);
});
