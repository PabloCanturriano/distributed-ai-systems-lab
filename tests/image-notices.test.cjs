const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { execFileSync } = require('node:child_process');

test('image notices preserve nested package and native attribution texts', () => {
  const root = mkdtempSync(join(tmpdir(), 'lab-notices-'));
  try {
    const modules = join(root, 'modules');
    for (const [path, name] of [
      ['parent', 'parent'],
      ['parent/node_modules/child', 'child'],
      ['missing', 'missing'],
    ]) {
      mkdirSync(join(modules, path), { recursive: true });
      writeFileSync(
        join(modules, path, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          ...(name === 'child'
            ? { licenses: [{ type: 'MIT' }] }
            : { license: 'MIT' }),
        }),
      );
    }
    writeFileSync(join(modules, 'parent/LICENSE'), 'Exact parent license\n');
    writeFileSync(
      join(modules, 'parent/node_modules/child/NOTICE'),
      'Exact child notice\n',
    );
    mkdirSync(join(modules, '@confluentinc/kafka-javascript/deps/librdkafka'), {
      recursive: true,
    });
    writeFileSync(
      join(modules, '@confluentinc/kafka-javascript/package.json'),
      JSON.stringify({
        name: '@confluentinc/kafka-javascript',
        version: '1.11.0',
        license: 'MIT',
      }),
    );
    writeFileSync(
      join(
        modules,
        '@confluentinc/kafka-javascript/deps/librdkafka/LICENSES.txt',
      ),
      'Native component notices\n',
    );
    const outside = join(root, 'outside');
    writeFileSync(outside, 'must not export host files');
    symlinkSync(outside, join(modules, 'parent/COPYRIGHT'));
    const code = `import { collectImageNotices } from './scripts/image-notices.mjs'; console.log(JSON.stringify(collectImageNotices({modules:process.argv[1],baseFiles:[],osDocs:null})));`;
    const value = JSON.parse(
      execFileSync(
        process.execPath,
        ['--input-type=module', '-e', code, modules],
        { encoding: 'utf8' },
      ),
    );
    expect(value.packages.map((x) => x.name).sort()).toEqual([
      '@confluentinc/kafka-javascript',
      'child',
      'missing',
      'parent',
    ]);
    expect(
      value.packages.find((x) => x.name === 'missing').missingLicenseText,
    ).toBe(true);
    expect(
      value.packages.find((x) => x.name === 'child').declaredLicense,
    ).toEqual([{ type: 'MIT' }]);
    const texts = value.files.map((x) =>
      Buffer.from(x.contentBase64, 'base64').toString(),
    );
    expect(texts).toContain('Exact parent license\n');
    expect(texts).toContain('Exact child notice\n');
    expect(texts).toContain('Native component notices\n');
    expect(texts).not.toContain('must not export host files');
    expect(value.skippedLinks).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
