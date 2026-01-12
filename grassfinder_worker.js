import init, { scan_strict_box, scan_scored_box } from "./wasm/pkg/grassfinder_wasm.js";

let ready = init();

self.onmessage = async (e) => {
  await ready;

  const {
    jobId,
    x0, x1,
    z0, z1,
    y0, y1,
    version,
    relDx, relDy, relDz,
    relPacked, relMask, relDrip,
    maxMatches,
    post1_12_anyY,
    mode,
    tol,
    maxScore
  } = e.data;

  const post1_12 = (version === "post1_12");
  const anyY = !!post1_12_anyY || post1_12;

  const xCount = (x1 - x0 + 1);
  const zCount = (z1 - z0 + 1);
  const yCount = anyY ? 1 : (y1 - y0 + 1);
  const total = xCount * zCount * yCount;

  let done = 0;
  const matches = [];

  // Chunk by Z so we can emit progress periodically (similar feel to the JS worker)
  const emitEvery = 250000;
  const zChunk = Math.max(1, Math.floor(emitEvery / (xCount * yCount)));

  for (let zs = z0; zs <= z1; zs += zChunk) {
    const ze = Math.min(z1, zs + zChunk - 1);

    const remaining = Math.max(0, (maxMatches | 0) - matches.length);
    if (remaining === 0) {
      self.postMessage({ jobId, type: "done", done, total, matches, hitCap: true });
      return;
    }

    if (mode === "scored") {
      const arr = scan_scored_box(
        relDx, relDy, relDz,
        relPacked, relMask, relDrip,
        anyY,
        x0, x1, y0, y1, zs, ze,
        remaining,
        tol | 0,
        maxScore | 0
      );

      for (let i = 0; i < arr.length; i += 4) {
        matches.push({ x: arr[i], y: arr[i + 1], z: arr[i + 2], score: arr[i + 3] });
      }
    } else {
      const arr = scan_strict_box(
        relDx, relDy, relDz,
        relPacked, relMask, relDrip,
        anyY,
        x0, x1, y0, y1, zs, ze,
        remaining
      );

      for (let i = 0; i < arr.length; i += 3) {
        matches.push({ x: arr[i], y: arr[i + 1], z: arr[i + 2] });
      }
    }

    done += xCount * (ze - zs + 1) * yCount;

    if (matches.length >= (maxMatches | 0)) {
      self.postMessage({ jobId, type: "done", done, total, matches, hitCap: true });
      return;
    }

    self.postMessage({ jobId, type: "progress", done, total, matchesCount: matches.length });
  }

  self.postMessage({ jobId, type: "done", done, total, matches, hitCap: false });
};
