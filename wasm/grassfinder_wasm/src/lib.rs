use wasm_bindgen::prelude::*;
use js_sys::Int32Array;

#[inline(always)]
fn packed_offset_12bit(x: i32, y: i32, z: i32, post1_12: bool) -> u16 {
    // Vanilla:
    // long l = (long)(x * 3129871) ^ ((long)z * 116129781L) ^ (long)y;
    // l = l*l*42317861L + l*11L;
    // return (l >>> 16) & 0xFFF;
    let yy = if post1_12 { 0 } else { y };

    // x*3129871 happens as i32 multiply (wrap) then cast to long in vanilla expression
    let x_term = (x.wrapping_mul(3_129_871) as i64);

    // z term is long multiply
    let z_term = (z as i64).wrapping_mul(116_129_781i64);

    let mut l: i64 = x_term ^ z_term ^ (yy as i64);

    l = l
        .wrapping_mul(l)
        .wrapping_mul(42_317_861i64)
        .wrapping_add(l.wrapping_mul(11i64));

    let u = l as u64;
    ((u >> 16) & 0xFFF) as u16
}

#[inline(always)]
fn axis_nibble(v: u16, axis: usize) -> u8 {
    ((v >> (axis * 4)) & 0xF) as u8
}

#[inline(always)]
fn dripstone_nibble_matches(expected: u8, predicted: u8) -> bool {
    if expected <= 3 {
        predicted <= 3
    } else if expected >= 12 {
        predicted >= 12
    } else {
        predicted == expected
    }
}

#[inline(always)]
fn dripstone_nibble_distance(expected: u8, predicted: u8) -> i32 {
    if expected <= 3 {
        if predicted <= 3 { 0 } else { (predicted - 3) as i32 }
    } else if expected >= 12 {
        if predicted >= 12 { 0 } else { (12 - predicted) as i32 }
    } else {
        (predicted as i32 - expected as i32).abs()
    }
}

/// Strict scan: returns Int32Array [x,y,z, x,y,z, ...]
#[wasm_bindgen]
pub fn scan_strict_box(
    rel_dx: &[i32],
    rel_dy: &[i32],
    rel_dz: &[i32],
    rel_packed: &[u16],
    rel_mask: &[u16],
    rel_drip: &[u8],
    post1_12_any_y: bool,
    x0: i32, x1: i32,
    y0: i32, y1: i32,
    z0: i32, z1: i32,
    max_matches: u32,
) -> Result<Int32Array, JsValue> {
    let n = rel_dx.len();
    if rel_dy.len() != n || rel_dz.len() != n || rel_packed.len() != n || rel_mask.len() != n || rel_drip.len() != n {
        return Err(JsValue::from_str("Input arrays must have the same length."));
    }
    if x0 > x1 || y0 > y1 || z0 > z1 {
        return Err(JsValue::from_str("Invalid bounds (min > max)."));
    }

    let mut out: Vec<i32> = Vec::with_capacity((max_matches as usize).saturating_mul(3));

    if post1_12_any_y {
        let y = y0;
        for z in z0..=z1 {
            for x in x0..=x1 {
                let mut ok = true;

                for i in 0..n {
                    let ax = x.wrapping_add(rel_dx[i]);
                    let ay = y.wrapping_add(rel_dy[i]);
                    let az = z.wrapping_add(rel_dz[i]);

                    let pred = packed_offset_12bit(ax, ay, az, true);
                    let mask = rel_mask[i];
                    let exp  = rel_packed[i];

                    if rel_drip[i] == 0 {
                        if (pred & mask) != exp { ok = false; break; }
                    } else {
                        for axis in 0..3 {
                            let nib_mask = ((mask >> (axis * 4)) & 0xF) as u16;
                            if nib_mask == 0 { continue; }

                            let pn = axis_nibble(pred, axis);
                            let en = axis_nibble(exp, axis);

                            if axis == 1 {
                                if pn != en { ok = false; break; }
                            } else {
                                if !dripstone_nibble_matches(en, pn) { ok = false; break; }
                            }
                        }
                        if !ok { break; }
                    }
                }

                if ok {
                    out.push(x); out.push(y); out.push(z);
                    if (out.len() / 3) as u32 >= max_matches {
                        return Ok(Int32Array::from(out.as_slice()));
                    }
                }
            }
        }
    } else {
        for y in y0..=y1 {
            for z in z0..=z1 {
                for x in x0..=x1 {
                    let mut ok = true;

                    for i in 0..n {
                        let ax = x.wrapping_add(rel_dx[i]);
                        let ay = y.wrapping_add(rel_dy[i]);
                        let az = z.wrapping_add(rel_dz[i]);

                        let pred = packed_offset_12bit(ax, ay, az, false);
                        let mask = rel_mask[i];
                        let exp  = rel_packed[i];

                        if rel_drip[i] == 0 {
                            if (pred & mask) != exp { ok = false; break; }
                        } else {
                            for axis in 0..3 {
                                let nib_mask = ((mask >> (axis * 4)) & 0xF) as u16;
                                if nib_mask == 0 { continue; }

                                let pn = axis_nibble(pred, axis);
                                let en = axis_nibble(exp, axis);

                                if axis == 1 {
                                    if pn != en { ok = false; break; }
                                } else {
                                    if !dripstone_nibble_matches(en, pn) { ok = false; break; }
                                }
                            }
                            if !ok { break; }
                        }
                    }

                    if ok {
                        out.push(x); out.push(y); out.push(z);
                        if (out.len() / 3) as u32 >= max_matches {
                            return Ok(Int32Array::from(out.as_slice()));
                        }
                    }
                }
            }
        }
    }

    Ok(Int32Array::from(out.as_slice()))
}

/// Scored scan: returns Int32Array [x,y,z,score, x,y,z,score, ...]
#[wasm_bindgen]
pub fn scan_scored_box(
    rel_dx: &[i32],
    rel_dy: &[i32],
    rel_dz: &[i32],
    rel_packed: &[u16],
    rel_mask: &[u16],
    rel_drip: &[u8],
    post1_12_any_y: bool,
    x0: i32, x1: i32,
    y0: i32, y1: i32,
    z0: i32, z1: i32,
    max_matches: u32,
    tol: u8,
    max_score: i32,
) -> Result<Int32Array, JsValue> {
    let n = rel_dx.len();
    if rel_dy.len() != n || rel_dz.len() != n || rel_packed.len() != n || rel_mask.len() != n || rel_drip.len() != n {
        return Err(JsValue::from_str("Input arrays must have the same length."));
    }
    if x0 > x1 || y0 > y1 || z0 > z1 {
        return Err(JsValue::from_str("Invalid bounds (min > max)."));
    }

    let tol_i = tol as i32;
    let mut out: Vec<i32> = Vec::with_capacity((max_matches as usize).saturating_mul(4));

    let mut check_candidate = |x: i32, y: i32, z: i32, post1_12: bool| -> Option<i32> {
        let mut score: i32 = 0;

        for i in 0..n {
            let ax = x.wrapping_add(rel_dx[i]);
            let ay = y.wrapping_add(rel_dy[i]);
            let az = z.wrapping_add(rel_dz[i]);

            let pred = packed_offset_12bit(ax, ay, az, post1_12);
            let exp  = rel_packed[i];
            let mask = rel_mask[i];
            let drip = rel_drip[i] != 0;

            for axis in 0..3 {
                let nib_mask = ((mask >> (axis * 4)) & 0xF) as u16;
                if nib_mask == 0 { continue; }

                let pn = axis_nibble(pred, axis);
                let en = axis_nibble(exp, axis);

                let d = if drip && axis != 1 {
                    dripstone_nibble_distance(en, pn)
                } else {
                    (pn as i32 - en as i32).abs()
                };

                if d <= tol_i {
                    score += d;
                } else {
                    score += d * d;
                }

                if score > max_score {
                    return None;
                }
            }
        }

        Some(score)
    };

    if post1_12_any_y {
        let y = y0;
        for z in z0..=z1 {
            for x in x0..=x1 {
                if let Some(s) = check_candidate(x, y, z, true) {
                    out.push(x); out.push(y); out.push(z); out.push(s);
                    if (out.len() / 4) as u32 >= max_matches {
                        return Ok(Int32Array::from(out.as_slice()));
                    }
                }
            }
        }
    } else {
        for y in y0..=y1 {
            for z in z0..=z1 {
                for x in x0..=x1 {
                    if let Some(s) = check_candidate(x, y, z, false) {
                        out.push(x); out.push(y); out.push(z); out.push(s);
                        if (out.len() / 4) as u32 >= max_matches {
                            return Ok(Int32Array::from(out.as_slice()));
                        }
                    }
                }
            }
        }
    }

    Ok(Int32Array::from(out.as_slice()))
}
