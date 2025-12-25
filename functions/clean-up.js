import * as util from '../content/shared.js';

async function cleanCoverage(context, result) {
}

async function cleanSamples(context, result) {
}

function overlaps(a, b) {
  const dist = util.haversineMiles(a, b);
  return dist <= 0.25;  // Consider anything under 1/4 mile overlapped.
}

function groupByOverlap(repeaters) {
  const groups = [];

  for (const r of repeaters) {
    let found = false;

    // Look for an existing overlap group.
    // TODO: Technically should compute a group center for comparison.
    for (const g of groups) {
      if (overlaps(g.pos, r.pos)) {
        g.items.push(r);
        found = true;
        break;
      }
    }

    if (!found) {
      // Add a new group.
      groups.push({ id: r.id, pos: r.pos, items: [r] });
    }
  }

  return groups;
}

async function cleanRepeaters(context, result) {
  result.deleted_stale_repeaters = 0;
  result.deleted_dupe_repeaters = 0;

  // Delete entries that haven't been updated in N days.
  let dbResult = await context.env.DB
    .prepare("DELETE FROM repeaters WHERE time < ?")
    .bind(Date.now() - (10 * util.dayInMillis))
    .run();

  console.log("Delete stale:", dbResult);
  result.deleted_stale_repeaters = dbResult?.meta?.rows_written ?? 0;

  // Index repeaters by Id.
  const indexed = new Map();
  const { results: repeaters } = await context.env.DB
    .prepare("SELECT id, hash, time FROM repeaters").all();
  repeaters.forEach(r => {
    r.pos = util.posFromHash(r.hash);
    util.pushMap(indexed, r.id, r);
  });

  // Compute overlap groups and deduplicate.
  const deleteStmts = [];
  indexed.entries().forEach(([id, rptrs]) => {
    const groups = groupByOverlap(rptrs);
    groups.forEach(g => {
      if (g.items.length > 1) {
        // Sort newest first.
        const sorted = g.items.toSorted((a, b) => b.time - a.time);
        for (const i of sorted.slice(1)) {
          deleteStmts.push(context.env.DB
            .prepare("DELETE FROM repeaters WHERE id = ? AND hash = ?")
            .bind(i.id, i.hash));
        }
      }
    });
  });

  if (deleteStmts.length > 0) {
    // Batch returns an array of results.
    dbResult = await context.env.DB.batch(deleteStmts)
    console.log("Delete dupes:", dbResult);
    dbResult.forEach(r => {
      result.deleted_dupe_repeaters += r?.meta?.rows_written ?? 0
    });
  }
}

export async function onRequest(context) {
  const result = {};

  const url = new URL(context.request.url);
  const op = url.searchParams.get('op');

  switch (op) {
    case "coverage":
      await cleanCoverage(context, result);
      break;

    case "samples":
      await cleanSamples(context, result);
      break;

    case "repeaters":
      await cleanRepeaters(context, result);
      break;
  }

  return Response.json(result);
}
