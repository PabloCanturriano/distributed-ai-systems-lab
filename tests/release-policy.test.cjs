const { execFileSync } = require('node:child_process');
const run = (code) =>
  JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8',
    }),
  );

test('release plan rejects stable, mutable and command-shaped identities', () => {
  const value = run(
    `import {releasePlan} from './scripts/release-policy.mjs'; const cases=['latest','v1.0.0','v0.1.0-rc.0','v0.1.0-rc.1;echo bad']; console.log(JSON.stringify(cases.map(version=>{try{releasePlan(version,'a'.repeat(40));return false}catch{return true}})));`,
  );
  expect(value).toEqual([true, true, true, true]);
});

test('release gate blocks wrong artifacts, unfixed critical findings and incomplete notices', () => {
  const value = run(
    `import {assessReleaseImage} from './scripts/release-policy.mjs'; const image='sha256:'+ 'a'.repeat(64);const report={Metadata:{ImageID:image,ImageConfig:{architecture:'arm64'}},Results:[{Vulnerabilities:[]}]};const notices={image,packages:[{declaredLicense:'MIT',missingLicenseText:false}],files:[{}],skippedLinks:[]};const clean=assessReleaseImage(report,notices,image,'arm64');report.Results[0].Vulnerabilities=[{Severity:'CRITICAL',FixedVersion:''}];notices.packages[0].missingLicenseText=true;console.log(JSON.stringify({clean,blocked:assessReleaseImage(report,notices,'sha256:'+ 'b'.repeat(64),'amd64')}));`,
  );
  expect(value.clean).toEqual([]);
  expect(value.blocked).toEqual(
    expect.arrayContaining([
      'image_identity_mismatch',
      'architecture_mismatch',
      'unresolved_high_or_critical',
      'incomplete_notices',
    ]),
  );
});

test('published journeys require exact source, immutable role digests and both architectures', () => {
  const value = run(
    `import {releaseImageOverrides,releaseRoles} from './scripts/release-policy.mjs'; const revision='a'.repeat(40);const manifest={schemaVersion:1,version:'v0.1.0-rc.1',revision,images:releaseRoles.map(role=>({role,ref:'ghcr.io/pablocanturriano/distributed-ai-systems-lab/'+role+'@sha256:'+'b'.repeat(64),architectures:['amd64','arm64']}))};const valid=releaseImageOverrides(manifest,revision);const rejected=[];for(const change of [m=>m.revision='c'.repeat(40),m=>m.images.pop(),m=>m.images[0].ref='ghcr.io/foreign/api:latest',m=>m.images[0].architectures=['amd64']]){const copy=structuredClone(manifest);change(copy);try{releaseImageOverrides(copy,revision);rejected.push(false)}catch{rejected.push(true)}}console.log(JSON.stringify({services:Object.keys(valid.services),rejected}));`,
  );
  expect(value.services).toEqual(
    expect.arrayContaining([
      'secrets',
      'bootstrap',
      'migrate',
      'seed',
      'api',
      'cli',
      'executor',
    ]),
  );
  expect(value.rejected).toEqual([true, true, true, true]);
});
