const { createCollectorLookup } = require('../packages/telemetry/dist');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

test('collector DNS rejects other destinations and bounds unresolved requests', () => {
  jest.useFakeTimers();
  try {
    const resolvers = [];
    const lookup = createCollectorLookup(() => {
      const resolver = { resolve4: jest.fn(), cancel: jest.fn() };
      resolvers.push(resolver);
      return resolver;
    });
    const callbacks = Array.from({ length: 4 }, () => jest.fn());
    lookup('private-unapproved-host', {}, callbacks[0]);
    lookup('collector', {}, callbacks[1]);
    lookup('collector', { all: true }, callbacks[2]);
    lookup('collector', {}, callbacks[3]);
    jest.runAllTicks();
    expect(resolvers).toHaveLength(2);
    expect(callbacks[0].mock.calls[0][0].code).toBe('EAI_AGAIN');
    expect(callbacks[3].mock.calls[0][0].code).toBe('EAI_AGAIN');
    jest.advanceTimersByTime(350);
    for (const resolver of resolvers)
      expect(resolver.cancel).toHaveBeenCalledTimes(1);
    expect(callbacks[1]).toHaveBeenCalledTimes(1);
    expect(callbacks[2]).toHaveBeenCalledTimes(1);
    resolvers[0].resolve4.mock.calls[0][1](null, ['127.0.0.1']);
    expect(callbacks[1]).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});

test('collector DNS errors without result values are safe and do not retain a slot', () => {
  const requests = [];
  const lookup = createCollectorLookup(() => ({
    resolve4: (_, done) => requests.push(done),
    cancel: () => {},
  }));
  const failed = jest.fn();
  lookup('collector', {}, failed);
  expect(() =>
    requests[0](new Error('private-error-fixture'), undefined),
  ).not.toThrow();
  expect(failed.mock.calls[0][0].message).not.toContain(
    'private-error-fixture',
  );
  const accepted = jest.fn();
  lookup('collector', { all: true }, accepted);
  requests[1](null, ['127.0.0.1']);
  expect(accepted).toHaveBeenCalledWith(null, [
    { address: '127.0.0.1', family: 4 },
  ]);
});

test('collector resolution proceeds while the shared libuv worker pool is busy', async () => {
  const script = `
    const assert=require('node:assert/strict');
    const {createSocket}=require('node:dgram');
    const {Resolver,lookup}=require('node:dns');
    const {pbkdf2}=require('node:crypto');
    const {createCollectorLookup}=require('./packages/telemetry/dist');
    assert.equal(typeof createCollectorLookup,'function');
    const server=createSocket('udp4');
    server.on('message',(message,remote)=>{
      let end=12;while(message[end])end+=message[end]+1;end+=5;
      const header=Buffer.from([0x81,0x80,0,1,0,1,0,0,0,0]);
      const answer=Buffer.from([0xc0,0x0c,0,1,0,1,0,0,0,1,0,4,127,0,0,1]);
      server.send(Buffer.concat([message.subarray(0,2),header,message.subarray(12,end),answer]),remote.port,remote.address);
    });
    (async()=>{
      await new Promise(resolve=>server.bind(0,'127.0.0.1',resolve));
      try {
        let sharedDone=false,cryptoDone=false;
        const busy=new Promise((resolve,reject)=>pbkdf2('fixture','fixture',1000000,32,'sha512',(error)=>{cryptoDone=true;error?reject(error):resolve();}));
        const ordinary=new Promise(resolve=>lookup('localhost',()=>{sharedDone=true;resolve();}));
        const collector=createCollectorLookup(()=>{const resolver=new Resolver({timeout:250,tries:1});resolver.setServers(['127.0.0.1:'+server.address().port]);return resolver;});
        const addresses=await new Promise((resolve,reject)=>collector('collector',{all:true},(error,address)=>error?reject(error):resolve(address)));
        assert.deepEqual(addresses,[{address:'127.0.0.1',family:4}]);
        assert.equal(cryptoDone,false);
        assert.equal(sharedDone,false);
        await Promise.all([busy,ordinary]);
        console.log(JSON.stringify({collectorResolvedWhileSharedLookupBlocked:true}));
      }finally{server.close();}
    })().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const result = await promisify(execFile)(process.execPath, ['-e', script], {
    env: { ...process.env, UV_THREADPOOL_SIZE: '1' },
    timeout: 8000,
  });
  expect(
    JSON.parse(result.stdout).collectorResolvedWhileSharedLookupBlocked,
  ).toBe(true);
});
