const DATA_DIR = "./data";
const shardCache = new Map();
const matrixCache = new Map();
let manifestPromise = null;

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`);
  return await response.json();
}

export function loadShardManifest() {
  if (!manifestPromise) {
    manifestPromise = fetchJson(`${DATA_DIR}/shards/manifest.json`);
  }
  return manifestPromise;
}

export async function loadShard({ unit, profile, hub, metric }) {
  const key = `${unit}|${profile}|${hub}|${metric}`;
  if (shardCache.has(key)) return await shardCache.get(key);
  const promise = (async () => {
    const manifest = await loadShardManifest();
    const entry = manifest?.units?.[unit]?.[profile]?.[hub]?.[metric];
    if (!entry?.path) throw new Error(`No shard for ${key}`);
    return await fetchJson(`${DATA_DIR}/shards/${entry.path}`);
  })();
  shardCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    shardCache.delete(key);
    throw error;
  }
}

function littleEndianInt16(buffer) {
  const probe = new Uint16Array([0x0102]);
  const isLittleEndian = new Uint8Array(probe.buffer)[0] === 0x02;
  if (isLittleEndian) return new Int16Array(buffer);
  const view = new DataView(buffer);
  const values = new Int16Array(buffer.byteLength / 2);
  for (let i = 0; i < values.length; i++) values[i] = view.getInt16(i * 2, true);
  return values;
}

export async function loadMatrixBinary({ unit, profile }) {
  const key = `${unit}|${profile}`;
  if (matrixCache.has(key)) return await matrixCache.get(key);
  const promise = (async () => {
    const suffix = unit === "derived" ? "_derived" : "";
    const indexPath = `${DATA_DIR}/matrix_${profile}${suffix}_index.json`;
    const index = await fetchJson(indexPath);
    const response = await fetch(`${DATA_DIR}/${index.binary}`);
    if (!response.ok) throw new Error(`Failed to fetch ${index.binary}: ${response.status}`);
    const values = littleEndianInt16(await response.arrayBuffer());
    const expected = Number(index.size) * Number(index.size) * 2;
    if (values.length !== expected) {
      throw new Error(`${index.binary} has ${values.length} Int16 values; expected ${expected}`);
    }
    return { index, values };
  })();
  matrixCache.set(key, promise);
  try {
    return await promise;
  } catch (error) {
    matrixCache.delete(key);
    throw error;
  }
}

export function clearDataCachesForTests() {
  shardCache.clear();
  matrixCache.clear();
  manifestPromise = null;
}
