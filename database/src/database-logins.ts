import { escapeIdentifier, escapeLiteral, type Client } from 'pg';
import {
  databaseRoles,
  validDatabasePassword,
  type DatabaseRole,
} from './database-secrets.js';

export async function provisionDatabaseLogins(
  admin: Client,
  passwords: Partial<Record<DatabaseRole | 'operations', string>>,
  roles: readonly (DatabaseRole | 'operations')[] = databaseRoles,
): Promise<void> {
  for (const role of roles)
    if (
      typeof passwords[role] !== 'string' ||
      !validDatabasePassword(passwords[role]!)
    )
      throw new Error('Invalid database login material');
  await admin.query('BEGIN');
  try {
    await admin.query("SET LOCAL lock_timeout='5s'");
    await admin.query("SET LOCAL statement_timeout='10s'");
    await admin.query('SELECT pg_advisory_xact_lock(41017, 3)');
    for (const role of roles) {
      const login = `lab_${role}_login`;
      const group = `lab_${role}`;
      const result = await admin.query<{ safe: boolean }>(
        `SELECT rolcanlogin AND NOT (rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS safe FROM pg_roles WHERE rolname=$1`,
        [login],
      );
      if (!result.rows.length) {
        // PostgreSQL utility statements cannot bind identifiers/passwords. Escape both.
        await admin.query(
          `CREATE ROLE ${escapeIdentifier(login)} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(passwords[role]!)}`,
        );
        await admin.query(
          `GRANT ${escapeIdentifier(group)} TO ${escapeIdentifier(login)} WITH INHERIT FALSE, SET TRUE`,
        );
        const database = (
          await admin.query<{ name: string }>(
            'SELECT current_database() AS name',
          )
        ).rows[0]?.name;
        if (!database) throw new Error('Database identity unavailable');
        await admin.query(
          `GRANT CONNECT ON DATABASE ${escapeIdentifier(database)} TO ${escapeIdentifier(login)}`,
        );
      } else {
        if (!result.rows[0]?.safe)
          throw new Error('Incompatible database login attributes');
        const memberships = await admin.query<{
          name: string;
          admin_option: boolean;
          inherit_option: boolean;
          set_option: boolean;
        }>(
          `SELECT parent.rolname AS name,m.admin_option,m.inherit_option,m.set_option FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid WHERE m.member=(SELECT oid FROM pg_roles WHERE rolname=$1)`,
          [login],
        );
        const membership = memberships.rows[0];
        if (
          memberships.rows.length !== 1 ||
          !membership ||
          membership.name !== group ||
          membership.admin_option ||
          membership.inherit_option ||
          !membership.set_option
        )
          throw new Error('Incompatible database login membership');
        const access = await admin.query<{ allowed: boolean }>(
          "SELECT has_database_privilege($1,current_database(),'CONNECT') AS allowed",
          [login],
        );
        if (!access.rows[0]?.allowed)
          throw new Error('Database login cannot connect');
      }
    }
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  }
}
