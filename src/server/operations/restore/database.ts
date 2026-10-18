import { Client } from "pg";
import { type Database, type DbTransaction } from "../../db";
import { RestoreFailure } from "./failures";

export type Executor = Database | DbTransaction;
export const noop = () => {};

// ---------------------------------------------------------------- names

const NAME = /^[A-Za-z0-9_]+$/;
export const quoteName = (name: string) => {
  if (!NAME.test(name)) throw new RestoreFailure("invalid_name");
  return `"${name}"`;
};

export function databaseName(url: string) {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}
export function urlFor(url: string, name: string) {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}
/** The database a restore works in, next to the live one. */
export const scratchName = (liveUrl: string, mode: "drill" | "restore") =>
  `${databaseName(liveUrl)}_${mode === "drill" ? "drill" : "restore"}`;

export async function withAdmin<T>(
  liveUrl: string,
  work: (client: Client) => Promise<T>
) {
  const client = new Client({ connectionString: urlFor(liveUrl, "postgres") });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
export const exists = async (client: Client, name: string) =>
  (await client.query("select 1 from pg_database where datname = $1", [name]))
    .rowCount === 1;

export async function createScratch(
  liveUrl: string,
  name: string,
  replace: boolean
) {
  await withAdmin(liveUrl, async (client) => {
    if (await exists(client, name)) {
      if (!replace) throw new RestoreFailure("database_exists");
      await client.query(`drop database ${quoteName(name)} with (force)`);
    }
    await client.query(`create database ${quoteName(name)}`);
  });
}
export async function dropDatabase(liveUrl: string, name: string) {
  await withAdmin(liveUrl, (client) =>
    client.query(`drop database if exists ${quoteName(name)} with (force)`)
  );
}
