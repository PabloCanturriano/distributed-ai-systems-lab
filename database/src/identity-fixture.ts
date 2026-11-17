// Immutable fictional identity facts. Changing them requires a new fixture version.
export const identityFixture = {
  version: 'identities-v1',
  tenants: [
    {
      id: 'a1000000-0000-4000-8000-000000000001',
      name: 'Harbor Support',
      alias: 'harbor',
    },
    {
      id: 'a1000000-0000-4000-8000-000000000002',
      name: 'Summit Operations',
      alias: 'summit',
    },
  ],
  principals: [
    {
      id: 'a2000000-0000-4000-8000-000000000001',
      tenant: 0,
      role: 'reader',
      alias: 'harbor.reader',
    },
    {
      id: 'a2000000-0000-4000-8000-000000000002',
      tenant: 0,
      role: 'requester',
      alias: 'harbor.requester',
    },
    {
      id: 'a2000000-0000-4000-8000-000000000003',
      tenant: 0,
      role: 'operator',
      alias: 'harbor.operator',
    },
    {
      id: 'a2000000-0000-4000-8000-000000000004',
      tenant: 1,
      role: 'reader',
      alias: 'summit.reader',
    },
    {
      id: 'a2000000-0000-4000-8000-000000000005',
      tenant: 1,
      role: 'requester',
      alias: 'summit.requester',
    },
    {
      id: 'a2000000-0000-4000-8000-000000000006',
      tenant: 1,
      role: 'operator',
      alias: 'summit.operator',
    },
  ],
} as const;
