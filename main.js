import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

const foliageMatCache = new Map();
const blockCubeMatCache = new Map();

// Separate texture caches so we can mimic Minecraft's behavior:
// - Cube blocks (solid/cutout-mipped style) use mipmaps (controlled by the video setting)
// - Cross / x-shaped / bamboo / dripstone etc. do NOT use mipmaps (render type without mips)
const textureCacheMipped = new Map();
const textureCacheNoMips = new Map();

// Float32 helper (matches Java's (float) casts via Math.fround)
const f = Math.fround;

// --- Minecraft block textures ---
// We load foliage textures directly from the Minecraft assets repo.
// NOTE: Some assets (e.g. small dripleaf) are missing on older snapshot branches.
// Use a newer snapshot branch as the default upstream for block textures.
const MC_ASSETS_BLOCK_TEX_BASE = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/refs/heads/26.1-snapshot-4/assets/minecraft/textures/block/';
const PROGRAMMER_ART_BLOCK_TEX_BASE = 'https://raw.githubusercontent.com/Faithful-Pack/Default-Programmer-Art/refs/heads/1.21.10/assets/minecraft/textures/block/';

// Explicit whitelist of textures we swap to Programmer Art.
// Using explicit URLs avoids filename mismatches across versions (e.g. grass/short_grass renames).
const PROGRAMMER_ART_URLS = Object.freeze({
  // Flowers
  red_tulip: PROGRAMMER_ART_BLOCK_TEX_BASE + 'red_tulip.png',
  pink_tulip: PROGRAMMER_ART_BLOCK_TEX_BASE + 'pink_tulip.png',
  white_tulip: PROGRAMMER_ART_BLOCK_TEX_BASE + 'white_tulip.png',
  orange_tulip: PROGRAMMER_ART_BLOCK_TEX_BASE + 'orange_tulip.png',
  allium: PROGRAMMER_ART_BLOCK_TEX_BASE + 'allium.png',
  blue_orchid: PROGRAMMER_ART_BLOCK_TEX_BASE + 'blue_orchid.png',
  poppy: PROGRAMMER_ART_BLOCK_TEX_BASE + 'poppy.png',
  dandelion: PROGRAMMER_ART_BLOCK_TEX_BASE + 'dandelion.png',
  oxeye_daisy: PROGRAMMER_ART_BLOCK_TEX_BASE + 'oxeye_daisy.png',

  // Foliage
  fern: PROGRAMMER_ART_BLOCK_TEX_BASE + 'fern.png',
  short_grass: PROGRAMMER_ART_BLOCK_TEX_BASE + 'short_grass.png',
  tall_grass_top: PROGRAMMER_ART_BLOCK_TEX_BASE + 'tall_grass_top.png',
  tall_grass_bottom: PROGRAMMER_ART_BLOCK_TEX_BASE + 'tall_grass_bottom.png',
  large_fern_top: PROGRAMMER_ART_BLOCK_TEX_BASE + 'large_fern_top.png',
  large_fern_bottom: PROGRAMMER_ART_BLOCK_TEX_BASE + 'large_fern_bottom.png',

  // Tall flowers
  sunflower_top: PROGRAMMER_ART_BLOCK_TEX_BASE + 'sunflower_top.png',
  // Sunflower top model uses multiple textures (front/back/top).
  // Swap these too so the whole head changes when Programmer Art is enabled.
  sunflower_front: PROGRAMMER_ART_BLOCK_TEX_BASE + 'sunflower_front.png',
  sunflower_back: PROGRAMMER_ART_BLOCK_TEX_BASE + 'sunflower_back.png',
  sunflower_bottom: PROGRAMMER_ART_BLOCK_TEX_BASE + 'sunflower_bottom.png',
  lilac_top: PROGRAMMER_ART_BLOCK_TEX_BASE + 'lilac_top.png',
  lilac_bottom: PROGRAMMER_ART_BLOCK_TEX_BASE + 'lilac_bottom.png',
  rose_bush_top: PROGRAMMER_ART_BLOCK_TEX_BASE + 'rose_bush_top.png',
  rose_bush_bottom: PROGRAMMER_ART_BLOCK_TEX_BASE + 'rose_bush_bottom.png',
  peony_top: PROGRAMMER_ART_BLOCK_TEX_BASE + 'peony_top.png',
  peony_bottom: PROGRAMMER_ART_BLOCK_TEX_BASE + 'peony_bottom.png',
});

const PROGRAMMER_ART_KEYS = new Set(Object.keys(PROGRAMMER_ART_URLS));
let useProgrammerArt = false;
let useMSAA = true; // WebGLRenderer antialias (MSAA)

// --- Custom resource pack support (textures + models from a resource pack zip) ---
let resourcePackGeneration = 0;
/** @type {{name:string, textures:Map<string,string>, models:Map<string,any>, urlsToRevoke:string[]} | null} */
let activeResourcePack = null;

function resourcePackTextureUrl(key){
  const rp = activeResourcePack;
  if (!rp) return null;
  const k = String(key || '').trim();
  const kl = k.toLowerCase();
  return rp.textures.get(k) || rp.textures.get(kl) || null;
}

function resourcePackModelJson(key){
  const rp = activeResourcePack;
  if (!rp) return null;
  const k = String(key || '').trim();
  const kl = k.toLowerCase();
  return rp.models.get(k) || rp.models.get(kl) || null;
}

function revokeActiveResourcePackUrls(){
  const rp = activeResourcePack;
  if (!rp || !rp.urlsToRevoke) return;
  for (const u of rp.urlsToRevoke){
    try { URL.revokeObjectURL(u); } catch (_) {}
  }
}

let _zipLibPromise = null;
async function getZipLib(){
  if (_zipLibPromise) return _zipLibPromise;
  _zipLibPromise = import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js')
    .catch(() => import('https://unpkg.com/fflate@0.8.2/esm/browser.js'));
  return _zipLibPromise;
}

async function unzipToEntries(file){
  const lib = await getZipLib();
  const u8 = new Uint8Array(await file.arrayBuffer());
  return await new Promise((resolve, reject) => {
    try {
      lib.unzip(u8, (err, data) => err ? reject(err) : resolve({ data, lib }));
    } catch (e) {
      reject(e);
    }
  });
}

async function loadResourcePackZip(file){
  if (!file) return null;
  const name = String(file.name || 'resource_pack.zip');
  const { data } = await unzipToEntries(file);
  const dec = new TextDecoder('utf-8');

  const textures = new Map();
  const models = new Map();
  const urlsToRevoke = [];

  for (const fn of Object.keys(data || {})) {
    const rawName = String(fn || '').replace(/\\/g, '/');
    const lower = rawName.toLowerCase();
    const bytes = data[fn];

    // Textures: we index by filename (leaf) without extension.
    // Example: assets/minecraft/textures/block/grass_block_top.png -> key 'grass_block_top'
    //
    // NOTE: This tool only consumes *block* textures. Resource packs can contain the same
    // filename in multiple folders (e.g. textures/painting/fern.png vs textures/block/fern.png).
    // To avoid collisions where the wrong asset is picked, we only ingest overrides from:
    //   assets/minecraft/textures/block/
    if (lower.includes('assets/minecraft/textures/block/') && lower.endsWith('.png')) {
      const base = rawName.split('/').pop() || '';
      const key = base.replace(/\.png$/i, '').toLowerCase();
      if (!key) continue;
      try {
        const blob = new Blob([bytes], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        textures.set(key, url);
        urlsToRevoke.push(url)
      } catch (e) {
        console.warn('[Resource Pack] Failed to register texture', rawName, e);
      }
      continue;
    }

    // Models: index by leaf name (e.g. 'sunflower_top')
    if (lower.includes('assets/minecraft/models/') && lower.endsWith('.json')) {
      const base = rawName.split('/').pop() || '';
      const key = base.replace(/\.json$/i, '').toLowerCase();
      if (!key) continue;
      try {
        const txt = dec.decode(bytes);
        const obj = JSON.parse(txt);
        models.set(key, obj);
      } catch (e) {
        console.warn('[Resource Pack] Bad JSON model:', rawName, e);
      }
    }
  }

  return { name, textures, models, urlsToRevoke };
}

function setActiveResourcePack(rp){
  revokeActiveResourcePackUrls();
  activeResourcePack = rp;
  resourcePackGeneration++;
}

function blockTextureUrl(key){
  const k = String(key || '').trim();
  // If a resource pack is loaded, it overrides all default textures.
  const rpUrl = resourcePackTextureUrl(k);
  if (rpUrl) return rpUrl;

  // Fallback: built-in Programmer Art toggle for a small curated set.
  if (useProgrammerArt && PROGRAMMER_ART_KEYS.has(k)) return PROGRAMMER_ART_URLS[k];
  return `${MC_ASSETS_BLOCK_TEX_BASE}${encodeURIComponent(k)}.png`;
}

// Keep block model JSON in sync with the texture snapshot branch.
const MC_ASSETS_BLOCK_MODEL_BASE = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/refs/heads/26.1-snapshot-4/assets/minecraft/models/block/';

// Some vanilla foliage textures are grayscale and are normally tinted by the game.
// This tool doesn't simulate biome tinting, so we apply a fixed color overlay for
// those specific grayscale textures.
const GRAYSCALE_FOLIAGE_OVERLAY_HEX = 0xb3ff06; // #b3ff06
function isGrayscaleFoliage(id){
  return id === 'SHORT_GRASS' || id === 'TALL_GRASS' || id === 'FERN' || id === 'LARGE_FERN';
}
const TINTED_CROSS_MODEL = {"ambientocclusion":false,"textures":{"particle":"#cross"},"elements":[{"from":[0.8,0,8],"to":[15.2,16,8],"rotation":{"origin":[8,8,8],"axis":"y","angle":45,"rescale":true},"shade":false,"faces":{"north":{"uv":[0,0,16,16],"texture":"#cross","tintindex":0},"south":{"uv":[0,0,16,16],"texture":"#cross","tintindex":0}}},{"from":[8,0,0.8],"to":[8,16,15.2],"rotation":{"origin":[8,8,8],"axis":"y","angle":45,"rescale":true},"shade":false,"faces":{"west":{"uv":[0,0,16,16],"texture":"#cross","tintindex":0},"east":{"uv":[0,0,16,16],"texture":"#cross","tintindex":0}}}]};

// --- Block model cache (for special cases like mangrove propagules) ---
const blockModelCache = new Map();

// --- Viewport vs workspace ---
// The on-page viewport is a fixed 960x540 canvas.
// Inside that viewport, we display a (potentially huge) workspace coordinate space.
// You can pan/zoom the workspace, and independently choose the render resolution
// of the Three.js scene inside that workspace.
//
// Overlay images are NEVER scaled; they are drawn 1:1 pixels and centered in the workspace.
let VIEW_W = 960;   // workspace width
let VIEW_H = 540;   // workspace height
let RENDER_W = 960; // 3D render width inside workspace
let RENDER_H = 540; // 3D render height inside workspace

// Pan/zoom state (like local-overlay)
let centerX = VIEW_W / 2;
let centerY = VIEW_H / 2;
let roundedCenterX = centerX;
let roundedCenterY = centerY;
let zoomIndex = 0;
let zoom = 1;

// --- Minecraft camera conventions (Java) ---
// Axes: +X east, +Y up, +Z south.
// Yaw (degrees): 0 faces +Z, -90 faces +X, 180/-180 faces -Z, 90 faces -X.
// Pitch (degrees): 0 level, +90 looks straight down, -90 looks straight up.
function mcForwardFromYawPitch(yawDeg, pitchDeg) {
  // 1. Convert inputs to float32 first
  const yawF = f(yawDeg);
  const pitchF = f(pitchDeg);

  // 2. Convert to radians using the float constant.
  // IMPORTANT: Minecraft's look-vector helper is Vec3.directionFromRotation(pitch,yaw),
  // which applies the following float operations (see unobfuscated jar):
  //   yRot = (-yaw * RAD_PER_DEG) - PI
  //   xRot = (-pitch * RAD_PER_DEG)
  // This PI shift flips the camera basis to match MC's +Z=south, +X=east convention.
  const xRotRad = f(-pitchF * RAD_PER_DEG);
  const yRotRad = f(f(-yawF * RAD_PER_DEG) - PI_F);

  // 3. Trig results must be cast to float immediately
  const cosPitch = f(Math.cos(xRotRad));
  const sinPitch = f(Math.sin(xRotRad));
  const cosYaw = f(Math.cos(yRotRad));
  const sinYaw = f(Math.sin(yRotRad));

  // 4. Calculate Forward Vector components (Standard MC "Look" Vector)
  // 4. Calculate Forward Vector components (exact MC ordering)
  // Java (directionFromRotation):
  //   float f4 = -Mth.cos(xRot);
  //   return new Vec3(Mth.sin(yRot) * f4, Mth.sin(xRot), Mth.cos(yRot) * f4);
  const negCosPitch = f(-cosPitch);
  const vx = f(sinYaw * negCosPitch);
  const vy = f(sinPitch);
  const vz = f(cosYaw * negCosPitch);

  // IMPORTANT: do NOT normalize (Minecraft's float math can be microscopically off-unit).
  return new THREE.Vector3(vx, vy, vz);
}

// Set Three.js camera quaternion to match Minecraft's render camera rotation.
// Mirrors net.minecraft.client.Camera.setRotation(yaw, pitch):
//   rotationYXZ(PI - yaw*RAD_PER_DEG, -pitch*RAD_PER_DEG, 0)
// Note: Minecraft/JOML computes this using float32 angles and float32 sin/cos, so we
// fround at the same points.
function mcSetCameraQuaternion(camera, yawDeg, pitchDeg) {
  const yawF = f(yawDeg);
  const pitchF = f(pitchDeg);

  const yawRad = f(yawF * RAD_PER_DEG);
  const pitchRad = f(pitchF * RAD_PER_DEG);

  // rotationYXZ(y, x, z=0)
  const yAng = f(PI_F - yawRad);
  const xAng = f(-pitchRad);

  const half = f(0.5);
  const hy = f(yAng * half);
  const hx = f(xAng * half);

  const sy = f(Math.sin(hy));
  const cy = f(Math.cos(hy));
  const sx = f(Math.sin(hx));
  const cx = f(Math.cos(hx));

  // q = qy * qx (z rotation is 0)
  const qx = f(cy * sx);
  const qy = f(sy * cx);
  const qz = f(-sy * sx);
  const qw = f(cy * cx);

  camera.quaternion.set(qx, qy, qz, qw);
}

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function wrap(v, a, b){
  const range = (b - a + 1);
  let n = v;
  while (n < a) n += range;
  while (n > b) n -= range;
  return n;
}

// --- Minecraft block offset (1.21.4) ---
// Matches BlockBehaviour.Properties.offsetType(OffsetType.XYZ)
//
// In 1.21.4, short_grass uses offsetType(XYZ) and Block's default maxima:
//   max horizontal offset = 0.25 block
//   max vertical offset   = 0.2  block (negative only)
//
// ManualGrass uses 0..15 integers per axis; those map directly to the same
// 4-bit ranges used by Minecraft's offset function.
const MC_MAX_HORIZ_OFF = f(0.25);
const MC_MAX_VERT_OFF  = f(0.2);

// Pointed dripstone uses a smaller maximum horizontal offset than the default foliage grid.
// Vanilla (1.21.x): PointedDripstoneBlock.getMaxHorizontalOffset() = 0.125 (1/8).
function getMaxHorizontalOffsetForKind(kind){
  return (String(kind || '') === 'POINTED_DRIPSTONE') ? 0.125 : MC_MAX_HORIZ_OFF;
}

// Vanilla (26.1 snapshot 2): Small dripleaf overrides the default max vertical offset.
// - Default (BlockBehaviour): 0.2 blocks (negative only)
// - SmallDripleafBlock:       0.1 blocks (negative only)
function getMaxVerticalOffsetForKind(kind){
  return (String(kind || '') === 'SMALL_DRIPLEAF') ? 0.1 : MC_MAX_VERT_OFF;
}

// Convert the 0..15 per-axis offset integers into Minecraft's baked-model translation.
// Most foliage uses +/-0.25 horizontal, but pointed dripstone uses +/-0.125.
function offsetToVec3ForKind(kind, offX, offY, offZ) {
  // Blocks like the reference grass block cube have no random render offset in vanilla.
  if (String(kind || '') === 'CUBE') return new THREE.Vector3(0, 0, 0);
  const maxH = getMaxHorizontalOffsetForKind(kind);

  // 1. Force the input to be an integer nibble (0..15)
  const iX = clampInt(Math.floor(offX), 0, 15);
  const iY = clampInt(Math.floor(offY), 0, 15);
  const iZ = clampInt(Math.floor(offZ), 0, 15);

  // 2. Calculate the raw float offset (Standard Minecraft Formula)
  //    Java: (float)i / 15.0F * 0.5F - 0.25F
  let x = f((iX / 15.0) * 0.5 - 0.25);
  let z = f((iZ / 15.0) * 0.5 - 0.25);

  // Vertical offset is standard for OffsetType.XYZ:
  // Java: (float)i / 15.0F * maxV - maxV  -> [-maxV, 0]
  // (Small dripleaf uses maxV=0.1; most foliage uses 0.2.)
  const maxV = f(getMaxVerticalOffsetForKind(kind));
  const y = f((iY / 15.0) * maxV - maxV);

  // 3. Apply per-block maximum horizontal offset via clamp ("fold" for dripstone)
  x = f(clamp(x, -maxH, maxH));
  z = f(clamp(z, -maxH, maxH));

  return new THREE.Vector3(x, y, z);
}

// --- Viewport canvas (2D compositor) + Three.js renderer (offscreen WebGL) ---
const viewCanvas = document.getElementById('view');
viewCanvas.width = 960;
viewCanvas.height = 540;
const viewCtx = viewCanvas.getContext('2d');

// UX: if the user is typing in a sidebar input, clicking the canvas should exit typing mode
// so keyboard shortcuts (WASD, 1/2, etc.) work immediately.
viewCanvas.addEventListener('pointerdown', () => {
  const ae = document.activeElement;
  if (!ae) return;
  const tag = (ae.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    ae.blur();
  }
});

let webglCanvas = document.createElement('canvas');
// preserveDrawingBuffer allows drawImage(webglCanvas, ...) reliably.
let renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: useMSAA, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); // render is in workspace pixels; keep literal
renderer.setClearColor(0x000000, 0);

function rebuildRenderer(){
  const old = renderer;
  // New canvas/context is required because MSAA is decided at WebGL context creation.
  webglCanvas = document.createElement('canvas');
  renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: useMSAA, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  try { resizeWebGL(); } catch (_) { /* resizeWebGL not ready yet during early init */ }
  try { old?.dispose?.(); } catch (_) {}
  try { requestRender(); } catch (_) {}
}
const scene = new THREE.Scene();
scene.add(new THREE.AmbientLight(0xffffff, 0.35));

const camera = new THREE.PerspectiveCamera(70, RENDER_W / RENDER_H, 0.05, 2048);
camera.up.set(0, 1, 0);

function resizeWebGL() {
  renderer.setSize(RENDER_W, RENDER_H, false);
  camera.aspect = RENDER_W / RENDER_H;
  camera.updateProjectionMatrix();
}

// --- Helpers: wire grid + chunk borders ---
// Light gray like MC debug helpers, a bit subtle.
const GRID_COLOR = 0xd0d0d0;
const CHUNK_COLOR = 0xffd65c;

function make3DGrid({xmin, xmax, ymin, ymax, zmin, zmax, step=1}) {
  const verts = [];
  for (let y = ymin; y <= ymax; y += step) {
    for (let z = zmin; z <= zmax; z += step) {
      verts.push(xmin, y, z, xmax, y, z);
    }
  }
  for (let y = ymin; y <= ymax; y += step) {
    for (let x = xmin; x <= xmax; x += step) {
      verts.push(x, y, zmin, x, y, zmax);
    }
  }
  for (let x = xmin; x <= xmax; x += step) {
    for (let z = zmin; z <= zmax; z += step) {
      verts.push(x, ymin, z, x, ymax, z);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  // Note: WebGL ignores linewidth on most platforms; "thinner" is achieved via lower opacity.
  const mat = new THREE.LineBasicMaterial({ color: GRID_COLOR, transparent: true, opacity: 0.45 });
  return new THREE.LineSegments(geo, mat);
}

function makeChunkBorders({xmin, xmax, ymin, ymax, zmin, zmax}) {
  const verts = [];
  const xStart = Math.floor(xmin / 16) * 16;
  const xEnd   = Math.ceil (xmax / 16) * 16;
  const zStart = Math.floor(zmin / 16) * 16;
  const zEnd   = Math.ceil (zmax / 16) * 16;

  for (let x = xStart; x <= xEnd; x += 16) {
    verts.push(x, ymin, zStart, x, ymin, zEnd);
    verts.push(x, ymax, zStart, x, ymax, zEnd);
    verts.push(x, ymin, zStart, x, ymax, zStart);
    verts.push(x, ymin, zEnd,   x, ymax, zEnd);
  }
  for (let z = zStart; z <= zEnd; z += 16) {
    verts.push(xStart, ymin, z, xEnd, ymin, z);
    verts.push(xStart, ymax, z, xEnd, ymax, z);
    verts.push(xStart, ymin, z, xStart, ymax, z);
    verts.push(xEnd,   ymin, z, xEnd,   ymax, z);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const mat = new THREE.LineBasicMaterial({ color: CHUNK_COLOR, transparent: true, opacity: 0.95 });
  return new THREE.LineSegments(geo, mat);
}

// Dynamic helper bounds (Minecraft-like): render a wireframe block grid around the player.
// The radius (in blocks) is controlled by a UI slider.
// We rebuild the helper geometries as the player moves between blocks / vertical bands.
let gridLines = null;
let chunkLines = null;
let helperKey = '';

function getGridRadiusBlocks() {
  // Slider is the source of truth; default keeps prior behavior-ish.
  const r = Math.floor(num(el.gridRadius?.value, 4));
  return clamp(r, 2, 64);
}

function computeHelperBounds(centerX, centerY, centerZ) {
  const r = getGridRadiusBlocks();

  // Anchor bounds to the player's current block so the grid follows you as you move.
  const bx = Math.floor(centerX);
  const bz = Math.floor(centerZ);

  // We draw *edges*, so include one extra unit on the max side.
  const xmin = bx - r;
  const xmax = bx + r + 1;
  const zmin = bz - r;
  const zmax = bz + r + 1;

  // Vertical radius matches horizontal radius (Minecraft-like cube around player).
  const by = Math.floor(centerY);
  const ymin = by - r;
  const ymax = by + r + 1;

  return { xmin, xmax, ymin, ymax, zmin, zmax, by, bx, bz, r };
}

function rebuildHelpers(bounds) {
  if (gridLines) {
    scene.remove(gridLines);
    gridLines.geometry.dispose();
    gridLines.material.dispose();
    gridLines = null;
  }
  if (chunkLines) {
    scene.remove(chunkLines);
    chunkLines.geometry.dispose();
    chunkLines.material.dispose();
    chunkLines = null;
  }

  gridLines = make3DGrid(bounds);
  chunkLines = makeChunkBorders(bounds);
  scene.add(gridLines);
  scene.add(chunkLines);

  // Respect current UI visibility
  syncVisibilityUI();
}

function updateHelpersAroundPlayer(feetPos) {
  const b = computeHelperBounds(feetPos.x, feetPos.y, feetPos.z);
  const key = `${b.bx},${b.bz},${b.by},${b.r}`;
  if (key !== helperKey) {
    helperKey = key;
    rebuildHelpers(b);
  }
}

// --- Precision helpers ---
// Minecraft (Java) uses 32-bit floats for key camera/offset math.
// Emulate float32 rounding with Math.fround so values match "under a microscope".
// (f is defined near the top of the module.)
// Use the same casting order you'd get from Java floats.
const PI_F = f(Math.PI);
const RAD_PER_DEG = f(PI_F / f(180.0));

// Vanilla player eye height (standing). Minecraft uses 1.62 blocks for the camera.
// We use this to optionally let the UI show/accept feet Y (Minecraft F3 "XYZ")
// while the actual camera runs at eye Y.
const EYE_HEIGHT = f(1.62);

let originMarker = null;

// Grass group (created early so UI can toggle visibility before assets load)
let grassGroup = new THREE.Group();
scene.add(grassGroup);

// origin marker
{
const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 0,1.5,0], 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent:true, opacity:0.9 });
    originMarker = new THREE.LineSegments(geo, mat);
  scene.add(originMarker);
}
// Invisible ground plane used for raycasting (y=0). We keep it large and re-center it under the camera.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(512, 512),
  new THREE.MeshBasicMaterial({ visible: false })
);
// PlaneGeometry is XY; rotate to XZ.
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, 0, 0);
scene.add(ground);

// --- UI ---
const el = {
  viewport: document.querySelector('.viewport'),
  progArtToggle: document.getElementById('progArtToggle'),
  msaaToggle: document.getElementById('msaaToggle'),
  mipLevels: document.getElementById('mipLevels'),
  resourcePackFile: document.getElementById('resourcePackFile'),
  resourcePackLoad: document.getElementById('resourcePackLoad'),
  resourcePackUnload: document.getElementById('resourcePackUnload'),
  resourcePackName: document.getElementById('resourcePackName'),
  tpInput: document.getElementById('tpInput'),
  tpGo: document.getElementById('tpGo'),
  tpMsg: document.getElementById('tpMsg'),
  camX: document.getElementById('camX'),
  camY: document.getElementById('camY'),
  useFeetY: document.getElementById('useFeetY'),
  centerTpXZ: document.getElementById('centerTpXZ'),
  camZ: document.getElementById('camZ'),
  yaw: document.getElementById('yaw'),
  pitch: document.getElementById('pitch'),
  fov: document.getElementById('fov'),
  rotate90CW: document.getElementById('rotate90CW'),
  rotate90CCW: document.getElementById('rotate90CCW'),
  rotateMsg: document.getElementById('rotateMsg'),
  oldCamNudge: document.getElementById('oldCamNudge'),
  reallyOldCamNudge: document.getElementById('reallyOldCamNudge'),
  readout: document.getElementById('readout'),

  viewW: document.getElementById('viewW'),
  viewH: document.getElementById('viewH'),
  renderW: document.getElementById('renderW'),
  renderH: document.getElementById('renderH'),
  applyViewSize: document.getElementById('applyViewSize'),
  sizeToOverlay: document.getElementById('sizeToOverlay'),

  overlayFile: document.getElementById('overlayFile'),
  overlayOpacity: document.getElementById('overlayOpacity'),
  grassOpacity: document.getElementById('grassOpacity'),
  showOverlay: document.getElementById('showOverlay'),
  showGrid: document.getElementById('showGrid'),
  gridRadius: document.getElementById('gridRadius'),
  gridRadiusLabel: document.getElementById('gridRadiusLabel'),
  showGrass: document.getElementById('showGrass'),
  showBorder: document.getElementById('showBorder'),

  offX: document.getElementById('offX'),
  offY: document.getElementById('offY'),
  offZ: document.getElementById('offZ'),
  offXRange: document.getElementById('offXRange'),
  offZRange: document.getElementById('offZRange'),
  dripstoneOffsetNote: document.getElementById('dripstoneOffsetNote'),
  centerOffsets: document.getElementById('centerOffsets'),

  selBlockX: document.getElementById('selBlockX'),
  selBlockY: document.getElementById('selBlockY'),
  selBlockZ: document.getElementById('selBlockZ'),

  grassList: document.getElementById('grassList'),
  foliageSelect: document.getElementById('foliageSelect'),
  bambooUvControls: document.getElementById('bambooUvControls'),
  bambooUvU: document.getElementById('bambooUvU'),
  bambooUvV: document.getElementById('bambooUvV'),
  bambooModelSize: document.getElementById('bambooModelSize'),
  variantControls: document.getElementById('variantControls'),
  variantHeight: document.getElementById('variantHeight'),
  dirLabel: document.getElementById('dirLabel'),
  variantDir: document.getElementById('variantDir'),
  propaguleControls: document.getElementById('propaguleControls'),
  propaguleModel: document.getElementById('propaguleModel'),
  cubeControls: document.getElementById('cubeControls'),
  cubeBlockType: document.getElementById('cubeBlockType'),
  cubeTopRotationControls: document.getElementById('cubeTopRotationControls'),
  cubeTopRotateBtn: document.getElementById('cubeTopRotateBtn'),
  cubeTopRotLabel: document.getElementById('cubeTopRotLabel'),
  seagrassFrameControls: document.getElementById('seagrassFrameControls'),
  seagrassFramePrev: document.getElementById('seagrassFramePrev'),
  seagrassFrameNext: document.getElementById('seagrassFrameNext'),
  seagrassFrameLabel: document.getElementById('seagrassFrameLabel'),
  smallDripleafRotationControls: document.getElementById('smallDripleafRotationControls'),
  smallDripleafRotateBtn: document.getElementById('smallDripleafRotateBtn'),
  smallDripleafRotLabel: document.getElementById('smallDripleafRotLabel'),
  exportOffsets: document.getElementById('exportOffsets'),
  exportBox: document.getElementById('exportBox'),
  grassDataIn: document.getElementById('grassDataIn'),
  loadGrassData: document.getElementById('loadGrassData'),
  crackCoords: document.getElementById('crackCoords'),
  crackOut: document.getElementById('crackOut'),
  crackMatchSelect: document.getElementById('crackMatchSelect'),
  crackTpTarget: document.getElementById('crackTpTarget'),
  crackTpIncludeY: document.getElementById('crackTpIncludeY'),
  crackTpOriginY: document.getElementById('crackTpOriginY'),
  crackMakeTp: document.getElementById('crackMakeTp'),
  crackCopyTp: document.getElementById('crackCopyTp'),
  crackApplyCamShift: document.getElementById('crackApplyCamShift'),
  crackTpOut: document.getElementById('crackTpOut'),
  crackTpMsg: document.getElementById('crackTpMsg'),
  crackCenterX: document.getElementById('crackCenterX'),
  crackCenterZ: document.getElementById('crackCenterZ'),
  crackRadius: document.getElementById('crackRadius'),
  crackYMin: document.getElementById('crackYMin'),
  crackYMax: document.getElementById('crackYMax'),
  crackVersion: document.getElementById('crackVersion'),
  matchMode: document.getElementById('matchMode'),
  tolerance: document.getElementById('tolerance'),
  tolVal: document.getElementById('tolVal'),
  warn: document.getElementById('warn'),
  crackStatus: document.getElementById('crackStatus'),
  crackWorkers: document.getElementById('crackWorkers'),
  clearGrass: document.getElementById('clearGrass'),
};

// --- Event Listener Cleanup System ---
// Registry to track all event listeners for proper cleanup (prevents memory leaks)
const eventListenerRegistry = [];

/**
 * Add an event listener and register it for cleanup
 * @param {EventTarget} target - The element to attach the listener to
 * @param {string} event - The event name (e.g., 'click', 'input')
 * @param {Function} handler - The event handler function
 * @param {Object} options - Optional event listener options
 * @returns {Function} cleanup function to remove this specific listener
 */
function addManagedEventListener(target, event, handler, options = false) {
  if (!target) return () => {};
  
  target.addEventListener(event, handler, options);
  
  // Store cleanup info
  const cleanup = () => target.removeEventListener(event, handler, options);
  eventListenerRegistry.push(cleanup);
  
  return cleanup;
}

/**
 * Remove all registered event listeners (call this when cleaning up the app)
 */
function cleanupAllEventListeners() {
  console.log(`Cleaning up ${eventListenerRegistry.length} event listeners...`);
  
  eventListenerRegistry.forEach(cleanup => {
    try {
      cleanup();
    } catch (err) {
      console.warn('Failed to cleanup event listener:', err);
    }
  });
  
  eventListenerRegistry.length = 0; // Clear the array
  console.log('Event listener cleanup complete.');
}

// Expose cleanup function globally for manual cleanup or debugging
window.__cleanupEventListeners = cleanupAllEventListeners;

function num(v, fallback=0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// --- Debounce Utility for Input Performance ---
/**
 * Creates a debounced version of a function that delays execution until after
 * the specified wait time has elapsed since the last call.
 * Perfect for expensive operations triggered by user input (typing, dragging sliders).
 * 
 * @param {Function} func - The function to debounce
 * @param {number} wait - Milliseconds to wait before executing (default: 150ms)
 * @param {boolean} immediate - If true, execute on leading edge instead of trailing
 * @returns {Function} Debounced function with a .cancel() method
 * 
 * @example
 * const debouncedUpdate = debounce(updateCamera, 150);
 * input.addEventListener('input', debouncedUpdate);
 * // User types rapidly → updateCamera only called once, 150ms after they stop
 */
function debounce(func, wait = 150, immediate = false) {
  let timeout;
  
  const debounced = function(...args) {
    const context = this;
    
    const later = () => {
      timeout = null;
      if (!immediate) func.apply(context, args);
    };
    
    const callNow = immediate && !timeout;
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
    
    if (callNow) func.apply(context, args);
  };
  
  // Allow canceling pending execution
  debounced.cancel = () => {
    clearTimeout(timeout);
    timeout = null;
  };
  
  return debounced;
}

// Store debounced functions for cleanup
const debouncedFunctions = new Map();

/**
 * Create and register a debounced function for automatic cleanup
 * @param {string} key - Unique identifier for this debounced function
 * @param {Function} func - The function to debounce
 * @param {number} wait - Milliseconds to wait (default: 150ms)
 * @returns {Function} Debounced function
 */
function createDebounced(key, func, wait = 150) {
  // Cancel any existing debounced function with this key
  if (debouncedFunctions.has(key)) {
    debouncedFunctions.get(key).cancel();
  }
  
  const debounced = debounce(func, wait);
  debouncedFunctions.set(key, debounced);
  return debounced;
}

/**
 * Cancel all pending debounced function calls
 */
function cancelAllDebounced() {
  console.log(`Canceling ${debouncedFunctions.size} debounced functions...`);
  debouncedFunctions.forEach(fn => fn.cancel());
  debouncedFunctions.clear();
}

// Expose for debugging
window.__cancelAllDebounced = cancelAllDebounced;
window.__getDebounceState = () => ({
  count: debouncedFunctions.size,
  keys: Array.from(debouncedFunctions.keys())
});


// --- Cracker match mode UI wiring ---
const matchModeEl = el.matchMode;
const toleranceEl = el.tolerance;
const tolValEl = el.tolVal;
const warnEl = el.warn;
const toleranceRowEl = (toleranceEl && toleranceEl.closest) ? toleranceEl.closest('label.row') : null;

function updateCrackerModeUI() {
  const isStrict = (matchModeEl?.value === 'strict');

  // Strict mode ignores tolerance, so disable the slider to avoid confusion.
  if (toleranceEl) toleranceEl.disabled = isStrict;
  if (toleranceRowEl) toleranceRowEl.classList.toggle('is-disabled', isStrict);

  // Scored-mode warning.
  if (warnEl) warnEl.classList.toggle('hidden', isStrict);
}

if (toleranceEl && tolValEl) {
  tolValEl.textContent = String(toleranceEl.value);
  toleranceEl.oninput = () => { tolValEl.textContent = String(toleranceEl.value); };
}
if (matchModeEl) {
  updateCrackerModeUI();
  matchModeEl.onchange = updateCrackerModeUI;
}

function applyViewportSize(w, h) {
  // This controls the *workspace* (the scrollable render surface), not the fixed on-page viewport.
  const W = clamp(Math.round(num(w, VIEW_W)), 1, 10000);
  const H = clamp(Math.round(num(h, VIEW_H)), 1, 10000);
  VIEW_W = W;
  VIEW_H = H;

  // Resize the scrollable workspace DOM.
  if (scrollArea) {
    scrollArea.style.width = `${W}px`;
    scrollArea.style.height = `${H}px`;
  }

  // Resize renderer drawing buffer + camera aspect to match workspace.
  renderer.setSize(W, H, false);
  camera.aspect = W / H;
  camera.updateProjectionMatrix();

  // Keep the overlay centered.
  if (el.overlayImg) {
    el.overlayImg.style.left = `${W / 2}px`;
    el.overlayImg.style.top  = `${H / 2}px`;
  }
}

// --- Minecraft-style coordinate parsing for /tp-like inputs (1.21.4) ---
// Vanilla command parsing (Vec3Argument -> WorldCoordinates -> WorldCoordinate.parseDouble)
// adds +0.5 to *absolute* X/Z when the token has no '.' (e.g. "10"),
// so you land in the middle of the block. Y is NOT center-corrected.
function parseMcTpAxis(raw, axis, fallback = 0, centerXZEnabled = true) {
  const s = String(raw ?? '').trim();
  if (!s) return fallback;

  // Support a future "~" UI if you ever allow relative inputs.
  if (s.startsWith('~')) {
    const t = s.slice(1);
    const n = t === '' ? 0 : Number(t);
    return Number.isFinite(n) ? n : fallback;
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return fallback;

  const centerCorrect = centerXZEnabled && (axis === 'x' || axis === 'z');
  const hasDot = s.includes('.');
  if (centerCorrect && !hasDot) return n + 0.5;
  return n;
}

function formatMcNumber(n) {
  // Prefer clean integers when possible (e.g. "1" instead of "1.000").
  const r = Math.round(n);
  if (Math.abs(n - r) < 1e-9) return String(r);
  // Keep a stable, readable precision.
  return n.toFixed(3);
}

function nearlyInt(n, eps = 1e-9) {
  return Math.abs(n - Math.round(n)) < eps;
}

function fmt(n) {
  // Show integers without decimals; otherwise show 3 decimals like the readout.
  return nearlyInt(n) ? String(Math.round(n)) : n.toFixed(3);
}

// --- /tp helper (teleport camera by pasting a Minecraft-style /tp command) ---
function setTpMsg(text, isError = false) {
  if (!el.tpMsg) return;
  el.tpMsg.textContent = String(text ?? '');
  el.tpMsg.classList.toggle('tp-error', Boolean(isError));
}

function parseTpCommand(raw) {
  const s = String(raw ?? '').replace(/\u00a0/g, ' ').trim();
  if (!s) return { error: 'Enter a /tp command.' };

  const parts = s.split(/\s+/);
  if (parts.length === 0) return { error: 'Enter a /tp command.' };

  const head = (parts[0] ?? '').toLowerCase();
  if (head === '/tp' || head === 'tp') {
    parts.shift();
  } else {
    return { error: 'Expected a command starting with /tp.' };
  }

  if (parts.length < 3) {
    return { error: 'Expected: /tp [target] <x> <y> <z> [yaw] [pitch]' };
  }

  // Accept optional target selectors/playernames by skipping one leading non-number token.
  let i = 0;
  if (!Number.isFinite(Number(parts[0]))) i = 1;
  if (parts.length < i + 3) return { error: 'Expected coordinates: x y z' };

  const x = Number(parts[i]);
  const y = Number(parts[i + 1]);
  const z = Number(parts[i + 2]);
  if (![x, y, z].every(Number.isFinite)) return { error: 'Invalid x/y/z in /tp command.' };

  let yaw = null;
  let pitch = null;

  if (parts.length >= i + 5) {
    yaw = Number(parts[i + 3]);
    pitch = Number(parts[i + 4]);
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return { error: 'Invalid yaw/pitch in /tp command.' };
  } else if (parts.length === i + 4) {
    yaw = Number(parts[i + 3]);
    if (!Number.isFinite(yaw)) return { error: 'Invalid yaw in /tp command.' };
  }

  return { x, y, z, yaw, pitch };
}

function teleportFromTpInput() {
  const parsed = parseTpCommand(el.tpInput?.value);
  if (parsed?.error) {
    setTpMsg(parsed.error, true);
    return;
  }

  // Minecraft /tp uses entity position (feet). Map into the current Y input mode.
  const feetMode = Boolean(el.useFeetY?.checked);
  const yForUI = feetMode ? parsed.y : (parsed.y + EYE_HEIGHT);

  el.camX.value = formatMcNumber(parsed.x);
  el.camY.value = formatMcNumber(yForUI);
  el.camZ.value = formatMcNumber(parsed.z);
  if (parsed.yaw !== null) el.yaw.value = formatMcNumber(parsed.yaw);
  if (parsed.pitch !== null) el.pitch.value = formatMcNumber(parsed.pitch);

  updateCameraFromUI();
  setTpMsg(`Teleported to ${formatMcNumber(parsed.x)} ${formatMcNumber(parsed.y)} ${formatMcNumber(parsed.z)}`, false);
}

// Overlay image state (drawn into the compositor canvas, never scaled)
// NOTE: We allow several CanvasImageSource types here (HTMLImageElement / HTMLCanvasElement / ImageBitmap).
let overlayImage = null; // CanvasImageSource
let overlayImageW = 0;
let overlayImageH = 0;
let overlayOpacity = 1;
let overlayVisible = true;

function overlayHasImage(){ return !!overlayImage && overlayImageW > 0 && overlayImageH > 0; }

function setOverlayImage(src, w, h){
  overlayImage = src;
  overlayImageW = Math.max(0, Math.trunc(Number(w) || 0));
  overlayImageH = Math.max(0, Math.trunc(Number(h) || 0));
  try { requestRender(); } catch (_) {}
}

// Minimal BMP decoder (uncompressed 24/32-bit). Used as a fallback when the browser can't decode BMP.
function decodeBmpToCanvas(buf){
  const dv = new DataView(buf);
  if (dv.byteLength < 54) throw new Error('BMP file is too small.');
  const sig = String.fromCharCode(dv.getUint8(0), dv.getUint8(1));
  if (sig !== 'BM') throw new Error('Not a BMP file.');

  const pixelOffset = dv.getUint32(10, true);
  const dibSize = dv.getUint32(14, true);
  if (dibSize < 40) throw new Error('Unsupported BMP header.');

  const width = dv.getInt32(18, true);
  const heightSigned = dv.getInt32(22, true);
  const planes = dv.getUint16(26, true);
  const bpp = dv.getUint16(28, true);
  const compression = dv.getUint32(30, true);

  if (planes !== 1) throw new Error('Unsupported BMP planes.');
  if (compression !== 0) throw new Error('Compressed BMP is not supported.');
  if (!(bpp === 24 || bpp === 32)) throw new Error(`Unsupported BMP bit depth (${bpp}). Use a 24-bit or 32-bit BMP.`);
  if (!(width > 0)) throw new Error('Invalid BMP width.');

  const height = Math.abs(heightSigned);
  const topDown = heightSigned < 0;
  const bytesPerPixel = bpp >> 3;
  const rowBytes = Math.floor((bpp * width + 31) / 32) * 4; // rows padded to 4 bytes
  const needed = pixelOffset + rowBytes * height;
  if (dv.byteLength < needed) throw new Error('Truncated BMP pixel data.');

  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++){
    const srcY = topDown ? y : (height - 1 - y);
    const rowStart = pixelOffset + srcY * rowBytes;
    for (let x = 0; x < width; x++){
      const src = rowStart + x * bytesPerPixel;
      const dst = (y * width + x) * 4;
      const b = dv.getUint8(src);
      const g = dv.getUint8(src + 1);
      const r = dv.getUint8(src + 2);
      const a = (bytesPerPixel === 4) ? dv.getUint8(src + 3) : 255;
      out[dst] = r;
      out[dst + 1] = g;
      out[dst + 2] = b;
      out[dst + 3] = a;
    }
  }

  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(out, width, height), 0, 0);
  return c;
}

async function loadOverlayFromFile(file){
  const name = String(file?.name || '');
  const isBmp = /\.bmp$/i.test(name) || String(file?.type || '') === 'image/bmp';

  // 1) Try browser decoding first (works for PNG/JPEG and often BMP too).
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed.')); };
    im.src = url;
  }).catch(async (e) => {
    // 2) If it's BMP, fall back to a small decoder.
    if (!isBmp) throw e;
    const buf = await file.arrayBuffer();
    const c = decodeBmpToCanvas(buf);
    return c;
  });

  // Determine dimensions across source types.
  const w = (img && 'naturalWidth' in img) ? img.naturalWidth : (img?.width || 0);
  const h = (img && 'naturalHeight' in img) ? img.naturalHeight : (img?.height || 0);
  return { src: img, w, h };
}

// Grass overlay opacity (applies to the in-viewport grass planes)
let grassOpacity = 1.0;

// Materials are created later (after textures load). We declare handles here so
// we can safely update opacity from UI event handlers.
// (Historical) this tool started with a single grass material.
// Now we cache per-foliage materials in ensureFoliageMats().

function syncOverlayUI(){
  overlayOpacity = clamp(num(el.overlayOpacity?.value, 1), 0, 1);
  overlayVisible = Boolean(el.showOverlay?.checked);
  try { requestRender(); } catch (_) {}
}

function syncGrassOpacityUI(){
  grassOpacity = clamp(num(el.grassOpacity?.value, 1.0), 0, 1);

  // Apply to all cached foliage materials.
  for (const mats of foliageMatCache?.values?.() ?? []) {
    if (mats.model === 'double') {
      for (const m of [mats.baseBottom, mats.baseTop, mats.selectedBottom, mats.selectedTop]) {
        if (m) { m.opacity = grassOpacity; m.transparent = (grassOpacity < 1); }
      }
      for (const m of [mats.placementBottom, mats.placementTop]) {
        if (m) { m.opacity = clamp(grassOpacity * 0.65, 0, 1); m.transparent = true; }
      }
    } else {
      for (const m of [mats.base, mats.selected]) {
        if (m) { m.opacity = grassOpacity; m.transparent = (grassOpacity < 1); }
      }
      if (mats.placement) {
        mats.placement.opacity = clamp(grassOpacity * 0.65, 0, 1);
        mats.placement.transparent = true;
      }
    }
  }

  // Apply to any block-cube template materials (e.g., grass block cube).
  for (const mats of blockCubeMatCache?.values?.() ?? []) {
    if (!mats) continue;
    if (mats.base) { mats.base.opacity = grassOpacity; mats.base.transparent = (grassOpacity < 1); }
    if (mats.placement) { mats.placement.opacity = clamp(grassOpacity * 0.65, 0, 1); mats.placement.transparent = true; }
  }
  try { requestRender(); } catch (_) {}
}


function syncGridRadiusUI(){
  if (!el.gridRadiusLabel || !el.gridRadius) return;
  el.gridRadiusLabel.textContent = String(Math.floor(num(el.gridRadius.value, 4)));
}

function syncGridUI(){
  const on = Boolean(el.showGrid?.checked);
  gridLines.visible = on;
  chunkLines.visible = on;
  try { requestRender(); } catch (_) {}
}

function syncSceneVisUI(){
  // "Grid" here means the line helpers (grid + chunk borders).
  const showGrid = Boolean(el.showGrid?.checked);
  gridLines.visible = showGrid;
  chunkLines.visible = showGrid;

  const showGrass = Boolean(el.showGrass?.checked);
  if (grassGroup) grassGroup.visible = showGrass;
  try { requestRender(); } catch (_) {}
}

function syncVisibilityUI(){
  // "Grid" in the GUI means all line helpers (grid + chunk borders + origin marker).
  const gridVisible = Boolean(el.showGrid?.checked);
  gridLines.visible = gridVisible;
  chunkLines.visible = gridVisible;
  // origin marker is the 3rd object added after the grid/chunk (see below). We keep a reference.
  if (originMarker) originMarker.visible = gridVisible;

  if (grassGroup) grassGroup.visible = Boolean(el.showGrass?.checked);
  try { requestRender(); } catch (_) {}
}

// Use managed event listeners to enable proper cleanup
addManagedEventListener(el.overlayOpacity, 'input', syncOverlayUI);
addManagedEventListener(el.grassOpacity, 'input', () => {
  syncGrassOpacityUI();
  try { syncSpecialModelOpacity(); } catch (_) { /* placement mode not initialized yet */ }
});
addManagedEventListener(el.showOverlay, 'change', syncOverlayUI);
addManagedEventListener(el.showBorder, 'change', () => { try { requestRender(); } catch (_) {} });
addManagedEventListener(window, 'resize', () => { try { requestRender(); } catch (_) {} });
addManagedEventListener(el.gridRadius, 'input', () => {
  syncGridRadiusUI();
  // Rebuild helpers around the current camera position.
  // (updateCameraFromUI() calls updateHelpersAroundPlayer internally.)
  updateCameraFromUI();
});
addManagedEventListener(el.showGrid, 'change', syncGridUI);
addManagedEventListener(el.showGrid, 'change', syncSceneVisUI);
addManagedEventListener(el.showGrass, 'change', syncSceneVisUI);
addManagedEventListener(el.showGrid, 'change', syncVisibilityUI);
addManagedEventListener(el.showGrass, 'change', syncVisibilityUI);
addManagedEventListener(el.centerTpXZ, 'change', updateCameraFromUI);
addManagedEventListener(el.overlayFile, 'change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const { src, w, h } = await loadOverlayFromFile(file);
    setOverlayImage(src, w, h);

    // Auto-match workspace + render resolution to the loaded image.
    if (w > 0 && h > 0) {
      if (el.viewW) el.viewW.value = String(w);
      if (el.viewH) el.viewH.value = String(h);
      if (el.renderW) el.renderW.value = String(w);
      if (el.renderH) el.renderH.value = String(h);
      applyWorkspaceAndRenderSize(w, h, w, h);
    }
    syncOverlayUI();
  } catch (err) {
    console.error(err);
    alert(`Failed to load overlay image.\n\n${String(err?.message || err)}`);
  }
});

// Workspace + render sizing
if (el.viewW) el.viewW.value = String(VIEW_W);
if (el.viewH) el.viewH.value = String(VIEW_H);
if (el.renderW) el.renderW.value = String(RENDER_W);
if (el.renderH) el.renderH.value = String(RENDER_H);

function applyWorkspaceAndRenderSize(workW, workH, renW, renH) {
  const w = clamp(Math.round(Number(workW) || VIEW_W), 1, 10000);
  const h = clamp(Math.round(Number(workH) || VIEW_H), 1, 10000);
  const rw = clamp(Math.round(Number(renW) || RENDER_W), 1, 10000);
  const rh = clamp(Math.round(Number(renH) || RENDER_H), 1, 10000);

  VIEW_W = w;
  VIEW_H = h;
  RENDER_W = rw;
  RENDER_H = rh;

  // Keep pan center inside bounds and default to centering the workspace.
  centerX = VIEW_W / 2;
  centerY = VIEW_H / 2;
  roundedCenterX = centerX;
  roundedCenterY = centerY;

  if (el.viewW) el.viewW.value = String(VIEW_W);
  if (el.viewH) el.viewH.value = String(VIEW_H);
  if (el.renderW) el.renderW.value = String(RENDER_W);
  if (el.renderH) el.renderH.value = String(RENDER_H);

  resizeWebGL();
  try { requestRender(); } catch (_) {}
}

addManagedEventListener(el.applyViewSize, 'click', () => {
  applyWorkspaceAndRenderSize(el.viewW?.value, el.viewH?.value, el.renderW?.value, el.renderH?.value);
});

// Convenience: set workspace and render size to the currently loaded overlay image dimensions.
addManagedEventListener(el.sizeToOverlay, 'click', () => {
  const iw = overlayImageW || 0;
  const ih = overlayImageH || 0;
  if (iw > 0 && ih > 0) {
    if (el.viewW) el.viewW.value = String(iw);
    if (el.viewH) el.viewH.value = String(ih);
    if (el.renderW) el.renderW.value = String(iw);
    if (el.renderH) el.renderH.value = String(ih);
    applyWorkspaceAndRenderSize(iw, ih, iw, ih);
  }
});

// Initial sync
applyWorkspaceAndRenderSize(VIEW_W, VIEW_H, RENDER_W, RENDER_H);
syncOverlayUI();
syncGrassOpacityUI();

// --- Pan/zoom inside the fixed 960x540 viewport canvas ---
let leftDown = false;
let leftDownClientX = 0;
let leftDownClientY = 0;
let leftDownWorldX = 0;
let leftDownWorldY = 0;
let didPanDrag = false;

// Treat a tiny mouse wobble as a click, not a pan.
const PAN_DRAG_THRESHOLD_PX = 3;

function offsetToWorkspaceX(offsetX) {
  return (offsetX - viewCanvas.clientWidth / 2) / zoom + centerX;
}
function offsetToWorkspaceY(offsetY) {
  return (offsetY - viewCanvas.clientHeight / 2) / zoom + centerY;
}
function setOffsetWorkspacePos(offsetX, offsetY, worldX, worldY) {
  centerX = worldX - (offsetX - viewCanvas.clientWidth / 2) / zoom;
  centerY = worldY - (offsetY - viewCanvas.clientHeight / 2) / zoom;
  roundedCenterX = Math.round(centerX * zoom) / zoom;
  roundedCenterY = Math.round(centerY * zoom) / zoom;
  try { requestRender(); } catch (_) {}
}

addManagedEventListener(viewCanvas, 'mousedown', (event) => {
  // Left-click drag pans the workspace.
  if (event.button !== 0) return;
  leftDown = true;
  didPanDrag = false;
  leftDownClientX = event.clientX;
  leftDownClientY = event.clientY;
  leftDownWorldX = offsetToWorkspaceX(event.offsetX);
  leftDownWorldY = offsetToWorkspaceY(event.offsetY);
  event.preventDefault();
});
addManagedEventListener(viewCanvas, 'mousemove', (event) => {
  if (!leftDown) return;
  if (!didPanDrag) {
    const dx = Math.abs(event.clientX - leftDownClientX);
    const dy = Math.abs(event.clientY - leftDownClientY);
    if (dx + dy >= PAN_DRAG_THRESHOLD_PX) didPanDrag = true;
  }
  if (!didPanDrag) return;
  setOffsetWorkspacePos(event.offsetX, event.offsetY, leftDownWorldX, leftDownWorldY);
  event.preventDefault();
});

// If the mouse is released outside the canvas, stop any in-progress pan.
addManagedEventListener(window, 'mouseup', () => { leftDown = false; didPanDrag = false; });

addManagedEventListener(viewCanvas, 'wheel', (event) => {
  event.preventDefault();
  // Zoom around cursor (like local-overlay). One wheel tick ~ +/-1 zoom index.
  // If we're not actively panning, refresh the zoom anchor to the current cursor.
  if (!leftDown || !didPanDrag) {
    leftDownWorldX = offsetToWorkspaceX(event.offsetX);
    leftDownWorldY = offsetToWorkspaceY(event.offsetY);
  }
  zoomIndex = clamp(zoomIndex + Math.round(-event.deltaY / 100), -6, 6);
  zoom = Math.pow(2, zoomIndex);
  setOffsetWorkspacePos(event.offsetX, event.offsetY, leftDownWorldX, leftDownWorldY);
}, { passive: false });

function updateCameraFromUI(){
  // Match Minecraft /tp integer behavior (optional): X/Z integers land at .5 (block center), Y does not.
  const centerXZ = Boolean(el.centerTpXZ?.checked);
  const x = parseMcTpAxis(el.camX.value, 'x', 0, centerXZ);
  const yInput = parseMcTpAxis(el.camY.value, 'y', 0, centerXZ);
  const z = parseMcTpAxis(el.camZ.value, 'z', 0, centerXZ);
  const yaw = num(el.yaw.value);
  const pitch = clamp(num(el.pitch.value), -90, 90);
  const fov = clamp(num(el.fov.value, 70), 1, 179);

  const feetMode = Boolean(el.useFeetY?.checked);
  const yEye = feetMode ? (yInput + EYE_HEIGHT) : yInput;

  camera.fov = fov;
  camera.updateProjectionMatrix();

  const forward = mcForwardFromYawPitch(yaw, pitch);
  const useOldNudge = Boolean(el.oldCamNudge?.checked);
  const useReallyOldNudge = Boolean(el.reallyOldCamNudge?.checked);
  const nudge = useReallyOldNudge ? -0.10 : (useOldNudge ? 0.05 : 0.0);

  // Old Minecraft (e.g. 1.11) first-person rendering nudges the view forward by +0.05 in view direction.
  // Emulate that here when requested so overlays match older screenshots.
  // Match Java's float32 rounding for camera math.
  const xF = f(x);
  const yEyeF = f(yEye);
  const zF = f(z);
  const nudgeF = f(nudge);

  const camPos = new THREE.Vector3(
    f(xF + f(forward.x * nudgeF)),
    f(yEyeF + f(forward.y * nudgeF)),
    f(zF + f(forward.z * nudgeF))
  );

  camera.position.copy(camPos);

  // Match Minecraft's render-camera rotation pipeline (no lookAt).
  // This prevents tiny basis differences that can manifest as distance-amplified drift.
  mcSetCameraQuaternion(camera, yaw, pitch);

  if (feetMode) {
    const yFeet = yInput;
    el.readout.textContent =
`Minecraft-style camera
pos   = (${x.toFixed(3)}, ${yEye.toFixed(3)}, ${z.toFixed(3)})   [eye]
feet  = (${x.toFixed(3)}, ${yFeet.toFixed(3)}, ${z.toFixed(3)})
yaw   = ${yaw.toFixed(3)} deg   (0=+Z/south, -90=+X/east)
pitch = ${pitch.toFixed(3)} deg (+=down, -=up)
fov   = ${fov.toFixed(3)} deg   (vertical)
old nudge = ${useOldNudge ? '+0.05' : 'off'}
really old nudge = ${useReallyOldNudge ? '-0.10' : 'off'}`;
  } else {
    el.readout.textContent =
`Minecraft-style camera
pos   = (${x.toFixed(3)}, ${yEye.toFixed(3)}, ${z.toFixed(3)})   [blocks]
yaw   = ${yaw.toFixed(3)} deg   (0=+Z/south, -90=+X/east)
pitch = ${pitch.toFixed(3)} deg (+=down, -=up)
fov   = ${fov.toFixed(3)} deg   (vertical)
old nudge = ${useOldNudge ? '+0.05' : 'off'}
really old nudge = ${useReallyOldNudge ? '-0.10' : 'off'}`;
  }

  // Keep helper visuals centered around the player (3x3 chunks) and prevent the grid/borders from stopping at +/-32.
  // These helpers don't exist in vanilla, but they *do* depend on camera position.
  // Round to float32 so boundary-sensitive behavior (e.g. when you're right on a block edge)
  // stays consistent with the rest of the float32 camera pipeline.
  const feetY = feetMode ? yInput : (yEye - EYE_HEIGHT);
  const feetYF = f(feetY);

  updateHelpersAroundPlayer(new THREE.Vector3(xF, feetYF, zF));
  ground.position.set(xF, 0, zF);
  try { requestRender(); } catch (_) {}
}

function syncCamYDisplayToMode() {
  const feetMode = Boolean(el.useFeetY?.checked);
  const yEye = camera.position.y;
  const yDisplay = feetMode ? (yEye - EYE_HEIGHT) : yEye;
  el.camY.value = fmt(yDisplay);
}

function __wrapYawDeg(y){
  // Keep yaw in (-180..180] like Minecraft does.
  if (!Number.isFinite(y)) return 0;
  y = ((y % 360) + 360) % 360;
  if (y > 180) y -= 360;
  return y;
}

function __setRotateMsg(text, isError=false){
  if (!el.rotateMsg) return;
  el.rotateMsg.textContent = String(text ?? '');
  el.rotateMsg.classList.toggle('tp-error', Boolean(isError));
}

function __rotateXZ90About(x, z, px, pz, dir){
  const dx = x - px;
  const dz = z - pz;
  // dir=+1: yaw+90 (CW button) -> position rotation that keeps view identical.
  // dir=-1: yaw-90 (CCW button)
  if (dir >= 0) return { x: px - dz, z: pz + dx };
  return { x: px + dz, z: pz - dx };
}

function __rotateCameraAndOffsets90(dir=+1){
  try {
    const centerXZ = Boolean(el.centerTpXZ?.checked);
    const x0 = parseMcTpAxis(el.camX?.value, 'x', 0, centerXZ);
    const z0 = parseMcTpAxis(el.camZ?.value, 'z', 0, centerXZ);
    const yaw0 = num(el.yaw?.value, 0);

    // Rotate around the *center of the block the camera is currently in*.
    // This keeps block coordinates integral after rotation and matches Minecraft's mental model.
    const px = Math.floor(x0) + 0.5;
    const pz = Math.floor(z0) + 0.5;

    const camR = __rotateXZ90About(x0, z0, px, pz, dir);
    const yaw1 = __wrapYawDeg(yaw0 + (dir >= 0 ? 90 : -90));

    // Update camera inputs with high precision and avoid vanilla integer-centering quirks.
    if (el.camX) el.camX.value = __formatTpToken(camR.x, 'x');
    if (el.camZ) el.camZ.value = __formatTpToken(camR.z, 'z');
    if (el.yaw)  el.yaw.value  = __formatAngle(yaw1);

    // Rotate all placed textures so the on-screen view stays identical.
    // NOTE: grasses/occupiedByBlock are declared later in the file, but exist by the time the user clicks.
    if (typeof grasses !== 'undefined' && grasses && grasses.values) {
      try { occupiedByBlock?.clear?.(); } catch (_) {}

      for (const g of grasses.values()) {
        if (!g || !g.block || !g.off) continue;

        // Rotate the *block center* so the result stays on the integer block grid.
        const bcx = (g.block.x + 0.5);
        const bcz = (g.block.z + 0.5);
        const br = __rotateXZ90About(bcx, bcz, px, pz, dir);
        const bx2 = Math.floor(br.x);
        const bz2 = Math.floor(br.z);
        g.block.x = bx2;
        g.block.z = bz2;

        // Rotate the 0..15 offset nibbles. Horizontal axes swap; one axis flips.
        const ox = clampInt(Math.floor(g.off.x), 0, 15);
        const oz = clampInt(Math.floor(g.off.z), 0, 15);
        if (dir >= 0) {
          g.off.x = 15 - oz;
          g.off.z = ox;
        } else {
          g.off.x = oz;
          g.off.z = 15 - ox;
        }

        // Oriented foliage: keep orientation consistent in the rotated coordinate system.
        if (g.kind === 'SMALL_DRIPLEAF') {
          const r0 = clampRotSteps4(g.variant?.rot ?? 0);
          const step = (dir >= 0) ? 1 : 3; // -1 mod 4
          const r1 = (r0 + step) % 4;
          g.variant = g.variant || {};
          g.variant.rot = r1;
          try { applySmallDripleafTopRotation(g.mesh, r1); } catch (_) {}
        }

        try { updateGrassMeshTransform(g); } catch (_) {}

        try {
          const k = keyForBlock(g.block);
          occupiedByBlock?.set?.(k, g.id);
        } catch (_) {}
      }

      try { refreshGrassList(); } catch (_) {}
    }

    updateCameraFromUI();

    const dirLabel = (dir >= 0) ? 'CW (+90 yaw)' : 'CCW (-90 yaw)';
    __setRotateMsg(`Rotated ${dirLabel} around block (${Math.floor(x0)}, ${Math.floor(z0)}).`, false);
  } catch (e) {
    console.error(e);
    __setRotateMsg(String(e?.message || e), true);
  }
}


// /tp UI wiring
el.rotate90CW?.addEventListener('click', () => __rotateCameraAndOffsets90(+1));
el.rotate90CCW?.addEventListener('click', () => __rotateCameraAndOffsets90(-1));

el.tpGo?.addEventListener('click', teleportFromTpInput);
el.tpInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    teleportFromTpInput();
  }
});
el.tpInput?.addEventListener('input', () => {
  // Clear stale errors as the user edits.
  if ((el.tpMsg?.textContent ?? '') && el.tpMsg?.classList?.contains('tp-error')) setTpMsg('', false);
});

// Debounce camera updates for better performance during rapid input changes
const debouncedCameraUpdate = createDebounced('cameraUpdate', updateCameraFromUI, 100);

for (const k of ['camX','camY','camZ','yaw','pitch','fov']) {
  el[k].addEventListener('input', debouncedCameraUpdate);
}

el.oldCamNudge?.addEventListener('change', () => {
  if (el.oldCamNudge.checked && el.reallyOldCamNudge) el.reallyOldCamNudge.checked = false;
  updateCameraFromUI();
});
el.reallyOldCamNudge?.addEventListener('change', () => {
  if (el.reallyOldCamNudge.checked && el.oldCamNudge) el.oldCamNudge.checked = false;
  updateCameraFromUI();
});

el.useFeetY?.addEventListener('change', () => {
  // Preserve the *current* perceived value when flipping modes.
  // If switching to feet mode, convert the input from eye->feet.
  // If switching to eye mode, convert the input from feet->eye.
  const yRaw = num(el.camY.value, 0);
  if (el.useFeetY.checked) {
    // was eye, becomes feet
    el.camY.value = fmt(yRaw - EYE_HEIGHT);
  } else {
    // was feet, becomes eye
    el.camY.value = fmt(yRaw + EYE_HEIGHT);
  }
  updateCameraFromUI();
  syncCamYDisplayToMode();
});

updateCameraFromUI();
syncCamYDisplayToMode();
syncOverlayUI();
syncGridRadiusUI();
syncGridUI();
syncSceneVisUI();


// --- Grass model (MC block-model JSON) ---
// grassGroup already created above.

function syncGrassUI(){
  const on = Boolean(el.showGrass?.checked);
  grassGroup.visible = on;
  try { requestRender(); } catch (_) {}
}

el.showGrass.addEventListener('change', syncGrassUI);
syncGrassUI();

// Shared materials/geometry
// Two textures (same model + same 0-15 offsets). Switch with keyboard:
//   1 = Jappa (modern)
//   2 = Programmer Art
const texIndicatorEl = document.getElementById('texIndicator');

function syncTexIndicator(){
  if (texIndicatorEl) texIndicatorEl.textContent = `Grass texture: ${useProgrammerArt ? 'Programmer Art' : 'Jappa'}`;
  if (el.progArtToggle) el.progArtToggle.checked = useProgrammerArt;
}

if (el.progArtToggle){
  el.progArtToggle.addEventListener('change', async () => {
    useProgrammerArt = Boolean(el.progArtToggle.checked);
    syncTexIndicator();
    try { await safeRefreshAllFoliageTextures(); } catch (e) { console.warn('Failed to refresh textures', e); }
  });
}
syncTexIndicator();



function syncMsaaToggle(){
  if (el.msaaToggle) el.msaaToggle.checked = useMSAA;
}

if (el.msaaToggle){
  el.msaaToggle.addEventListener('change', () => {
    useMSAA = Boolean(el.msaaToggle.checked);
    rebuildRenderer();
  });
}
syncMsaaToggle();

// --- Resource pack UI wiring ---
let resourcePackLoading = false;

function syncResourcePackUI(){
  const on = !!activeResourcePack;
  if (el.resourcePackUnload) el.resourcePackUnload.classList.toggle('hidden', !on);
  if (el.resourcePackName) {
    el.resourcePackName.classList.toggle('hidden', !on);
    el.resourcePackName.textContent = on ? String(activeResourcePack.name || 'resource_pack.zip').replace(/\.zip$/i, '') : '';
  }
  if (el.resourcePackLoad) el.resourcePackLoad.textContent = on ? 'Replace pack' : 'Load resource pack';

  // When a custom pack is loaded, it fully overrides textures; keep the Programmer Art toggle disabled.
  if (el.progArtToggle) {
    el.progArtToggle.disabled = on;
    if (on) {
      el.progArtToggle.checked = false;
      useProgrammerArt = false;
    }
  }
}

function disposeCachedTextures(){
  for (const cache of [textureCacheMipped, textureCacheNoMips]) {
    for (const v of cache.values()) {
    try {
      // v can be a Promise during streaming.
      if (v && typeof v.then !== 'function' && v !== PLACEHOLDER_TEX_NO_MIP && v !== PLACEHOLDER_TEX_MIP && v !== PLACEHOLDER_TEX && v.dispose) v.dispose();
    } catch (_) {}
    }
  }
  textureCacheMipped.clear();
  textureCacheNoMips.clear();
}

function resetAssetCachesForPackSwitch(){
  try { disposeCachedTextures(); } catch (_) {}
  try { modelJsonCache.clear(); } catch (_) {}
  try { resolvedModelJsonCache.clear(); } catch (_) {}

  // Re-seed local model overrides (used as fallbacks when a pack doesn't include them).
  try {
    modelJsonCache.set('mangrove_propagule', Promise.resolve(LOCAL_MANGROVE_PROPAGULE_GROUND_MODEL));
    modelJsonCache.set('template_seagrass', Promise.resolve(LOCAL_TEMPLATE_SEAGRASS_MODEL));
  } catch (_) {}
}

function disposeMeshGeometries(root){
  if (!root) return;
  root.traverse(o => {
    try { if (o.isMesh && o.geometry && o.geometry.dispose) o.geometry.dispose(); } catch (_) {}
  });
}

function rebuildAllPlacedGrassMeshes(){
  // Defensive: grasses/grassGroup may not exist yet during early boot.
  try {
    if (typeof grasses === 'undefined' || !grasses || typeof grassGroup === 'undefined' || !grassGroup) return;
  } catch (_) { return; }

  const keepSelected = (typeof selectedId !== 'undefined') ? selectedId : null;

  // Remove existing meshes.
  for (const g of grasses.values()) {
    if (!g || !g.mesh) continue;
    try { grassGroup.remove(g.mesh); } catch (_) {}
    try { disposeMeshGeometries(g.mesh); } catch (_) {}
    g.mesh = null;
  }

  // Rebuild meshes using current materials + current model/texture sources.
  for (const g of grasses.values()) {
    if (!g) continue;
    let mesh = null;
    const kind = String(g.kind || 'SHORT_GRASS');

    try {
      if (kind === 'CUBE') {
        const cmats = ensureCubeMats();
        const t = String(g.cubeType || 'GRASS_BLOCK');
        const modelName = ensureCubeModelRegistered(t, g.cubeTopRot ?? 0);
        mesh = makeAsyncMinecraftModelMesh(modelName, cmats.base, { perFaceMaterials: true });
      } else if (kind === 'BAMBOO') {
        const mats = ensureFoliageMats(kind);
        const h = Math.max(1, Math.min(16, Math.trunc(g.variant?.height ?? 1)));
        mesh = makeBambooMesh(mats.base, h);
      } else if (kind === 'POINTED_DRIPSTONE') {
        const mats = ensureFoliageMats(kind);
        const h = Math.max(1, Math.min(16, Math.trunc(g.variant?.height ?? 1)));
        const dir = String(g.variant?.dir || 'up');
        mesh = makeDripstoneStackMesh(mats.base, h, dir, { preview: false });
      } else if (kind === 'MANGROVE_PROPAGULE') {
        const v = String(g.propaguleModel || 'ground');
        const pmats = ensurePropaguleMats(v);
        const modelName = propaguleModelToBlockModelName(v);
        mesh = makeAsyncMinecraftModelMesh(modelName, pmats.base);
      } else if (kind === 'SUNFLOWER') {
        const mats = ensureFoliageMats(kind);
        mesh = makeSunflowerDoubleMesh(mats.baseBottom, mats.baseTop);
      } else if (kind === 'PITCHER_PLANT') {
        const mats = ensureFoliageMats(kind);
        mesh = makePitcherPlantDoubleMesh(mats.baseBottom, mats.baseTop);
      } else if (kind === 'TALL_SEAGRASS') {
        const mats = ensureFoliageMats(kind);
        mesh = makeTallSeagrassDoubleMesh(mats.baseBottom, mats.baseTop);
      } else {
        const mats = ensureFoliageMats(kind);
        if (mats && mats.model === 'double') mesh = makeTallGrassMesh(mats.baseBottom, mats.baseTop);
        else mesh = makeGrassMesh(mats.base);
      }
    } catch (e) {
      console.warn('[Resource Pack] Failed to rebuild mesh for', g, e);
      try {
        const mats = ensureFoliageMats('SHORT_GRASS');
        mesh = makeGrassMesh(mats.base);
      } catch (_) {
        mesh = new THREE.Group();
      }
    }

    if (!mesh) mesh = new THREE.Group();
    mesh.userData.__grassId = g.id;
    g.mesh = mesh;
    grassGroup.add(mesh);
    try { updateGrassMeshTransform(g); } catch (_) {}
  }

  // Re-apply selection tint.
  try { if (keepSelected != null) setSelected(keepSelected); } catch (_) {}

  // Placement preview (if any) must also be rebuilt to pick up new models/textures.
  try {
    if (typeof placementPreview !== 'undefined' && placementPreview) {
      placementPreview.userData.__previewKey = '__forcePack__' + Math.random();
      ensurePlacementPreview();
      if (!placementMode && placementPreview) placementPreview.visible = false;
      if (placementMode && placementPreview) {
        const off = offsetToVec3ForKind(activeFoliageId, placementOff.x, placementOff.y, placementOff.z);
        placementPreview.position.set(placementBlock.x + off.x, placementBlock.y + off.y, placementBlock.z + off.z);
        updatePlacementPreviewBlockedState();
      }
    }
  } catch (_) {}
}

async function applyResourcePackSwitch(){
  resetAssetCachesForPackSwitch();
  try { await safeRefreshAllFoliageTextures(); } catch (_) {}
  try { rebuildAllPlacedGrassMeshes(); } catch (_) {}
  try { syncSpecialModelOpacity(); } catch (_) {}
  try { requestRender(); } catch (_) {}
}

async function handleResourcePackFile(file){
  if (!file) return;
  if (resourcePackLoading) return;
  resourcePackLoading = true;
  syncResourcePackUI();
  try {
    const rp = await loadResourcePackZip(file);
    if (!rp) throw new Error('No resource pack data');
    if ((rp.textures?.size || 0) === 0 && (rp.models?.size || 0) === 0) {
      console.warn('[Resource Pack] Zip contained no usable assets (assets/minecraft/textures or models).');
    }
    setActiveResourcePack(rp);
    useProgrammerArt = false;
    if (el.progArtToggle) el.progArtToggle.checked = false;
    syncResourcePackUI();
    await applyResourcePackSwitch();
    try { showPlacementMsg(`Loaded resource pack: ${rp.name}`, 1800); } catch (_) {}
  } catch (e) {
    console.warn('[Resource Pack] Failed to load', e);
    try { showPlacementMsg('Failed to load resource pack zip. See console for details.', 2200); } catch (_) {}
  } finally {
    resourcePackLoading = false;
    syncResourcePackUI();
  }
}

function unloadResourcePack(){
  setActiveResourcePack(null);
  syncResourcePackUI();
  applyResourcePackSwitch();
  try { showPlacementMsg('Unloaded resource pack.', 1400); } catch (_) {}
}

// Button wiring
if (el.resourcePackLoad && el.resourcePackFile) {
  el.resourcePackLoad.addEventListener('click', () => {
    if (resourcePackLoading) return;
    el.resourcePackFile.click();
  });
}
if (el.resourcePackFile) {
  el.resourcePackFile.addEventListener('change', async () => {
    const f = el.resourcePackFile.files && el.resourcePackFile.files[0];
    // allow re-selecting the same file
    el.resourcePackFile.value = '';
    await handleResourcePackFile(f);
  });
}
if (el.resourcePackUnload) {
  el.resourcePackUnload.addEventListener('click', () => {
    if (resourcePackLoading) return;
    unloadResourcePack();
  });
}

syncResourcePackUI();

// --- Minecraft-like mipmaps (parity-ish) ---
// Matches the in-game idea: a user-selected mip chain depth + special handling for cutout (alphaTest) textures.
let mcMipmapLevels = 0; // 0..4 (Minecraft video setting)
try { mcMipmapLevels = Math.max(0, Math.min(4, Math.trunc(Number(el.mipLevels?.value ?? 0)))); } catch (_) {}


function syncMipLevelsUI(){
  if (!el.mipLevels) return;
  const v = Math.max(0, Math.min(4, Math.trunc(Number(mcMipmapLevels) || 0)));
  el.mipLevels.value = String(v);
}

async function applyMipmapSettingsSwitch(){
  // Rebuild textures + meshes so every material gets the new sampler + mip chain.
  resetAssetCachesForPackSwitch();
  try { await safeRefreshAllFoliageTextures(); } catch (_) {}
  try { rebuildAllPlacedGrassMeshes(); } catch (_) {}
  try { syncSpecialModelOpacity(); } catch (_) {}
}

if (el.mipLevels){
  syncMipLevelsUI();
  el.mipLevels.addEventListener('change', async () => {
    mcMipmapLevels = Math.max(0, Math.min(4, Math.trunc(Number(el.mipLevels.value) || 0)));
    syncMipLevelsUI();
    await applyMipmapSettingsSwitch();
  });
}

const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');

function configureMcTexture(t, opts){
  if (!t) return;
  t.colorSpace = THREE.SRGBColorSpace;

  const useMips = Boolean(opts && opts.useMips);

  // Minecraft-style sampling defaults:
  // - Nearest for magnification
  // - Nearest-per-mip + linear blend between mips for minification (GL_NEAREST_MIPMAP_LINEAR)
  t.magFilter = THREE.NearestFilter;

  const levels = useMips ? Math.max(0, Math.min(4, Math.trunc(Number(mcMipmapLevels) || 0))) : 0;

  // Clear any prior manual mip chain so Three.js doesn't upload stale levels.
  try { t.mipmaps = []; } catch (_) {}

  if (levels > 0) {
    t.minFilter = THREE.NearestMipmapLinearFilter;
    // We provide our own mip chain (Minecraft-ish), so disable GPU autogen.
    t.generateMipmaps = false;
    try { applyMinecraftMipmapsToTexture(t, levels); } catch (e) { console.warn('[Mipmaps] Failed, falling back to no mips', e); t.minFilter = THREE.NearestFilter; }
  } else {
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
  }

  t.needsUpdate = true;
}




// ------------------------------------------------------------
// Minecraft-ish mipmap generation (CPU) with cutout coverage
// ------------------------------------------------------------
const __SRGB8_TO_LINEAR = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++){
    const c = i / 255;
    lut[i] = (c <= 0.04045) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

function __linearToSrgb8(x){
  // x in [0,1]
  x = (x <= 0) ? 0 : (x >= 1 ? 1 : x);
  const s = (x <= 0.0031308) ? (x * 12.92) : (1.055 * Math.pow(x, 1/2.4) - 0.055);
  const v = Math.round(s * 255);
  return v < 0 ? 0 : (v > 255 ? 255 : v);
}

function __isPowerOfTwo(n){
  n = n | 0;
  return n > 0 && (n & (n - 1)) === 0;
}

function __maxAdditionalMipLevels(w, h){
  // Number of additional levels beyond level 0 (e.g. 16->4, 32->5).
  w = w | 0; h = h | 0;
  let levels = 0;
  while (w > 1 && h > 1) { w >>= 1; h >>= 1; levels++; }
  return levels;
}

function __canvasFromImage(img){
  const w = img.width | 0, h = img.height | 0;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c;
}

function __getImageDataFromCanvas(c){
  const ctx = c.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, c.width, c.height);
}

function __putImageDataToCanvas(c, id){
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.putImageData(id, 0, 0);
}

function __hasAnyTransparency(data){
  // data is Uint8ClampedArray RGBA
  for (let i = 3; i < data.length; i += 4){
    if (data[i] !== 255) return true;
  }
  return false;
}

function __coverageAtThreshold(data, thresh){
  // fraction of pixels with alpha >= thresh
  let pass = 0;
  const n = (data.length / 4) | 0;
  for (let i = 3; i < data.length; i += 4) if ((data[i] | 0) >= thresh) pass++;
  return n ? (pass / n) : 0;
}

function __coverageWithScale(data, thresh, scale){
  let pass = 0;
  const n = (data.length / 4) | 0;
  for (let i = 3; i < data.length; i += 4){
    const a = data[i] | 0;
    const as = Math.max(0, Math.min(255, Math.round(a * scale)));
    if (as >= thresh) pass++;
  }
  return n ? (pass / n) : 0;
}

function __scaleAlphaToMatchCoverage(data, thresh, targetCoverage){
  // Find scale s such that coverage(alpha*s) ~= targetCoverage.
  // Monotonic in s, so binary search.
  if (!Number.isFinite(targetCoverage)) return 1;
  targetCoverage = Math.max(0, Math.min(1, targetCoverage));
  if (targetCoverage <= 0) return 0;
  if (targetCoverage >= 1) return 10;

  let lo = 0.0, hi = 10.0;
  for (let it = 0; it < 16; it++){
    const mid = (lo + hi) * 0.5;
    const cov = __coverageWithScale(data, thresh, mid);
    if (cov < targetCoverage) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

function __downsample2x2_meanLinear(prev, w, h){
  // prev: Uint8ClampedArray, w,h are prev dims
  const w2 = Math.max(1, w >> 1);
  const h2 = Math.max(1, h >> 1);
  const out = new Uint8ClampedArray(w2 * h2 * 4);

  for (let y2 = 0; y2 < h2; y2++){
    const y0 = y2 * 2;
    const y1 = Math.min(h - 1, y0 + 1);
    for (let x2 = 0; x2 < w2; x2++){
      const x0 = x2 * 2;
      const x1 = Math.min(w - 1, x0 + 1);

      const i00 = (y0 * w + x0) * 4;
      const i10 = (y0 * w + x1) * 4;
      const i01 = (y1 * w + x0) * 4;
      const i11 = (y1 * w + x1) * 4;

      // Convert sRGB->linear via LUT, average in linear space.
      const r = (__SRGB8_TO_LINEAR[prev[i00]] + __SRGB8_TO_LINEAR[prev[i10]] + __SRGB8_TO_LINEAR[prev[i01]] + __SRGB8_TO_LINEAR[prev[i11]]) * 0.25;
      const g = (__SRGB8_TO_LINEAR[prev[i00+1]] + __SRGB8_TO_LINEAR[prev[i10+1]] + __SRGB8_TO_LINEAR[prev[i01+1]] + __SRGB8_TO_LINEAR[prev[i11+1]]) * 0.25;
      const b = (__SRGB8_TO_LINEAR[prev[i00+2]] + __SRGB8_TO_LINEAR[prev[i10+2]] + __SRGB8_TO_LINEAR[prev[i01+2]] + __SRGB8_TO_LINEAR[prev[i11+2]]) * 0.25;

      // Alpha is averaged in linear integer space.
      const a = ((prev[i00+3] + prev[i10+3] + prev[i01+3] + prev[i11+3]) * 0.25);

      const o = (y2 * w2 + x2) * 4;
      out[o]   = __linearToSrgb8(r);
      out[o+1] = __linearToSrgb8(g);
      out[o+2] = __linearToSrgb8(b);
      out[o+3] = Math.max(0, Math.min(255, Math.round(a)));
    }
  }
  return { data: out, w: w2, h: h2 };
}

function __buildMinecraftMipChain(baseCanvas, requestedLevels, alphaTestThreshold255 = 128){
  // Returns an array of canvases [level0, level1, ...].
  const baseId = __getImageDataFromCanvas(baseCanvas);
  const baseData = baseId.data;
  const w0 = baseCanvas.width | 0, h0 = baseCanvas.height | 0;

  const maxLevels = __maxAdditionalMipLevels(w0, h0);
  const levels = Math.max(0, Math.min(requestedLevels | 0, maxLevels));

  // Decide strategy: if any transparency exists, use CUTOUT coverage scaling.
  const cutout = __hasAnyTransparency(baseData);
  const targetCoverage = cutout ? __coverageAtThreshold(baseData, alphaTestThreshold255 | 0) : 0;

  const chain = [];
  chain.push(baseCanvas);

  let prev = baseData;
  let w = w0, h = h0;

  for (let lv = 1; lv <= levels; lv++){
    const ds = __downsample2x2_meanLinear(prev, w, h);

    // If this is a cutout texture (plants), scale alpha to preserve coverage
    // relative to level0 at the alphaTest threshold.
    if (cutout) {
      const s = __scaleAlphaToMatchCoverage(ds.data, alphaTestThreshold255 | 0, targetCoverage);
      if (Number.isFinite(s) && s !== 1) {
        for (let i = 3; i < ds.data.length; i += 4) {
          ds.data[i] = Math.max(0, Math.min(255, Math.round((ds.data[i] | 0) * s)));
        }
      }
    }

    const c = document.createElement('canvas');
    c.width = ds.w; c.height = ds.h;
    const id = new ImageData(ds.data, ds.w, ds.h);
    __putImageDataToCanvas(c, id);

    chain.push(c);

    prev = ds.data;
    w = ds.w; h = ds.h;
  }

  return { chain, cutout, levels };
}

function applyMinecraftMipmapsToTexture(tex, levels){
  if (!tex) return;

  // If the texture is an animated vertical strip, we can optionally crop to a single frame
  // so mipmaps work even on WebGL1 (NPOT mipmaps are restricted).
  // The strip handlers below will take over if needed.
  const img = tex.image;
  if (!img || !img.width || !img.height) return;

  // If an animated-strip canvas mode is active, the strip functions will call this again after updating tex.image.
  if (tex.userData?.__stripUsesCanvas) {
    // tex.image is already the per-frame canvas
  }

  const w = tex.image.width | 0, h = tex.image.height | 0;
  if (!w || !h) return;

  // Mipmaps require POT dims in WebGL1; WebGL2 allows NPOT, but we keep POT to avoid silent failures.
  if (!__isPowerOfTwo(w) || !__isPowerOfTwo(h)) {
    // Fall back: keep nearest only (still deterministic).
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    try { tex.mipmaps = []; } catch (_) {}
    return;
  }

  // Cache key to avoid regenerating repeatedly.
  const key = `mcMip|${w}x${h}|L${levels}|img:${(img.currentSrc || img.src || '')}|frame:${tex.userData?.__stripFrame ?? -1}`;
  if (tex.userData && tex.userData.__mcMipKey === key) return;

  let baseCanvas = null;
  try {
    baseCanvas = __canvasFromImage(tex.image);
  } catch (e) {
    // If the image is CORS-tainted, we can't read pixels. Fall back to GPU mipmaps.
    tex.generateMipmaps = true;
    tex.minFilter = THREE.NearestMipmapLinearFilter;
    tex.needsUpdate = true;
    return;
  }

  // Build chain and attach to texture.
  const alphaThresh = 128; // matches plant alphaTest=0.5 in this tool
  const res = __buildMinecraftMipChain(baseCanvas, levels, alphaThresh);

  // IMPORTANT: Three.js treats `texture.mipmaps` as a complete mip chain when provided.
  // Provide [level0, level1, ...].
  tex.image = res.chain[0];
  tex.mipmaps = res.chain;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;

  tex.userData = tex.userData || {};
  tex.userData.__mcMipKey = key;

  // Invalidate alpha-pick cache (texture UUID remains the same).
  try { if (typeof __texAlphaCache !== 'undefined') __texAlphaCache.delete(tex.uuid); } catch (_) {}
}


function fixAnimatedStripTexture(tex){
  try {
    // Minecraft animated textures are usually vertical strips of N frames of size WxW.
    // For GUI preview we show a single frame.
    const img = tex && tex.image;
    if (!img || !img.width || !img.height) return;

    const frames = Math.round(img.height / img.width);
    if (!Number.isFinite(frames) || frames <= 1) return;

    tex.userData = tex.userData || {};
    tex.userData.__stripFrames = frames;
    tex.userData.__stripSrcImage = img; // keep the full strip even if we swap tex.image later
    if (!Number.isFinite(tex.userData.__stripFrame)) tex.userData.__stripFrame = 0;

    // If mipmaps are enabled, force a POT per-frame canvas. This avoids WebGL1 NPOT mipmap restrictions.
    const wantMip = (Math.max(0, Math.min(4, Math.trunc(Number(mcMipmapLevels) || 0))) > 0);

    if (wantMip) {
      const size = img.width | 0; // frame is WxW
      let c = tex.userData.__stripCanvas;
      if (!c || (c.width|0) !== size || (c.height|0) !== size) {
        c = document.createElement('canvas');
        c.width = size; c.height = size;
        tex.userData.__stripCanvas = c;
      }
      tex.userData.__stripUsesCanvas = true;

      // Set image to the per-frame canvas; frame selection will draw into it.
      tex.image = c;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.set(1, 1);
      tex.offset.set(0, 0);

      // Default to frame 0.
      setAnimatedStripTextureFrame(tex, tex.userData.__stripFrame);
      return;
    }

    // Default (no mipmaps): use repeat/offset into the full strip.
    setAnimatedStripTextureFrame(tex, tex.userData.__stripFrame);
  } catch (e) {
    // ignore
  }
}

function setAnimatedStripTextureFrame(tex, frameIndex, frameCountOverride = null){
  try {
    if (!tex) return;

    // Prefer the preserved strip source image if available.
    const src = tex.userData?.__stripSrcImage || tex.image;
    if (!src || !src.width || !src.height) return;

    const detected = Math.round(src.height / src.width);
    let frames = Number.isFinite(detected) ? detected : 1;
    if (Number.isFinite(frameCountOverride) && frameCountOverride > 1) {
      if (frames <= 1 || frames == frameCountOverride) frames = frameCountOverride;
    }
    if (!Number.isFinite(frames) || frames <= 1) return;

    const n = Math.floor(frames);
    const f = ((Math.floor(Number(frameIndex) || 0) % n) + n) % n;

    tex.userData = tex.userData || {};
    tex.userData.__stripFrames = n;
    tex.userData.__stripFrame = f;

    // Canvas mode (mipmaps enabled): draw the chosen frame into a POT canvas and rebuild mip chain.
    if (tex.userData.__stripUsesCanvas && tex.userData.__stripCanvas) {
      const c = tex.userData.__stripCanvas;
      const size = src.width | 0;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, size, size);

      // Frame 0 is at the top of the strip.
      const sy = (f * size) | 0;
      ctx.drawImage(src, 0, sy, size, size, 0, 0, size, size);

      tex.image = c;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
      tex.repeat.set(1, 1);
      tex.offset.set(0, 0);

      // Rebuild mipmaps for the current frame.
      const levels = useMips ? Math.max(0, Math.min(4, Math.trunc(Number(mcMipmapLevels) || 0))) : 0;
      if (levels > 0) {
        tex.minFilter = THREE.NearestMipmapLinearFilter;
        tex.magFilter = THREE.NearestFilter;
        tex.generateMipmaps = false;
        try { applyMinecraftMipmapsToTexture(tex, levels); } catch (_) {}
      } else {
        tex.minFilter = THREE.NearestFilter;
      }

      tex.needsUpdate = true;
      return;
    }

    // Default mode: use repeat/offset into the full strip.
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(1, 1 / n);
    tex.offset.set(0, 1 - (f + 1) / n);
    tex.needsUpdate = true;
  } catch (e) {
    // ignore
  }
}


// A tiny placeholder so meshes don't flash white while textures stream in.
// Fully transparent (1x1) so cutout geometry stays invisible until the real texture is ready.
function makePlaceholderTexture(useMips){
  const data = new Uint8Array([0, 0, 0, 0]); // 1x1 transparent
  const t = new THREE.DataTexture(data, 1, 1);
  configureMcTexture(t, { useMips: Boolean(useMips) });
  return t;
}

const PLACEHOLDER_TEX_NO_MIP = makePlaceholderTexture(false);
const PLACEHOLDER_TEX_MIP = makePlaceholderTexture(true);
// Default placeholder used by most foliage/cross models.
const PLACEHOLDER_TEX = PLACEHOLDER_TEX_NO_MIP;

// Small UX polish: fade meshes in once their texture arrives (avoids harsh pop-in).
function fadeMaterialOpacity(mat, targetOpacity = 1, ms = 120){
  if (!mat) return;
  const from = Number.isFinite(mat.opacity) ? mat.opacity : 1;
  const start = performance.now();
  mat.transparent = true;

  function step(now){
    const k = Math.min(1, (now - start) / ms);
    mat.opacity = from + (targetOpacity - from) * k;
    try { requestRender(); } catch (_) {}
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function hideMaterialForLoad(mat){
  if (!mat) return;
  if (!mat.userData) mat.userData = {};
  // Record the intended opacity so we can restore it after the texture arrives.
  mat.userData.__targetOpacity = Number.isFinite(mat.opacity) ? mat.opacity : 1;
  mat.opacity = 0;
  mat.transparent = true;
}

function revealMaterialAfterLoad(mat, ms = 120){
  if (!mat) return;
  const target = (mat.userData && Number.isFinite(mat.userData.__targetOpacity)) ? mat.userData.__targetOpacity : 1;
  fadeMaterialOpacity(mat, target, ms);
}

// If a material was previously hidden with `hideMaterialForLoad`, its visible `opacity` is 0
// but the *intended* opacity is stored in userData.__targetOpacity. This matters when we
// clone a hidden material (e.g. pointed dripstone segments): the clone would otherwise inherit
// opacity=0 and then get "stuck" invisible.
function intendedOpacityOf(mat, fallback = 1){
  const ud = mat && mat.userData;
  if (ud && Number.isFinite(ud.__targetOpacity)) return ud.__targetOpacity;
  if (mat && Number.isFinite(mat.opacity) && mat.opacity > 0) return mat.opacity;
  return fallback;
}


// Cache textures by name (e.g. 'fern', 'tall_grass_bottom').
// Texture caches are split: textureCacheMipped / textureCacheNoMips

function clearProgrammerArtTextureCache(){
  // Because the cache key is just the texture name, switching packs
  // requires invalidating any texture names we may swap.
  for (const k of PROGRAMMER_ART_KEYS) { textureCacheMipped.delete(k); textureCacheNoMips.delete(k); }
}

// --- Texture Refresh Race Condition Prevention ---
// Prevents multiple simultaneous texture refresh operations
let isRefreshingTextures = false;
let pendingTextureRefresh = false;

/**
 * Safely refresh all foliage textures with race condition prevention.
 * If a refresh is already in progress, queues one more refresh to run after completion.
 * Multiple rapid calls will be coalesced into a single pending refresh.
 */
async function safeRefreshAllFoliageTextures() {
  // If already refreshing, mark that we need another refresh
  if (isRefreshingTextures) {
    console.log('[Texture Refresh] Already in progress, queuing refresh...');
    pendingTextureRefresh = true;
    return;
  }
  
  isRefreshingTextures = true;
  
  try {
    await refreshAllFoliageTextures();
    
    // If another refresh was requested while we were working, do it now
    if (pendingTextureRefresh) {
      console.log('[Texture Refresh] Running queued refresh...');
      pendingTextureRefresh = false;
      await refreshAllFoliageTextures();
    }
  } catch (error) {
    console.error('[Texture Refresh] Failed:', error);
    throw error; // Re-throw so callers can handle
  } finally {
    isRefreshingTextures = false;
    pendingTextureRefresh = false; // Clear any pending flag
  }
}

/**
 * Internal function that performs the actual texture refresh.
 * ⚠️ Do not call directly! Use safeRefreshAllFoliageTextures() instead to prevent race conditions.
 */
async function refreshAllFoliageTextures(){
  clearProgrammerArtTextureCache();
  // Helpful visibility when diagnosing pack switches.
  console.info('[Texture Pack] Refreshing foliage textures:', useProgrammerArt ? 'Programmer Art' : 'Jappa');
  const jobs = [];
  for (const mats of foliageMatCache.values()){
    if (!mats) continue;
    // We have a few material shapes:
    //  - single: { base, selected, placement, __tex }
    //  - double: { baseBottom/baseTop..., __texBottom/__texTop }
    //  - propagule: { base, selected, placement, __tex }
    // Older code also used __texSingle; support it defensively.
    if (mats.model === 'double' || mats.__texBottom || mats.__texTop) {
      jobs.push((async () => {
        const bt = await getBlockTexture(mats.__texBottom);
        const tt = await getBlockTexture(mats.__texTop);
        for (const m of [mats.baseBottom, mats.selectedBottom, mats.placementBottom]){ if (m){ m.map = bt; m.needsUpdate = true; } }
        for (const m of [mats.baseTop, mats.selectedTop, mats.placementTop]){ if (m){ m.map = tt; m.needsUpdate = true; } }
      })());
      continue;
    }

    // single / propagule
    const texKey = mats.__texSingle || mats.__tex;
    if (texKey && (mats.base || mats.selected || mats.placement)){
      jobs.push((async () => {
        const t0 = await getBlockTexture(texKey);

        // Bamboo needs per-user UV shifting; keep the original behavior.
        let t = t0;
        // We don't have the foliage id here; detect bamboo by tex key.
        if (String(texKey) === 'bamboo_stalk') {
          t = t0.clone();
          applyBambooUvToTexture(t);
        }

        for (const m of [mats.base, mats.selected, mats.placement]){ if (m){ m.map = t; m.needsUpdate = true; } }
      })());
    }
  }

  // Also refresh any per-face materials created by buildMinecraftModelGroup() (MultiMaterial).
  // This is required for models like sunflower_top (and others) that don't use the simple
  // single/double cross-material pipeline, otherwise only the stalk textures would update.
  try {
    const seen = new Set();
    const roots = [];
    // Prefer known scene roots if they exist.
    try { if (typeof grassGroup !== 'undefined' && grassGroup) roots.push(grassGroup); } catch (_) {}
    try { if (typeof placementPreview !== 'undefined' && placementPreview) roots.push(placementPreview); } catch (_) {}
    // Fallback: scan the whole scene.
    if (!roots.length) {
      try { if (typeof scene !== 'undefined' && scene) roots.push(scene); } catch (_) {}
    }

    for (const r of roots) {
      r.traverse(obj => {
        if (!obj || !obj.isMesh) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          const texName = m?.userData?.__mcTexName;
          if (!texName || seen.has(m)) continue;
          seen.add(m);
          jobs.push((async () => {
            const t = await getBlockTexture(texName, { useMips: true });
            m.map = t;
            m.needsUpdate = true;
          })());
        }
      });
    }
  } catch (e) {
    console.warn('[Texture Pack] Failed to refresh per-face materials', e);
  }

  await Promise.all(jobs);
  // Re-apply manual animated frame selection (tall seagrass).
  applyTallSeagrassFrameToCachedMats();
  try { requestRender(); } catch (_) {}
}

// Cache block model JSON by name (e.g. 'mangrove_propagule_hanging_0').
// Values are Promises that resolve to a parsed model object (or null on failure).
const modelJsonCache = new Map();

//
// Local override: ground mangrove propagule model (for visuals only).
// Source: https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/refs/heads/26.1-snapshot-1/assets/minecraft/models/block/mangrove_propagule.json
//
const LOCAL_MANGROVE_PROPAGULE_GROUND_MODEL = {"ambientocclusion":false,"textures":{"particle":"block/mangrove_propagule","sapling":"block/mangrove_propagule"},"elements":[{"name":"leaves","from":[4.5,9,8],"to":[11.5,15,8],"rotation":{"angle":45,"axis":"y","origin":[8,0,8],"rescale":true},"faces":{"north":{"uv":[4,1,11,7],"texture":"#sapling"},"south":{"uv":[4,1,11,7],"texture":"#sapling"}}},{"name":"leaves","from":[8,9,4.5],"to":[8,15,11.5],"rotation":{"angle":45,"axis":"y","origin":[8,0,8],"rescale":true},"faces":{"east":{"uv":[4,1,11,7],"texture":"#sapling"},"west":{"uv":[4,1,11,7],"texture":"#sapling"}}},{"name":"hypocotyl","from":[8,0,7],"to":[8,9,9],"rotation":{"angle":45,"axis":"y","origin":[8,0,8],"rescale":true},"faces":{"east":{"uv":[7,7,9,16],"texture":"#sapling"},"west":{"uv":[7,7,9,16],"texture":"#sapling"}}},{"name":"hypocotyl","from":[7,0,8],"to":[9,9,8],"rotation":{"angle":45,"axis":"y","origin":[8,0,8],"rescale":true},"faces":{"north":{"uv":[7,7,9,16],"texture":"#sapling"},"south":{"uv":[7,7,9,16],"texture":"#sapling"}}}]};
modelJsonCache.set('mangrove_propagule', Promise.resolve(LOCAL_MANGROVE_PROPAGULE_GROUND_MODEL));

// Local overrides: tall seagrass models (snapshot parity).
// Sources:
//  - https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/refs/heads/26.1-snapshot-3/assets/minecraft/models/block/tall_seagrass_bottom.json
//  - https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/refs/heads/26.1-snapshot-3/assets/minecraft/models/block/tall_seagrass_top.json
//  - https://mcasset.cloud/1.21.5/assets/minecraft/models/block/template_seagrass.json
const LOCAL_TEMPLATE_SEAGRASS_MODEL = {"parent":"block/block","textures":{"particle":"#texture"},"elements":[{"from":[0,0,4],"to":[16,16,4],"faces":{"north":{"uv":[0,0,16,16],"texture":"#texture"},"south":{"uv":[0,0,16,16],"texture":"#texture"}}},{"from":[12,0,0],"to":[12,16,16],"faces":{"west":{"uv":[0,0,16,16],"texture":"#texture"},"east":{"uv":[0,0,16,16],"texture":"#texture"}}},{"from":[4,0,0],"to":[4,16,16],"faces":{"west":{"uv":[0,0,16,16],"texture":"#texture"},"east":{"uv":[0,0,16,16],"texture":"#texture"}}},{"from":[0,0,12],"to":[16,16,12],"faces":{"north":{"uv":[0,0,16,16],"texture":"#texture"},"south":{"uv":[0,0,16,16],"texture":"#texture"}}}],"shade":false};
const LOCAL_TALL_SEAGRASS_BOTTOM_MODEL = {"parent":"block/template_seagrass","textures":{"texture":"block/tall_seagrass_bottom"}};
const LOCAL_TALL_SEAGRASS_TOP_MODEL = {"parent":"block/template_seagrass","textures":{"texture":"block/tall_seagrass_top"}};
modelJsonCache.set('template_seagrass', Promise.resolve(LOCAL_TEMPLATE_SEAGRASS_MODEL));
modelJsonCache.set('tall_seagrass_bottom', Promise.resolve(LOCAL_TALL_SEAGRASS_BOTTOM_MODEL));
modelJsonCache.set('tall_seagrass_top', Promise.resolve(LOCAL_TALL_SEAGRASS_TOP_MODEL));

async function getBlockTexture(texName, opts){
  const useMips = Boolean(opts && opts.useMips);
  const cache = useMips ? textureCacheMipped : textureCacheNoMips;
  const placeholder = useMips ? PLACEHOLDER_TEX_MIP : PLACEHOLDER_TEX_NO_MIP;

  const key = String(texName || '').trim();
  if (!key) return placeholder;

  // IMPORTANT: we may have *in-flight* loads.
  // Older code cached PLACEHOLDER_TEX immediately, which made any concurrent callers
  // permanently receive the placeholder (they would never await the real texture).
  // To fix this, we cache the *Promise* for the load. Awaiting a non-Promise value
  // still works, so callers can safely `await getBlockTexture(...)` either way.
  if (cache.has(key)) return await cache.get(key);

  const url = blockTextureUrl(key);
  const p = (async () => {
    try {
      const t = await texLoader.loadAsync(url);
      configureMcTexture(t, { useMips });
      fixAnimatedStripTexture(t);
      cache.set(key, t);
      try { requestRender(); } catch (_) {}
      return t;
    } catch (e) {
      console.warn('Failed to load texture', { key, url }, e);
      cache.set(key, placeholder);
      try { requestRender(); } catch (_) {}
      return placeholder;
    }
  })();

  cache.set(key, p);
  return await p;
}

function getBlockModelJSON(modelName){
  const key = String(modelName || '').trim();
  if (!key) return Promise.resolve(null);

  // Resource pack overrides (if loaded).
  const rpModel = resourcePackModelJson(key);
  if (rpModel) return Promise.resolve(rpModel);

  if (modelJsonCache.has(key)) return modelJsonCache.get(key);

  const url = `${MC_ASSETS_BLOCK_MODEL_BASE}${encodeURIComponent(key)}.json`;
  const p = fetch(url)
    .then(r => (r && r.ok) ? r.json() : null)
    .catch(() => null);
  modelJsonCache.set(key, p);
  return p;
}

// Cache for fully-resolved (parent-flattened) block models.
// Many vanilla models are just {parent, textures} and rely on inheriting elements from the parent.
const resolvedModelJsonCache = new Map();

function normalizeParentModelName(parent){
  let p = String(parent || '').trim();
  if (!p) return '';
  // Strip namespace.
  const colon = p.indexOf(':');
  if (colon >= 0) p = p.slice(colon + 1);
  // Strip common folder prefixes.
  if (p.startsWith('block/')) p = p.slice('block/'.length);
  if (p.startsWith('item/')) p = p.slice('item/'.length);
  // If still pathy, keep the leaf.
  if (p.includes('/')) p = p.split('/').pop();
  return p;
}

function getResolvedBlockModelJSON(modelName){
  const key = String(modelName || '').trim();
  if (!key) return Promise.resolve(null);

  // Cache must be invalidated when a resource pack is (un)loaded.
  const cacheKey = `${resourcePackGeneration}|${key}`;
  if (resolvedModelJsonCache.has(cacheKey)) return resolvedModelJsonCache.get(cacheKey);

  const p = (async () => {
    const model = await getBlockModelJSON(key);
    if (!model) return null;

    // Depth-limited parent resolution.
    let cur = model;
    let safety = 0;
    while (cur && cur.parent && safety++ < 12) {
      const parentName = normalizeParentModelName(cur.parent);
      if (!parentName) break;
      const parent = await getBlockModelJSON(parentName);
      if (!parent) break;

      // Merge parent -> child (child wins). Elements are inherited when absent.
      const merged = JSON.parse(JSON.stringify(parent));
      merged.textures = Object.assign({}, parent.textures || {}, cur.textures || {});
      if (Array.isArray(cur.elements)) merged.elements = cur.elements;
      if (cur.ambientocclusion !== undefined) merged.ambientocclusion = cur.ambientocclusion;
      if (cur.gui_light !== undefined) merged.gui_light = cur.gui_light;
      // Stop further resolution if the parent's already the same (avoid cycles).
      if (merged.parent === cur.parent) delete merged.parent;
      cur = merged;
    }

    // Drop parent key to avoid confusing later texture indirection resolution.
    if (cur && cur.parent) {
      // If we hit the safety limit, keep parent but it won't be used.
    }
    return cur;
  })();

  resolvedModelJsonCache.set(cacheKey, p);
  return p;
}

// --- Synthetic block models: cube with selectable block textures ---
// We register "cube_<TYPE>" models into the modelJsonCache so the generic model renderer can use them.
// These use cube.json geometry but inject per-face textures (top/side/bottom) for each block type.
const CUBE_KIND = 'CUBE';

const CUBE_BLOCK_TYPES = Object.freeze([
  { token: 'GRASS_BLOCK', label: 'grass block', textures: { up:'block/grass_block_top', side:'block/grass_block_side', down:'block/dirt', particle:'block/dirt' } },
  { token: 'DIRT', label: 'dirt', textures: { all:'block/dirt', particle:'block/dirt' } },
  { token: 'STONE', label: 'stone block', textures: { all:'block/stone', particle:'block/stone' } },
  { token: 'PODZOL', label: 'podzol', textures: { up:'block/podzol_top', side:'block/podzol_side', down:'block/dirt', particle:'block/podzol_side' } },
  // Nylium: top + side textures, with netherrack underside (matches vanilla).
  { token: 'CRIMSON_NYLIUM', label: 'crimson nylium', textures: { up:'block/crimson_nylium', side:'block/crimson_nylium_side', down:'block/netherrack', particle:'block/crimson_nylium_side' } },
  { token: 'WARPED_NYLIUM', label: 'warped nylium', textures: { up:'block/warped_nylium', side:'block/warped_nylium_side', down:'block/netherrack', particle:'block/warped_nylium_side' } },
  { token: 'DIRT_PATH', label: 'dirt path', textures: { up:'block/dirt_path_top', side:'block/dirt_path_side', down:'block/dirt', particle:'block/dirt_path_top' } },
  { token: 'COARSE_DIRT', label: 'coarse dirt', textures: { all:'block/coarse_dirt', particle:'block/coarse_dirt' } },
  { token: 'ROOTED_DIRT', label: 'rooted dirt', textures: { all:'block/rooted_dirt', particle:'block/rooted_dirt' } },
  { token: 'DRIPSTONE_BLOCK', label: 'dripstone block', textures: { all:'block/dripstone_block', particle:'block/dripstone_block' } },
  { token: 'GRAVEL', label: 'gravel', textures: { all:'block/gravel', particle:'block/gravel' } },
  { token: 'SAND', label: 'sand', textures: { all:'block/sand', particle:'block/sand' } },
]);

const CUBE_BLOCK_TYPE_BY_TOKEN = new Map(CUBE_BLOCK_TYPES.map(t => [t.token, t]));
let activeCubeBlockType = 'GRASS_BLOCK';

// Cube top-face UV rotation (0,90,180,270) stored as steps 0..3.
// This is purely visual and does not affect exported offset datasets.
let cubeTopPlacementRot = 0;

function cubeBlockTypeToModelName(token, topRotSteps = 0){
  const t = String(token || '').toUpperCase();
  const base = `cube_${t.toLowerCase()}`;
  const steps = clampRotSteps4(topRotSteps);
  return steps ? `${base}_u${steps * 90}` : base;
}

function ensureCubeModelRegistered(token, topRotSteps = 0){
  const t = String(token || '').toUpperCase();
  const def = CUBE_BLOCK_TYPE_BY_TOKEN.get(t) || CUBE_BLOCK_TYPE_BY_TOKEN.get('GRASS_BLOCK');
  const steps = clampRotSteps4(topRotSteps);
  const modelName = cubeBlockTypeToModelName(def.token, steps);
  if (modelJsonCache.has(modelName)) return modelName;

  const p = (async () => {
    const cube = await getBlockModelJSON('cube');
    if (!cube) return null;

    // Deep clone so we can safely inject textures without mutating the shared cube model.
    const m = JSON.parse(JSON.stringify(cube));
    const tex = def.textures || {};
    const all = tex.all;

    // cube.json expects per-face keys; we map common {up,down,side} forms onto them.
    m.textures = Object.assign({}, m.textures, {
      particle: tex.particle || all || tex.side || tex.up || tex.down,
      down: tex.down || all,
      up: tex.up || all,
      north: tex.north || tex.side || all,
      south: tex.south || tex.side || all,
      west: tex.west || tex.side || all,
      east: tex.east || tex.side || all,
    });

    // Apply optional UV rotation to the top face only.
    const rotDeg = steps * 90;
    if (Array.isArray(m.elements)) {
      for (const elmt of m.elements) {
        const up = elmt?.faces?.up;
        if (up) up.rotation = rotDeg;
      }
    }

    return m;
  })();

  modelJsonCache.set(modelName, p);
  return modelName;
}


// --- Foliage catalog ---
// Each foliage type has:
//  - id: stable export/import token
//  - label: UI label
//  - offsetType: 'XYZ' (x/y/z) or 'XZ' (x/z only; y is unobservable in-game)
//  - model: 'single' (one-block cross), or 'double' (two-block style preview)
const FOLIAGE = {
  groups: [
    {
      label: 'grass',
      items: [
        { id: 'SHORT_GRASS', label: 'short grass', offsetType: 'XYZ', model: 'single' },
        { id: 'TALL_GRASS', label: 'tall grass', offsetType: 'XZ', model: 'double' },
        { id: 'FERN', label: 'fern', offsetType: 'XYZ', model: 'single' },
        { id: 'LARGE_FERN', label: 'large fern', offsetType: 'XZ', model: 'double' },

        { id: 'SHORT_DRY_GRASS', label: 'short dry grass', offsetType: 'XYZ', model: 'single' },
        { id: 'TALL_DRY_GRASS', label: 'tall dry grass', offsetType: 'XYZ', model: 'single' },

        { id: 'SMALL_DRIPLEAF', label: 'small dripleaf', offsetType: 'XYZ', model: 'single' },

        { id: 'CRIMSON_ROOTS', label: 'crimson roots', offsetType: 'XZ', model: 'single' },
        { id: 'WARPED_ROOTS', label: 'warped roots', offsetType: 'XZ', model: 'single' },
        { id: 'NETHER_SPROUTS', label: 'warped sprouts', offsetType: 'XZ', model: 'single' },

        { id: 'TALL_SEAGRASS', label: 'tall seagrass', offsetType: 'XZ', model: 'double' },
      ],
    },
    {
      label: 'flowers',
      items: [
        { id: 'DANDELION', label: 'dandelion', offsetType: 'XZ', model: 'single' },
        { id: 'TORCHFLOWER', label: 'torchflower', offsetType: 'XZ', model: 'single' },
        { id: 'POPPY', label: 'poppy', offsetType: 'XZ', model: 'single' },
        { id: 'BLUE_ORCHID', label: 'blue orchid', offsetType: 'XZ', model: 'single' },
        { id: 'ALLIUM', label: 'allium', offsetType: 'XZ', model: 'single' },
        { id: 'AZURE_BLUET', label: 'azure bluet', offsetType: 'XZ', model: 'single' },

        { id: 'RED_TULIP', label: 'red tulip', offsetType: 'XZ', model: 'single' },
        { id: 'ORANGE_TULIP', label: 'orange tulip', offsetType: 'XZ', model: 'single' },
        { id: 'WHITE_TULIP', label: 'white tulip', offsetType: 'XZ', model: 'single' },
        { id: 'PINK_TULIP', label: 'pink tulip', offsetType: 'XZ', model: 'single' },

        { id: 'OXEYE_DAISY', label: 'oxeye daisy', offsetType: 'XZ', model: 'single' },
        { id: 'CORNFLOWER', label: 'cornflower', offsetType: 'XZ', model: 'single' },
        { id: 'WITHER_ROSE', label: 'wither rose', offsetType: 'XZ', model: 'single' },
        { id: 'LILY_OF_THE_VALLEY', label: 'lily of the valley', offsetType: 'XZ', model: 'single' },

        { id: 'SUNFLOWER', label: 'sunflower', offsetType: 'XZ', model: 'double' },
        { id: 'LILAC', label: 'lilac', offsetType: 'XZ', model: 'double' },
        { id: 'ROSE_BUSH', label: 'rose bush', offsetType: 'XZ', model: 'double' },
        { id: 'PEONY', label: 'peony', offsetType: 'XZ', model: 'double' },

        { id: 'PITCHER_PLANT', label: 'pitcher plant', offsetType: 'XZ', model: 'double' },

        { id: 'OPEN_EYEBLOSSOM', label: 'eyeblossom (open)', offsetType: 'XZ', model: 'single' },
        { id: 'CLOSED_EYEBLOSSOM', label: 'eyeblossom (closed)', offsetType: 'XZ', model: 'single' },
      ],
    },
    {
      label: 'misc',
      items: [
        { id: 'CUBE', label: 'cube (for visuals only)', offsetType: 'XZ', model: 'single' },
        { id: 'HANGING_ROOTS', label: 'hanging roots', offsetType: 'XZ', model: 'single' },
        { id: 'MANGROVE_PROPAGULE', label: 'mangrove propagule', offsetType: 'XZ', model: 'single' },
        { id: 'BAMBOO_SAPLING', label: 'bamboo sapling', offsetType: 'XZ', model: 'single' },
        { id: 'BAMBOO', label: 'bamboo', offsetType: 'XZ', model: 'single' },
        { id: 'POINTED_DRIPSTONE', label: 'pointed dripstone', offsetType: 'XZ', model: 'single' },
      ],
    },
  ],
  byId: new Map(),
};

for (const g of FOLIAGE.groups) {
  for (const it of g.items) FOLIAGE.byId.set(it.id, it);
}

function foliageMaskFor(offsetType){
  return (offsetType === 'XZ') ? 0xF0F : 0xFFF;
}

function isYOffsetLocked(foliageId){
  const def = FOLIAGE.byId.get(foliageId);
  return (def?.offsetType === 'XZ');
}

// Current placement foliage. Defaults to short grass.
let activeFoliageId = 'SHORT_GRASS';



/** Bamboo texture UV shift (0..15 pixels). Vanilla bamboo chooses among different UV mappings/models. */
let bambooUvU = 0; // 0..15
let bambooUvV = 0; // 0..15
let bambooModelSize = '2x2'; // '2x2' | '3x3'


function isBamboo(id){ return String(id || '') === 'BAMBOO'; }

function showHideBambooUvControls(foliageId = activeFoliageId){
  if (!el.bambooUvControls) return;
  const show = isBamboo(foliageId);
  el.bambooUvControls.classList.toggle('hidden', !show);
  if (show && el.bambooModelSize) el.bambooModelSize.value = String(bambooModelSize || '2x2');
}

function clampInt(v, a, b){
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

/** Pointed dripstone: vanilla uses the default 16-step foliage grid (+/-0.25) and then clamps to +/-0.125.
    This collapses indices 0-3 and 12-15 into identical final positions.
    We expose a 10-step *effective* selector (0..9) to avoid fake precision. */
const DRIPSTONE_EFF_TO_RAW = [0,4,5,6,7,8,9,10,11,15]; // representatives
function isPointedDripstone(id){ return String(id || '') === 'POINTED_DRIPSTONE'; }
function dripstoneRawToEff(i){
  const n = clampInt(i, 0, 15);
  if (n <= 3) return 0;
  if (n >= 12) return 9;
  return n - 3; // 4..11 -> 1..8
}
function dripstoneEffToRaw(j){
  const e = clampInt(j, 0, 9);
  return DRIPSTONE_EFF_TO_RAW[e];
}

function updateOffsetUiMode(foliageId = activeFoliageId){
  const isDrip = isPointedDripstone(foliageId);
  if (el.offX) { el.offX.min = '0'; el.offX.max = isDrip ? '9' : '15'; el.offX.step = '1'; }
  if (el.offZ) { el.offZ.min = '0'; el.offZ.max = isDrip ? '9' : '15'; el.offZ.step = '1'; }
  if (el.offXRange) el.offXRange.textContent = isDrip ? '0-9' : '0-15';
  if (el.offZRange) el.offZRange.textContent = isDrip ? '0-9' : '0-15';

  // Heads-up: pointed dripstone edge offsets collapse (0-3 and 12-15 map to the same final offset).
  const showNote = isDrip;
  if (el.dripstoneOffsetNote) el.dripstoneOffsetNote.classList.toggle('hidden', !showNote);
}


function applyBambooUvToTexture(tex, u = bambooUvU, v = bambooUvV){
  if (!tex) return;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);

  // 1px = 1/16 of a Minecraft texture
  tex.offset.set(((u|0) % 16) / 16, ((v|0) % 16) / 16);
  tex.needsUpdate = true;
}

function applyBambooUvToCachedMats(){
  const mats = foliageMatCache.get('BAMBOO');
  if (!mats) return;

  for (const m of [mats.base, mats.selected, mats.placement, mats.baseTop, mats.baseBottom, mats.selectedTop, mats.selectedBottom, mats.placementTop, mats.placementBottom]) {
    if (!m) continue;
    if (m.map) applyBambooUvToTexture(m.map);
  }
}

function syncBambooUvUI(){
  if (el.bambooUvU) el.bambooUvU.value = String(bambooUvU);
  if (el.bambooUvV) el.bambooUvV.value = String(bambooUvV);
  showHideBambooUvControls();
  updateOffsetUiMode();
}

// Extra per-foliage variant controls (used by bamboo + pointed dripstone preview)
// Height controls how many block-units tall the rendered preview/placed mesh appears.
// This is purely visual; offsets/solver behavior are unchanged.
let activeVariantHeight = 1;        // 1..16
let activeVariantDir = 'up';        // 'up' or 'down' (for dripstone)

// Mangrove propagule has multiple distinct vanilla models (ground + hanging ages 0..4).
// Default: ground.
let activePropaguleModel = 'ground'; // 'ground' | 'hanging_0'..'hanging_4'

// Small dripleaf: allow rotating the *top* model (leaf) in 90° steps.
let smallDripleafPlacementRot = 0; // 0..3 quarter turns

function foliageSupportsPropaguleModel(foliageId){
  return foliageId === 'MANGROVE_PROPAGULE';
}

function propaguleModelToBlockModelName(v){
  const s = String(v || 'ground');
  if (s === 'ground') return 'mangrove_propagule';
  const m = s.match(/^hanging_(\d)$/);
  if (m) return `mangrove_propagule_hanging_${m[1]}`;
  return 'mangrove_propagule';
}

function propaguleModelToTextureName(v){
  // Ground uses block/mangrove_propagule; hanging models share block/mangrove_propagule_hanging.
  return (String(v) === 'ground') ? 'mangrove_propagule' : 'mangrove_propagule_hanging';
}

// Extract a usable block texture key from a minecraft block-model json.
// Examples:
//  - 'block/mangrove_propagule_hanging' -> 'mangrove_propagule_hanging'
//  - 'minecraft:block/grass_block_top'  -> 'grass_block_top'
function textureNameFromMcModel(model){
  try {
    const tex = model && model.textures;
    if (!tex) return null;

    // Prefer a non-particle layer if present.
    const raw = tex.propagule ?? tex.cross ?? tex.layer0 ?? tex.all ?? tex.texture ?? tex.particle;
    if (!raw) return null;

    // Strip namespace.
    let s = String(raw);
    if (s.startsWith('#')) return null; // unresolved indirection; caller should resolve parents if needed
    const colon = s.indexOf(':');
    if (colon >= 0) s = s.slice(colon + 1);
    // Strip any folder prefixes.
    if (s.includes('/')) s = s.split('/').pop();
    return s || null;
  } catch (_) {
    return null;
  }
}

function foliageSupportsHeight(foliageId){
  return foliageId === 'BAMBOO' || foliageId === 'POINTED_DRIPSTONE';
}
function foliageSupportsDir(foliageId){
  return foliageId === 'POINTED_DRIPSTONE';
}

function syncVariantControls(){
  const box = el.variantControls;
  if (!box) return;
  const show = foliageSupportsHeight(activeFoliageId);
  box.classList.toggle('hidden', !show);
  if (!show) return;

  // Height
  const hEl = el.variantHeight;
  if (hEl) {
    hEl.min = '1';
    hEl.max = '16';
    hEl.value = String(activeVariantHeight);
  }

  // Direction (dripstone only)
  const dEl = el.variantDir;
  if (dEl) {
    // Keep the UI clean: Direction is only meaningful for pointed dripstone.
    // Hide it by default in the HTML, and only reveal it when applicable.
    const dLabel = el.dirLabel ?? dEl.parentElement;
    const showDir = foliageSupportsDir(activeFoliageId);
    // Use both a class toggle AND an inline style to avoid any CSS specificity issues.
    // (Inline style also helps if the user is running an older cached stylesheet.)
    if (dLabel) {
      dLabel.classList.toggle('hidden', !showDir);
      dLabel.style.display = showDir ? '' : 'none';
    }
    dEl.value = activeVariantDir;
  }
}

function syncPropaguleControls(){
  const box = el.propaguleControls;
  if (!box) return;
  const show = foliageSupportsPropaguleModel(activeFoliageId);
  box.classList.toggle('hidden', !show);
  if (!show) return;
  if (el.propaguleModel) el.propaguleModel.value = String(activePropaguleModel || 'ground');
}


function foliageSupportsCubeBlockType(foliageId){
  return foliageId === 'CUBE';
}

function syncCubeControls(){
  const box = el.cubeControls;
  if (!box) return;
  const show = foliageSupportsCubeBlockType(activeFoliageId);
  box.classList.toggle('hidden', !show);
  if (!show) return;
  if (el.cubeBlockType) el.cubeBlockType.value = String(activeCubeBlockType || 'GRASS_BLOCK').toUpperCase();
}

function syncCubeTopRotationControls(){
  const box = el.cubeTopRotationControls;
  if (!box) return;
  const show = foliageSupportsCubeBlockType(activeFoliageId);
  box.classList.toggle('hidden', !show);
  if (!show) return;
  if (el.cubeTopRotLabel) el.cubeTopRotLabel.textContent = `${clampRotSteps4(cubeTopPlacementRot) * 90}°`;
}

// Tall seagrass has an animated texture strip (19 frames).
// The GUI defaults to frame 0, but allows manual stepping when tall seagrass is selected.
const TALL_SEAGRASS_FRAME_COUNT = 19;
let tallSeagrassFrame = 0;

function foliageSupportsSeagrassFrame(foliageId){
  return foliageId === 'TALL_SEAGRASS';
}

function updateSeagrassFrameLabel(){
  if (el.seagrassFrameLabel) el.seagrassFrameLabel.textContent = `${tallSeagrassFrame + 1}/${TALL_SEAGRASS_FRAME_COUNT}`;
}

function applyTallSeagrassFrameToCachedMats(){
  const mats = foliageMatCache.get('TALL_SEAGRASS');
  if (!mats || mats.model !== 'double') return;
  for (const m of [mats.baseBottom, mats.selectedBottom, mats.placementBottom]){
    if (m && m.map) setAnimatedStripTextureFrame(m.map, tallSeagrassFrame, TALL_SEAGRASS_FRAME_COUNT);
  }
  for (const m of [mats.baseTop, mats.selectedTop, mats.placementTop]){
    if (m && m.map) setAnimatedStripTextureFrame(m.map, tallSeagrassFrame, TALL_SEAGRASS_FRAME_COUNT);
  }
}

function setTallSeagrassFrame(frame){
  const n = TALL_SEAGRASS_FRAME_COUNT;
  tallSeagrassFrame = ((frame % n) + n) % n;
  updateSeagrassFrameLabel();
  applyTallSeagrassFrameToCachedMats();
  // On-demand renderer: changing the animated frame must invalidate the view.
  try { requestRender(); } catch (_) {}
}

function syncSeagrassFrameControls(){
  const box = el.seagrassFrameControls;
  if (!box) return;
  const show = foliageSupportsSeagrassFrame(activeFoliageId);
  box.classList.toggle('hidden', !show);
  if (show) updateSeagrassFrameLabel();
}


function clampRotSteps4(v){
  const n = Math.trunc(num(v, 0));
  return ((n % 4) + 4) % 4;
}

function findSmallDripleafTopPivot(root){
  if (!root) return null;

  // Fast-path: stored on root when created.
  if (root.userData && root.userData.__smallDripleafTopPivot) return root.userData.__smallDripleafTopPivot;

  // Otherwise traverse to find the pivot group.
  let found = null;
  root.traverse(obj => {
    if (found) return;
    if (obj && obj.userData && obj.userData.__smallDripleafTopPivot === true) found = obj;
  });
  if (found && root.userData) root.userData.__smallDripleafTopPivot = found;
  return found;
}

function applySmallDripleafTopRotation(meshRoot, rotSteps){
  const steps = clampRotSteps4(rotSteps);
  const pivot = findSmallDripleafTopPivot(meshRoot);
  if (!pivot) return;
  pivot.rotation.y = steps * (Math.PI / 2);
  pivot.userData.__smallDripleafRotSteps = steps;
}

function getSelectedSmallDripleaf(){
  try {
    if (selectedId == null) return null;
    const g = grasses.get(selectedId);
    if (g && g.kind === 'SMALL_DRIPLEAF') return g;
  } catch (_) {}
  return null;
}

function getSelectedCube(){
  try {
    if (selectedId == null) return null;
    const g = grasses.get(selectedId);
    if (g && g.kind === 'CUBE') return g;
  } catch (_) {}
  return null;
}

function disposeCubePerFaceMaterials(root){
  // Per-face materials are cloned on the fly; dispose only those, not the shared base material.
  try {
    root?.traverse?.(obj => {
      if (!obj?.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (m && m.userData && m.userData.__mcTexName) {
          try { m.dispose?.(); } catch (_) {}
        }
      }
    });
  } catch (_) {}
}

function rebuildCubeInstance(g){
  if (!g || g.kind !== 'CUBE') return;

  // Normalize state.
  const ct = String(g.cubeType || activeCubeBlockType || 'GRASS_BLOCK').toUpperCase();
  g.cubeType = CUBE_BLOCK_TYPE_BY_TOKEN.has(ct) ? ct : 'GRASS_BLOCK';
  g.cubeTopRot = clampRotSteps4(g.cubeTopRot ?? 0);

  const old = g.mesh;
  const cmats = ensureCubeMats();
  const modelName = ensureCubeModelRegistered(g.cubeType, g.cubeTopRot);
  const newMesh = makeAsyncMinecraftModelMesh(modelName, cmats.base, { perFaceMaterials: true });
  newMesh.userData.__grassId = g.id;

  grassGroup.remove(old);
  grassGroup.add(newMesh);
  g.mesh = newMesh;

  // Best-effort dispose old geometry/materials.
  try { old?.traverse?.(obj => { if (obj.isMesh && obj.geometry) obj.geometry.dispose?.(); }); } catch (_) {}
  disposeCubePerFaceMaterials(old);

  updateGrassMeshTransform(g);
  try { requestRender(); } catch (_) {}
}

function syncSmallDripleafRotationControls(){
  const box = el.smallDripleafRotationControls;
  if (!box) return;

  const sel = getSelectedSmallDripleaf();
  const show = !!sel || activeFoliageId === 'SMALL_DRIPLEAF';
  box.classList.toggle('hidden', !show);
  if (!show) return;

  const steps = sel ? clampRotSteps4(sel.variant?.rot ?? 0) : clampRotSteps4(smallDripleafPlacementRot);
  if (el.smallDripleafRotLabel) el.smallDripleafRotLabel.textContent = `${steps * 90}°`;

  if (el.smallDripleafRotateBtn) {
    el.smallDripleafRotateBtn.title = sel
      ? 'Rotate selected small dripleaf top (90°)'
      : 'Rotate placement small dripleaf top (90°)';
  }
}

function getActiveVariantFor(foliageId){
  if (foliageId === 'SMALL_DRIPLEAF') return { rot: (smallDripleafPlacementRot|0) };
  if (!foliageSupportsHeight(foliageId)) return null;
  const v = { height: activeVariantHeight|0 };
  if (foliageId === 'POINTED_DRIPSTONE') v.dir = activeVariantDir;
  if (foliageId === 'BAMBOO') {
    v.uvU = bambooUvU|0;
    v.uvV = bambooUvV|0;
    v.modelSize = String(bambooModelSize || '2x2');
  }
  return v;
}


function populateFoliageSelect(){
  const sel = el.foliageSelect;
  if (!sel) return;
  sel.innerHTML = '';
  for (const grp of FOLIAGE.groups) {
    const og = document.createElement('optgroup');
    og.label = grp.label;
    for (const it of grp.items) {
      const opt = document.createElement('option');
      opt.value = it.id;
      opt.textContent = it.label;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.value = activeFoliageId;
  sel.addEventListener('change', () => {
    const v = String(sel.value || 'SHORT_GRASS');
    setPlacementFoliage(v);
  });
}

function setPlacementFoliage(id){
  const next = FOLIAGE.byId.has(id) ? id : 'SHORT_GRASS';
  activeFoliageId = next;
  if (el.foliageSelect && el.foliageSelect.value !== next) el.foliageSelect.value = next;
  syncGrassTextureIndicator();
  syncVariantControls();

  showHideBambooUvControls();
  syncPropaguleControls();
  syncCubeControls();
  syncCubeTopRotationControls();
  syncSeagrassFrameControls();
  syncSmallDripleafRotationControls();
  updateOffsetUiMode(activeFoliageId);
// If we are in placement mode, rebuild preview immediately.
  if (typeof placementMode !== 'undefined' && placementMode) {
    ensurePlacementOffsetRules();
    ensurePlacementPreview();
    const off = offsetToVec3ForKind(activeFoliageId, placementOff.x, placementOff.y, placementOff.z);
    placementPreview.position.set(placementBlock.x + off.x, placementBlock.y + off.y, placementBlock.z + off.z);
  updatePlacementPreviewBlockedState();
  }
}

populateFoliageSelect();

// Ensure the correct initial visibility for height/direction controls.
syncVariantControls();


showHideBambooUvControls();
syncBambooUvUI();
syncCubeControls();
syncCubeTopRotationControls();
syncSeagrassFrameControls();
syncSmallDripleafRotationControls();

updateOffsetUiMode();

// Safety net for render-on-demand: if any block-specific UI in the canvas changes,
// make sure we schedule a redraw even if a specific handler forgets to.
// (requestRender() is de-duped internally, so extra calls are cheap.)
try {
  const __foliagePicker = document.querySelector('.foliage-picker');
  if (__foliagePicker) {
    const __invalidate = () => { try { requestRender(); } catch (_) {} };
    __foliagePicker.addEventListener('input', __invalidate);
    __foliagePicker.addEventListener('change', __invalidate);
    __foliagePicker.addEventListener('click', __invalidate);
  }
} catch (_) {}

el.seagrassFramePrev?.addEventListener('click', () => {
  setTallSeagrassFrame(tallSeagrassFrame - 1);
});

el.seagrassFrameNext?.addEventListener('click', () => {
  setTallSeagrassFrame(tallSeagrassFrame + 1);
});

el.smallDripleafRotateBtn?.addEventListener('click', () => {
  // If a small dripleaf instance is selected, rotate that instance.
  const sel = getSelectedSmallDripleaf();
  if (sel) {
    if (!sel.variant) sel.variant = {};
    sel.variant.rot = clampRotSteps4((sel.variant.rot ?? 0) + 1);
    applySmallDripleafTopRotation(sel.mesh, sel.variant.rot);
    refreshGrassList();
    setSelected(sel.id);
    return;
  }

  // Otherwise rotate the placement default / placement preview (if active).
  smallDripleafPlacementRot = clampRotSteps4(smallDripleafPlacementRot + 1);
  if (placementPreview && placementPreview.userData.__previewFoliageId === 'SMALL_DRIPLEAF') {
    applySmallDripleafTopRotation(placementPreview, smallDripleafPlacementRot);
  }
  syncSmallDripleafRotationControls();
  // On-demand renderer: placement preview rotation must invalidate the view.
  try { requestRender(); } catch (_) {}
});

el.cubeTopRotateBtn?.addEventListener('click', () => {
  // If a cube instance is selected, rotate that cube's top-face texture.
  const sel = getSelectedCube();
  if (sel) {
    sel.cubeTopRot = clampRotSteps4((sel.cubeTopRot ?? cubeTopPlacementRot) + 1);
    cubeTopPlacementRot = sel.cubeTopRot;
    rebuildCubeInstance(sel);
    // Ensure the UI + selection tint stays in sync once the async mesh loads.
    setSelected(sel.id);
    return;
  }

  // Otherwise rotate the placement default / placement preview (if active).
  cubeTopPlacementRot = clampRotSteps4(cubeTopPlacementRot + 1);
  if (typeof placementMode !== 'undefined' && placementMode) {
    // This invalidates the previewKey, forcing a rebuild with the new UV rotation.
    ensurePlacementPreview();
  }
  syncCubeTopRotationControls();
  try { requestRender(); } catch (_) {}
});


// Debounced bamboo UV U updates for smoother performance
const handleBambooUvU = () => {
  const nextU = clampInt(el.bambooUvU.value, 0, 15);

  // If a bamboo instance is selected, edit that instance only.
  try {
    if (selectedId != null) {
      const g = grasses.get(selectedId);
      if (g && g.kind === 'BAMBOO') {
        if (!g.variant) g.variant = {};
        g.variant.uvU = nextU;
        const mat = ensureBambooInstanceMat(g);
        const u = clampInt(g.variant.uvU ?? nextU, 0, 15);
        const v = clampInt(g.variant.uvV ?? bambooUvV, 0, 15);
        if (mat && mat.map) applyBambooUvToTexture(mat.map, u, v);
        // On-demand renderer: material UV edits must invalidate the view.
        try { requestRender(); } catch (_) {}
        return;
      }
    }
  } catch (_) {}

  // Otherwise treat as placement default.
  bambooUvU = nextU;
  applyBambooUvToCachedMats();
  if (typeof placementMode !== 'undefined' && placementMode) ensurePlacementPreview();
  try { requestRender(); } catch (_) {}
};

const debouncedBambooUvU = createDebounced('bambooUvU', handleBambooUvU, 75);
el.bambooUvU?.addEventListener('input', debouncedBambooUvU);

// Debounced bamboo UV V updates for smoother performance
// Debounced bamboo UV V updates for smoother performance
const handleBambooUvV = () => {
  const nextV = clampInt(el.bambooUvV.value, 0, 15);

  // If a bamboo instance is selected, edit that instance only.
  try {
    if (selectedId != null) {
      const g = grasses.get(selectedId);
      if (g && g.kind === 'BAMBOO') {
        if (!g.variant) g.variant = {};
        g.variant.uvV = nextV;
        const mat = ensureBambooInstanceMat(g);
        const u = clampInt(g.variant.uvU ?? bambooUvU, 0, 15);
        const v = clampInt(g.variant.uvV ?? nextV, 0, 15);
        if (mat && mat.map) applyBambooUvToTexture(mat.map, u, v);
        // On-demand renderer: material UV edits must invalidate the view.
        try { requestRender(); } catch (_) {}
        return;
      }
    }
  } catch (_) {}

  // Otherwise treat as placement default.
  bambooUvV = nextV;
  applyBambooUvToCachedMats();
  if (typeof placementMode !== 'undefined' && placementMode) ensurePlacementPreview();
  try { requestRender(); } catch (_) {}
};

const debouncedBambooUvV = createDebounced('bambooUvV', handleBambooUvV, 75);
el.bambooUvV?.addEventListener('input', debouncedBambooUvV);

el.bambooModelSize?.addEventListener('change', () => {
  const nextSize = String(el.bambooModelSize.value || '2x2');

  // If a bamboo instance is selected, edit that instance only.
  try {
    if (selectedId != null) {
      const g = grasses.get(selectedId);
      if (g && g.kind === 'BAMBOO') {
        if (!g.variant) g.variant = {};
        g.variant.modelSize = nextSize;
        rebuildBambooInstance(g);
        refreshGrassList();
        setSelected(g.id);
        return;
      }
    }
  } catch (_) {}

  // Otherwise treat as placement default (and update existing bamboo like before).
  bambooModelSize = nextSize;

  // Rebuild any placed bamboo meshes so the change is visible immediately.
  try {
    for (const g of grasses.values()) {
      if (g.kind !== 'BAMBOO') continue;
      rebuildBambooInstance(g);
    }
    setSelected(selectedId);
  } catch (_) {
    // no-op
  }

  if (typeof placementMode !== 'undefined' && placementMode) ensurePlacementPreview();
  try { requestRender(); } catch (_) {}
});

// Variant controls wiring
syncVariantControls();
syncPropaguleControls();

el.propaguleModel?.addEventListener('change', () => {
  activePropaguleModel = String(el.propaguleModel.value || 'ground');

  // If we're placing, rebuild the preview so the model updates immediately.
  if (typeof placementMode !== 'undefined' && placementMode) {
    ensurePlacementPreview();
  }

  // If a mangrove propagule is currently selected, apply the model change to it as well.
  try {
    if (selectedId != null) {
      const g = grasses.get(selectedId);
      if (g && g.kind === 'MANGROVE_PROPAGULE') {
        g.propaguleModel = activePropaguleModel;

        // Rebuild the mesh using the chosen vanilla block model.
        const pmats = ensurePropaguleMats(g.propaguleModel);
        const mat = pmats.selected; // since it's selected
        const modelName = propaguleModelToBlockModelName(g.propaguleModel);

        const newMesh = makeAsyncMinecraftModelMesh(modelName, mat);
        newMesh.userData.__grassId = g.id;

        grassGroup.remove(g.mesh);
        grassGroup.add(newMesh);
        g.mesh = newMesh;

        updateGrassMeshTransform(g);
        refreshGrassList();
        setSelected(g.id);
      }
    }
  } catch (_) {
    // no-op (defensive: selection state not ready yet)
  }
});


syncCubeControls();
syncCubeTopRotationControls();

el.cubeBlockType?.addEventListener('change', () => {
  const ct = String(el.cubeBlockType.value || 'GRASS_BLOCK').toUpperCase();
  activeCubeBlockType = CUBE_BLOCK_TYPE_BY_TOKEN.has(ct) ? ct : 'GRASS_BLOCK';

  // If we're placing, rebuild the preview so the textures update immediately.
  if (typeof placementMode !== 'undefined' && placementMode) {
    ensurePlacementPreview();
  }

  // If a cube is currently selected, apply the texture change to it as well.
  try {
    if (selectedId != null) {
      const g = grasses.get(selectedId);
      if (g && g.kind === 'CUBE') {
        g.cubeType = activeCubeBlockType;

        const old = g.mesh;
        const cmats = ensureCubeMats();
        const modelName = ensureCubeModelRegistered(activeCubeBlockType, g.cubeTopRot ?? cubeTopPlacementRot);
        const newMesh = makeAsyncMinecraftModelMesh(modelName, cmats.base, { perFaceMaterials: true });
        newMesh.userData.__grassId = g.id;

        grassGroup.remove(old);
        grassGroup.add(newMesh);
        g.mesh = newMesh;

        // Best-effort dispose old geometry.
        old?.traverse?.(obj => { if (obj.isMesh && obj.geometry) obj.geometry.dispose?.(); });
        disposeCubePerFaceMaterials(old);

        updateGrassMeshTransform(g);
        refreshGrassList();
        setSelected(selectedId);
      }
    }
  } catch (_) {
    // ignore (defensive: selection state not ready yet)
  }
});




function applyVariantHeightFromUI(){
  const nextH = Math.max(1, Math.min(16, Math.trunc(num(el.variantHeight?.value, activeVariantHeight))));

  // If a height-capable instance is selected, edit that instance only.
  try {
    if (selectedId != null) {
      const g = grasses.get(selectedId);
      if (g && foliageSupportsHeight(g.kind)) {
        if (!g.variant) g.variant = {};
        g.variant.height = nextH;
        if (g.kind === 'BAMBOO') rebuildBambooInstance(g);
        if (g.kind === 'POINTED_DRIPSTONE') rebuildDripstoneInstance(g);
        refreshGrassList();
        setSelected(g.id);
        return;
      }
    }
  } catch (_) {}

  // Otherwise treat as placement default.
  activeVariantHeight = nextH;
  if (typeof placementMode !== 'undefined' && placementMode) {
    ensurePlacementPreview();
  }
}

// Debounce variant height updates for better performance
const debouncedVariantHeight = createDebounced('variantHeight', applyVariantHeightFromUI, 75);

el.variantHeight?.addEventListener('input', debouncedVariantHeight);
el.variantHeight?.addEventListener('change', applyVariantHeightFromUI); // Keep instant on blur/enter

el.variantDir?.addEventListener('change', () => {
  const nextDir = (String(el.variantDir.value) === 'down') ? 'down' : 'up';

  // If a dripstone instance is selected, edit that instance only.
  try {
    if (selectedId != null) {
      const g = grasses.get(selectedId);
      if (g && g.kind === 'POINTED_DRIPSTONE') {
        if (!g.variant) g.variant = {};
        g.variant.dir = nextDir;
        rebuildDripstoneInstance(g);
        refreshGrassList();
        setSelected(g.id);
        return;
      }
    }
  } catch (_) {}

  // Otherwise treat as placement default.
  activeVariantDir = nextDir;
  if (typeof placementMode !== 'undefined' && placementMode) {
    ensurePlacementPreview();
  }
});


function syncGrassTextureIndicator(){
  if (!texIndicatorEl) return;
  const def = FOLIAGE.byId.get(activeFoliageId);
  const kindLabel = def ? def.label : activeFoliageId;
  texIndicatorEl.textContent = `Mode: ${kindLabel}`;
}

// --- Foliage textures + materials ---
// We support both "single" (one-block) and "double" (two-block tall) foliage.
// For the tall ones, we use the vanilla _bottom/_top texture names (same as the model json).

function texNamesForFoliage(id){
  switch (id) {
    // XYZ
    case 'SHORT_GRASS': return { single: 'short_grass' };
    case 'FERN': return { single: 'fern' };
    case 'SHORT_DRY_GRASS': return { single: 'short_dry_grass' };
    case 'TALL_DRY_GRASS': return { single: 'tall_dry_grass' };
    // Small dripleaf doesn't have a single "small_dripleaf.png" texture in vanilla.
    // Use a real texture key for the basic material template.
    case 'SMALL_DRIPLEAF': return { single: 'small_dripleaf_top' };

    // XZ (double-height)
    case 'TALL_GRASS': return { bottom: 'tall_grass_bottom', top: 'tall_grass_top' };
    case 'LARGE_FERN': return { bottom: 'large_fern_bottom', top: 'large_fern_top' };
    case 'SUNFLOWER': return { bottom: 'sunflower_bottom', top: 'sunflower_top' };
    case 'LILAC': return { bottom: 'lilac_bottom', top: 'lilac_top' };
    case 'ROSE_BUSH': return { bottom: 'rose_bush_bottom', top: 'rose_bush_top' };
    case 'PEONY': return { bottom: 'peony_bottom', top: 'peony_top' };
    // Pitcher plant (final growth stage) uses the pitcher crop stage 4 textures in vanilla.
    // (The block model JSONs reference `block/pitcher_crop_*_stage_4`, not `pitcher_plant_*`.)
    case 'PITCHER_PLANT': return { bottom: 'pitcher_crop_bottom_stage_4', top: 'pitcher_crop_top_stage_4' };
    case 'TALL_SEAGRASS': return { bottom: 'tall_seagrass_bottom', top: 'tall_seagrass_top' };

    // XZ (single)
    case 'CRIMSON_ROOTS': return { single: 'crimson_roots' };
    case 'WARPED_ROOTS': return { single: 'warped_roots' };
    case 'NETHER_SPROUTS': return { single: 'nether_sprouts' };
    case 'HANGING_ROOTS': return { single: 'hanging_roots' };
    case 'MANGROVE_PROPAGULE': return { single: 'mangrove_propagule' };
    // Bamboo "sapling" (shoot) uses the stage0 texture in vanilla.
    // (The block model's texture is `block/bamboo_stage0`, not `bamboo_sapling`.)
    case 'BAMBOO_SAPLING': return { single: 'bamboo_stage0' };
    case 'BAMBOO':
      // Bamboo is a multi-model block in-game; as a simple preview, use the stalk texture.
      return { single: 'bamboo_stalk' };
    case 'POINTED_DRIPSTONE': return { single: 'pointed_dripstone_up_tip' };

    // Flowers (XZ)
    case 'DANDELION': return { single: 'dandelion' };
    case 'TORCHFLOWER': return { single: 'torchflower' };
    case 'POPPY': return { single: 'poppy' };
    case 'BLUE_ORCHID': return { single: 'blue_orchid' };
    case 'ALLIUM': return { single: 'allium' };
    case 'AZURE_BLUET': return { single: 'azure_bluet' };
    case 'RED_TULIP': return { single: 'red_tulip' };
    case 'ORANGE_TULIP': return { single: 'orange_tulip' };
    case 'WHITE_TULIP': return { single: 'white_tulip' };
    case 'PINK_TULIP': return { single: 'pink_tulip' };
    case 'OXEYE_DAISY': return { single: 'oxeye_daisy' };
    case 'CORNFLOWER': return { single: 'cornflower' };
    case 'WITHER_ROSE': return { single: 'wither_rose' };
    case 'LILY_OF_THE_VALLEY': return { single: 'lily_of_the_valley' };

    case 'OPEN_EYEBLOSSOM': return { single: 'open_eyeblossom' };
    case 'CLOSED_EYEBLOSSOM': return { single: 'closed_eyeblossom' };

    default: {
      // Best-effort fallback: lower-case id.
      return { single: String(id || '').toLowerCase() };
    }
  }
}function makePlantMaterial(mapTex){
  const m = new THREE.MeshBasicMaterial({
    map: mapTex,
    transparent: true,
    alphaTest: 0.5,
    // IMPORTANT (Minecraft parity): plants are not mirrored when viewed from the back.
    // A single DoubleSide plane in WebGL appears mirrored on the backface.
    // We duplicate planes instead (see makeGrassMesh).
    side: THREE.FrontSide,
    depthWrite: true,
  });
  return m;
}

// Materials for the reference grass block cube (6 faces, 3 textures).
// NOTE: The actual per-face textured materials are created inside buildMinecraftModelGroup()
// when perFaceMaterials=true. These base/placement materials act as templates (tint/opacity/etc.).
function ensureCubeMats(){
  const key = 'CUBE';
  if (blockCubeMatCache.has(key)) return blockCubeMatCache.get(key);

  const base = new THREE.MeshBasicMaterial({
    map: PLACEHOLDER_TEX_MIP,
    color: 0xdddddd,
    opacity: grassOpacity,
    transparent: (grassOpacity < 1),
    side: THREE.FrontSide,
    depthWrite: true,
  });

  const placement = base.clone();
  placement.opacity = clamp(grassOpacity * 0.65, 0, 1);
  placement.transparent = true;

  const mats = { base, placement };
  blockCubeMatCache.set(key, mats);
  return mats;
}

/**
 * Returns cached materials for a foliage id.
 * For single: { model:'single', base, selected, placement }
 * For double: { model:'double', baseBottom, baseTop, selectedBottom, selectedTop, placementBottom, placementTop }
 */
function ensureFoliageMats(id){
  const key = String(id || 'SHORT_GRASS');
  if (foliageMatCache.has(key)) return foliageMatCache.get(key);

  const def = FOLIAGE.byId.get(key);
  const model = def?.model ?? 'single';
  const names = texNamesForFoliage(key);
  const useOverlayTint = isGrayscaleFoliage(key);
  const baseTintHex = useOverlayTint ? GRAYSCALE_FOLIAGE_OVERLAY_HEX : 0xdddddd;
  const placementTintHex = useOverlayTint ? GRAYSCALE_FOLIAGE_OVERLAY_HEX : 0xd6d6d6;

  if (model === 'double') {
    const baseBottom = makePlantMaterial(PLACEHOLDER_TEX_NO_MIP);
    const baseTop = makePlantMaterial(PLACEHOLDER_TEX_NO_MIP);
    baseBottom.color.setHex(baseTintHex);
    baseTop.color.setHex(baseTintHex);

    const selectedBottom = baseBottom.clone();
    const selectedTop = baseTop.clone();
    selectedBottom.color.setHex(0xdb8484);
    selectedTop.color.setHex(0xdb8484);
    selectedBottom.depthTest = true;
    selectedTop.depthTest = true;
    selectedBottom.depthWrite = true;
    selectedTop.depthWrite = true;

    const placementBottom = baseBottom.clone();
    const placementTop = baseTop.clone();
    placementBottom.color.setHex(placementTintHex);
    placementTop.color.setHex(placementTintHex);
    placementBottom.opacity = clamp(grassOpacity * 0.65, 0, 1);
    placementTop.opacity = clamp(grassOpacity * 0.65, 0, 1);
    placementBottom.transparent = true;
    placementTop.transparent = true;
    placementBottom.depthWrite = false;
    placementTop.depthWrite = false;

    const mats = {
      model: 'double',
      baseBottom, baseTop,
      selectedBottom, selectedTop,
      placementBottom, placementTop,
      __texBottom: names.bottom ?? names.single,
      __texTop: names.top ?? names.single,
    };
    foliageMatCache.set(key, mats);

    // Hide placeholder until textures arrive (prevents white flash during streaming).
    for (const m of [baseBottom, baseTop, selectedBottom, selectedTop, placementBottom, placementTop]) hideMaterialForLoad(m);

    // Async load actual textures + apply to all mats.
    (async () => {
      const bt = await getBlockTexture(mats.__texBottom);
      const tt = await getBlockTexture(mats.__texTop);
      for (const m of [baseBottom, selectedBottom, placementBottom]) { m.map = bt; m.needsUpdate = true; revealMaterialAfterLoad(m); }
      for (const m of [baseTop, selectedTop, placementTop]) { m.map = tt; m.needsUpdate = true; revealMaterialAfterLoad(m); }

      // Tall seagrass: keep manual frame selection in sync.
      if (key === 'TALL_SEAGRASS') {
        applyTallSeagrassFrameToCachedMats();
      }
    })();

    return mats;
  }

  // single
  const base = makePlantMaterial(PLACEHOLDER_TEX_NO_MIP);
  base.color.setHex(baseTintHex);
  const selected = base.clone();
  selected.color.setHex(0xdb8484);
  selected.depthTest = true;
  selected.depthWrite = true;

  const placement = base.clone();
  placement.color.setHex(placementTintHex);
  placement.opacity = clamp(grassOpacity * 0.65, 0, 1);
  placement.transparent = true;
  placement.depthWrite = false;

  const mats = { model: 'single', base, selected, placement, __tex: names.single };
  foliageMatCache.set(key, mats);

  // Hide placeholder until texture arrives.
  for (const m of [base, selected, placement]) hideMaterialForLoad(m);

  (async () => {
    const t0 = await getBlockTexture(mats.__tex);

    // Bamboo needs per-user UV shifting, so it must NOT share the global cached texture object.
    const t = (key === 'BAMBOO') ? t0.clone() : t0;

    if (key === 'BAMBOO') {
      applyBambooUvToTexture(t);
    }

    for (const m of [base, selected, placement]) { m.map = t; m.needsUpdate = true; revealMaterialAfterLoad(m); }
  })();

return mats;
}

/**
 * Mangrove propagule uses different vanilla models and textures depending on whether it is
 * on the ground or hanging (age 0..4). We keep separate materials per variant so the
 * correct texture is loaded and reused.
 */
function ensurePropaguleMats(variantKey){
  const v = String(variantKey || 'ground');
  const cacheKey = `MANGROVE_PROPAGULE__${v}`;
  if (foliageMatCache.has(cacheKey)) return foliageMatCache.get(cacheKey);

  const base = makePlantMaterial(PLACEHOLDER_TEX);
  base.color.setHex(0xdddddd);
  const selected = base.clone();
  selected.color.setHex(0xdb8484);
  selected.depthTest = true;
  selected.depthWrite = true;

  const placement = base.clone();
  placement.color.setHex(0xd6d6d6);
  placement.opacity = clamp(grassOpacity * 0.65, 0, 1);
  placement.transparent = true;
  placement.depthWrite = false;

  const mats = { model: 'propagule', base, selected, placement, __tex: propaguleModelToTextureName(v), __variant: v };
  foliageMatCache.set(cacheKey, mats);

  // Hide placeholder until texture arrives.
  for (const m of [base, selected, placement]) hideMaterialForLoad(m);

  (async () => {
    // Prefer the texture referenced by the model JSON itself (more robust than manual mapping).
    const modelName = propaguleModelToBlockModelName(v);
    const model = await getResolvedBlockModelJSON(modelName);
    const inferred = textureNameFromMcModel(model);
    const texKey = inferred || mats.__tex;
    const t = await getBlockTexture(texKey);
    for (const m of [base, selected, placement]) { m.map = t; m.needsUpdate = true; revealMaterialAfterLoad(m); }
  })();

  return mats;
}

// Apply initial grass opacity to placement materials.
syncGrassOpacityUI();

// Initial label
syncGrassTextureIndicator();

// Initialize indicator to match the default texture.
syncGrassTextureIndicator();

// We build the grass directly from the Minecraft model JSON (tinted_cross.json)
// so that rotations (including `rescale: true`) match the in-game geometry.
const RESCALE_22_5 = 1 / Math.cos(0.39269908169872414) - 1; // 22.5 deg
const RESCALE_45   = 1 / Math.cos(Math.PI / 4) - 1;         // 45 deg

/**
 * Compute the per-axis rescale factor used by Minecraft's FaceBakery when
 * BlockElementRotation.rescale() is true.
 */
function mcRescaleVec(axis, angleDeg, rescale) {
  if (!rescale) return new THREE.Vector3(1, 1, 1);
  const a = Math.abs(angleDeg);
  const k = (a === 22.5) ? RESCALE_22_5 : RESCALE_45;

  // In FaceBakery.applyElementRotation, the base vector is:
  // X axis -> (0,1,1)
  // Y axis -> (1,0,1)
  // Z axis -> (1,1,0)
  let v;
  if (axis === 'x') v = new THREE.Vector3(0, 1, 1);
  else if (axis === 'y') v = new THREE.Vector3(1, 0, 1);
  else v = new THREE.Vector3(1, 1, 0);

  v.multiplyScalar(k);
  v.addScalar(1);
  return v;
}

const grassModel = TINTED_CROSS_MODEL;

// --- Generic Minecraft "block model" renderer (subset) ---
// We implement just enough of vanilla block model JSON to render mangrove propagules:
// - elements: from/to boxes (including 0-thickness "planes")
// - faces: per-face UV mapping + optional rotation (0/90/180/270)
// - element rotation with rescale, using the same mcRescaleVec() parity helper as plants

function rotateUvQuad(quad, rotDeg){
  // quad is [[u,v], [u,v], [u,v], [u,v]] in PlaneGeometry vertex order: TL, TR, BL, BR
  const r = ((Number(rotDeg) || 0) % 360 + 360) % 360;
  if (r === 0) return quad;
  // Minecraft rotates face UVs clockwise in 90 deg steps.
  if (r === 90)  return [quad[2], quad[0], quad[3], quad[1]]; // clockwise
  if (r === 180) return [quad[3], quad[2], quad[1], quad[0]];
  if (r === 270) return [quad[1], quad[3], quad[0], quad[2]];
  return quad;
}

function uvQuadFromPix(uvPix, rotDeg){
  // Returns [[u,v] TL, TR, BL, BR] normalized 0..1.
  const uv = (Array.isArray(uvPix) && uvPix.length >= 4) ? uvPix : [0,0,16,16];
  const u1 = uv[0] / 16;
  const v1t = 1 - (uv[1] / 16); // top
  const u2 = uv[2] / 16;
  const v2b = 1 - (uv[3] / 16); // bottom
  let quad = [
    [u1, v1t], // TL
    [u2, v1t], // TR
    [u1, v2b], // BL
    [u2, v2b], // BR
  ];
  return rotateUvQuad(quad, rotDeg);
}


function applyFaceUvToPlaneGeometry(geo, uvPix, rotDeg){
  if (!geo || !geo.attributes?.uv) return;
  const quad = uvQuadFromPix(uvPix, rotDeg);
  const arr = geo.attributes.uv.array;
  // PlaneGeometry uses 4 vertices with uv order TL, TR, BL, BR
  arr[0] = quad[0][0]; arr[1] = quad[0][1];
  arr[2] = quad[1][0]; arr[3] = quad[1][1];
  arr[4] = quad[2][0]; arr[5] = quad[2][1];
  arr[6] = quad[3][0]; arr[7] = quad[3][1];
  geo.attributes.uv.needsUpdate = true;
}

// Resolve a Minecraft block model texture reference to a concrete texture name.
// Examples:
//  - "#front" -> model.textures.front -> "block/sunflower_front" -> "sunflower_front"
//  - "minecraft:block/mangrove_propagule_hanging" -> "mangrove_propagule_hanging"
function resolveMcModelTextureName(model, texRef){
  if (!texRef) return null;
  let t = String(texRef);
  // Resolve indirections like "#top".
  for (let i=0; i<8 && t.startsWith('#'); i++){
    const key = t.slice(1);
    const next = model?.textures?.[key];
    if (!next) break;
    t = String(next);
  }

  // Strip namespace.
  if (t.startsWith('minecraft:')) t = t.slice('minecraft:'.length);

  // Strip directories (block/foo -> foo, item/foo -> foo).
  if (t.includes('/')) t = t.split('/').pop();
  return t || null;
}

function buildMinecraftModelGroup(model, material, { perFaceMaterials=false } = {}){
  const root = new THREE.Group();
  if (!model || !Array.isArray(model.elements)) return root;

  // Optional per-face material support (needed for blocks like sunflower_top which use multiple textures).
  // We build a multi-material array + geometry groups so the entire element shares one object transform,
  // eliminating 1px cracks that can happen when each face is a separate Mesh with its own matrix.
  const texToMatIndex = new Map();
  const materials = perFaceMaterials ? [material] : null; // index 0 = fallback base
  const perFaceMatCache = new Map();

  function matIndexForFace(face){
    if (!perFaceMaterials) return 0;
    const texName = resolveMcModelTextureName(model, face?.texture);
    if (!texName) return 0;
    if (texToMatIndex.has(texName)) return texToMatIndex.get(texName);

    const m = material.clone();
    // IMPORTANT: `material` may currently be hidden (opacity=0) while its own texture streams in.
    // If we clone that hidden material and then call hideMaterialForLoad(), we'd incorrectly
    // record a target opacity of 0 and the per-face material would stay invisible forever.
    // Use the source material's *intended* opacity instead.
    const intended = intendedOpacityOf(material, 1);
    if (Number.isFinite(intended)) m.opacity = intended;
    m.map = PLACEHOLDER_TEX;
    m.needsUpdate = true;
    hideMaterialForLoad(m);
    // Carry selection tint metadata so special-case selection logic can work.
    m.userData.__mcTexName = texName;

    // Vanilla biome-tints grass_block_top; mirror the short-grass fixed tint.
    if (texName === 'grass_block_top' && m.color) {
      m.color.setHex(GRAYSCALE_FOLIAGE_OVERLAY_HEX);
    }

    const idx = materials.length;
    materials.push(m);
    texToMatIndex.set(texName, idx);
    perFaceMatCache.set(texName, m);

    (async () => {
      const t = await getBlockTexture(texName, { useMips: true });
      m.map = t;
      m.needsUpdate = true;
      revealMaterialAfterLoad(m);
    })();

    return idx;
  }

  function pushTri(posArr, uvArr, a, b, c, uva, uvb, uvc){
    posArr.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]);
    uvArr.push(uva[0],uva[1], uvb[0],uvb[1], uvc[0],uvc[1]);
  }

  for (const elmt of model.elements) {
    const from = (elmt.from ?? [0,0,0]).map(v => f(v / 16));
    const to   = (elmt.to   ?? [16,16,16]).map(v => f(v / 16));

    const x0 = from[0], y0 = from[1], z0 = from[2];
    const x1 = to[0],   y1 = to[1],   z1 = to[2];

    const faces = elmt.faces ?? {};
    const elementGroup = new THREE.Group();

    const pos = [];
    const uvs = [];
    const groups = []; // {start,count,matIndex}

    function addFace(which){
      const face = faces[which];
      if (!face) return;

      const uvPix = face.uv ?? [0,0,16,16];
      const rot = face.rotation ?? 0;
      const quadUV = uvQuadFromPix(uvPix, rot); // TL, TR, BL, BR

      // Match the previous PlaneGeometry+rotation pipeline exactly (but without per-face Mesh transforms).
      let TL, TR, BL, BR;

      if (which === 'south') {
        TL = [x0, y1, z1]; TR = [x1, y1, z1]; BL = [x0, y0, z1]; BR = [x1, y0, z1];
      } else if (which === 'north') {
        TL = [x1, y1, z0]; TR = [x0, y1, z0]; BL = [x1, y0, z0]; BR = [x0, y0, z0];
      } else if (which === 'west') {
        TL = [x0, y1, z0]; TR = [x0, y1, z1]; BL = [x0, y0, z0]; BR = [x0, y0, z1];
      } else if (which === 'east') {
        TL = [x1, y1, z1]; TR = [x1, y1, z0]; BL = [x1, y0, z1]; BR = [x1, y0, z0];
      } else if (which === 'up') {
        TL = [x0, y1, z0]; TR = [x1, y1, z0]; BL = [x0, y1, z1]; BR = [x1, y1, z1];
      } else if (which === 'down') {
        TL = [x0, y0, z1]; TR = [x1, y0, z1]; BL = [x0, y0, z0]; BR = [x1, y0, z0];
      } else {
        return;
      }

      const start = (pos.length / 3);
      // Two triangles: TL, BL, TR and BL, BR, TR (same as PlaneGeometry)
      pushTri(pos, uvs, TL, BL, TR, quadUV[0], quadUV[2], quadUV[1]);
      pushTri(pos, uvs, BL, BR, TR, quadUV[2], quadUV[3], quadUV[1]);

      if (perFaceMaterials) {
        const mi = matIndexForFace(face);
        groups.push({ start, count: 6, materialIndex: mi });
      }
    }

    addFace('north');
    addFace('south');
    addFace('east');
    addFace('west');
    addFace('up');
    addFace('down');

    if (pos.length > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

      if (perFaceMaterials) {
        // Ensure we have at least one group; if a face had no texture, it will use material index 0.
        for (const g of groups) geo.addGroup(g.start, g.count, g.materialIndex);
      }

      const mesh = new THREE.Mesh(geo, perFaceMaterials ? materials : material);
      mesh.userData.__isGrassPart = true;
      elementGroup.add(mesh);
    }

    // Apply element rotation (with rescale) exactly like Minecraft (same approach as makeGrassMesh).
    if (elmt.rotation) {
      const axis = String(elmt.rotation.axis).toLowerCase();
      const angleDeg = Number(elmt.rotation.angle ?? 0);
      const origin = (elmt.rotation.origin ?? [8, 8, 8]).map(v => f(v / 16));
      const rescale = Boolean(elmt.rotation.rescale);
      const sVec = mcRescaleVec(axis, angleDeg, rescale);

      const scaleGroup = new THREE.Group();
      scaleGroup.position.set(origin[0], origin[1], origin[2]);
      scaleGroup.scale.copy(sVec);

      const rotGroup = new THREE.Group();
      if (axis === 'x') rotGroup.rotation.x = THREE.MathUtils.degToRad(angleDeg);
      else if (axis === 'y') rotGroup.rotation.y = THREE.MathUtils.degToRad(angleDeg);
      else rotGroup.rotation.z = THREE.MathUtils.degToRad(angleDeg);

      // Offset the element so rotation happens around origin.
      elementGroup.position.set(-origin[0], -origin[1], -origin[2]);
      rotGroup.add(elementGroup);
      scaleGroup.add(rotGroup);
      root.add(scaleGroup);
    } else {
      root.add(elementGroup);
    }
  }

  return root;
}

function makeAsyncMinecraftModelMesh(modelName, material, opts = undefined){
  const root = new THREE.Group();
  root.userData.__isGrassPart = true;

  (async () => {
    const model = await getResolvedBlockModelJSON(modelName);
    if (!model) return;
    // Remove any old children and rebuild.
    while (root.children.length) {
      const c = root.children.pop();
      if (c) root.remove(c);
    }
    const built = buildMinecraftModelGroup(model, material, opts);
    root.add(...built.children);
    try { requestRender(); } catch (_) {}

    // Some models are built asynchronously (e.g., tall seagrass top/bottom, sunflower top).
    // If something is currently selected, re-apply selection materials now that real meshes exist.
    // (Otherwise the selected tint would only appear after the next interaction.)
    try {
      // IMPORTANT: Placement previews are not part of the selection set and should never
      // mutate placement defaults. Calling setSelected() here can inadvertently overwrite
      // placement state (e.g., cube top-face UV rotation) while the user is in placement.
      // We only need to re-apply the selection tint for *placed* instances.
      const isPlacementPreview = !!(root?.userData?.__placementPreview || root?.userData?.__previewFoliageId);
      if (!isPlacementPreview && typeof selectedId !== 'undefined' && selectedId != null) {
        setSelected(selectedId);
      }
    } catch (_) {
      // ignore
    }
  })();

  return root;
}

function makeGrassMesh(mat){
  const mtl = mat ?? makePlantMaterial(PLACEHOLDER_TEX);
  if (!mat) hideMaterialForLoad(mtl);
  const root = new THREE.Group();

  for (const elmt of (grassModel.elements ?? [])) {
    const from = elmt.from.map(v => v / 16);
    const to   = elmt.to.map(v => v / 16);

    const cx = (from[0] + to[0]) / 2;
    const cy = (from[1] + to[1]) / 2;
    const cz = (from[2] + to[2]) / 2;

    const sx = Math.abs(to[0] - from[0]);
    const sy = Math.abs(to[1] - from[1]);
    const sz = Math.abs(to[2] - from[2]);

    // Determine which axis is "flat" (size ~ 0). Our model uses true planes.
    const eps = 1e-6;
    let plane;
    let planeKind = 'box';
    if (sz < eps) {
      // XY plane (constant Z)
      plane = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), mtl);
      plane.position.set(cx, cy, cz);
      planeKind = 'xy';
    } else if (sx < eps) {
      // YZ plane (constant X)
      plane = new THREE.Mesh(new THREE.PlaneGeometry(sz, sy), mtl);
      plane.rotation.y = Math.PI / 2;
      plane.position.set(cx, cy, cz);
      planeKind = 'yz';
    } else if (sy < eps) {
      // XZ plane (constant Y) - not used by tinted_cross but supported
      plane = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), mtl);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(cx, cy, cz);
      planeKind = 'xz';
    } else {
      // Fallback: thin box (shouldn't happen for tinted_cross)
      plane = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), mtl);
      plane.position.set(cx, cy, cz);
      planeKind = 'box';
    }

    // Minecraft parity: the plant quads must look identical from both sides.
    // Instead of DoubleSide (mirrors UVs), we duplicate the plane and flip it.
    if (plane.isMesh && plane.geometry?.type === 'PlaneGeometry') {
      const back = plane.clone();
      // Use FrontSide on both meshes so UVs remain consistent.
      back.material = mtl;
      if (planeKind === 'xz') {
        back.rotation.x += Math.PI;
      } else {
        // Works for XY and YZ planes (and any plane whose normal changes under Y-rotation).
        back.rotation.y += Math.PI;
      }
      // Put both under a local group so element rotation/rescale affects them together.
      // Move the world-space position onto the group so later element-rotation code
      // can treat `plane` uniformly as (Mesh|Group) with the correct position.
      const g = new THREE.Group();
      g.position.copy(plane.position);
      plane.position.set(0, 0, 0);
      back.position.set(0, 0, 0);
      g.add(plane);
      g.add(back);
      plane = g;
    }

    // Apply element rotation (with rescale) exactly like Minecraft:
    // v' = origin + S * (R * (v - origin))
    if (elmt.rotation) {
      const axis = String(elmt.rotation.axis).toLowerCase();
      const angleDeg = Number(elmt.rotation.angle ?? 0);
      const origin = (elmt.rotation.origin ?? [8, 8, 8]).map(v => v / 16);
      const rescale = Boolean(elmt.rotation.rescale);
      const sVec = mcRescaleVec(axis, angleDeg, rescale);

      const scaleGroup = new THREE.Group();
      scaleGroup.position.set(origin[0], origin[1], origin[2]);
      scaleGroup.scale.copy(sVec);

      const rotGroup = new THREE.Group();
      rotGroup.position.set(0, 0, 0);
      if (axis === 'x') rotGroup.rotation.x = THREE.MathUtils.degToRad(angleDeg);
      else if (axis === 'y') rotGroup.rotation.y = THREE.MathUtils.degToRad(angleDeg);
      else rotGroup.rotation.z = THREE.MathUtils.degToRad(angleDeg);

      // Put the plane under rotGroup, offset from origin.
      // (plane may be a Mesh or a Group containing front+back meshes)
      plane.position.sub(new THREE.Vector3(origin[0], origin[1], origin[2]));
      rotGroup.add(plane);
      scaleGroup.add(rotGroup);
      root.add(scaleGroup);
    } else {
      root.add(plane);
    }
  }

  // Tag meshes for raycasting.
  root.traverse(obj => {
    if (obj.isMesh) obj.userData.__isGrassPart = true;
  });

  return root;
}

function makePlacementPreviewMesh(foliageId = 'SHORT_GRASS'){
  if (foliageId === 'CUBE') {
    const cmats = ensureCubeMats();
    const modelName = ensureCubeModelRegistered(activeCubeBlockType, cubeTopPlacementRot);
    return makeAsyncMinecraftModelMesh(modelName, cmats.placement, { perFaceMaterials: true });
  }
  const mats = ensureFoliageMats(foliageId);
  const variant = getActiveVariantFor(foliageId);

  if (foliageId === 'BAMBOO') {
    return makeBambooMesh(mats.placement, variant?.height ?? 1, { modelSize: variant?.modelSize });
  }
  if (foliageId === 'POINTED_DRIPSTONE') {
    // In placement mode we want a visible preview even while textures are still streaming.
    return makeDripstoneStackMesh(mats.placement, variant?.height ?? 1, variant?.dir ?? 'up', { preview: true });
  }

  if (foliageId === 'MANGROVE_PROPAGULE') {
    const v = foliageSupportsPropaguleModel(foliageId) ? activePropaguleModel : 'ground';
    const modelName = propaguleModelToBlockModelName(v);
    // Use a variant-specific material key so the correct texture is loaded.
    const pmats = ensurePropaguleMats(v);
    return makeAsyncMinecraftModelMesh(modelName, pmats.placement);
  }

  // Sunflower uses a custom top model (flower head) rather than a second crossed-stalk.
  if (foliageId === 'SUNFLOWER') {
    return makeSunflowerDoubleMesh(mats.placementBottom, mats.placementTop);
  }

  // Small dripleaf is a two-block plant with its own top/bottom block models and multiple textures.
  // Render the vanilla models so textures like stem/side/top load correctly.
  if (foliageId === 'SMALL_DRIPLEAF') {
    return makeSmallDripleafDoubleMesh(mats.placement, mats.placement);
  }

  // Tall seagrass uses vanilla tall_seagrass_bottom/top models (template_seagrass geometry).
  if (foliageId === 'TALL_SEAGRASS') {
    return makeTallSeagrassDoubleMesh(mats.placementBottom, mats.placementTop);
  }

  // Pitcher plant uses dedicated top/bottom block models (with a slight overlap between halves).
  if (foliageId === 'PITCHER_PLANT') {
    return makePitcherPlantDoubleMesh(mats.placementBottom, mats.placementTop);
  }

  if (mats.model === 'double') {
    return makeTallGrassMesh(mats.placementBottom, mats.placementTop);
  }
  return makeGrassMesh(mats.placement);
}

function makePitcherPlantDoubleMesh(bottomMat, topMat){
  const root = new THREE.Group();

  const bottom = makeAsyncMinecraftModelMesh('pitcher_plant_bottom', bottomMat);
  bottom.position.set(0, 0, 0);
  bottom.userData.__tallPart = 'bottom';
  bottom.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'bottom'; });

  const top = makeAsyncMinecraftModelMesh('pitcher_plant_top', topMat);
  top.position.set(0, 1, 0);
  top.userData.__tallPart = 'top';
  top.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'top'; });

  root.add(bottom);
  root.add(top);

  root.traverse(obj => {
    if (obj.isMesh) obj.userData.__isGrassPart = true;
  });

  return root;
}

function makeTallSeagrassDoubleMesh(bottomMat, topMat){
  const root = new THREE.Group();

  const bottom = makeAsyncMinecraftModelMesh('tall_seagrass_bottom', bottomMat);
  bottom.position.set(0, 0, 0);
  bottom.userData.__tallPart = 'bottom';
  bottom.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'bottom'; });

  const top = makeAsyncMinecraftModelMesh('tall_seagrass_top', topMat);
  top.position.set(0, 1, 0);
  top.userData.__tallPart = 'top';
  top.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'top'; });

  root.add(bottom);
  root.add(top);

  root.traverse(obj => {
    if (obj.isMesh) obj.userData.__isGrassPart = true;
  });

  return root;
}

function makeSmallDripleafDoubleMesh(bottomMat, topMat){
  // Vanilla models:
  //  - https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/refs/heads/26.1-snapshot-3/assets/minecraft/models/block/small_dripleaf_bottom.json
  //  - https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/refs/heads/26.1-snapshot-3/assets/minecraft/models/block/small_dripleaf_top.json
  // Vanilla textures:
  //  - small_dripleaf_stem_bottom.png, small_dripleaf_side.png, small_dripleaf_stem_top.png, small_dripleaf_top.png
  const root = new THREE.Group();

  // Bottom: crossed stem planes (single texture)
  const bottom = makeAsyncMinecraftModelMesh('small_dripleaf_bottom', bottomMat, { perFaceMaterials: true });
  bottom.position.set(0, 0, 0);
  bottom.userData.__tallPart = 'bottom';
  bottom.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'bottom'; });

  // Top: leaf planes + stem, multiple textures.
  // Wrap in a pivot group so we can rotate around the block center (vanilla "facing" style rotation).
  const top = makeAsyncMinecraftModelMesh('small_dripleaf_top', topMat, { perFaceMaterials: true });
  top.userData.__tallPart = 'top';
  top.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'top'; });

  const topPivot = new THREE.Group();
  topPivot.position.set(0.5, 1.5, 0.5); // center of the *top* block cell
  topPivot.userData.__tallPart = 'top';
  topPivot.userData.__smallDripleafTopPivot = true;

  // Place the model under the pivot so its original (0,1,0) block-corner origin is preserved.
  top.position.set(-0.5, -0.5, -0.5);
  topPivot.add(top);

  root.add(bottom);
  root.add(topPivot);

  // Cache pivot for quick lookup.
  root.userData.__smallDripleafTopPivot = topPivot;

  // Tag meshes for raycasting.
  root.traverse(obj => {
    if (obj.isMesh) obj.userData.__isGrassPart = true;
  });

  return root;
}



function makeSunflowerDoubleMesh(bottomMat, topMat){
  const root = new THREE.Group();

  const bottom = makeGrassMesh(bottomMat);
  bottom.position.set(0, 0, 0);
  bottom.userData.__tallPart = 'bottom';
  bottom.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'bottom'; });

  // Top: render the vanilla sunflower_top block model (uses sunflower_top/front/back textures).
  const top = makeAsyncMinecraftModelMesh('sunflower_top', topMat, { perFaceMaterials: true });
  top.position.set(0, 1, 0);
  top.userData.__tallPart = 'top';
  top.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'top'; });

  root.add(bottom);
  root.add(top);

  // Tag meshes for raycasting.
  root.traverse(obj => {
    if (obj.isMesh) obj.userData.__isGrassPart = true;
  });

  return root;
}


function makeTallGrassMesh(baseBottomMat, baseTopMat){
  const root = new THREE.Group();

  const bottom = makeGrassMesh(baseBottomMat);
  bottom.position.set(0, 0, 0);
  bottom.userData.__tallPart = 'bottom';
  bottom.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'bottom'; });

  const top = makeGrassMesh(baseTopMat);
  top.position.set(0, 1, 0); // one block above
  top.userData.__tallPart = 'top';
  top.traverse(obj => { if (obj.isMesh) obj.userData.__tallPart = 'top'; });

  root.add(bottom);
  root.add(top);

  // Tag meshes for raycasting.
  root.traverse(obj => {
    if (obj.isMesh) obj.userData.__isGrassPart = true;
  });

  return root;
}


function tagAsFoliagePart(root){
  root.traverse(obj => {
    if (obj.isMesh) obj.userData.__isGrassPart = true;
  });
  return root;
}

// Bamboo: render using the vanilla block model proportions (a thin 2x2 stalk in the block center).
// We keep it simple: one 2/16 wide box per block stacked to the chosen height.

function makeBambooStackMesh(mat, height=1){
  const root = new THREE.Group();
  const h = Math.max(1, Math.min(16, Math.trunc(height)));

  // Vanilla bamboo stalk is a thin 2x2 post centered in the block, with UVs sampling only the
  // 2px-wide stalk strip from bamboo_stalk.png (to avoid "smearing" the whole texture).
  const geo = new THREE.BoxGeometry(2/16, 1, 2/16);

  // Remap UVs: use the center stalk strip [7..9] on the U axis (2px wide), full V.
  // This matches the vanilla block model better than using the whole 16px width.
  const u0 = 7/16, u1 = 9/16;
  const uv = geo.attributes.uv;
  for (let i=0; i<uv.count; i++){
    const u = uv.getX(i);
    const v = uv.getY(i);
    uv.setXY(i, (u < 0.5 ? u0 : u1), v);
  }
  uv.needsUpdate = true;

  for (let i=0;i<h;i++){
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0.5, i+0.5, 0.5);
    root.add(mesh);
  }
  return tagAsFoliagePart(root);
}

// --- Bamboo model size support (2x2 procedural or 3x3 via local JSON model) ---
const LOCAL_BAMBOO_3X3_MODEL = {"textures":{"all":"block/bamboo_stalk","particle":"block/bamboo_stalk"},"elements":[{"from":[7,0,7],"to":[9,16,9],"faces":{"down":{"uv":[13,4,15,6],"texture":"#all","cullface":"down"},"up":{"uv":[13,0,15,2],"texture":"#all","cullface":"up"},"north":{"uv":[0,0,2,16],"texture":"#all"},"south":{"uv":[0,0,2,16],"texture":"#all"},"west":{"uv":[0,0,2,16],"texture":"#all"},"east":{"uv":[0,0,2,16],"texture":"#all"}}}]};
let bamboo3x3ModelJsonPromise = Promise.resolve(LOCAL_BAMBOO_3X3_MODEL);
function getLocalBamboo3x3ModelJSON(){
  return bamboo3x3ModelJsonPromise;
}

function makeBambooMesh(mat, height=1, opts = {}){
  const ms = String((opts && opts.modelSize) || bambooModelSize || '2x2');
  return (ms === '3x3')
    ? makeBamboo3x3StackMesh(mat, height)
    : makeBambooStackMesh(mat, height);
}

// When we scale the vanilla 2x2 bamboo JSON element up to a 3x3 stalk, we must also widen the
// UV rectangles so we sample a 3px-wide strip (instead of stretching a 2px strip across 3px).
function adjustBamboo3x3ModelUVs(model){
  if (!model || !Array.isArray(model.elements)) return model;

  // Deep-clone so we don't mutate the cached/fetched JSON.
  let m;
  try { m = JSON.parse(JSON.stringify(model)); }
  catch { return model; }

  function widenUv(uv, wantW, wantH){
    if (!Array.isArray(uv) || uv.length < 4) return;
    const u0 = Number(uv[0]), v0 = Number(uv[1]), u1 = Number(uv[2]), v1 = Number(uv[3]);
    if (!Number.isFinite(u0) || !Number.isFinite(v0) || !Number.isFinite(u1) || !Number.isFinite(v1)) return;
    const w = u1 - u0;
    const h = v1 - v0;

    // Only adjust the common 2px-wide (and 2px-tall) rectangles used by the thin stalk.
    // Keep the starting corner the same so the user's UV offset controls continue to work.
    if (Math.abs(w - 2) < 1e-6) uv[2] = u0 + wantW;
    if (wantH != null && Math.abs(h - 2) < 1e-6) uv[3] = v0 + wantH;
  }

  for (const elmt of m.elements) {
    const faces = elmt?.faces;
    if (!faces) continue;

    // Side faces: widen to 3px, keep full-height.
    for (const k of ['north','south','east','west']) {
      if (faces[k]?.uv) widenUv(faces[k].uv, 3, null);
    }

    // Caps: widen + heighten to 3x3 if they're the 2x2 vanilla cap UVs.
    for (const k of ['up','down']) {
      if (faces[k]?.uv) widenUv(faces[k].uv, 3, 3);
    }
  }
  return m;
}

function makeBamboo3x3StackMesh(mat, height=1){
  const root = new THREE.Group();
  const h = Math.max(1, Math.min(16, Math.trunc(height)));
  root.userData.__isGrassPart = true;

  (async () => {
    const model = await getLocalBamboo3x3ModelJSON();
    if (!model) return;

    const uvFixedModel = adjustBamboo3x3ModelUVs(model);

    // Remove any old children and rebuild.
    while (root.children.length) {
      const c = root.children.pop();
      if (c) root.remove(c);
    }

    // Build one segment from the provided JSON model, then clone it for each height level.
    const seg = buildMinecraftModelGroup(uvFixedModel, mat);

    // Scale only XZ to turn the 2x2 post into a 3x3 post, keeping it centered in the block.
    const pivot = new THREE.Group();
    pivot.position.set(0.5, 0, 0.5);
    seg.position.set(-0.5, 0, -0.5);
    pivot.add(seg);
    pivot.scale.set(1.5, 1, 1.5);

    for (let i=0;i<h;i++){ 
      const part = pivot.clone(true);
      part.position.set(0.5, i, 0.5);
      root.add(part);
    }

    // If selection changed while the async model was loading, re-apply selection materials now.
    try { setSelected(selectedId); } catch (_) {}
  })();

  return tagAsFoliagePart(root);
}



// Pointed dripstone: use the vanilla model approach (two crossed planes) with the correct per-segment textures.
// Vanilla assets define a shared "pointed_dripstone" parent model (crossed planes rotated 45 deg), and variants
// are just different textures (up_tip, up_frustum, up_middle, up_base, and the down_* equivalents).
//
// Height selector:
//  - h=1: tip
//  - h=2: frustum + tip
//  - h=3: base + frustum + tip
//  - h>=4: base + middle*(h-3) + frustum + tip

function makeDripstoneStackMesh(baseMat, height=1, dir='up', opts = {}){
  const root = new THREE.Group();
  const h = Math.max(1, Math.min(16, Math.trunc(height)));
  const d = (dir === 'down') ? 'down' : 'up';

  const isPreview = !!(opts && opts.preview);
  const baseTargetOpacity = intendedOpacityOf(baseMat, 1);

  // Bottom-to-top segment texture names in the assets repo.
  function segListUp(hh){
    if (hh === 1) return ['pointed_dripstone_up_tip'];
    if (hh === 2) return ['pointed_dripstone_up_frustum','pointed_dripstone_up_tip'];
    if (hh === 3) return ['pointed_dripstone_up_base','pointed_dripstone_up_frustum','pointed_dripstone_up_tip'];
    const mid = new Array(hh - 3).fill('pointed_dripstone_up_middle');
    return ['pointed_dripstone_up_base', ...mid, 'pointed_dripstone_up_frustum', 'pointed_dripstone_up_tip'];
  }
  function segListDown(hh){
    // Tip at the bottom, base at the top.
    if (hh === 1) return ['pointed_dripstone_down_tip'];
    if (hh === 2) return ['pointed_dripstone_down_tip','pointed_dripstone_down_frustum'];
    if (hh === 3) return ['pointed_dripstone_down_tip','pointed_dripstone_down_frustum','pointed_dripstone_down_base'];
    const mid = new Array(hh - 3).fill('pointed_dripstone_down_middle');
    return ['pointed_dripstone_down_tip', 'pointed_dripstone_down_frustum', ...mid, 'pointed_dripstone_down_base'];
  }

  const texNames = (d === 'down') ? segListDown(h) : segListUp(h);

  for (let i=0;i<texNames.length;i++){
    // Clone material per segment so each can have its own map.
    const mat = baseMat.clone();
    // IMPORTANT: baseMat may be "hidden" (opacity=0) while its own texture is loading.
    // If we clone it as-is, the clone inherits opacity=0 and ends up permanently invisible.
    // Use the intended opacity (captured in baseMat.userData.__targetOpacity) instead.
    mat.opacity = baseTargetOpacity;
    mat.transparent = true;

    if (isPreview) {
      // For placement preview: don't apply the transparent placeholder map + opacity=0 hide.
      // Show a simple tinted silhouette immediately, then swap in the real texture when it arrives.
      mat.map = null;
    } else {
      // For placed meshes: hide until the real texture arrives to avoid flashing placeholders.
      mat.map = PLACEHOLDER_TEX;
      hideMaterialForLoad(mat);
    }

    mat.needsUpdate = true;

    const seg = makeGrassMesh(mat); // crossed planes (same geometry as foliage)
    // Stack direction:
    //  - 'up' grows toward +Y (base at y=0, tip at y=h-1)
    //  - 'down' should grow toward -Y (the TOP segment should sit at y=0)
    //
    // Note: segListDown() returns textures in *bottom-to-top* order (tip .. base).
    // To make a hanging dripstone grow downward from its anchor block, we flip the
    // Y placement so the last segment (base/frustum) ends up at y=0.
    const y = (d === 'down') ? (i - (texNames.length - 1)) : i;
    seg.position.set(0, y, 0);
    root.add(seg);

    (async () => {
      const t = await getBlockTexture(texNames[i]);
      mat.map = t;
      mat.needsUpdate = true;
      if (!isPreview) revealMaterialAfterLoad(mat);
    })();
  }

  return tagAsFoliagePart(root);
}


// (Legacy helper removed; handled via ensureFoliageMats + makePlacementPreviewMesh)
// --- Grass instances state ---
let nextId = 1;
/** @type {Map<number, {id:number, block:THREE.Vector3, off:{x:number,y:number,z:number}, mesh:THREE.Group}>} */
const grasses = new Map();
let selectedId = null;
let activeBlock = new THREE.Vector3(0, 0, 0);

function keyForBlock(b){ return `${b.x}|${b.y}|${b.z}`; }

/** Block occupancy map: at most one placed texture per 1x1x1 block cell. */
/** @type {Map<string, number>} */
const occupiedByBlock = new Map();

/**
 * Returns the id of the placed texture occupying this block, or null if free.
 * @param {THREE.Vector3} block
 * @param {{excludeId?: (number|null)}} [opts]
 */
function occupantAtBlock(block, opts = {}){
  const excludeId = (opts && Number.isFinite(opts.excludeId)) ? opts.excludeId : null;
  const id = occupiedByBlock.get(keyForBlock(block));
  if (id == null) return null;
  if (excludeId != null && id === excludeId) return null;
  return id;
}

function isBlockFree(block, opts = {}){
  return occupantAtBlock(block, opts) == null;
}
function grassLabel(g){
  const b = g.block;
  const o = g.off;
  const def = FOLIAGE.byId.get(g.kind);
  const name = def ? def.label : g.kind;

  let extra = '';
  if (g.variant && Number.isFinite(g.variant.height) && g.variant.height > 1) {
    extra = ` h${Math.trunc(g.variant.height)}`;
    if (g.kind === 'POINTED_DRIPSTONE' && g.variant.dir) extra += ` ${g.variant.dir}`;
  }

  if (g.kind === 'MANGROVE_PROPAGULE') {
    const v = String(g.propaguleModel || 'ground');
    extra += ` ${v.replace('_', ' ')}`;
  }

  if (g.kind === 'CUBE') {
    const ct = String(g.cubeType || 'GRASS_BLOCK').toLowerCase().replace(/_/g, ' ');
    const r = clampRotSteps4(g.cubeTopRot ?? 0) * 90;
    extra += ` ${ct}${r ? ` u${r}` : ''}`;
  }

if (g.kind === 'SMALL_DRIPLEAF') {
  const r = clampRotSteps4(g.variant?.rot ?? 0);
  extra += ` rot${r * 90}`;
}

  return `#${g.id}  ${name}${extra}  block(${b.x},${b.y},${b.z})  off(${o.x},${o.y},${o.z})`;
}


function updateGrassMeshTransform(g){
  const blockOrigin = new THREE.Vector3(g.block.x, g.block.y, g.block.z);
  // Vanilla behavior (confirmed in 1.19 decompiled code):
  // - short grass (Blocks.GRASS / Blocks.FERN) uses OffsetType.XYZ (includes vertical offset)
  // - tall grass (Blocks.TALL_GRASS) uses OffsetType.XZ (no vertical offset)
  // For OffsetType.XZ blocks (e.g. tall grass, flowers), Y is unobservable in-game.
  // We hard-lock it to offY=15 (which maps to y=0) for visual consistency.
  const oy = isYOffsetLocked(g.kind) ? 15 : g.off.y;
  const offset = offsetToVec3ForKind(g.kind, g.off.x, oy, g.off.z);
  // Minecraft renders baked model vertices in block-local space [0..1] with the origin at the
  // *block corner*, then translates by BlockState.getOffset(pos). So the correct world-space
  // placement is simply: blockPosCorner + offset.
  g.mesh.position.copy(blockOrigin.add(offset));
  try { requestRender(); } catch (_) {}
}

// --- Rebuild helpers (selected-instance variant editing) ---
function ensureBambooInstanceMat(g){
  if (!g) return null;
  // IMPORTANT: bamboo instances may use a per-instance, UV-shifted texture clone.
  // Also, our global "hide while loading" logic can temporarily set base opacity=0.
  // Always normalize the instance material's opacity from the *intended* base opacity
  // so it stays in sync with the texture opacity slider.
  if (g.__bambooMat && g.__bambooMat.isMaterial) {
    try {
      const src = ensureFoliageMats('BAMBOO')?.base;
      if (src) {
        const op = intendedOpacityOf(src, grassOpacity);
        g.__bambooMat.opacity = op;
        g.__bambooMat.transparent = (op < 1) || g.__bambooMat.transparent;
      }
    } catch (_) {}
    return g.__bambooMat;
  }
  const mats = ensureFoliageMats('BAMBOO');
  const src = mats.base;
  const m = src.clone();
  if (src.map) m.map = src.map.clone();
  // Normalize opacity (see note above).
  try {
    const op = intendedOpacityOf(src, grassOpacity);
    m.opacity = op;
    m.transparent = (op < 1) || m.transparent;
  } catch (_) {}
  g.__bambooMat = m;
  return m;
}

function rebuildBambooInstance(g){
  if (!g || g.kind !== 'BAMBOO') return;
  const h = clampInt(g.variant?.height ?? 1, 1, 16);
  const ms = String(g.variant?.modelSize || bambooModelSize || '2x2');
  const u = clampInt(g.variant?.uvU ?? bambooUvU, 0, 15);
  const v = clampInt(g.variant?.uvV ?? bambooUvV, 0, 15);

  const mat = ensureBambooInstanceMat(g);
  if (mat && mat.map) applyBambooUvToTexture(mat.map, u, v);

  const old = g.mesh;
  const newMesh = makeBambooMesh(mat, h, { modelSize: ms });
  newMesh.userData.__grassId = g.id;

  grassGroup.remove(old);
  grassGroup.add(newMesh);
  g.mesh = newMesh;

  // Best-effort dispose old geometry to limit GPU leaks.
  try {
    old?.traverse?.(obj => { if (obj.isMesh && obj.geometry) obj.geometry.dispose?.(); });
  } catch (_) {}

  updateGrassMeshTransform(g);
}

function rebuildDripstoneInstance(g){
  if (!g || g.kind !== 'POINTED_DRIPSTONE') return;
  const mats = ensureFoliageMats('POINTED_DRIPSTONE');
  const h = clampInt(g.variant?.height ?? 1, 1, 16);
  const dir = (String(g.variant?.dir) === 'down') ? 'down' : 'up';

  const old = g.mesh;
  const newMesh = makeDripstoneStackMesh(mats.base, h, dir);
  newMesh.userData.__grassId = g.id;

  grassGroup.remove(old);
  grassGroup.add(newMesh);
  g.mesh = newMesh;

  try {
    old?.traverse?.(obj => { if (obj.isMesh && obj.geometry) obj.geometry.dispose?.(); });
  } catch (_) {}

  updateGrassMeshTransform(g);
}


function setSelected(id){
  selectedId = id;
  for (const g of grasses.values()) {
    const isSel = g.id === id;

    // Some foliage uses multiple materials (per-face or per-segment) that must be preserved.
    // If we replace materials wholesale, we'd lose the correct texture mapping.
    // - Sunflower top uses the sunflower_top block model with multiple textures.
    // - Pointed dripstone stacks have one material per segment (base/middle/frustum/tip).
    // For these, just tint the existing materials to indicate selection.
    if (g.kind === 'SUNFLOWER' || g.kind === 'SMALL_DRIPLEAF' || g.kind === 'POINTED_DRIPSTONE' || g.kind === 'BAMBOO') {
      const tintHex = isSel ? 0xdb8484 : 0xdddddd;
      g.mesh.traverse(obj => {
        if (!obj.isMesh) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m && m.color) {
            m.color.setHex(tintHex);
            // Keep selection readable through other transparent foliage.
            m.depthTest = true;
            m.depthWrite = true;
          }
        }
      });
      continue;
    }

    // Cube is a reference block; keep grass_block_top tinted like short grass when not selected.
    if (g.kind === 'CUBE') {
      const selHex = 0xdb8484;
      const baseHex = 0xdddddd;
      g.mesh.traverse(obj => {
        if (!obj.isMesh) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!m || !m.color) continue;
          if (isSel) {
            m.color.setHex(selHex);
          } else {
            const texName = m.userData?.__mcTexName;
            m.color.setHex(texName === 'grass_block_top' ? GRAYSCALE_FOLIAGE_OVERLAY_HEX : baseHex);
          }
          m.depthTest = true;
          m.depthWrite = true;
        }
      });
      continue;
    }

    const mats = (g.kind === 'MANGROVE_PROPAGULE')
      ? ensurePropaguleMats(g.propaguleModel ?? activePropaguleModel)
      : ensureFoliageMats(g.kind);
    const model = mats.model;
    if (model === 'double') {
      g.mesh.traverse(obj => {
        if (!obj.isMesh) return;

        // Some double-height plants are built asynchronously (e.g., tall seagrass) so
        // the Meshes themselves may not carry __tallPart. Walk up ancestors to find it.
        let part = obj.userData.__tallPart;
        if (!part) {
          let p = obj.parent;
          for (let i = 0; i < 8 && p; i++) {
            if (p.userData && p.userData.__tallPart) { part = p.userData.__tallPart; break; }
            p = p.parent;
          }
        }

        if (isSel) obj.material = (part === 'top') ? mats.selectedTop : mats.selectedBottom;
        else obj.material = (part === 'top') ? mats.baseTop : mats.baseBottom;
      });
    } else {
      g.mesh.traverse(obj => {
        if (obj.isMesh) obj.material = isSel ? mats.selected : mats.base;
      });
    }
  }


  try { requestRender(); } catch (_) {}

	// sync UI
  if (id == null) {
    // No selection: show placement-mode controls.
    syncVariantControls();
    syncPropaguleControls();
    syncCubeControls();
    syncCubeTopRotationControls();
    syncSeagrassFrameControls();
    syncSmallDripleafRotationControls();
    syncBambooUvUI();
    updateOffsetUiMode(activeFoliageId);
    return;
  }
	const g = grasses.get(id);
	if (!g) {
    syncVariantControls();
    syncPropaguleControls();
    syncCubeControls();
    syncCubeTopRotationControls();
    syncSeagrassFrameControls();
    syncSmallDripleafRotationControls();
    syncBambooUvUI();
    updateOffsetUiMode(activeFoliageId);
    return;
  }

  // If a selectable instance supports height/direction, edit *that instance* (not the placement defaults).
  if (foliageSupportsHeight(g.kind)) {
    if (el.variantControls) el.variantControls.classList.remove('hidden');
    if (el.variantHeight) el.variantHeight.value = String(clampInt(g.variant?.height ?? 1, 1, 16));

    const showDir = foliageSupportsDir(g.kind);
    const dEl = el.variantDir;
    const dLabel = el.dirLabel ?? dEl?.parentElement;
    if (dLabel) {
      dLabel.classList.toggle('hidden', !showDir);
      dLabel.style.display = showDir ? '' : 'none';
    }
    if (dEl) dEl.value = String(g.variant?.dir ?? 'up');
  } else {
    syncVariantControls();
  }

  // Bamboo UV + model size can be edited per selected bamboo instance.
  if (g.kind === 'BAMBOO') {
    showHideBambooUvControls('BAMBOO');
    if (el.bambooUvU) el.bambooUvU.value = String(clampInt(g.variant?.uvU ?? bambooUvU, 0, 15));
    if (el.bambooUvV) el.bambooUvV.value = String(clampInt(g.variant?.uvV ?? bambooUvV, 0, 15));
    if (el.bambooModelSize) el.bambooModelSize.value = String(g.variant?.modelSize || bambooModelSize || '2x2');
  } else {
    // Placement-mode visibility/value.
    showHideBambooUvControls();
    if (isBamboo(activeFoliageId)) {
      if (el.bambooUvU) el.bambooUvU.value = String(bambooUvU);
      if (el.bambooUvV) el.bambooUvV.value = String(bambooUvV);
      if (el.bambooModelSize) el.bambooModelSize.value = String(bambooModelSize || '2x2');
    }
  }

	// Mangrove propagule: show the variant dropdown while selected, and mirror its current variant.
	if (g.kind === 'MANGROVE_PROPAGULE') {
		activePropaguleModel = String(g.propaguleModel || activePropaguleModel || 'ground');
		if (el.propaguleControls) el.propaguleControls.classList.remove('hidden');
		if (el.propaguleModel) el.propaguleModel.value = activePropaguleModel;
	} else {
		// Only show the dropdown in placement mode for propagules.
		if (!foliageSupportsPropaguleModel(activeFoliageId) && el.propaguleControls) {
			el.propaguleControls.classList.add('hidden');
		}
	}


	// Cube: mirror selected cube's texture into the cube selector.
	if (g.kind === 'CUBE') {
		activeCubeBlockType = String(g.cubeType || activeCubeBlockType || 'GRASS_BLOCK').toUpperCase();
		if (!CUBE_BLOCK_TYPE_BY_TOKEN.has(activeCubeBlockType)) activeCubeBlockType = 'GRASS_BLOCK';

		// Also mirror the selected cube's top-face UV rotation into the placement defaults.
		cubeTopPlacementRot = clampRotSteps4(g.cubeTopRot ?? cubeTopPlacementRot);
		if (el.cubeControls) el.cubeControls.classList.remove('hidden');
		if (el.cubeBlockType) el.cubeBlockType.value = activeCubeBlockType;
		if (el.cubeTopRotationControls) el.cubeTopRotationControls.classList.remove('hidden');
		if (el.cubeTopRotLabel) el.cubeTopRotLabel.textContent = `${cubeTopPlacementRot * 90}°`;
	} else {
		// Only show the cube selector when placing cubes (unless a cube is currently selected).
		if (!foliageSupportsCubeBlockType(activeFoliageId) && el.cubeControls) {
			el.cubeControls.classList.add('hidden');
		}
		if (!foliageSupportsCubeBlockType(activeFoliageId) && el.cubeTopRotationControls) {
			el.cubeTopRotationControls.classList.add('hidden');
		}
	}

  // Tall seagrass: show frame step controls when a tall seagrass instance is selected.
  if (g.kind === 'TALL_SEAGRASS') {
    if (el.seagrassFrameControls) el.seagrassFrameControls.classList.remove('hidden');
    updateSeagrassFrameLabel();
  } else {
    if (!foliageSupportsSeagrassFrame(activeFoliageId) && el.seagrassFrameControls) {
      el.seagrassFrameControls.classList.add('hidden');
    }
  }


  // Selected texture block position (separate from "active block")
  el.selBlockX.value = String(g.block.x);
  el.selBlockY.value = String(g.block.y);
  el.selBlockZ.value = String(g.block.z);
  el.offX.value = String(isPointedDripstone(g.kind) ? dripstoneRawToEff(g.off.x) : g.off.x);
  el.offY.value = String(isYOffsetLocked(g.kind) ? 15 : g.off.y);
  el.offZ.value = String(isPointedDripstone(g.kind) ? dripstoneRawToEff(g.off.z) : g.off.z);

  // Tall grass
  updateOffsetUiMode(g.kind);
  syncSmallDripleafRotationControls();

  // Tall grass never uses Y offset. Disable the Y box in the GUI while it's selected.
  if (el.offY) {
    el.offY.disabled = isYOffsetLocked(g.kind);
    if (isYOffsetLocked(g.kind)) el.offY.value = '15';
  }

  // select in list
  for (const opt of el.grassList.options) {
    opt.selected = Number(opt.value) === id;
  }
}

function refreshGrassList(){
  const prev = selectedId;
  el.grassList.innerHTML = '';
  const ordered = [...grasses.values()]
    .filter(g => g && g.kind !== 'CUBE')
    .sort((a,b)=>a.id-b.id);
  for (const g of ordered) {
    const opt = document.createElement('option');
    opt.value = String(g.id);
    opt.textContent = grassLabel(g);
    el.grassList.appendChild(opt);
  }
  if (prev != null && grasses.has(prev)) setSelected(prev);
}

function addGrass(block, off = {x:7,y:7,z:7}, foliageId = activeFoliageId){
  const bKey = keyForBlock(block);
  if (occupiedByBlock.has(bKey)) return null;
  const id = nextId++;
  const kind = FOLIAGE.byId.has(foliageId) ? foliageId : 'SHORT_GRASS';
  const def = FOLIAGE.byId.get(kind);
  const model = def?.model ?? 'single';
  const mats = (kind === 'MANGROVE_PROPAGULE' || kind === 'CUBE') ? null : ensureFoliageMats(kind);

  // Enforce vanilla semantics: XZ-only foliage has no Y offset.
  // We store y=15 so offsetToVec3 maps to y=0.
  const fixedOff = { ...off };
  if (isYOffsetLocked(kind)) fixedOff.y = 15;

  let mesh;
  const variant = getActiveVariantFor(kind);
  let __bambooMat = null;
  if (kind === 'BAMBOO') {
    // Per-instance bamboo material so UV/model tweaks can affect only the selected bamboo.
    const src = mats.base;
    __bambooMat = src.clone();
    if (src.map) {
      __bambooMat.map = src.map.clone();
      applyBambooUvToTexture(__bambooMat.map, variant?.uvU ?? bambooUvU, variant?.uvV ?? bambooUvV);
    }
    mesh = makeBambooMesh(__bambooMat, variant?.height ?? 1, { modelSize: variant?.modelSize });
  } else if (kind === 'POINTED_DRIPSTONE') {
    mesh = makeDripstoneStackMesh(mats.base, variant?.height ?? 1, variant?.dir ?? 'up');
  } else if (kind === 'CUBE') {
    const cmats = ensureCubeMats();
    const modelName = ensureCubeModelRegistered(activeCubeBlockType, cubeTopPlacementRot);
    mesh = makeAsyncMinecraftModelMesh(modelName, cmats.base, { perFaceMaterials: true });
  } else if (kind === 'MANGROVE_PROPAGULE') {
    const pmats = ensurePropaguleMats(activePropaguleModel);
    const modelName = propaguleModelToBlockModelName(activePropaguleModel);
    mesh = makeAsyncMinecraftModelMesh(modelName, pmats.base);
  } else if (kind === 'SUNFLOWER') {
    // Sunflower top is not a second stalk cross; it uses sunflower_top.json with multiple textures.
    mesh = makeSunflowerDoubleMesh(mats.baseBottom, mats.baseTop);
  } else if (kind === 'SMALL_DRIPLEAF') {
    // Small dripleaf is a two-block plant with custom top/bottom block models.
    // Render the vanilla models so all required textures load.
    mesh = makeSmallDripleafDoubleMesh(mats.base, mats.base);
  } else if (kind === 'TALL_SEAGRASS') {
    mesh = makeTallSeagrassDoubleMesh(mats.baseBottom, mats.baseTop);
  } else if (kind === 'PITCHER_PLANT') {
    // Pitcher plant uses dedicated top/bottom block models (not a generic crossed-stalk).
    // Keep placed instances consistent with placement preview.
    mesh = makePitcherPlantDoubleMesh(mats.baseBottom, mats.baseTop);
  } else {
    mesh = (model === 'double')
      ? makeTallGrassMesh(mats.baseBottom, mats.baseTop)
      : makeGrassMesh(mats.base);
  }

  if (kind === 'SMALL_DRIPLEAF') applySmallDripleafTopRotation(mesh, variant?.rot ?? 0);
  mesh.userData.__grassId = id;
  grassGroup.add(mesh);

  const g = { id, kind, block: block.clone(), off: { ...fixedOff }, mesh, variant };
  if (kind === 'BAMBOO' && __bambooMat) g.__bambooMat = __bambooMat;
  if (kind === 'MANGROVE_PROPAGULE') g.propaguleModel = String(activePropaguleModel || 'ground');
  if (kind === 'CUBE') {
    g.cubeType = String(activeCubeBlockType || 'GRASS_BLOCK');
    g.cubeTopRot = clampRotSteps4(cubeTopPlacementRot);
  }
  grasses.set(id, g);
  occupiedByBlock.set(bKey, id);

  // Ensure correct materials if this is the first selection.
  updateGrassMeshTransform(g);
  refreshGrassList();
  setSelected(id);
  return id;
}

function removeGrass(id){
  const g = grasses.get(id);
  if (!g) return;

  // Release the 1x1x1 block occupancy so something else can be placed here.
  // Guard against rare state mismatches (e.g., if something overwrote the map).
  const k = keyForBlock(g.block);
  if (occupiedByBlock.get(k) === id) {
    occupiedByBlock.delete(k);
  } else {
    // Fallback: remove any entry that points to this id.
    for (const [kk, vv] of occupiedByBlock.entries()) {
      if (vv === id) { occupiedByBlock.delete(kk); break; }
    }
  }
  grassGroup.remove(g.mesh);
  grasses.delete(id);
  if (selectedId === id) selectedId = null;
  refreshGrassList();
  if (placementMode) updatePlacementPreviewBlockedState();
  // pick a new selection if any remain
  const first = grasses.values().next().value;
  if (first) setSelected(first.id);
  try { requestRender(); } catch (_) {}
}

function clearAllGrass(){
  for (const id of [...grasses.keys()]) removeGrass(id);
  grasses.clear();
  occupiedByBlock.clear();
  selectedId = null;
  refreshGrassList();
  if (placementMode) updatePlacementPreviewBlockedState();
  try { requestRender(); } catch (_) {}
}

// --- Offset UI apply ---
function applyOffsetsFromUI({syncUI=true} = {}){
  if (selectedId == null) return;
  const g = grasses.get(selectedId);
  if (!g) return;

  if (isPointedDripstone(g.kind)) {
    g.off.x = dripstoneEffToRaw(el.offX.value);
  } else {
    g.off.x = wrap(Math.trunc(num(el.offX.value, g.off.x)), 0, 15);
  }
  if (isPointedDripstone(g.kind)) {
    g.off.z = dripstoneEffToRaw(el.offZ.value);
  } else {
    g.off.z = wrap(Math.trunc(num(el.offZ.value, g.off.z)), 0, 15);
  }

  // XZ-only foliage: ignore UI Y edits and hard-lock to 15.
  if (isYOffsetLocked(g.kind)) {
    g.off.y = 15;
    if (el.offY) el.offY.value = '15';
  } else {
    g.off.y = wrap(Math.trunc(num(el.offY.value, g.off.y)), 0, 15);
  }

  updateGrassMeshTransform(g);
  refreshGrassList();
  if (syncUI) setSelected(selectedId);
}

// --- Selected texture block position UI ---

function applySelectedBlockFromUI({syncUI=true} = {}){
  if (selectedId == null) return;
  const g = grasses.get(selectedId);
  if (!g) return;

  const oldX = g.block.x, oldY = g.block.y, oldZ = g.block.z;
  const oldKey = keyForBlock(g.block);

  const nx = Math.trunc(num(el.selBlockX.value, oldX));
  const ny = Math.trunc(num(el.selBlockY.value, oldY));
  const nz = Math.trunc(num(el.selBlockZ.value, oldZ));
  const newKey = `${nx}|${ny}|${nz}`;

  if (newKey !== oldKey) {
    const occ = occupiedByBlock.get(newKey);
    if (occ != null && occ !== g.id) {
      showPlacementMsg(`Block (${nx}, ${ny}, ${nz}) is already occupied (#${occ}).`);
      if (syncUI) {
        el.selBlockX.value = String(oldX);
        el.selBlockY.value = String(oldY);
        el.selBlockZ.value = String(oldZ);
      }
      if (placementMode) updatePlacementPreviewBlockedState();
      return;
    }
    occupiedByBlock.delete(oldKey);
    occupiedByBlock.set(newKey, g.id);
  }

  g.block.x = nx;
  g.block.y = ny;
  g.block.z = nz;

  updateGrassMeshTransform(g);
  refreshGrassList();
  if (syncUI) setSelected(selectedId);
  if (placementMode) updatePlacementPreviewBlockedState();
}


// Live update: typing in the offset boxes or using their arrow steppers immediately moves the selected grass.
// Debounced for better performance during rapid changes
const debouncedOffsetUpdate = createDebounced('offsetUpdate', () => applyOffsetsFromUI({syncUI:false}), 75);

for (const k of ['offX','offY','offZ']) {
  el[k].addEventListener('input', debouncedOffsetUpdate);
  el[k].addEventListener('change', () => applyOffsetsFromUI({syncUI:false})); // Keep instant on blur/enter
}

// Live update: typing in the selected block XYZ boxes immediately moves the selected grass.
// Debounced for better performance during rapid changes
const debouncedBlockUpdate = createDebounced('blockUpdate', () => applySelectedBlockFromUI({syncUI:false}), 75);

for (const k of ['selBlockX','selBlockY','selBlockZ']) {
  el[k].addEventListener('input', debouncedBlockUpdate);
  el[k].addEventListener('change', () => applySelectedBlockFromUI({syncUI:false})); // Keep instant on blur/enter
}

el.centerOffsets.addEventListener('click', () => {
  const g = (selectedId != null) ? grasses.get(selectedId) : null;
  const isDrip = !!(g && isPointedDripstone(g.kind));
  el.offX.value = isDrip ? '4' : '7';
  el.offZ.value = isDrip ? '4' : '7';

  // Tall grass cannot be Y-offset; keep it at 15.
  el.offY.value = (g && isYOffsetLocked(g.kind)) ? '15' : '7';
  applyOffsetsFromUI();
});

el.grassList.addEventListener('change', () => {
  const id = Number(el.grassList.value);
  if (Number.isFinite(id) && grasses.has(id)) setSelected(id);
});

el.exportOffsets.addEventListener('click', () => {
  // The "cube" entry is a visual reference block (it has no vanilla random render offset).
  // Do not include it in exported offset datasets.
  const ordered = [...grasses.values()]
    .filter(g => String(g?.kind || '') !== 'CUBE')
    .sort((a,b)=>a.id-b.id);
  const lines = ordered.map(g => {
    const b = g.block;
    const o = g.off;
    const oy = isYOffsetLocked(g.kind) ? 15 : o.y;
    // Always include foliage id so the cracker can apply the correct axis mask.
    let extra = '';
    if (g.kind === 'MANGROVE_PROPAGULE' && g.propaguleModel) extra = ` ${g.propaguleModel}`;
    if (g.kind === 'CUBE') extra = ` ${String(g.cubeType || 'GRASS_BLOCK').toUpperCase()}`;
    return `${b.x} ${b.y} ${b.z}  ${o.x} ${oy} ${o.z} ${g.kind}${extra}`;
  });
  el.exportBox.value = lines.join('\n');
  el.exportBox.focus();
  el.exportBox.select();
});




function parseGrassDataStrict(text){
  const lines = String(text || '').split(/\r?\n/);
  const rows = [];

  for (let i = 0; i < lines.length; i++){
    // Accept ANY whitespace-separated columns (spaces/tabs), including fixed-width padded columns.
    // Format:
	    //   blockX blockY blockZ  offX offY offZ  [TYPE] [variant]
	    // TYPE is optional and defaults to SHORT_GRASS.
    let raw = String(lines[i] || '').trim();
    if (!raw) continue;

    // Allow end-of-line comments (handy for notes while pasting data).
    raw = raw.replace(/\s*(?:#|\/\/).*$/, '').trim();
    if (!raw) continue;

    // Tokenize by whitespace (handles "lots of spaces" and tabs).
    const parts = raw.split(/\s+/);
    if (parts.length < 6){
	      throw new Error(`Invalid format on line ${i+1}. Expected: blockX blockY blockZ offX offY offZ [TYPE]`);
    }

    // Parse the six required integers.
    const nums = parts.slice(0, 6).map(v => Number(v));
    if (!nums.every(n => Number.isInteger(n))){
      throw new Error(`Invalid numbers on line ${i+1}. Expected 6 integers: blockX blockY blockZ offX offY offZ`);
    }
    const [bx, by, bz, ox, oy, oz] = nums;

    let kind = (parts[6] ? String(parts[6]).trim() : 'SHORT_GRASS');
    const variantToken = parts[7] ? String(parts[7]).trim() : '';

    // Legacy aliases
    if (/^short$/i.test(kind)) kind = 'SHORT_GRASS';
    if (/^tall$/i.test(kind)) kind = 'TALL_GRASS';
    kind = kind.toUpperCase();

    // Legacy alias for earlier builds
    if (kind === 'GRASS_BLOCK_CUBE') kind = 'CUBE';

    // Normalize unknown foliage ids to SHORT_GRASS so the UI stays usable.
    if (!FOLIAGE.byId.has(kind)) kind = 'SHORT_GRASS';

    if (![ox, oy, oz].every(v => Number.isInteger(v) && v >= 0 && v <= 15)){
      throw new Error(`Offsets must be 0-15 on line ${i+1}. Got: ${ox} ${oy} ${oz}`);
    }

    const row = { bx, by, bz, ox, oy, oz, kind };
    if (kind === 'MANGROVE_PROPAGULE' && variantToken) row.propaguleModel = variantToken;
    if (kind === 'CUBE'){
      let ct = variantToken ? String(variantToken).toUpperCase() : 'GRASS_BLOCK';
      if (!CUBE_BLOCK_TYPE_BY_TOKEN.has(ct)) ct = 'GRASS_BLOCK';
      row.cubeType = ct;
    }

    rows.push(row);
  }

  if (!rows.length) throw new Error('No grass data found.');
  return rows;
}


el.loadGrassData.addEventListener('click', () => {
  try{
    const rows = parseGrassDataStrict(el.grassDataIn.value);
    el.exportBox.value = '';
    clearAllGrass();
    let skipped = 0;
    for (const r of rows){
      const prevProp = activePropaguleModel;
      const prevCube = activeCubeBlockType;
      if (r.kind === 'MANGROVE_PROPAGULE') {
        activePropaguleModel = String(r.propaguleModel || 'ground');
      }
      if (r.kind === 'CUBE') {
        const ct = String(r.cubeType || 'GRASS_BLOCK').toUpperCase();
        activeCubeBlockType = CUBE_BLOCK_TYPE_BY_TOKEN.has(ct) ? ct : 'GRASS_BLOCK';
      }
            const placed = addGrass(new THREE.Vector3(r.bx, r.by, r.bz), {x:r.ox, y:r.oy, z:r.oz}, r.kind);
      if (placed == null) skipped++;
      activePropaguleModel = prevProp;
      activeCubeBlockType = prevCube;
    }
    // select first grass and set active block
    const first = [...grasses.values()].sort((a,b)=>a.id-b.id)[0];
    if (first){
      activeBlock.copy(first.block);
      setSelected(first.id);
    }
    el.crackStatus.textContent = skipped
      ? `Loaded ${rows.length - skipped} of ${rows.length} entries (${skipped} skipped: block already occupied).`
      : `Loaded ${rows.length} grass entries.`;
  }catch(err){
    console.error(err);
    el.crackStatus.textContent = String(err?.message || err);
    alert(String(err?.message || err));
  }
});

el.crackCoords.addEventListener('click', async () => {
  const centerX = num(el.crackCenterX.value, 0);
  const centerZ = num(el.crackCenterZ.value, 0);
  const radius = clamp(Math.round(num(el.crackRadius.value, 256)), 0, 50000);
  const yMin = Math.round(num(el.crackYMin.value, 62));
  const yMax = Math.round(num(el.crackYMax.value, 70));
  const version = el.crackVersion.value === 'postb1_5' ? 'postb1_5' : 'post1_12';
  const matchMode = (el.matchMode?.value === 'scored') ? 'scored' : 'strict';
  const tolerance = clamp(Math.round(num(el.tolerance?.value, 1)), 0, 2);

  el.crackOut.value = '';
  el.crackCoords.disabled = true;
  el.crackStatus.textContent = 'Cracking... (this can take a while for large radii)';

  const t0 = performance.now();
  try{
    const res = await GF.crack({
      centerX, centerZ, radius, yMin, yMax, version,
      matchMode,
      tolerance,
      maxScore: 6,
      maxResults: 50,
      useWorkers: !!el.crackWorkers?.checked,
      onProgress: ({done, total, matches}) => {
        const pct = total ? (done/total*100) : 0;
        el.crackStatus.textContent = `Cracking... ${pct.toFixed(1)}%  checked ${done.toLocaleString()} / ${total.toLocaleString()}  matches ${matches}`;
      }
    });

    // Expose matches for the experimental teleport helper UI.
    try {
      __lastCrackMatches = Array.isArray(res?.matches) ? res.matches : [];
      __lastCrackMatchMode = matchMode;
      __lastCrackVersion = version;
      __crackTpYUserEdited = false;
      if (el.crackTpOriginY) el.crackTpOriginY.value = String(yMin);
      __populateCrackMatchSelect();
    } catch (_) { /* ignore */ }

    const dt = performance.now() - t0;
    const lines = res.matches.map(p => {
      if (matchMode === 'scored') return `${p.x} ${p.y} ${p.z}  score=${p.score}`;
      return `${p.x} ${p.y} ${p.z}`;
    });

    if (res.warning) {
      el.crackOut.value = `WARNING: ${res.warning}\n\n` + (lines.join('\n') || '(no matches)');
    } else {
      el.crackOut.value = lines.length ? lines.join('\n') : '(no matches in the searched range)';
    }
    el.crackStatus.textContent = `Done in ${(dt/1000).toFixed(2)}s - matches: ${res.matches.length}`;
    el.crackOut.focus();
    el.crackOut.select();
  } catch (err){
    console.error(err);
    el.crackStatus.textContent = 'Error while cracking - see console.';
    try {
      __lastCrackMatches = [];
      __populateCrackMatchSelect();
    } catch (_) {}
    el.crackOut.value = String(err?.message || err);

  } finally {
    el.crackCoords.disabled = false;
  }
});



// --- Grassfinder match -> teleport helper (EXPERIMENTAL) ---
let __lastCrackMatches = [];
let __lastCrackMatchMode = 'strict';
let __lastCrackVersion = 'post1_12';
let __crackTpYUserEdited = false;

function __setCrackTpMsg(text, isError=false){
  if (!el.crackTpMsg) return;
  el.crackTpMsg.textContent = String(text ?? '');
  el.crackTpMsg.classList.toggle('tp-error', Boolean(isError));
}

function __formatTpToken(n, axis){
  // Always include a '.' for X/Z integers to avoid vanilla +0.5 centering on integer tokens.
  if (!Number.isFinite(n)) n = 0;
  const r = Math.round(n);
  const isInt = Math.abs(n - r) < 1e-9;

  const trim = (s) => String(s).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'.0');

  if (axis === 'x' || axis === 'z') {
    if (isInt) return `${r}.0`;
    // Keep high precision so camera tests match in-game.
    return trim(n.toFixed(12));
  }

  // Y: no centering quirk, keep integers clean.
  if (isInt) return String(r);
  return trim(n.toFixed(12));
}

function __formatAngle(n){
  if (!Number.isFinite(n)) n = 0;
  const r = Math.round(n * 1000000) / 1000000;
  const isInt = Math.abs(r - Math.round(r)) < 1e-9;
  const trim = (s) => String(s).replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'.0');
  return isInt ? String(Math.round(r)) : trim(r.toFixed(6));
}

async function __copyToClipboard(text){
  const t = String(text ?? '');
  if (!t) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (_) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (_) {
    return false;
  }
}

function __getCrackReferenceOrigin(){
  // Must match GF.rowsFromGrasses(): ignore CUBE and pick smallest id.
  const ordered = [...grasses.values()]
    .filter(g => String(g?.kind || '') !== 'CUBE')
    .sort((a,b)=>a.id-b.id);
  const first = ordered[0];
  return first?.block ? first.block.clone() : null;
}

function __readCameraInputs(){
  // Base entity position in the tool's current coordinate system.
  const centerXZ = Boolean(el.centerTpXZ?.checked);
  const x = parseMcTpAxis(el.camX?.value, 'x', 0, centerXZ);
  const yIn = parseMcTpAxis(el.camY?.value, 'y', 0, centerXZ);
  const z = parseMcTpAxis(el.camZ?.value, 'z', 0, centerXZ);
  const yaw = num(el.yaw?.value, 0);
  const pitch = clamp(num(el.pitch?.value, 0), -90, 90);
  const feetMode = Boolean(el.useFeetY?.checked);
  const feetY = feetMode ? yIn : (yIn - EYE_HEIGHT);
  return { x, yIn, z, feetY, yaw, pitch, feetMode };
}

function __populateCrackMatchSelect(){
  const sel = el.crackMatchSelect;
  const btnMake = el.crackMakeTp;
  const btnCopy = el.crackCopyTp;
  const btnShift = el.crackApplyCamShift;

  // Show/hide Origin Y helper depending on crack version.
  try {
    const wrap = document.querySelector('.crack-tp-originy');
    const show = (__lastCrackVersion === 'post1_12');
    if (wrap) wrap.classList.toggle('hidden', !show);
    if (show && el.crackTpOriginY && !__crackTpYUserEdited) {
      const firstY = (__lastCrackMatches?.[0]?.y ?? Math.round(num(el.crackYMin?.value, 62)));
      el.crackTpOriginY.value = String(Math.round(firstY));
    }
  } catch (_) {}

  if (!sel) return;

  sel.innerHTML = '';
  const has = Array.isArray(__lastCrackMatches) && __lastCrackMatches.length > 0;

  sel.disabled = !has;
  if (btnMake) btnMake.disabled = !has;
  if (btnShift) btnShift.disabled = !has;
  if (btnCopy) btnCopy.disabled = true;

  if (!has) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(run crack first)';
    sel.appendChild(opt);
    if (el.crackTpOut) el.crackTpOut.value = '';
    return;
  }

  for (let i=0;i<__lastCrackMatches.length;i++){
    const m = __lastCrackMatches[i];
    const opt = document.createElement('option');
    opt.value = String(i);
    const base = `${m.x} ${m.y} ${m.z}`;
    opt.textContent = (__lastCrackMatchMode === 'scored' && typeof m.score === 'number')
      ? `${base}  (score=${m.score})`
      : base;
    sel.appendChild(opt);
  }

  // Auto-generate an initial command preview (non-copy) for convenience.
  __updateCrackTpOutput(false);
}

function __selectedCrackMatch(){
  const sel = el.crackMatchSelect;
  if (!sel) return null;
  const i = Number(sel.value);
  if (!Number.isInteger(i) || i < 0 || i >= __lastCrackMatches.length) return __lastCrackMatches[0] ?? null;
  return __lastCrackMatches[i] ?? null;
}

function __computeCrackShift(match){
  const ref = __getCrackReferenceOrigin();
  if (!ref) return { error: 'No reference block found. Place at least 1 non-cube texture block.' };
  if (!match) return { error: 'No match selected.' };

  const includeY = Boolean(el.crackTpIncludeY?.checked);
  const dx = (match.x|0) - (ref.x|0);
  const dz = (match.z|0) - (ref.z|0);
  const version = (__lastCrackVersion === 'postb1_5') ? 'postb1_5' : 'post1_12';
  const yIsFree = (version === 'post1_12');

  // In 1.8+ mode, the hash ignores Y entirely, so the "match Y" is just Y min.
  // When shifting Y, use the explicit Origin Y field.
  let dy = 0;
  let yAnchor = null;
  if (includeY) {
    if (yIsFree) {
      yAnchor = Math.round(num(el.crackTpOriginY?.value, match.y|0));
      dy = (yAnchor|0) - (ref.y|0);
    } else {
      yAnchor = (match.y|0);
      dy = yAnchor - (ref.y|0);
    }
  }

  return { dx, dy, dz, ref, version, yIsFree, yAnchor, includeY };
}

function __updateCrackTpOutput(wantCopyFeedback){
  const out = el.crackTpOut;
  if (!out) return;

  const match = __selectedCrackMatch();
  const shift = __computeCrackShift(match);
  if (shift?.error) {
    out.value = '';
    if (el.crackCopyTp) el.crackCopyTp.disabled = true;
    __setCrackTpMsg(shift.error, true);
    return;
  }

  const cam = __readCameraInputs();
  const target = String(el.crackTpTarget?.value || '@s').trim() || '@s';

  const x2 = cam.x + shift.dx;
  const z2 = cam.z + shift.dz;

  // Apply shift in the same Y input space; convert to feet for /tp if needed.
  const yIn2 = cam.yIn + shift.dy;
  const yFeet2 = cam.feetMode ? yIn2 : (yIn2 - EYE_HEIGHT);

  const cmd = `/tp ${target} ${__formatTpToken(x2, 'x')} ${__formatTpToken(yFeet2, 'y')} ${__formatTpToken(z2, 'z')} ${__formatAngle(cam.yaw)} ${__formatAngle(cam.pitch)}`;
  out.value = cmd;
  if (el.crackCopyTp) el.crackCopyTp.disabled = !cmd;

  let note = '';
  if (shift.yIsFree && shift.includeY) {
    const yTxt = (shift.yAnchor == null) ? '?' : String(shift.yAnchor);
    note = ` (1.8+: Y not cracked; using Origin Y=${yTxt})`;
  }
  __setCrackTpMsg(`Δ = (${shift.dx}, ${shift.dy}, ${shift.dz})${note}`, false);
}

function __shiftCameraByCrackMatch(){
  const match = __selectedCrackMatch();
  const shift = __computeCrackShift(match);
  if (shift?.error) { __setCrackTpMsg(shift.error, true); return; }

  const centerXZ = Boolean(el.centerTpXZ?.checked);

  const x0 = parseMcTpAxis(el.camX?.value, 'x', 0, centerXZ);
  const y0 = parseMcTpAxis(el.camY?.value, 'y', 0, centerXZ);
  const z0 = parseMcTpAxis(el.camZ?.value, 'z', 0, centerXZ);

  const x1 = x0 + shift.dx;
  const y1 = y0 + shift.dy;
  const z1 = z0 + shift.dz;

  // Preserve exact positions even if "Center X/Z integers" is enabled.
  el.camX.value = __formatTpToken(x1, 'x');
  el.camY.value = __formatTpToken(y1, 'y');
  el.camZ.value = __formatTpToken(z1, 'z');

  updateCameraFromUI();
  __updateCrackTpOutput(false);
}

// Hook up UI (safe if elements are absent in older builds)
el.crackMatchSelect?.addEventListener('change', () => {
  // In 1.8+ mode, match Y is arbitrary; keep Origin Y in sync unless the user overrode it.
  try {
    if (__lastCrackVersion === 'post1_12' && el.crackTpOriginY && !__crackTpYUserEdited) {
      const m = __selectedCrackMatch();
      const y = (m?.y ?? Math.round(num(el.crackYMin?.value, 62)));
      el.crackTpOriginY.value = String(Math.round(y));
    }
  } catch (_) {}
  __updateCrackTpOutput(false);
});
el.crackTpIncludeY?.addEventListener('change', () => __updateCrackTpOutput(false));
el.crackTpOriginY?.addEventListener('input', () => {
  __crackTpYUserEdited = true;
  __updateCrackTpOutput(false);
});
el.crackTpTarget?.addEventListener('input', () => {
  // Clear stale errors as the user edits.
  if ((el.crackTpMsg?.textContent ?? '') && el.crackTpMsg?.classList?.contains('tp-error')) __setCrackTpMsg('', false);
  __updateCrackTpOutput(false);
});
el.crackMakeTp?.addEventListener('click', () => __updateCrackTpOutput(false));
el.crackApplyCamShift?.addEventListener('click', __shiftCameraByCrackMatch);
el.crackCopyTp?.addEventListener('click', async () => {
  const t = el.crackTpOut?.value || '';
  const ok = await __copyToClipboard(t);
  if (ok) __setCrackTpMsg('Copied /tp command to clipboard.', false);
  else __setCrackTpMsg('Could not copy automatically. Select and copy manually.', true);
});

// Initialize select state
__populateCrackMatchSelect();


el.clearGrass.addEventListener('click', () => {
  el.exportBox.value = '';
  clearAllGrass();
});

// --- Picking / interaction ---
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

// "Alpha-aware" picking:
// Three.js raycasting hits triangles even where the texture is fully transparent.
// For plant-style blocks (grass, flowers, seagrass, etc.), this feels wrong: you
// shouldn't be able to select a model by clicking an area where there are no
// visible (non-transparent) pixels.
//
// We solve this by filtering raycast hits using the hit UV and the texture's
// alpha channel. If the sampled pixel would be discarded by alphaTest, we treat
// that hit as "empty" and continue to the next object behind it.
const __texAlphaCache = new Map(); // texture.uuid -> { w, h, data }

function __getTextureImageData(tex){
  try {
    if (!tex || !tex.image) return null;
    const img = tex.image;
    const w = img.width | 0;
    const h = img.height | 0;
    if (!w || !h) return null;

    const key = tex.uuid;
    const cached = __texAlphaCache.get(key);
    if (cached && cached.w === w && cached.h === h) return cached;

    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const id = ctx.getImageData(0, 0, w, h);
    const entry = { w, h, data: id.data };
    __texAlphaCache.set(key, entry);
    return entry;
  } catch (e) {
    // If the image is not CORS-readable (tainted canvas), we can't do alpha picking.
    return null;
  }
}

function __materialForHit(hit){
  const obj = hit?.object;
  if (!obj) return null;
  const mat = obj.material;
  if (!Array.isArray(mat)) return mat;

  // Multi-material BufferGeometry: determine which group contains this face.
  const geo = obj.geometry;
  const groups = geo?.groups;
  const fi = hit.faceIndex;
  if (!groups || !groups.length || fi == null) return mat[0] ?? null;

  // For non-indexed geometries (ours), group.start/count are in vertices.
  // faceIndex is triangle index; triangle i uses vertices [i*3 .. i*3+2].
  const vert = (fi | 0) * 3;
  for (const g of groups){
    const s = g.start | 0;
    const e = s + (g.count | 0);
    if (vert >= s && vert < e) return mat[g.materialIndex] ?? mat[0] ?? null;
  }
  return mat[0] ?? null;
}

function __hitIsOpaqueEnough(hit){
  const obj = hit?.object;
  if (!obj) return true;
  const mat = __materialForHit(hit);
  const map = mat?.map;
  const uv = hit?.uv;
  if (!map || !uv) return true;

  const info = __getTextureImageData(map);
  if (!info) return true; // no readable data -> fall back to triangle pick

  // Apply texture transform (repeat/offset/rotation/center) so animated-strip frames
  // and any future UV transforms are respected.
  let u = uv.x;
  let v = uv.y;
  try {
    if (map.matrixAutoUpdate) map.updateMatrix();
    const uv2 = uv.clone().applyMatrix3(map.matrix);
    u = uv2.x;
    v = uv2.y;
  } catch (_) {
    // ignore and fall back to raw UV
  }

  // Clamp to edge (Minecraft plant textures use clamp in this app).
  if (!Number.isFinite(u) || !Number.isFinite(v)) return true;
  u = Math.min(1, Math.max(0, u));
  v = Math.min(1, Math.max(0, v));

  const x = Math.min(info.w - 1, Math.max(0, Math.floor(u * info.w)));
  // ImageData has origin at top-left; our UV v=1 is top, v=0 is bottom.
  const y = Math.min(info.h - 1, Math.max(0, Math.floor((1 - v) * info.h)));

  const a = info.data[(y * info.w + x) * 4 + 3] | 0;
  const alphaTest = (typeof mat?.alphaTest === 'number') ? mat.alphaTest : 0.5;
  const thresh = Math.floor(Math.max(0, Math.min(1, alphaTest)) * 255);
  return a >= thresh;
}

function setNDCFromMouseEvent(e){
  // Map viewport-canvas mouse coordinates -> workspace coordinates -> NDC in the render rectangle.
  // If the mouse is outside the render rectangle, return false.
  const wx = offsetToWorkspaceX(e.offsetX);
  const wy = offsetToWorkspaceY(e.offsetY);
  const left = (VIEW_W - RENDER_W) / 2;
  const top  = (VIEW_H - RENDER_H) / 2;
  if (wx < left || wx > left + RENDER_W || wy < top || wy > top + RENDER_H) return false;
  const lx = (wx - left) / RENDER_W;
  const ly = (wy - top) / RENDER_H;
  ndc.set(lx * 2 - 1, -(ly * 2 - 1));
  return true;
}

function pickGrass(e){
  if (!grassGroup.visible) return null;
  if (!setNDCFromMouseEvent(e)) return null;
  raycaster.setFromCamera(ndc, camera);
  const meshes = [];
  grassGroup.traverse(obj => { if (obj.isMesh) meshes.push(obj); });
  const hits = raycaster.intersectObjects(meshes, false);
  if (!hits.length) return null;

  // Find the nearest hit that is not "empty" in alpha space.
  for (const hit of hits){
    if (!__hitIsOpaqueEnough(hit)) continue;
    let obj = hit.object;
    while (obj && !obj.parent?.userData?.__grassId && !obj.userData.__grassId) obj = obj.parent;
    const id = obj?.userData?.__grassId ?? obj?.parent?.userData?.__grassId;
    if (typeof id === 'number') return id;
  }
  return null;
}

function pickBlockOnGround(e){
  if (!setNDCFromMouseEvent(e)) return null;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(ground, false);
  if (!hits.length) return null;
  const p = hits[0].point;
  const bx = Math.floor(p.x);
  const bz = Math.floor(p.z);
  const by = 0; // ground plane
  return new THREE.Vector3(bx, by, bz);
}


// --- Coordinate cracking (grassfinder logic, adapted to browser) ---
const GF = (() => {
  // Vanilla formula (b1.7.3 BlockRenderer / later MathHelper):
  //   long l = (x*3129871) ^ (z*116129781L) ^ y;
  //   l = l*l*42317861L + l*11L;
  // Offsets use bits 16..27 of l.
  //
  // Those bits live in the low 32 bits, and the low 32 bits depend only on the low 32 bits
  // of intermediate results. So we can compute the packed offset using fast 32-bit Math.imul
  // instead of BigInt-heavy 64-bit math.
  const X_MULT = 0x2fc20f | 0;    // 3129871
  const Z_MULT = 0x6ebfff5 | 0;   // 116129781
  const LCG_MULT = 0x285b825 | 0; // 42317861
  const LCG_ADDEND = 11 | 0;

  function packedGrassOffset(x, y, z, version){
    const yy = (version === 'post1_12') ? 0 : (y | 0);

    // Java (BlockState.getOffset / AbstractBlock.getOffset):
    //   long l = (x*3129871L) ^ (z*116129781L) ^ y;
    //   l = l*l*42317861L + l*11L;
    let l = (BigInt(x | 0) * BigInt(X_MULT)) ^ (BigInt(z | 0) * BigInt(Z_MULT)) ^ BigInt(yy);
    l = BigInt.asIntN(64, l);
    l = BigInt.asIntN(64, (l * l * BigInt(LCG_MULT)) + (l * BigInt(LCG_ADDEND)));
    const u = BigInt.asUintN(64, l);

    // Bits 16..27 contain three 4-bit nibbles (ox | oy<<4 | oz<<8).
    return Number((u >> 16n) & 0xFFFn) >>> 0;
  }

  // --- Pointed dripstone equivalence handling ---
  // In vanilla, pointed dripstone's final X/Z positions clamp such that indices 0..3 are
  // indistinguishable (all behave like "negative edge") and 12..15 are indistinguishable
  // ("positive edge"). The cracker must treat those as equivalence classes, otherwise
  // real-world data can produce zero matches.
  function dripstoneNibbleMatches(pred, expected){
    const p = pred & 15;
    const e = expected & 15;
    if (e <= 3) return p <= 3;
    if (e >= 12) return p >= 12;
    return p === e;
  }

  function dripstoneNibbleDistance(pred, expected){
    const p = pred & 15;
    const e = expected & 15;
    if (e <= 3) {
      // distance to nearest of {0,1,2,3}
      if (p <= 3) return 0;
      return p - 3;
    }
    if (e >= 12) {
      // distance to nearest of {12,13,14,15}
      if (p >= 12) return 0;
      return 12 - p;
    }
    return Math.abs(p - e);
  }

  // Score a predicted packed offset against an expected packed offset.
  // `mask` is a 12-bit nibble mask: if an axis nibble is 0, that axis is ignored.
  // This is used to support blocks like tall grass (OffsetType.XZ) where Y is unobservable.
  //
  // Pointed dripstone note:
  // Vanilla generates offsets on the standard 0..15 grid and then clamps the *final* position.
  // That means the underlying nibble indices 0..3 are indistinguishable (all clamp to -1/8),
  // and 12..15 are indistinguishable (all clamp to +1/8). When cracking, we must therefore
  // treat those index ranges as equivalence classes rather than exact values.

  function scorePacked(predPacked, expectedPacked, mask, tol, isDripstone){
    // tol in {0,1,2}
    let score = 0;
    const drip = !!isDripstone;
    for (let axis = 0; axis < 3; axis++) {
      const nibMask = (mask >> (axis * 4)) & 15;
      if (nibMask === 0) continue;
      const p = (predPacked >> (axis * 4)) & 15;
      const e = (expectedPacked >> (axis * 4)) & 15;
      const d = (drip && axis !== 1) ? dripstoneNibbleDistance(p, e) : Math.abs(p - e);
      if (d <= tol) score += d;
      else score += d * d;
    }
    return score;
  }

  function rowsFromGrasses(){
    // Exclude visual-only reference blocks (like the cube) from cracking datasets.
    const ordered = [...grasses.values()]
      .filter(g => String(g?.kind || '') !== 'CUBE')
      .sort((a,b)=>a.id-b.id);
    return ordered.map(g => ({
      pos: { x: g.block.x|0, y: g.block.y|0, z: g.block.z|0 },
      kind: g.kind,
      isDripstone: isPointedDripstone(g.kind),
      // For tall grass (OffsetType.XZ), Y is not observable in-game.
      // We keep a 12-bit mask so the solver can ignore Y constraints for tall grass samples.
      mask: foliageMaskFor(FOLIAGE.byId.get(g.kind)?.offsetType ?? 'XYZ'),
      packed: ((g.off.x|0) | ((g.off.y|0) << 4) | ((g.off.z|0) << 8)) >>> 0,
    }));
  }
  // --- Worker implementation (optional) ---
  // External module worker (WASM-backed). Create ./grassfinder_worker.js next to main.js.
  function getWorkerURL(){
    return new URL('./grassfinder_worker.js', import.meta.url);
  }

  async function crack({
    centerX, centerZ, radius, yMin, yMax, version,
    matchMode='strict',
    tolerance=1,
    maxScore=6,
    maxResults=50,
    useWorkers=true,
    onProgress
  }){
    const rows = rowsFromGrasses();
    if (rows.length < 2) {
      return { matches: [], warning: 'Add at least 2 blocks to crack coordinates.' };
    }

    const mode = (matchMode === 'scored') ? 'scored' : 'strict';
    const tol = clamp(Math.round(Number(tolerance)), 0, 2);
    const MAX_SCORE = Math.max(0, (maxScore|0) || 0);
    const MAX_RESULTS = Math.max(1, (maxResults|0) || 1);

    const recorigin = rows[0].pos;
    let rel = rows.map(r => ({
      dx: (r.pos.x - recorigin.x) | 0,
      dy: (r.pos.y - recorigin.y) | 0,
      dz: (r.pos.z - recorigin.z) | 0,
      isDripstone: !!r.isDripstone,
      mask: (r.mask & 0xFFF) >>> 0,
      // Mask expected packed so ignored axes don't accidentally constrain results.
      packed: (r.packed & r.mask & 0xFFF) >>> 0,
    }));

    // Check farthest samples first for early mismatch exit.
    rel = rel.sort((a,b) => (Math.abs(b.dx)+Math.abs(b.dz)+Math.abs(b.dy)) - (Math.abs(a.dx)+Math.abs(a.dz)+Math.abs(a.dy)));

    // Convert rel samples to tight typed arrays for faster hot-loop access and cheaper worker transfer.
    const relLen = rel.length | 0;
    const relDx = new Int32Array(relLen);
    const relDy = new Int32Array(relLen);
    const relDz = new Int32Array(relLen);
    const relPacked = new Uint16Array(relLen);
    const relMask = new Uint16Array(relLen);
    const relDrip = new Uint8Array(relLen);
    for (let i=0;i<relLen;i++){
      const r = rel[i];
      relDx[i] = r.dx | 0;
      relDy[i] = r.dy | 0;
      relDz[i] = r.dz | 0;
      relPacked[i] = (r.packed & 0xFFF) >>> 0;
      relMask[i] = (r.mask & 0xFFF) >>> 0;
      relDrip[i] = r.isDripstone ? 1 : 0;
    }

    const x0 = Math.floor(centerX - radius);
    const x1 = Math.floor(centerX + radius);
    const z0 = Math.floor(centerZ - radius);
    const z1 = Math.floor(centerZ + radius);
    const yy0 = Math.floor(Math.min(yMin, yMax));
    const yy1 = Math.floor(Math.max(yMin, yMax));

    const post1_12_anyY = (version === 'post1_12');
    const total = (x1-x0+1) * (z1-z0+1) * (post1_12_anyY ? 1 : (yy1-yy0+1));

    const MAX_MATCHES = 2000;

    // --- Fast path: Web Workers ---
    const wantWorkers = !!useWorkers && !!window.Worker;
    const hw = Math.max(1, Math.min(16, (navigator.hardwareConcurrency|0) || 1));
    const xCount = (x1 - x0 + 1);

    // Old versions (b1.5-1.12) do far more work because Y affects offsets.
    // Cap worker count to 4 to keep overhead low and match the newer-cracker style.
    const targetWorkers = (version === 'postb1_5') ? 4 : hw;
    const nWorkers = wantWorkers ? Math.max(1, Math.min(targetWorkers, hw, xCount)) : 1;

    if (wantWorkers && nWorkers > 1) {
      const url = getWorkerURL();
      const workers = [];
      const jobIdBase = (Math.random()*1e9)|0;

      const stripes = [];
      const base = Math.floor(xCount / nWorkers);
      let rem = xCount % nWorkers;
      let cur = x0;
      for (let i=0;i<nWorkers;i++){
        const w = base + (rem>0 ? 1 : 0);
        if (rem>0) rem--;
        const xs = cur;
        const xe = cur + w - 1;
        cur = xe + 1;
        stripes.push({ xs, xe });
      }

      const progress = new Array(nWorkers).fill(0);
      const totals = new Array(nWorkers).fill(0);
      const matchesAll = [];
      let hitCap = false;

      function emitProgress(){
        if (!onProgress) return;
        const done = progress.reduce((a,b)=>a+b,0);
        const tot = totals.reduce((a,b)=>a+b,0) || total;
        onProgress({ done, total: tot, matches: matchesAll.length });
      }

      const promises = stripes.map((s, idx) => new Promise((resolve, reject) => {
        const w = new Worker(url, { type: 'module' });
        workers.push(w);

        w.onmessage = (ev) => {
          const msg = ev.data;
          if (!msg || msg.jobId !== (jobIdBase + idx)) return;
          if (msg.type === 'progress'){
            // Don't coerce progress counters to int32. Large radii can overflow signed 32-bit
            // and make the displayed percentage go backwards.
            progress[idx] = Number(msg.done);
            totals[idx] = Number(msg.total);
            emitProgress();
            return;
          }
          if (msg.type === 'done'){
            progress[idx] = Number(msg.done);
            totals[idx] = Number(msg.total);

            if (!hitCap) {
              for (const m of msg.matches){
                matchesAll.push(m);
                if (matchesAll.length >= MAX_MATCHES) { hitCap = true; break; }
              }
            }

            if (msg.hitCap) hitCap = true;

            emitProgress();
            resolve();
            return;
          }
        };

        w.onerror = (e) => reject(e);

        w.postMessage({
          jobId: jobIdBase + idx,
          x0: s.xs, x1: s.xe,
          z0, z1,
          y0: yy0, y1: yy1,
          version,
          relDx,
          relDy,
          relDz,
          relPacked,
          relMask,
          relDrip,
          maxMatches: MAX_MATCHES,
          post1_12_anyY,
          mode,
          tol,
          maxScore: MAX_SCORE
        });
      }));

      try {
        await Promise.all(promises);
      } finally {
        for (const w of workers) w.terminate();
      }

      const warning =
        hitCap ? `Hit the cap of ${MAX_MATCHES} matches. Reduce radius / tighten inputs.` :
        (post1_12_anyY && yy1 !== yy0) ? `` :
        null;

      if (mode === 'scored') {
        matchesAll.sort((a,b)=> (a.score-b.score) || (a.x-b.x) || (a.z-b.z) || (a.y-b.y));
        return { matches: matchesAll.slice(0, MAX_RESULTS), warning };
      }

      // Keep deterministic order (x then z then y).
      matchesAll.sort((a,b)=> (a.x-b.x) || (a.z-b.z) || (a.y-b.y));
      return { matches: matchesAll, warning };
    }

    // --- Fallback: single-threaded chunked scan (still optimized) ---
    function checkAt(x,y,z){
      let score = 0;
      for (let i=0;i<relLen;i++){
        const ax = x + relDx[i];
        const ay = y + relDy[i];
        const az = z + relDz[i];
        const p = packedGrassOffset(ax, ay, az, version);

        if (mode === 'strict') {
          // Pointed dripstone edge indices are ambiguous (0..3 and 12..15 collapse).
          // Treat them as equivalence classes during matching.
          const isDrip = !!relDrip[i];
          if (!isDrip) {
            if ((p & relMask[i]) !== relPacked[i]) return -1;
          } else {
            // Per-axis strict match with plateau equivalence on X/Z.
            for (let axis = 0; axis < 3; axis++) {
              const nibMask = (relMask[i] >> (axis * 4)) & 15;
              if (nibMask === 0) continue;
              const pn = (p >> (axis * 4)) & 15;
              const en = (relPacked[i] >> (axis * 4)) & 15;
              if (axis === 1) { if (pn !== en) return -1; }
              else { if (!dripstoneNibbleMatches(pn, en)) return -1; }
            }
          }
        } else {
          score += scorePacked(p, relPacked[i], relMask[i], tol, relDrip[i]);
          if (score > MAX_SCORE) return -1;
        }
      }
      return score|0;
    }

    let done = 0;
    const matches = [];

    // Chunked scan to keep UI responsive.
    let cy = yy0, cz = z0, cx = x0;
    const CHUNK = 12000;

    return new Promise(resolve => {
      function step(){
        let n = 0;

        if (post1_12_anyY){
          const y = yy0; // representative
          while (n < CHUNK && cz <= z1){
            const s = checkAt(cx, y, cz);
            if (s >= 0) {
              if (mode === 'scored') matches.push({ x: cx, y, z: cz, score: s });
              else matches.push({ x: cx, y, z: cz });
              if (matches.length >= MAX_MATCHES) {
                resolve({ matches, warning: `Hit the cap of ${MAX_MATCHES} matches. Reduce radius / tighten inputs.` });
                return;
              }
            }

            done++; n++;
            cx++;
            if (cx > x1){ cx = x0; cz++; }

            if (onProgress && (done % 50000 === 0)) onProgress({ done, total, matches: matches.length });
          }

          if (onProgress) onProgress({ done, total, matches: matches.length });

          if (cz > z1) {
            const warning = (yy1 !== yy0)
              ? ``
              : null;
            if (mode === 'scored') {
              matches.sort((a,b)=> (a.score-b.score) || (a.x-b.x) || (a.z-b.z) || (a.y-b.y));
              resolve({ matches: matches.slice(0, MAX_RESULTS), warning });
            } else {
              resolve({ matches, warning });
            }
            return;
          }

          requestAnimationFrame(step);
          return;
        }

        while (n < CHUNK && cy <= yy1){
          const s = checkAt(cx, cy, cz);
          if (s >= 0) {
            if (mode === 'scored') matches.push({ x: cx, y: cy, z: cz, score: s });
            else matches.push({ x: cx, y: cy, z: cz });
            if (matches.length >= MAX_MATCHES) {
              resolve({ matches, warning: `Hit the cap of ${MAX_MATCHES} matches. Reduce radius / tighten inputs.` });
              return;
            }
          }

          done++; n++;
          cx++;
          if (cx > x1){ cx = x0; cz++; }
          if (cz > z1){ cz = z0; cy++; }

          if (onProgress && (done % 50000 === 0)) onProgress({ done, total, matches: matches.length });
        }

        if (onProgress) onProgress({ done, total, matches: matches.length });

        if (cy > yy1) {
          if (mode === 'scored') {
            matches.sort((a,b)=> (a.score-b.score) || (a.x-b.x) || (a.z-b.z) || (a.y-b.y));
            resolve({ matches: matches.slice(0, MAX_RESULTS), warning: null });
          } else {
            resolve({ matches, warning: null });
          }
          return;
        }
        requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  return { crack };
})();


// --- Placement mode (right-click to start, right-click to confirm) ---
let placementMode = false;
let placementY = 0;
let placementBlock = new THREE.Vector3(0, 0, 0);
let placementPreview = null;
const placementOff = { x: 7, y: 7, z: 7 };

let placementPreviewBlocked = false;

/** Small on-canvas placement message (non-blocking). */
function showPlacementMsg(text, ms = 1600){
  try{
    if (!el.viewport) { console.warn(text); return; }
    if (!el.__placementMsgEl){
      // Ensure the viewport is a positioned container.
      const cs = getComputedStyle(el.viewport);
      if (cs.position === 'static') el.viewport.style.position = 'relative';

      const d = document.createElement('div');
      d.id = 'placementMsg';
      d.style.position = 'absolute';
      d.style.left = '10px';
      d.style.bottom = '10px';
      d.style.padding = '6px 10px';
      d.style.borderRadius = '10px';
      d.style.background = 'rgba(0,0,0,0.65)';
      d.style.color = 'white';
      d.style.fontSize = '12px';
      d.style.fontWeight = '600';
      d.style.pointerEvents = 'none';
      d.style.zIndex = '20';
      d.style.display = 'none';
      el.viewport.appendChild(d);
      el.__placementMsgEl = d;
      el.__placementMsgTimer = null;
    }
    const d = el.__placementMsgEl;
    d.textContent = String(text ?? '');
    d.style.display = 'block';
    if (el.__placementMsgTimer) clearTimeout(el.__placementMsgTimer);
    el.__placementMsgTimer = setTimeout(() => { d.style.display = 'none'; }, ms);
  }catch(e){
    console.warn('showPlacementMsg failed', e);
  }
}

function setPlacementPreviewBlocked(blocked){
  placementPreviewBlocked = !!blocked;
  if (!placementPreview) return;
  placementPreview.traverse(obj => {
    if (!obj.isMesh) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const m of mats){
      if (!m || !m.color) continue;
      if (!m.userData) m.userData = {};
      if (m.userData.__origColorHex == null) m.userData.__origColorHex = m.color.getHex();
      // IMPORTANT: our global "hide while loading" logic sets opacity=0 until the real texture arrives.
      // If we snapshot __origOpacity during that hidden phase, the placement preview can get stuck
      // invisible the next time we toggle blocked/unblocked. Use the *intended* opacity instead.
      if (m.userData.__origOpacity == null) {
        const intended = intendedOpacityOf(m, 1);
        m.userData.__origOpacity = (Number.isFinite(intended) && intended > 0) ? intended : 1;
      }

      if (placementPreviewBlocked) {
        m.color.setHex(0xff4b4b);
        m.opacity = clamp(m.userData.__origOpacity * 0.65, 0, 1);
        m.transparent = true;
      } else {
        m.color.setHex(m.userData.__origColorHex);
        m.opacity = m.userData.__origOpacity;
      }
      m.needsUpdate = true;
    }
  });
  try { requestRender(); } catch (_) {}
}

function updatePlacementPreviewBlockedState(){
  const occ = occupantAtBlock(placementBlock);
  setPlacementPreviewBlocked(occ != null);
}


function ensurePlacementOffsetRules(){
  // XZ-only foliage cannot be Y-offset.
  if (isYOffsetLocked(activeFoliageId)) placementOff.y = 15;
}

function ensurePlacementPreview(){
  const previewKey = foliageSupportsHeight(activeFoliageId)
    ? (activeFoliageId === 'BAMBOO'
        ? `${activeFoliageId}|${activeVariantHeight}|${activeVariantDir}|${bambooModelSize}`
        : `${activeFoliageId}|${activeVariantHeight}|${activeVariantDir}`)
    : (activeFoliageId === 'CUBE'
        ? `${activeFoliageId}|${String(activeCubeBlockType || 'GRASS_BLOCK').toUpperCase()}|u${clampRotSteps4(cubeTopPlacementRot) * 90}`
        : (activeFoliageId === 'MANGROVE_PROPAGULE'
            ? `${activeFoliageId}|${activePropaguleModel}`
            : activeFoliageId));
  if (placementPreview && placementPreview.userData.__previewKey === previewKey) return;

  if (placementPreview) {
    scene.remove(placementPreview);
    // Best-effort dispose.
    placementPreview.traverse(obj => {
      if (obj.isMesh && obj.geometry) obj.geometry.dispose?.();
    });
    placementPreview = null;
  }

  placementPreview = makePlacementPreviewMesh(activeFoliageId);
  if (activeFoliageId === 'SMALL_DRIPLEAF') applySmallDripleafTopRotation(placementPreview, smallDripleafPlacementRot);
  placementPreview.userData.__placementPreview = true;
  placementPreview.userData.__previewKey = previewKey;
  placementPreview.userData.__previewFoliageId = activeFoliageId;
  scene.add(placementPreview);

  // IMPORTANT: When we rebuild the placement preview (e.g. rotating the cube top face with T,
  // switching variants, changing block type, etc.) we must keep it anchored to the current
  // placementBlock under the mouse. Otherwise it resets to (0,0,0) until the next mousemove.
  if (placementMode && placementPreview) {
    const off = offsetToVec3ForKind(activeFoliageId, placementOff.x, placementOff.y, placementOff.z);
    placementPreview.position.set(
      placementBlock.x + off.x,
      placementBlock.y + off.y,
      placementBlock.z + off.z
    );
    placementPreview.visible = true;
  }

  updatePlacementPreviewBlockedState();
  try { requestRender(); } catch (_) {}
}


// A reusable raycast plane that we move to the current placement Y.
const placementPlane = ground.clone();
placementPlane.material = ground.material; // invisible
scene.add(placementPlane);

function pickBlockOnPlaneY(e, y){
  if (!setNDCFromMouseEvent(e)) return null;
  raycaster.setFromCamera(ndc, camera);

  // Robust mouse-to-world mapping for a horizontal plane at Y=y.
  // Using math planes (instead of intersecting a finite mesh) avoids "no hit" cases
  // that can happen when the plane is above the camera, behind the ray, or when the
  // ray is nearly parallel to the plane.
  const targetY = y;

  const ray = raycaster.ray;
  const up = new THREE.Vector3(0, 1, 0);
  const p = new THREE.Vector3();

  // 1) Try the actual target plane.
  const targetPlane = new THREE.Plane(up, -targetY);
  let ok = ray.intersectPlane(targetPlane, p);

  // 2) Fallback: intersect a plane at the camera's Y to get stable X/Z,
  // then re-apply the desired targetY.
  if (!ok) {
    const camPlane = new THREE.Plane(up, -camera.position.y);
    ok = ray.intersectPlane(camPlane, p);
  }

  // 3) Final fallback: if the ray is parallel to both planes (rare, e.g. perfectly horizontal),
  // take a point some distance along the ray.
  if (!ok) {
    p.copy(ray.origin).addScaledVector(ray.direction, 16);
  }

  const bx = Math.floor(p.x);
  const bz = Math.floor(p.z);
  return new THREE.Vector3(bx, targetY, bz);
}


function updatePlacementPreviewFromEvent(e){
  if (!placementMode) return;
  const b = pickBlockOnPlaneY(e, placementY);
  if (!b) return;
  placementBlock.copy(b);
  if (placementPreview) {
    const off = offsetToVec3ForKind(activeFoliageId, placementOff.x, placementOff.y, placementOff.z);
    placementPreview.position.set(b.x + off.x, b.y + off.y, b.z + off.z);
  }
  updatePlacementPreviewBlockedState();
  try { requestRender(); } catch (_) {}
}

function enterPlacementMode(startY){
  placementMode = true;
  placementY = Math.trunc(startY);
  placementBlock.set(Math.trunc(activeBlock.x), placementY, Math.trunc(activeBlock.z));

  ensurePlacementPreview();
  placementPreview.visible = true;
  const off = offsetToVec3ForKind(activeFoliageId, placementOff.x, placementOff.y, placementOff.z);
  placementPreview.position.set(placementBlock.x + off.x, placementBlock.y + off.y, placementBlock.z + off.z);
  updatePlacementPreviewBlockedState();
  try { requestRender(); } catch (_) {}
}

function computeBlockInFrontOfCameraSameY(){
  // Spawn placement in front of the camera, on the camera's current Y level.
  // This matches the user's expectation when comparing screenshots: a new foliage
  // sample should start near what you're looking at, not at some stale "active block" Y.
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  // A small distance in front of the camera so the initial block is "in view".
  // (Using >1 avoids frequently landing in the same block when very close to a boundary.)
  const dist = 2.0;
  const p = camera.position.clone().add(dir.multiplyScalar(dist));
  return new THREE.Vector3(Math.floor(p.x), Math.floor(camera.position.y), Math.floor(p.z));
}

function enterPlacementModeAtBlock(startBlock){
  placementMode = true;
  placementY = Math.trunc(startBlock.y);
  placementBlock.set(Math.trunc(startBlock.x), placementY, Math.trunc(startBlock.z));

  ensurePlacementOffsetRules();

  ensurePlacementPreview();
  placementPreview.visible = true;
  const off = offsetToVec3ForKind(activeFoliageId, placementOff.x, placementOff.y, placementOff.z);
  placementPreview.position.set(placementBlock.x + off.x, placementBlock.y + off.y, placementBlock.z + off.z);
  updatePlacementPreviewBlockedState();
  try { requestRender(); } catch (_) {}
}

function exitPlacementMode(){
  placementMode = false;
  if (placementPreview) placementPreview.visible = false;
  try { requestRender(); } catch (_) {}
}

// Disable browser context menu on viewport canvas.
viewCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

// While in placement mode, snap the preview to the block under the mouse.
viewCanvas.addEventListener('mousemove', (e) => {
  updatePlacementPreviewFromEvent(e);
});

viewCanvas.addEventListener('mousedown', (e) => {
  // Left button selection happens on mouseup (so we can distinguish click vs drag-pan).
  if (e.button === 0) return;

  // Right = place/remove
  if (e.button === 2) {
    // Placement mode confirmation
    if (placementMode) {
      const block = placementBlock.clone();
      activeBlock.copy(block);
      
const placed = addGrass(block, { ...placementOff });
if (placed == null) {
  const occ = occupantAtBlock(block);
  if (occ != null) showPlacementMsg(`Block (${block.x}, ${block.y}, ${block.z}) is occupied (#${occ}). Delete/move it first.`);
  else showPlacementMsg('Cannot place here.');
  updatePlacementPreviewBlockedState();
  return;
}
exitPlacementMode();
return;
    }

    // Otherwise: enter placement mode.
    // Start placement in front of the camera at the camera's current Y level
    // (more intuitive than using a potentially stale active block Y).
    const start = computeBlockInFrontOfCameraSameY();
    enterPlacementModeAtBlock(start);
    // Snap preview under the cursor immediately.
    updatePlacementPreviewFromEvent(e);
  }
});

// Left-click selects (only if it was not a pan-drag).
viewCanvas.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  // If the user dragged to pan, don't also select.
  if (didPanDrag) return;
  const id = pickGrass(e);
  if (id != null) setSelected(id);
});

// --- Keyboard offsets: WASD/arrows X/Z, R/F Y ---
window.addEventListener('keydown', (e) => {
  // Grass texture quick toggle (ignore when typing in inputs)
  const tag0 = document.activeElement?.tagName?.toLowerCase();
  const typing0 = (tag0 === 'input' || tag0 === 'textarea' || tag0 === 'select');
  // Textures are loaded from the linked Minecraft assets repo now, so 1/2 are unused.

  // Quick toggle between short grass and tall grass (legacy hotkey).
  if (!typing0 && e.key === '') {
    setPlacementFoliage(activeFoliageId === 'TALL_GRASS' ? 'SHORT_GRASS' : 'TALL_GRASS');
    e.preventDefault();
    return;
  }

  // DEL is the only way to delete foliage.
  if (!placementMode && e.key === 'Delete') {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (selectedId != null) {
      removeGrass(selectedId);
      e.preventDefault();
    }
    return;
  }

  // Placement mode: R/F moves placement Y level.
  if (placementMode) {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const key = e.key.toLowerCase();
    if (key === 'r' || key === 'f') {
      placementY += (key === 'r') ? 1 : -1;
      placementBlock.y = placementY;
      if (placementPreview) {
        const off = offsetToVec3ForKind(activeFoliageId, placementOff.x, placementOff.y, placementOff.z);
        placementPreview.position.set(placementBlock.x + off.x, placementBlock.y + off.y, placementBlock.z + off.z);
      }
      try { requestRender(); } catch (_) {}
      e.preventDefault();
    }
    // Cube top-face texture rotation in placement preview: T rotates 90° clockwise.
    if (key === 't' && activeFoliageId === 'CUBE') {
      cubeTopPlacementRot = clampRotSteps4(cubeTopPlacementRot + 1);
      // Rebuild preview so the UV rotation is applied.
      try { ensurePlacementPreview(); } catch (_) {}
      try { syncCubeTopRotationControls(); } catch (_) {}
      try { requestRender(); } catch (_) {}
      e.preventDefault();
      return;
    }

    // ESC cancels placement.
    if (e.key === 'Escape') {
      exitPlacementMode();
      e.preventDefault();
    }
    return;
  }

  if (selectedId == null) return;
  const g = grasses.get(selectedId);
  if (!g) return;

  // avoid moving when typing in inputs
  const tag = document.activeElement?.tagName?.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (e.key !== 'Enter') return;
  }

  let changed = false;
  const key = e.key.toLowerCase();

  // Cube top-face texture rotation (visual-only): T rotates 90° clockwise.
  if (key === 't' && g.kind === 'CUBE') {
    g.cubeTopRot = clampRotSteps4((g.cubeTopRot ?? cubeTopPlacementRot) + 1);
    cubeTopPlacementRot = g.cubeTopRot;
    rebuildCubeInstance(g);
    setSelected(g.id);
    e.preventDefault();
    return;
  }

  // MC axes: +Z south. W should move north => offZ--.
  if (key === 'w' || e.key === 'ArrowUp') {
    if (isPointedDripstone(g.kind)) {
      const ez = dripstoneRawToEff(g.off.z);
      g.off.z = dripstoneEffToRaw(wrap(ez - 1, 0, 9));
    } else {
      g.off.z = wrap(g.off.z - 1, 0, 15);
    }
    changed = true;
  }
  if (key === 's' || e.key === 'ArrowDown') {
    if (isPointedDripstone(g.kind)) {
      const ez = dripstoneRawToEff(g.off.z);
      g.off.z = dripstoneEffToRaw(wrap(ez + 1, 0, 9));
    } else {
      g.off.z = wrap(g.off.z + 1, 0, 15);
    }
    changed = true;
  }
  if (key === 'a' || e.key === 'ArrowLeft') {
    if (isPointedDripstone(g.kind)) {
      const ex = dripstoneRawToEff(g.off.x);
      g.off.x = dripstoneEffToRaw(wrap(ex - 1, 0, 9));
    } else {
      g.off.x = wrap(g.off.x - 1, 0, 15);
    }
    changed = true;
  }
  if (key === 'd' || e.key === 'ArrowRight') {
    if (isPointedDripstone(g.kind)) {
      const ex = dripstoneRawToEff(g.off.x);
      g.off.x = dripstoneEffToRaw(wrap(ex + 1, 0, 9));
    } else {
      g.off.x = wrap(g.off.x + 1, 0, 15);
    }
    changed = true;
  }

  if (!isYOffsetLocked(g.kind)) {
    if (key === 'r') { g.off.y = wrap(g.off.y + 1, 0, 15); changed = true; }
    if (key === 'f') { g.off.y = wrap(g.off.y - 1, 0, 15); changed = true; }
  }

  if (e.key === 'Enter') {
    // "Confirm" (keeps values). We just sync UI.
    changed = true;
  }

  if (changed) {
    updateGrassMeshTransform(g);
    refreshGrassList();
    setSelected(selectedId);
    e.preventDefault();
  }
});

// (No default grass on load; list starts empty.)


// Some models use per-face materials created on the fly (e.g., block models).
// Those materials are not part of foliageMatCache, so we update their opacity here.
function syncSpecialModelOpacity(){
  try {
    const baseOp = grassOpacity;
    const placeOp = clamp(grassOpacity * 0.65, 0, 1);

    // Update placed grass-block-cube meshes (and other per-face block models)
    for (const g of grasses.values()) {
      if (!g || !g.mesh) continue;
      // Some foliage kinds render via block-model/per-segment meshes with their own cloned
      // materials (not shared via foliageMatCache). These need manual opacity updates.
      if (g.kind !== 'CUBE' && g.kind !== 'SUNFLOWER' && g.kind !== 'BAMBOO' && g.kind !== 'POINTED_DRIPSTONE') continue;
      g.mesh.traverse(obj => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!m) continue;
          m.opacity = baseOp;
          m.transparent = (baseOp < 1);
          m.depthWrite = true;
        }
      });
    }

    // Update placement preview (if active)
    if (placementPreview) {
      placementPreview.traverse(obj => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (!m) continue;
          m.opacity = placeOp;
          m.transparent = true;
          m.depthWrite = true;
        }
      });
    }
    try { requestRender(); } catch (_) {}
  } catch (_) {
    // ignore (defensive: placement mode not initialized yet)
  }
}
// --- Render (on-demand) ---
let __renderQueued = false;
let __readyToRender = false;

function requestRender(){
  if (!__readyToRender) return;
  if (__renderQueued) return;
  __renderQueued = true;
  requestAnimationFrame(renderFrame);
}

function renderFrame(){
  __renderQueued = false;
  // Render the 3D scene to the offscreen WebGL canvas (RENDER_WxRENDER_H).
  renderer.render(scene, camera);

  // Composite into the fixed 960x540 viewport canvas with pan/zoom.
  const cw = viewCanvas.clientWidth || 960;
  const ch = viewCanvas.clientHeight || 540;
  if (viewCanvas.width !== cw) viewCanvas.width = cw;
  if (viewCanvas.height !== ch) viewCanvas.height = ch;
  viewCtx.setTransform(1, 0, 0, 1, 0, 0);
  viewCtx.clearRect(0, 0, viewCanvas.width, viewCanvas.height);
  viewCtx.imageSmoothingEnabled = false;

  // Pan/zoom transforms (workspace coords)
  viewCtx.translate(Math.round(viewCanvas.width / 2), Math.round(viewCanvas.height / 2));
  viewCtx.scale(zoom, zoom);
  viewCtx.translate(-roundedCenterX, -roundedCenterY);

  const renderLeft = (VIEW_W - RENDER_W) / 2;
  const renderTop  = (VIEW_H - RENDER_H) / 2;
  // Draw overlay first (never scaled), centered in the workspace.
  // This ensures all 3D helpers (including the grass overlay) render *on top* of the image overlay.
  if (overlayVisible && overlayHasImage()) {
    const ox = Math.round((VIEW_W - overlayImageW) / 2);
    const oy = Math.round((VIEW_H - overlayImageH) / 2);
    viewCtx.globalAlpha = overlayOpacity;
    viewCtx.drawImage(overlayImage, ox, oy);
    viewCtx.globalAlpha = 1;
  }

  // Draw 3D render on top
  viewCtx.drawImage(webglCanvas, renderLeft, renderTop, RENDER_W, RENDER_H);

  // Fixed-thickness (screen-space) border around the 3D render area.
  // This stays 1px no matter how much you zoom/pan, while the rectangle resizes with resolution.
  if (Boolean(el.showBorder?.checked)) {
    const sx = (renderLeft - roundedCenterX) * zoom + (viewCanvas.width / 2);
    const sy = (renderTop  - roundedCenterY) * zoom + (viewCanvas.height / 2);
    const sw = RENDER_W * zoom;
    const sh = RENDER_H * zoom;

    const x = Math.round(sx) + 0.5;
    const y = Math.round(sy) + 0.5;
    const w = Math.round(sw) - 1;
    const h = Math.round(sh) - 1;

    if (w > 0 && h > 0) {
      viewCtx.save();
      viewCtx.setTransform(1, 0, 0, 1, 0, 0);
      viewCtx.globalAlpha = 1;
      viewCtx.strokeStyle = '#ffffff';
      viewCtx.lineWidth = 1;
      viewCtx.strokeRect(x, y, w, h);
      viewCtx.restore();
    }
  }

}

__readyToRender = true;
requestRender();

// --- Global Error Handlers ---
// Catch unhandled promise rejections (e.g., failed async operations)
addManagedEventListener(window, 'unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  
  // Show user-friendly error message
  const errorMsg = event.reason?.message || String(event.reason) || 'An unexpected error occurred';
  alert(`⚠️ Error: ${errorMsg}\n\nCheck the browser console (F12) for details.`);
  
  // Prevent the default browser error handling
  event.preventDefault();
});

// Catch synchronous errors that bubble up
addManagedEventListener(window, 'error', (event) => {
  console.error('Global error:', event.error || event.message);
  
  // Only show alert for critical errors, not resource loading failures
  if (event.error && !event.filename?.includes('http')) {
    const errorMsg = event.error?.message || event.message || 'An unexpected error occurred';
    alert(`⚠️ Error: ${errorMsg}\n\nCheck the browser console (F12) for details.`);
  }
  
  // Let resource loading errors fail silently (textures, etc.)
  if (event.filename?.includes('http')) {
    console.warn('Resource loading failed:', event.filename);
  }
});

// --- Event Listener Cleanup Info ---
// The application now tracks event listeners for proper cleanup.
// To clean up all registered event listeners, call: window.__cleanupEventListeners()
// This is useful for:
// - Testing/debugging memory leaks
// - Preparing for app teardown
// - Resetting the application state
//
// Note: Some event listeners (~50 remaining) still use the old .addEventListener() pattern.
// These can be converted to addManagedEventListener() as needed.
console.log(`✅ Application initialized with ${eventListenerRegistry.length} managed event listeners.`);
console.log('💡 To cleanup all event listeners, call: window.__cleanupEventListeners()');

// --- Texture Refresh Debugging Utilities ---
// Expose texture refresh state for debugging
window.__getTextureRefreshState = () => ({
  isRefreshing: isRefreshingTextures,
  hasPending: pendingTextureRefresh,
  status: isRefreshingTextures 
    ? (pendingTextureRefresh ? 'Refreshing (1 queued)' : 'Refreshing') 
    : (pendingTextureRefresh ? 'Idle (1 queued)' : 'Idle')
});

// Force a texture refresh (useful for debugging)
window.__forceTextureRefresh = async () => {
  console.log('[Debug] Forcing texture refresh...');
  await safeRefreshAllFoliageTextures();
  console.log('[Debug] Texture refresh complete.');
};

console.log('💡 To check texture refresh status, call: window.__getTextureRefreshState()');
console.log('💡 To force a texture refresh, call: window.__forceTextureRefresh()');

// --- Debounce Debugging Utilities ---
console.log(`✅ Application initialized with ${debouncedFunctions.size} debounced input handlers.`);
console.log('💡 Debounced inputs: camera controls, offsets, block position, bamboo UV, variant height');
console.log('💡 To check debounce state, call: window.__getDebounceState()');
console.log('💡 To cancel all pending debounced calls, call: window.__cancelAllDebounced()');
