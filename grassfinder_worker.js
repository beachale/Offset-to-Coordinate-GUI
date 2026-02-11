import init, { scan_strict_box, scan_scored_box } from "./wasm/pkg/grassfinder_wasm.js";

let ready = init();

// --- b1.6-tb3 JS fallback ---
// The shipped WASM implementation matches vanilla's XOR seed:
//   l = (x*3129871) ^ (z*116129781) ^ y
// b1.6-tb3 uses a different seed in RenderBlocks:
//   l = (x*3129871 + z*6129781 + y)
// Everything after that is identical.
//
// For the packed 12-bit offset, we only need bits 16..27 of the 64-bit long.
// Those bits live in the low 32 bits, so we can compute this using 32-bit Math.imul.
const X_MULT = 3_129_871 | 0;
const Z_MULT_TB3 = 6_129_781 | 0;
const LCG_MULT = 42_317_861 | 0;
const LCG_ADDEND = 11 | 0;

function packed_offset_12bit_tb3(x, y, z) {
  let l = (Math.imul(x|0, X_MULT) + Math.imul(z|0, Z_MULT_TB3) + (y|0)) | 0;
  const ll = Math.imul(l, l) | 0;
  l = (Math.imul(ll, LCG_MULT) + Math.imul(l, LCG_ADDEND)) | 0;
  return (l >>> 16) & 0xFFF;
}

function axis_nibble_12(v, axis){
  return (v >>> (axis * 4)) & 15;
}

function dripstone_nibble_matches(expected, predicted){
  if (expected <= 3) return predicted <= 3;
  if (expected >= 12) return predicted >= 12;
  return predicted === expected;
}

function dripstone_nibble_distance(expected, predicted){
  if (expected <= 3) {
    return (predicted <= 3) ? 0 : (predicted - 3);
  }
  if (expected >= 12) {
    return (predicted >= 12) ? 0 : (12 - predicted);
  }
  return Math.abs(predicted - expected);
}

function scan_strict_box_tb3(
  relDx, relDy, relDz,
  relPacked, relMask, relDrip,
  anyY,
  x0, x1, y0, y1, z0, z1,
  maxMatches,
){
  const n = relDx.length|0;
  const matches = [];

  const yStart = anyY ? y0 : y0;
  const yEnd   = anyY ? y0 : y1;

  for (let y = yStart; y <= yEnd; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        let ok = true;
        for (let i=0;i<n;i++) {
          const ax = (x + relDx[i]) | 0;
          const ay = (y + relDy[i]) | 0;
          const az = (z + relDz[i]) | 0;

          const pred = packed_offset_12bit_tb3(ax, ay, az) | 0;
          const mask = relMask[i] | 0;
          const exp  = relPacked[i] | 0;

          if ((relDrip[i] | 0) === 0) {
            if ((pred & mask) !== exp) { ok = false; break; }
          } else {
            for (let axis=0; axis<3; axis++) {
              const nibMask = (mask >>> (axis*4)) & 15;
              if (nibMask === 0) continue;
              const pn = axis_nibble_12(pred, axis);
              const en = axis_nibble_12(exp, axis);
              if (axis === 1) {
                if (pn !== en) { ok = false; break; }
              } else {
                if (!dripstone_nibble_matches(en, pn)) { ok = false; break; }
              }
            }
            if (!ok) break;
          }
        }
        if (ok) {
          matches.push({ x, y, z });
          if (matches.length >= (maxMatches|0)) return matches;
        }
      }
    }
  }

  return matches;
}

function scan_scored_box_tb3(
  relDx, relDy, relDz,
  relPacked, relMask, relDrip,
  anyY,
  x0, x1, y0, y1, z0, z1,
  maxMatches,
  tol,
  maxScore,
){
  const n = relDx.length|0;
  const matches = [];
  const tolI = tol|0;
  const maxS = maxScore|0;

  const yStart = anyY ? y0 : y0;
  const yEnd   = anyY ? y0 : y1;

  for (let y = yStart; y <= yEnd; y++) {
    for (let z = z0; z <= z1; z++) {
      for (let x = x0; x <= x1; x++) {
        let score = 0;
        for (let i=0;i<n;i++) {
          const ax = (x + relDx[i]) | 0;
          const ay = (y + relDy[i]) | 0;
          const az = (z + relDz[i]) | 0;
          const pred = packed_offset_12bit_tb3(ax, ay, az) | 0;
          const exp  = relPacked[i] | 0;
          const mask = relMask[i] | 0;
          const drip = (relDrip[i] | 0) !== 0;

          for (let axis=0; axis<3; axis++) {
            const nibMask = (mask >>> (axis*4)) & 15;
            if (nibMask === 0) continue;
            const pn = axis_nibble_12(pred, axis);
            const en = axis_nibble_12(exp, axis);
            const d = (drip && axis !== 1) ? dripstone_nibble_distance(en, pn) : Math.abs(pn - en);
            score += (d <= tolI) ? d : (d * d);
            if (score > maxS) { score = -1; break; }
          }
          if (score < 0) break;
        }
        if (score >= 0) {
          matches.push({ x, y, z, score });
          if (matches.length >= (maxMatches|0)) return matches;
        }
      }
    }
  }

  return matches;
}

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

  // b1.6-tb3 is the only supported mode that the shipped WASM doesn't implement.
  const isTb3 = (version === 'b1_6_tb3');

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

    if (isTb3) {
      // JS fallback (tb3 seed)
      const sub = (mode === 'scored')
        ? scan_scored_box_tb3(relDx, relDy, relDz, relPacked, relMask, relDrip, anyY, x0, x1, y0, y1, zs, ze, remaining, tol|0, maxScore|0)
        : scan_strict_box_tb3(relDx, relDy, relDz, relPacked, relMask, relDrip, anyY, x0, x1, y0, y1, zs, ze, remaining);

      for (const m of sub) matches.push(m);
    } else if (mode === "scored") {
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
