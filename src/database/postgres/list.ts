'use strict';

// using pg module -- connecting to a PostgreSQL daytabase
import { Pool, QueryResult } from 'pg'; 
import * as helpers from './helpers';

// defining all types for my CurrentModule
interface CurrentModule {
    listPrepend(key: string, value: string | string[]): Promise<void>;
    listAppend(key: string, value: string | string[]): Promise<void>;
    listRemoveLast(key: string): Promise<string | null>;
    listRemoveAll(key: string, value: string | string[]): Promise<void>;
    listTrim(key: string, start: number, stop: number): Promise<void>;
    getListRange(key: string, start: number, stop: number): Promise<string[]>;
    listLength(key: string): Promise<number>;
    transaction(callback: (client: Pool) => Promise<void>): Promise<void>;
    pool: Pool;
  }

module.exports = function (module: CurrentModule): void {
    module.listPrepend = async function (key: string, value: string | string[]): Promise<void> {
        if (!key) {
            return;
        }

        await module.transaction(async (client) => {
            await helpers.ensureLegacyObjectType(client, key, 'list');
            value = Array.isArray(value) ? value : [value];
            value.reverse();
            await client.query({
                name: 'listPrependValues',
                text: `
INSERT INTO "legacy_list" ("_key", "array")
VALUES ($1::TEXT, $2::TEXT[])
ON CONFLICT ("_key")
DO UPDATE SET "array" = EXCLUDED.array || "legacy_list"."array"`,
                values: [key, value],
            });
        });
    };

    module.listAppend = async function (key: string, value: string | string[]): Promise<void> {
        if (!key) {
            return;
        }
        await module.transaction(async (client) => {
            value = Array.isArray(value) ? value : [value];

            await helpers.ensureLegacyObjectType(client, key, 'list');
            await client.query({
                name: 'listAppend',
                text: `
INSERT INTO "legacy_list" ("_key", "array")
VALUES ($1::TEXT, $2::TEXT[])
ON CONFLICT ("_key")
DO UPDATE SET "array" = "legacy_list"."array" || EXCLUDED.array`,
                values: [key, value],
            });
        });
    };

    module.listRemoveLast = async function (key: string): Promise<string | null> {
        if (!key) {
            return;
        }

        const res = await module.pool.query({
            name: 'listRemoveLast',
            text: `
WITH A AS (
    SELECT l.*
      FROM "legacy_object_live" o
     INNER JOIN "legacy_list" l
             ON o."_key" = l."_key"
            AND o."type" = l."type"
     WHERE o."_key" = $1::TEXT
       FOR UPDATE)
UPDATE "legacy_list" l
   SET "array" = A."array"[1 : array_length(A."array", 1) - 1]
  FROM A
 WHERE A."_key" = l."_key"
RETURNING A."array"[array_length(A."array", 1)] v`,
            values: [key],
        });

        return res.rows.length ? res.rows[0].v : null;
    };

    module.listRemoveAll = async function (key: string, value: string | string[]): Promise<void> {
        if (!key) {
            return;
        }
        // TODO: remove all values with one query
        if (Array.isArray(value)) {
            await Promise.all(value.map(v => module.listRemoveAll(key, v)));
            return;
        }
        await module.pool.query({
            name: 'listRemoveAll',
            text: `
UPDATE "legacy_list" l
   SET "array" = array_remove(l."array", $2::TEXT)
  FROM "legacy_object_live" o
 WHERE o."_key" = l."_key"
   AND o."type" = l."type"
   AND o."_key" = $1::TEXT`,
            values: [key, value],
        });
    };

    module.listTrim = async function (key: string, start: number, stop: number): Promise<void> {
        if (!key) {
            return;
        }

        stop += 1;

        await module.pool.query(stop > 0 ? {
            name: 'listTrim',
            text: `
UPDATE "legacy_list" l
   SET "array" = ARRAY(SELECT m.m
                         FROM UNNEST(l."array") WITH ORDINALITY m(m, i)
                        ORDER BY m.i ASC
                        LIMIT ($3::INTEGER - $2::INTEGER)
                       OFFSET $2::INTEGER)
  FROM "legacy_object_live" o
 WHERE o."_key" = l."_key"
   AND o."type" = l."type"
   AND o."_key" = $1::TEXT`,
            values: [key, start, stop],
        } : {
            name: 'listTrimBack',
            text: `
UPDATE "legacy_list" l
   SET "array" = ARRAY(SELECT m.m
                         FROM UNNEST(l."array") WITH ORDINALITY m(m, i)
                        ORDER BY m.i ASC
                        LIMIT ($3::INTEGER - $2::INTEGER + array_length(l."array", 1))
                       OFFSET $2::INTEGER)
  FROM "legacy_object_live" o
 WHERE o."_key" = l."_key"
   AND o."type" = l."type"
   AND o."_key" = $1::TEXT`,
            values: [key, start, stop],
        });
    };

    module.getListRange = async function (key: string, start: number, stop: number): Promise<string[]> {
        if (!key) {
            return;
        }

        stop += 1;

        const res = await module.pool.query(stop > 0 ? {
            name: 'getListRange',
            text: `
SELECT ARRAY(SELECT m.m
               FROM UNNEST(l."array") WITH ORDINALITY m(m, i)
              ORDER BY m.i ASC
              LIMIT ($3::INTEGER - $2::INTEGER)
             OFFSET $2::INTEGER) l
  FROM "legacy_object_live" o
 INNER JOIN "legacy_list" l
         ON o."_key" = l."_key"
        AND o."type" = l."type"
      WHERE o."_key" = $1::TEXT`,
            values: [key, start, stop],
        } : {
            name: 'getListRangeBack',
            text: `
SELECT ARRAY(SELECT m.m
               FROM UNNEST(l."array") WITH ORDINALITY m(m, i)
              ORDER BY m.i ASC
              LIMIT ($3::INTEGER - $2::INTEGER + array_length(l."array", 1))
             OFFSET $2::INTEGER) l
  FROM "legacy_object_live" o
 INNER JOIN "legacy_list" l
         ON o."_key" = l."_key"
        AND o."type" = l."type"
 WHERE o."_key" = $1::TEXT`,
            values: [key, start, stop],
        });

        return res.rows.length ? res.rows[0].l : [];
    };

    module.listLength = async function (key) {
        const res = await module.pool.query({
            name: 'listLength',
            text: `
SELECT array_length(l."array", 1) l
  FROM "legacy_object_live" o
 INNER JOIN "legacy_list" l
         ON o."_key" = l."_key"
        AND o."type" = l."type"
      WHERE o."_key" = $1::TEXT`,
            values: [key],
        });

        return res.rows.length ? res.rows[0].l : 0;
    };
};