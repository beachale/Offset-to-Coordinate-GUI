import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

const foliageMatCache = new Map();
const blockCubeMatCache = new Map();

// Float32 helper (matches Java's (float) casts via Math.fround)
const f = Math.fround;

// --- Minecraft block textures ---
// We load foliage textures directly from the Minecraft assets repo you linked.
// (This keeps the zip tiny while still supporting many foliage types.)
const MC_ASSETS_BLOCK_TEX_BASE = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/refs/heads/26.1-snapshot-1/assets/minecraft/textures/block/';
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

const MC_ASSETS_BLOCK_MODEL_BASE = 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/refs/heads/26.1-snapshot-1/assets/minecraft/models/block/';

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
// The on-page viewport is a fixed 960Ã—540 canvas.
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
  // Java: (float)i / 15.0F * 0.2F - 0.2F  -> [-0.2, 0]
  const y = f((iY / 15.0) * MC_MAX_VERT_OFF - MC_MAX_VERT_OFF);

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
  applyOffsets: document.getElementById('applyOffsets'),
  centerOffsets: document.getElementById('centerOffsets'),

  selBlockX: document.getElementById('selBlockX'),
  selBlockY: document.getElementById('selBlockY'),
  selBlockZ: document.getElementById('selBlockZ'),
  applySelBlock: document.getElementById('applySelBlock'),

  grassList: document.getElementById('grassList'),
  foliageSelect: document.getElementById('foliageSelect'),
  bambooUvControls: document.getElementById('bambooUvControls'),
  bambooUvU: document.getElementById('bambooUvU'),
  bambooUvV: document.getElementById('bambooUvV'),
  bambooModelSize: document.getElementById('bambooModelSize'),
  variantControls: document.getElementById('variantControls'),
  variantHeight: document.getElementById('variantHeight'),
  variantDir: document.getElementById('variantDir'),
  propaguleControls: document.getElementById('propaguleControls'),
  propaguleModel: document.getElementById('propaguleModel'),
  cubeControls: document.getElementById('cubeControls'),
  cubeBlockType: document.getElementById('cubeBlockType'),
  seagrassFrameControls: document.getElementById('seagrassFrameControls'),
  seagrassFramePrev: document.getElementById('seagrassFramePrev'),
  seagrassFrameNext: document.getElementById('seagrassFrameNext'),
  seagrassFrameLabel: document.getElementById('seagrassFrameLabel'),
  exportOffsets: document.getElementById('exportOffsets'),
  exportBox: document.getElementById('exportBox'),
  grassDataIn: document.getElementById('grassDataIn'),
  loadGrassData: document.getElementById('loadGrassData'),
  crackCoords: document.getElementById('crackCoords'),
  crackOut: document.getElementById('crackOut'),
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

function num(v, fallback=0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// --- Cracker match mode UI wiring ---
const matchModeEl = el.matchMode;
const toleranceEl = el.tolerance;
const tolValEl = el.tolVal;
const warnEl = el.warn;

if (toleranceEl && tolValEl) {
  tolValEl.textContent = String(toleranceEl.value);
  toleranceEl.oninput = () => { tolValEl.textContent = String(toleranceEl.value); };
}
if (matchModeEl && warnEl) {
  warnEl.classList.toggle('hidden', matchModeEl.value === 'strict');
  matchModeEl.onchange = () => warnEl.classList.toggle('hidden', matchModeEl.value === 'strict');
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
let overlayOpacity = 0.65;
let overlayVisible = true;

function overlayHasImage(){ return !!overlayImage && overlayImageW > 0 && overlayImageH > 0; }

function setOverlayImage(src, w, h){
  overlayImage = src;
  overlayImageW = Math.max(0, Math.trunc(Number(w) || 0));
  overlayImageH = Math.max(0, Math.trunc(Number(h) || 0));
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
  overlayOpacity = clamp(num(el.overlayOpacity?.value, 0.65), 0, 1);
  overlayVisible = Boolean(el.showOverlay?.checked);
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
}


function syncGridRadiusUI(){
  if (!el.gridRadiusLabel || !el.gridRadius) return;
  el.gridRadiusLabel.textContent = String(Math.floor(num(el.gridRadius.value, 4)));
}

function syncGridUI(){
  const on = Boolean(el.showGrid?.checked);
  gridLines.visible = on;
  chunkLines.visible = on;
}

function syncSceneVisUI(){
  // "Grid" here means the line helpers (grid + chunk borders).
  const showGrid = Boolean(el.showGrid?.checked);
  gridLines.visible = showGrid;
  chunkLines.visible = showGrid;

  const showGrass = Boolean(el.showGrass?.checked);
  if (grassGroup) grassGroup.visible = showGrass;
}

function syncVisibilityUI(){
  // "Grid" in the GUI means all line helpers (grid + chunk borders + origin marker).
  const gridVisible = Boolean(el.showGrid?.checked);
  gridLines.visible = gridVisible;
  chunkLines.visible = gridVisible;
  // origin marker is the 3rd object added after the grid/chunk (see below). We keep a reference.
  if (originMarker) originMarker.visible = gridVisible;

  if (grassGroup) grassGroup.visible = Boolean(el.showGrass?.checked);
}

el.overlayOpacity.addEventListener('input', syncOverlayUI);
el.grassOpacity?.addEventListener('input', () => {
  syncGrassOpacityUI();
  try { syncSpecialModelOpacity(); } catch (_) { /* placement mode not initialized yet */ }
});
el.showOverlay.addEventListener('change', syncOverlayUI);
el.gridRadius?.addEventListener('input', () => {
  syncGridRadiusUI();
  // Rebuild helpers around the current camera position.
  // (updateCameraFromUI() calls updateHelpersAroundPlayer internally.)
  updateCameraFromUI();
});
el.showGrid.addEventListener('change', syncGridUI);
el.showGrid.addEventListener('change', syncSceneVisUI);
el.showGrass.addEventListener('change', syncSceneVisUI);
el.showGrid?.addEventListener('change', syncVisibilityUI);
el.showGrass?.addEventListener('change', syncVisibilityUI);
el.centerTpXZ?.addEventListener('change', updateCameraFromUI);
el.overlayFile.addEventListener('change', async (e) => {
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
}

el.applyViewSize?.addEventListener('click', () => {
  applyWorkspaceAndRenderSize(el.viewW?.value, el.viewH?.value, el.renderW?.value, el.renderH?.value);
});

// Convenience: set workspace and render size to the currently loaded overlay image dimensions.
el.sizeToOverlay?.addEventListener('click', () => {
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

// --- Pan/zoom inside the fixed 960Ã—540 viewport canvas ---
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
}

viewCanvas.addEventListener('mousedown', (event) => {
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
viewCanvas.addEventListener('mousemove', (event) => {
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
window.addEventListener('mouseup', () => { leftDown = false; didPanDrag = false; });

viewCanvas.addEventListener('wheel', (event) => {
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
yaw   = ${yaw.toFixed(3)}Â°   (0=+Z/south, -90=+X/east)
pitch = ${pitch.toFixed(3)}Â° (+=down, -=up)
fov   = ${fov.toFixed(3)}Â°   (vertical)
old nudge = ${useOldNudge ? '+0.05' : 'off'}`;
  } else {
    el.readout.textContent =
`Minecraft-style camera
pos   = (${x.toFixed(3)}, ${yEye.toFixed(3)}, ${z.toFixed(3)})   [blocks]
yaw   = ${yaw.toFixed(3)}Â°   (0=+Z/south, -90=+X/east)
pitch = ${pitch.toFixed(3)}Â° (+=down, -=up)
fov   = ${fov.toFixed(3)}Â°   (vertical)
old nudge = ${useOldNudge ? '+0.05' : 'off'}`;
  }

  // Keep helper visuals centered around the player (3x3 chunks) and prevent the grid/borders from stopping at +/-32.
  // These helpers don't exist in vanilla, but they *do* depend on camera position.
  // Round to float32 so boundary-sensitive behavior (e.g. when you're right on a block edge)
  // stays consistent with the rest of the float32 camera pipeline.
  const feetY = feetMode ? yInput : (yEye - EYE_HEIGHT);
  const feetYF = f(feetY);

  updateHelpersAroundPlayer(new THREE.Vector3(xF, feetYF, zF));
  ground.position.set(xF, 0, zF);
}

function syncCamYDisplayToMode() {
  const feetMode = Boolean(el.useFeetY?.checked);
  const yEye = camera.position.y;
  const yDisplay = feetMode ? (yEye - EYE_HEIGHT) : yEye;
  el.camY.value = fmt(yDisplay);
}

// /tp UI wiring
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

for (const k of ['camX','camY','camZ','yaw','pitch','fov']) {
  el[k].addEventListener('input', updateCameraFromUI);
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
syncGridUI();
syncSceneVisUI();


// --- Grass model (MC block-model JSON) ---
// grassGroup already created above.

function syncGrassUI(){
  const on = Boolean(el.showGrass?.checked);
  grassGroup.visible = on;
}

el.showGrass.addEventListener('change', syncGrassUI);
syncGrassUI();

// Shared materials/geometry
// Two textures (same model + same 0â€“15 offsets). Switch with keyboard:
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
    try { await refreshAllFoliageTextures(); } catch (e) { console.warn('Failed to refresh textures', e); }
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
  if (el.resourcePackLoad) el.resourcePackLoad.textContent = on ? 'Replace pack' : 'Load pack';

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
  for (const v of textureCache.values()) {
    try {
      // v can be a Promise during streaming.
      if (v && typeof v.then !== 'function' && v !== PLACEHOLDER_TEX && v.dispose) v.dispose();
    } catch (_) {}
  }
  textureCache.clear();
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
        const modelName = ensureCubeModelRegistered(t);
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
  try { await refreshAllFoliageTextures(); } catch (_) {}
  try { rebuildAllPlacedGrassMeshes(); } catch (_) {}
  try { syncSpecialModelOpacity(); } catch (_) {}
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

const texLoader = new THREE.TextureLoader();
texLoader.setCrossOrigin('anonymous');

function configureMcTexture(t){
  if (!t) return;
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
}



function fixAnimatedStripTexture(tex){
  try {
    // Minecraft animated textures are usually vertical strips of 16x16 frames.
    // For GUI preview we show a single frame by adjusting repeat/offset.
    const img = tex && tex.image;
    if (!img || !img.width || !img.height) return;

    const frames = Math.round(img.height / img.width);
    if (!Number.isFinite(frames) || frames <= 1) return;

    // Store for manual frame selection (e.g. tall seagrass).
    tex.userData = tex.userData || {};
    tex.userData.__stripFrames = frames;
    if (!Number.isFinite(tex.userData.__stripFrame)) tex.userData.__stripFrame = 0;

    // Default to frame 0.
    setAnimatedStripTextureFrame(tex, tex.userData.__stripFrame);
  } catch (e) {
    // ignore
  }
}

function setAnimatedStripTextureFrame(tex, frameIndex, frameCountOverride = null){
  try {
    if (!tex) return;
    const img = tex.image;
    if (!img || !img.width || !img.height) return;

    const detected = Math.round(img.height / img.width);
    let frames = Number.isFinite(detected) ? detected : 1;
    if (Number.isFinite(frameCountOverride) && frameCountOverride > 1) {
      // Prefer the override if it matches the strip shape; otherwise fall back.
      if (frames <= 1 || frames == frameCountOverride) frames = frameCountOverride;
    }
    if (!Number.isFinite(frames) || frames <= 1) return;

    const n = Math.floor(frames);
    const f = ((Math.floor(Number(frameIndex) || 0) % n) + n) % n;

    tex.userData = tex.userData || {};
    tex.userData.__stripFrames = n;
    tex.userData.__stripFrame = f;

    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.repeat.set(1, 1 / n);
    // Frame 0 is at the top of the strip.
    tex.offset.set(0, 1 - (f + 1) / n);
    tex.needsUpdate = true;
  } catch (e) {
    // ignore
  }
}


// A tiny placeholder so meshes don't flash white while textures stream in.
// Fully transparent (1x1) so cutout geometry stays invisible until the real texture is ready.
function makePlaceholderTexture(){
  const data = new Uint8Array([0, 0, 0, 0]); // 1x1 transparent
  const t = new THREE.DataTexture(data, 1, 1);
  configureMcTexture(t);
  return t;
}

const PLACEHOLDER_TEX = makePlaceholderTexture();

// Small UX polish: fade meshes in once their texture arrives (avoids harsh pop-in).
function fadeMaterialOpacity(mat, targetOpacity = 1, ms = 120){
  if (!mat) return;
  const from = Number.isFinite(mat.opacity) ? mat.opacity : 1;
  const start = performance.now();
  mat.transparent = true;

  function step(now){
    const k = Math.min(1, (now - start) / ms);
    mat.opacity = from + (targetOpacity - from) * k;
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
const textureCache = new Map();


function clearProgrammerArtTextureCache(){
  // Because the cache key is just the texture name, switching packs
  // requires invalidating any texture names we may swap.
  for (const k of PROGRAMMER_ART_KEYS) textureCache.delete(k);
}

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
  await Promise.all(jobs);
  // Re-apply manual animated frame selection (tall seagrass).
  applyTallSeagrassFrameToCachedMats();
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

async function getBlockTexture(texName){
  const key = String(texName || '').trim();
  if (!key) return PLACEHOLDER_TEX;

  // IMPORTANT: we may have *in-flight* loads.
  // Older code cached PLACEHOLDER_TEX immediately, which made any concurrent callers
  // permanently receive the placeholder (they would never await the real texture).
  // To fix this, we cache the *Promise* for the load. Awaiting a non-Promise value
  // still works, so callers can safely `await getBlockTexture(...)` either way.
  if (textureCache.has(key)) return await textureCache.get(key);

  const url = blockTextureUrl(key);
  const p = (async () => {
    try {
      const t = await texLoader.loadAsync(url);
      configureMcTexture(t);
      fixAnimatedStripTexture(t);
      textureCache.set(key, t);
      return t;
    } catch (e) {
      console.warn('Failed to load texture', { key, url }, e);
      textureCache.set(key, PLACEHOLDER_TEX);
      return PLACEHOLDER_TEX;
    }
  })();

  textureCache.set(key, p);
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
  { token: 'DIRT_PATH', label: 'dirt path', textures: { up:'block/dirt_path_top', side:'block/dirt_path_side', down:'block/dirt', particle:'block/dirt_path_top' } },
  { token: 'COARSE_DIRT', label: 'coarse dirt', textures: { all:'block/coarse_dirt', particle:'block/coarse_dirt' } },
  { token: 'ROOTED_DIRT', label: 'rooted dirt', textures: { all:'block/rooted_dirt', particle:'block/rooted_dirt' } },
  { token: 'DRIPSTONE_BLOCK', label: 'dripstone block', textures: { all:'block/dripstone_block', particle:'block/dripstone_block' } },
]);

const CUBE_BLOCK_TYPE_BY_TOKEN = new Map(CUBE_BLOCK_TYPES.map(t => [t.token, t]));
let activeCubeBlockType = 'GRASS_BLOCK';

function cubeBlockTypeToModelName(token){
  const t = String(token || '').toUpperCase();
  return `cube_${t.toLowerCase()}`;
}

function ensureCubeModelRegistered(token){
  const t = String(token || '').toUpperCase();
  const def = CUBE_BLOCK_TYPE_BY_TOKEN.get(t) || CUBE_BLOCK_TYPE_BY_TOKEN.get('GRASS_BLOCK');
  const modelName = cubeBlockTypeToModelName(def.token);
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

function showHideBambooUvControls(){
  if (!el.bambooUvControls) return;
  const show = isBamboo(activeFoliageId);
  el.bambooUvControls.classList.toggle('hidden', !show);
  if (show && el.bambooModelSize) el.bambooModelSize.value = String(bambooModelSize || '2x2');
}

function clampInt(v, a, b){
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}

/** Pointed dripstone: vanilla uses the default 16-step foliage grid (±0.25) and then clamps to ±0.125.
    This collapses indices 0–3 and 12–15 into identical final positions.
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

function updateOffsetUiMode(){
  const isDrip = isPointedDripstone(activeFoliageId);
  if (el.offX) { el.offX.min = '0'; el.offX.max = isDrip ? '9' : '15'; el.offX.step = '1'; }
  if (el.offZ) { el.offZ.min = '0'; el.offZ.max = isDrip ? '9' : '15'; el.offZ.step = '1'; }
  if (el.offXRange) el.offXRange.textContent = isDrip ? '0–9' : '0–15';
  if (el.offZRange) el.offZRange.textContent = isDrip ? '0–9' : '0–15';

  // Heads-up: pointed dripstone edge offsets collapse (0–3 and 12–15 map to the same final offset).
  const showNote = isDrip;
  if (el.dripstoneOffsetNote) el.dripstoneOffsetNote.classList.toggle('hidden', !showNote);
}


function applyBambooUvToTexture(tex){
  if (!tex) return;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 1);

  // 1px = 1/16 of a Minecraft texture
  tex.offset.set((bambooUvU % 16) / 16, (bambooUvV % 16) / 16);
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
    dEl.parentElement?.classList?.toggle('hidden', !foliageSupportsDir(activeFoliageId));
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
}

function syncSeagrassFrameControls(){
  const box = el.seagrassFrameControls;
  if (!box) return;
  const show = foliageSupportsSeagrassFrame(activeFoliageId);
  box.classList.toggle('hidden', !show);
  if (show) updateSeagrassFrameLabel();
}

function getActiveVariantFor(foliageId){
  if (!foliageSupportsHeight(foliageId)) return null;
  const v = { height: activeVariantHeight|0 };
  if (foliageId === 'POINTED_DRIPSTONE') v.dir = activeVariantDir;
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
  syncSeagrassFrameControls();
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


showHideBambooUvControls();
syncBambooUvUI();
syncCubeControls();
syncSeagrassFrameControls();

updateOffsetUiMode();

el.seagrassFramePrev?.addEventListener('click', () => {
  setTallSeagrassFrame(tallSeagrassFrame - 1);
});

el.seagrassFrameNext?.addEventListener('click', () => {
  setTallSeagrassFrame(tallSeagrassFrame + 1);
});

el.bambooUvU?.addEventListener('input', () => {
  bambooUvU = clampInt(el.bambooUvU.value, 0, 15);
  applyBambooUvToCachedMats();
  if (typeof placementMode !== 'undefined' && placementMode) ensurePlacementPreview();
});

el.bambooUvV?.addEventListener('input', () => {
  bambooUvV = clampInt(el.bambooUvV.value, 0, 15);
  applyBambooUvToCachedMats();
  if (typeof placementMode !== 'undefined' && placementMode) ensurePlacementPreview();
});

el.bambooModelSize?.addEventListener('change', () => {
  bambooModelSize = String(el.bambooModelSize.value || '2x2');
  // Rebuild any placed bamboo meshes so the change is visible immediately.
  try {
    for (const g of grasses.values()) {
      if (g.kind !== 'BAMBOO') continue;
      const mats = ensureFoliageMats('BAMBOO');
      const isSel = (g.id === selectedId);
      const mat = isSel ? mats.selected : mats.base;

      const newMesh = makeBambooMesh(mat, g.variant?.height ?? 1);
      newMesh.userData.__grassId = g.id;

      grassGroup.remove(g.mesh);
      grassGroup.add(newMesh);
      g.mesh = newMesh;
      updateGrassMeshTransform(g);
    }
    // Re-apply selection materials/tint to keep state consistent.
    setSelected(selectedId);
  } catch (_) {
    // no-op
  }

  if (typeof placementMode !== 'undefined' && placementMode) ensurePlacementPreview();
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
        const modelName = ensureCubeModelRegistered(activeCubeBlockType);
        const newMesh = makeAsyncMinecraftModelMesh(modelName, cmats.base, { perFaceMaterials: true });
        newMesh.userData.__grassId = g.id;

        grassGroup.remove(old);
        grassGroup.add(newMesh);
        g.mesh = newMesh;

        // Best-effort dispose old geometry.
        old?.traverse?.(obj => { if (obj.isMesh && obj.geometry) obj.geometry.dispose?.(); });

        updateGrassMeshTransform(g);
        refreshGrassList();
        setSelected(selectedId);
      }
    }
  } catch (_) {
    // ignore (defensive: selection state not ready yet)
  }
});




el.variantHeight?.addEventListener('input', () => {
  activeVariantHeight = Math.max(1, Math.min(16, Math.trunc(num(el.variantHeight.value, activeVariantHeight))));
  if (typeof placementMode !== 'undefined' && placementMode) {
    ensurePlacementPreview();
  }
});
el.variantHeight?.addEventListener('change', () => {
  activeVariantHeight = Math.max(1, Math.min(16, Math.trunc(num(el.variantHeight.value, activeVariantHeight))));
  if (typeof placementMode !== 'undefined' && placementMode) {
    ensurePlacementPreview();
  }
});
el.variantDir?.addEventListener('change', () => {
  activeVariantDir = String(el.variantDir.value || 'up');
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
    case 'SMALL_DRIPLEAF': return { single: 'small_dripleaf' };

    // XZ (double-height)
    case 'TALL_GRASS': return { bottom: 'tall_grass_bottom', top: 'tall_grass_top' };
    case 'LARGE_FERN': return { bottom: 'large_fern_bottom', top: 'large_fern_top' };
    case 'SUNFLOWER': return { bottom: 'sunflower_bottom', top: 'sunflower_top' };
    case 'LILAC': return { bottom: 'lilac_bottom', top: 'lilac_top' };
    case 'ROSE_BUSH': return { bottom: 'rose_bush_bottom', top: 'rose_bush_top' };
    case 'PEONY': return { bottom: 'peony_bottom', top: 'peony_top' };
    case 'PITCHER_PLANT': return { bottom: 'pitcher_plant_bottom', top: 'pitcher_plant_top' };
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
    map: PLACEHOLDER_TEX,
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
    const baseBottom = makePlantMaterial(PLACEHOLDER_TEX);
    const baseTop = makePlantMaterial(PLACEHOLDER_TEX);
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
  const base = makePlantMaterial(PLACEHOLDER_TEX);
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
const RESCALE_22_5 = 1 / Math.cos(0.39269908169872414) - 1; // 22.5Â°
const RESCALE_45   = 1 / Math.cos(Math.PI / 4) - 1;         // 45Â°

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
  // Minecraft rotates face UVs clockwise in 90° steps.
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
      const t = await getBlockTexture(texName);
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

    // Some models are built asynchronously (e.g., tall seagrass top/bottom, sunflower top).
    // If something is currently selected, re-apply selection materials now that real meshes exist.
    // (Otherwise the selected tint would only appear after the next interaction.)
    try {
      if (typeof selectedId !== 'undefined' && selectedId != null) setSelected(selectedId);
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
      // XZ plane (constant Y) â€” not used by tinted_cross but supported
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
    const modelName = ensureCubeModelRegistered(activeCubeBlockType);
    return makeAsyncMinecraftModelMesh(modelName, cmats.placement, { perFaceMaterials: true });
  }
  const mats = ensureFoliageMats(foliageId);
  const variant = getActiveVariantFor(foliageId);

  if (foliageId === 'BAMBOO') {
    return makeBambooMesh(mats.placement, variant?.height ?? 1);
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

  // Tall seagrass uses vanilla tall_seagrass_bottom/top models (template_seagrass geometry).
  if (foliageId === 'TALL_SEAGRASS') {
    return makeTallSeagrassDoubleMesh(mats.placementBottom, mats.placementTop);
  }

  if (mats.model === 'double') {
    return makeTallGrassMesh(mats.placementBottom, mats.placementTop);
  }
  return makeGrassMesh(mats.placement);
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

// --- Bamboo model size support (2×2 procedural or 3×3 via local JSON model) ---
const LOCAL_BAMBOO_3X3_MODEL = {"textures":{"all":"block/bamboo_stalk","particle":"block/bamboo_stalk"},"elements":[{"from":[7,0,7],"to":[9,16,9],"faces":{"down":{"uv":[13,4,15,6],"texture":"#all","cullface":"down"},"up":{"uv":[13,0,15,2],"texture":"#all","cullface":"up"},"north":{"uv":[0,0,2,16],"texture":"#all"},"south":{"uv":[0,0,2,16],"texture":"#all"},"west":{"uv":[0,0,2,16],"texture":"#all"},"east":{"uv":[0,0,2,16],"texture":"#all"}}}]};
let bamboo3x3ModelJsonPromise = Promise.resolve(LOCAL_BAMBOO_3X3_MODEL);
function getLocalBamboo3x3ModelJSON(){
  return bamboo3x3ModelJsonPromise;
}

function makeBambooMesh(mat, height=1){
  return (String(bambooModelSize) === '3x3')
    ? makeBamboo3x3StackMesh(mat, height)
    : makeBambooStackMesh(mat, height);
}

// When we scale the vanilla 2×2 bamboo JSON element up to a 3×3 stalk, we must also widen the
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

    // Caps: widen + heighten to 3×3 if they're the 2×2 vanilla cap UVs.
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

    // Scale only XZ to turn the 2×2 post into a 3×3 post, keeping it centered in the block.
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
// Vanilla assets define a shared "pointed_dripstone" parent model (crossed planes rotated 45°), and variants
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
    seg.position.set(0, i, 0);
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

/** Block occupancy map: at most one placed texture per 1×1×1 block cell. */
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
    extra += ` ${ct}`;
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
    if (g.kind === 'SUNFLOWER' || g.kind === 'POINTED_DRIPSTONE') {
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

	// sync UI
  if (id == null) return;
	const g = grasses.get(id);
	if (!g) return;

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
		if (el.cubeControls) el.cubeControls.classList.remove('hidden');
		if (el.cubeBlockType) el.cubeBlockType.value = activeCubeBlockType;
	} else {
		// Only show the cube selector when placing cubes (unless a cube is currently selected).
		if (!foliageSupportsCubeBlockType(activeFoliageId) && el.cubeControls) {
			el.cubeControls.classList.add('hidden');
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
  updateOffsetUiMode();

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
  if (kind === 'BAMBOO') {
    mesh = makeBambooMesh(mats.base, variant?.height ?? 1);
  } else if (kind === 'POINTED_DRIPSTONE') {
    mesh = makeDripstoneStackMesh(mats.base, variant?.height ?? 1, variant?.dir ?? 'up');
  } else if (kind === 'CUBE') {
    const cmats = ensureCubeMats();
    const modelName = ensureCubeModelRegistered(activeCubeBlockType);
    mesh = makeAsyncMinecraftModelMesh(modelName, cmats.base, { perFaceMaterials: true });
  } else if (kind === 'MANGROVE_PROPAGULE') {
    const pmats = ensurePropaguleMats(activePropaguleModel);
    const modelName = propaguleModelToBlockModelName(activePropaguleModel);
    mesh = makeAsyncMinecraftModelMesh(modelName, pmats.base);
  } else if (kind === 'SUNFLOWER') {
    // Sunflower top is not a second stalk cross; it uses sunflower_top.json with multiple textures.
    mesh = makeSunflowerDoubleMesh(mats.baseBottom, mats.baseTop);
  } else if (kind === 'TALL_SEAGRASS') {
    mesh = makeTallSeagrassDoubleMesh(mats.baseBottom, mats.baseTop);
  } else {
    mesh = (model === 'double')
      ? makeTallGrassMesh(mats.baseBottom, mats.baseTop)
      : makeGrassMesh(mats.base);
  }

  mesh.userData.__grassId = id;
  grassGroup.add(mesh);

  const g = { id, kind, block: block.clone(), off: { ...fixedOff }, mesh, variant: getActiveVariantFor(kind) };
  if (kind === 'MANGROVE_PROPAGULE') g.propaguleModel = String(activePropaguleModel || 'ground');
  if (kind === 'CUBE') g.cubeType = String(activeCubeBlockType || 'GRASS_BLOCK');
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

  // Release the 1×1×1 block occupancy so something else can be placed here.
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
}

function clearAllGrass(){
  for (const id of [...grasses.keys()]) removeGrass(id);
  grasses.clear();
  occupiedByBlock.clear();
  selectedId = null;
  refreshGrassList();
  if (placementMode) updatePlacementPreviewBlockedState();
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


// Button (kept for parity with your old workflow)
el.applyOffsets.addEventListener('click', () => applyOffsetsFromUI());

// Live update: typing in the offset boxes or using their arrow steppers immediately moves the selected grass.
for (const k of ['offX','offY','offZ']) {
  el[k].addEventListener('input', () => applyOffsetsFromUI({syncUI:false}));
  el[k].addEventListener('change', () => applyOffsetsFromUI({syncUI:false}));
}

// Set selected grass block from XYZ boxes (below the offsets)
el.applySelBlock.addEventListener('click', () => applySelectedBlockFromUI());

// Live update: typing in the selected block XYZ boxes immediately moves the selected grass.
for (const k of ['selBlockX','selBlockY','selBlockZ']) {
  el[k].addEventListener('input', () => applySelectedBlockFromUI({syncUI:false}));
  el[k].addEventListener('change', () => applySelectedBlockFromUI({syncUI:false}));
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
    //   blockX blockY blockZ  offX offY offZ  [KIND] [variant]
    // KIND is optional and defaults to SHORT_GRASS.
    let raw = String(lines[i] || '').trim();
    if (!raw) continue;

    // Allow end-of-line comments (handy for notes while pasting data).
    raw = raw.replace(/\s*(?:#|\/\/).*$/, '').trim();
    if (!raw) continue;

    // Tokenize by whitespace (handles "lots of spaces" and tabs).
    const parts = raw.split(/\s+/);
    if (parts.length < 6){
      throw new Error(`Invalid format on line ${i+1}. Expected: blockX blockY blockZ offX offY offZ [KIND]`);
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
  el.crackStatus.textContent = 'Crackingâ€¦ (this can take a while for large radii)';

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
        el.crackStatus.textContent = `Crackingâ€¦ ${pct.toFixed(1)}%  checked ${done.toLocaleString()} / ${total.toLocaleString()}  matches ${matches}`;
      }
    });

    const dt = performance.now() - t0;
    const lines = res.matches.map(p => {
      if (matchMode === 'scored') return `${p.x} ${p.y} ${p.z}  score=${p.score}`;
      return `${p.x} ${p.y} ${p.z}`;
    });

    if (res.warning) {
      el.crackOut.value = `âš  ${res.warning}\n\n` + (lines.join('\n') || '(no matches)');
    } else {
      el.crackOut.value = lines.length ? lines.join('\n') : '(no matches in the searched range)';
    }
    el.crackStatus.textContent = `Done in ${(dt/1000).toFixed(2)}s â€” matches: ${res.matches.length}`;
    el.crackOut.focus();
    el.crackOut.select();
  } catch (err){
    console.error(err);
    el.crackStatus.textContent = 'Error while cracking â€” see console.';
    el.crackOut.value = String(err?.message || err);
  } finally {
    el.crackCoords.disabled = false;
  }
});


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

    // Old versions (b1.5â€“1.12) do far more work because Y affects offsets.
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
        ? `${activeFoliageId}|${String(activeCubeBlockType || 'GRASS_BLOCK').toUpperCase()}`
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
  placementPreview.userData.__placementPreview = true;
  placementPreview.userData.__previewKey = previewKey;
  placementPreview.userData.__previewFoliageId = activeFoliageId;
  scene.add(placementPreview);
  updatePlacementPreviewBlockedState();
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
}

function exitPlacementMode(){
  placementMode = false;
  if (placementPreview) placementPreview.visible = false;
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
      e.preventDefault();
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
      if (g.kind !== 'CUBE' && g.kind !== 'SUNFLOWER') continue;
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
  } catch (_) {
    // ignore (defensive: placement mode not initialized yet)
  }
}
// --- Render loop ---
function animate(){
  updateCameraFromUI();
  // Render the 3D scene to the offscreen WebGL canvas (RENDER_W×RENDER_H).
  renderer.render(scene, camera);

  // Composite into the fixed 960×540 viewport canvas with pan/zoom.
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

  requestAnimationFrame(animate);
}
animate();

