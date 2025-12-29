export async function onRequest(context) {
  const { results } = await context.env.DB
    .prepare(`
      SELECT
        hash,
        time,
        COUNT(hash) as count,
        AVG(json_extract(s.value, "$.rssi")) as rssi,
        AVG(json_extract(s.value, "$.snr")) as snr,
        json_group_array(DISTINCT json_extract(s.value, "$.repeater")) as repeaters
      FROM rx_samples, json_each(rx_samples.samples) AS s
      GROUP BY hash
    `)
    .all();

  results.forEach(r => { r.repeaters = JSON.parse(r.repeaters); });
  return Response.json(results);
}
