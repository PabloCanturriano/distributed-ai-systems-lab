import { TicketAccessError, type SubmissionLimits } from './ticket-access';

// Two bounded scopes at most; Redis TIME defines fixed UTC-minute boundaries.
const script = `
local now=redis.call('TIME')
local window=math.floor(tonumber(now[1])/60)
local retry=60-(tonumber(now[1])%60)
local counts={}
for i,key in ipairs(KEYS) do
  local entry=redis.call('HMGET',key,'window','count')
  local count=0
  if entry[1] or entry[2] then
    local storedWindow=tonumber(entry[1])
    local storedCount=tonumber(entry[2])
    if not storedWindow or not storedCount or storedWindow<0 or storedCount<0 or storedWindow%1~=0 or storedCount%1~=0 then
      return redis.error_reply('Invalid limiter state')
    end
    if storedWindow==window then count=storedCount end
  end
  if count>=tonumber(ARGV[i]) then return {0,retry} end
  counts[i]=count
end
for i,key in ipairs(KEYS) do
  redis.call('HSET',key,'window',window,'count',counts[i]+1)
  redis.call('EXPIRE',key,120)
end
return {1,retry}
`;

export class RedisSubmissionLimits implements SubmissionLimits {
  constructor(
    private readonly evaluate: (
      script: string,
      keys: string[],
      args: string[],
    ) => Promise<unknown>,
  ) {}
  async consume(scopes: Array<{ key: string; limit: number }>): Promise<void> {
    try {
      if (scopes.length < 1 || scopes.length > 2)
        throw new Error('Invalid limiter scope');
      const result = await this.evaluate(
        script,
        scopes.map((s) => `lab:limits:${s.key}`),
        scopes.map((s) => String(s.limit)),
      );
      if (
        !Array.isArray(result) ||
        result.length !== 2 ||
        ![0, 1].includes(result[0]) ||
        !Number.isInteger(result[1]) ||
        result[1] < 1 ||
        result[1] > 60
      )
        throw new Error('Invalid limiter response');
      if (result[0] === 0)
        throw new TicketAccessError('RATE_LIMITED', result[1]);
    } catch (error) {
      if (error instanceof TicketAccessError) throw error;
      throw new TicketAccessError('DEPENDENCY_UNAVAILABLE');
    }
  }
}
