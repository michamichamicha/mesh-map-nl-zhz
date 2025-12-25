// KV to D1 Data Migration
import {
  geohash8
} from '../content/shared.js'

async function migrateArchive(context, result) {
  const now = Date.now();
  const archived = await context.env.ARCHIVE.list();
  const insertStmts = [];
  const keysToDelete = [];

  // Limit batch size to stay within request limits.
  for (const k of archived.keys) {
    if (insertStmts.length >= 450) {
      result.archive_has_more = true;
      break;
    }

    const metadata = k.metadata;
    metadata.hash = k.name;
    insertStmts.push(context.env.DB
      .prepare("INSERT INTO sample_archive (time, data) VALUES (?, ?)")
      .bind(now, JSON.stringify(metadata)));
    keysToDelete.push(k.name);
  }

  if (insertStmts.length > 0) {
    await context.env.DB.batch(insertStmts);
    for (const k of keysToDelete) {
      await context.env.ARCHIVE.delete(k);
    }
  }

  result.archive_insert_time = now;
  result.archive_migrated = keysToDelete.length;
}

async function migrateSamples(context, result) {
  const now = Date.now();
  const samples = await context.env.SAMPLES.list();
  const insertStmts = [];
  const keysToDelete = [];

  // Limit batch size to stay within request limits.
  for (const k of samples.keys) {
    if (insertStmts.length >= 450) {
      result.samples_has_more = true;
      break;
    }

    const metadata = k.metadata;
    insertStmts.push(context.env.DB
      .prepare(`
        INSERT OR IGNORE INTO samples
          (hash, time, rssi, snr, observed, repeaters)
        VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(
        k.name,
        metadata.time,
        metadata.rssi ?? null,
        metadata.snr ?? null,
        metadata.observed ?? 0,
        JSON.stringify(metadata.path ?? [])
      ));
    keysToDelete.push(k.name);
  }

  if (insertStmts.length > 0) {
    await context.env.DB.batch(insertStmts);
    for (const k of keysToDelete) {
      await context.env.SAMPLES.delete(k);
    }
  }

  result.samples_insert_time = now;
  result.samples_migrated = keysToDelete.length;
}

async function migrateRepeaters(context, result) {
  const repeaters = await context.env.REPEATERS.list();
  const insertStmts = [];
  const keysToDelete = [];

  // Limit batch size to stay within request limits.
  for (const k of repeaters.keys) {
    if (insertStmts.length >= 450) {
      result.repeaters_has_more = true;
      break;
    }

    const metadata = k.metadata;
    insertStmts.push(context.env.DB
      .prepare(`
        INSERT OR IGNORE INTO repeaters
          (id, hash, time, name, elevation)
        VALUES (?, ?, ?, ?, ?)`)
      .bind(
        metadata.id,
        geohash8(metadata.lat, metadata.lon),
        metadata.time,
        metadata.name,
        metadata.elev
      ));
    keysToDelete.push(k.name);
  }

  if (insertStmts.length > 0) {
    await context.env.DB.batch(insertStmts);
    for (const k of keysToDelete) {
      await context.env.REPEATERS.delete(k);
    }
  }

  result.repeaters_insert_time = Date.now();
  result.repeaters_migrated = keysToDelete.length;
}

// First step is to move all the metadata.
async function migrateCoverage1(context, result) {
  result.coverage_migrated = 0;
  const store = context.env.COVERAGE;
  const insertStmts = [];
  let cursor = null;

  do {
    const coverage = await store.list({ cursor: cursor });
    cursor = coverage.cursor ?? null;
    coverage.keys.forEach(c => {
      const metadata = c.metadata;
      // Old coverage items only have "lastHeard".
      const lastHeard = metadata.heard ? metadata.lastHeard : 0;
      const updated = metadata.updated > 0 ? metadata.updated : Date.now();
      const lastObserved = metadata.lastObserved ?? lastHeard;
      insertStmts.push(context.env.DB
        .prepare(`
        INSERT OR IGNORE INTO coverage
          (hash, time, lastObserved, lastHeard, observed, heard, lost, rssi, snr, repeaters)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          c.name,
          updated,
          lastObserved,
          lastHeard,
          metadata.observed ?? metadata.heard ?? 0,
          metadata.heard ?? 0,
          metadata.lost ?? 0,
          metadata.rssi ?? null,
          metadata.snr ?? null,
          JSON.stringify(metadata.hitRepeaters ?? [])
        ));
    });
  } while (cursor !== null);

  const batchSize = 90;
  console.log("Insert count:", insertStmts.length);
  for (let i = 0; i < insertStmts.length; i += batchSize) {
    const batch = insertStmts.slice(i, i + batchSize);
    if (batch.length < 1) {
      console.log("Empty batch. All done.");
      break;
    }

    console.log("Executing batch size:", batch.length);
    await context.env.DB.batch(batch);
    result.coverage_migrated += batch.length;
  }
}

// Second step is to get the values and delete.
async function migrateCoverage2(context, result) {
  result.coverage_set_value = 0;
  result.coverage_deleted_kv = 0;

  const batchSize = 450;
  const { results: toUpdate } = await context.env.DB
    .prepare("SELECT hash FROM coverage WHERE entries = '[]' LIMIT ?").bind(batchSize).all();
  if (toUpdate.length == batchSize)
    result.coverage_has_more = true;
  const updateStmts = [];

  for (const c of toUpdate) {
    const value = await context.env.COVERAGE.get(c.hash, "json");
    if (value == null)
      continue;
    
    // Migrate existing values to newest format.
    value.forEach(v => {
      // An older version saved 'time' as a string. Yuck.
      v.time = Number(v.time);

      if (v.heard === undefined) {
        const wasHeard = v.path?.length > 0;
        v.heard = wasHeard ? 1 : 0;
        v.lost = wasHeard ? 0 : 1;
        v.lastHeard = wasHeard ? v.time : 0;
        v.repeaters = v.path;
        delete v.path;
      }

      if (v.observed === undefined) {
        // All previously "heard" entries were observed.
        v.observed = v.heard;
        v.snr = null;
        v.rssi = null;
        v.lastObserved = v.lastHeard;
      }
    });

    updateStmts.push(context.env.DB
      .prepare("UPDATE coverage SET entries = ? WHERE hash = ?")
      .bind(JSON.stringify(value), c.hash));
  }

  if (updateStmts.length > 0) {
    await context.env.DB.batch(updateStmts);
    result.coverage_set_value = updateStmts.length;
  }

  for (const c of toUpdate) {
    await context.env.COVERAGE.delete(c.hash);
    result.coverage_deleted_kv++;
  }
}

export async function onRequest(context) {
  const result = {};
  const url = new URL(context.request.url);
  const op = url.searchParams.get('op');

  switch (op) {
    case "archive":
      await migrateArchive(context, result);
      break;
    case "samples":
      await migrateSamples(context, result);
      break;
    case "repeaters":
      await migrateRepeaters(context, result);
      break;
    case "coverage-1":
      await migrateCoverage1(context, result);
      break;
    case "coverage-2":
      await migrateCoverage2(context, result);
      break;
  }

  return Response.json(result);
}