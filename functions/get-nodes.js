export async function onRequest(context) {
  const sampleStore = context.env.SAMPLES;
  const repeaterStore = context.env.REPEATERS;
  const responseData = {
    samples: [],
    repeaters:[]
  };

  let cursor = null;
  do {
    const samplesList = await sampleStore.list({cursor: cursor});
    cursor = samplesList.list_complete ? null : samplesList.cursor;
    samplesList.keys.forEach(s => {
      responseData.samples.push({
        hash: s.name,
        time: s.metadata.time,
        path: s.metadata.path,
      });
    });
  } while (cursor !== null)

  const repeatersList = await repeaterStore.list();
  repeatersList.keys.forEach(r => {
    responseData.repeaters.push({
      time: r.metadata.time ?? 0,
      id: r.metadata.id,
      name: r.metadata.name,
      lat: r.metadata.lat,
      lon: r.metadata.lon,
      elev: r.metadata.elev ?? 0,
    });
  });

  return new Response(JSON.stringify(responseData));
}
