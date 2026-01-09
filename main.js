import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

// --- Embedded assets (baked into JS) ---
const GRASS_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IB2cksfwAAAARnQU1BAACxjwv8YQUAAAAgY0hSTQAAeiYAAICEAAD6AAAAgOgAAHUwAADqYAAAOpgAABdwnLpRPAAAAAlwSFlzAAALEwAACxMBAJqcGAAAAAd0SU1FB+oBCBUdD/bhgw0AAAF2SURBVDjLzVAva8NAFP9dRFmgpaSlEDFGTew+QapiS1RNZfIBoqb6AaKq8gEWWRNVYqdaPTE7sTDK2ChJGTm4I+YmtheSNlTvmbv7vfd+fw74d7XaL1TXfZ15nfhVkuYS3c+Xta7F0e2gRejHjioOJbp6nbbP1a450gAgtBNGwNvzF0iN1EmV8HXmqYdpzC4iAMAm2DEACLZzFdoJ64/1uvf5erpw3yJYRjMFALyQ6I9usIxmiucC7y9HrDNPibJqOQEAjfIVhxKT6RAAcHc/QWgnDABMy0DkpqxpP7QTRmK1A1IlsmU0UxTHjx3FC4lNsGNN9dV+oTQaiNyUEcgLiSYxgJqcFxKr/UJtgh3jhQQLtnMVuSnzY0f1xzqO2Tcm02Hr1Ac9mJYBXkjwXIA+lufiN0KwnSsCqPRBrz7p847ZN5pzj94T0yI3ZTwXEGUF0zIgywr0JtuyrOoopmXUJH7sKI3U5Z8K1fmb56LGTh8cACDKCj8oGPasvjKMHwAAAABJRU5ErkJggg==';
const TINTED_CROSS_MODEL = {"ambientocclusion":false,"textures":{"particle":"#cross"},"elements":[{"from":[0.8,0,8],"to":[15.2,16,8],"rotation":{"origin":[8,8,8],"axis":"y","angle":45,"rescale":true},"shade":false,"faces":{"north":{"uv":[0,0,16,16],"texture":"#cross","tintindex":0},"south":{"uv":[0,0,16,16],"texture":"#cross","tintindex":0}}},{"from":[8,0,0.8],"to":[8,16,15.2],"rotation":{"origin":[8,8,8],"axis":"y","angle":45,"rescale":true},"shade":false,"faces":{"west":{"uv":[0,0,16,16],"texture":"#cross","tintindex":0},"east":{"uv":[0,0,16,16],"texture":"#cross","tintindex":0}}}]};

// --- Viewport vs workspace ---
// The on-page viewport is a fixed 960×540 canvas.
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
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  const fx = -Math.sin(yaw) * Math.cos(pitch);
  const fy = -Math.sin(pitch);
  const fz =  Math.cos(yaw) * Math.cos(pitch);
  return new THREE.Vector3(fx, fy, fz).normalize();
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
const MC_MAX_HORIZ_OFF = 0.25;
const MC_MAX_VERT_OFF  = 0.2;

function offsetToVec3(offX, offY, offZ) {
  const xRaw = ((offX / 15) - 0.5) * 0.5;
  const zRaw = ((offZ / 15) - 0.5) * 0.5;
  const yRaw = ((offY / 15) - 1.0) * MC_MAX_VERT_OFF;

  // Minecraft clamps X/Z to +/- getMaxHorizontalOffset().
  const x = clamp(xRaw, -MC_MAX_HORIZ_OFF, MC_MAX_HORIZ_OFF);
  const z = clamp(zRaw, -MC_MAX_HORIZ_OFF, MC_MAX_HORIZ_OFF);
  return new THREE.Vector3(x, yRaw, z);
}

// --- Viewport canvas (2D compositor) + Three.js renderer (offscreen WebGL) ---
const viewCanvas = document.getElementById('view');
viewCanvas.width = 960;
viewCanvas.height = 540;
const viewCtx = viewCanvas.getContext('2d');

const webglCanvas = document.createElement('canvas');
// preserveDrawingBuffer allows drawImage(webglCanvas, ...) reliably.
const renderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); // render is in workspace pixels; keep literal
renderer.setClearColor(0x000000, 0);
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
  const r = Math.floor(num(el.gridRadius?.value, 24));
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

// Vanilla player eye height (standing). Minecraft uses 1.62 blocks for the camera.
// We use this to optionally let the UI show/accept feet Y (Minecraft F3 "XYZ")
// while the actual camera runs at eye Y.
const EYE_HEIGHT = 1.62;

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
  camX: document.getElementById('camX'),
  camY: document.getElementById('camY'),
  useFeetY: document.getElementById('useFeetY'),
  centerTpXZ: document.getElementById('centerTpXZ'),
  camZ: document.getElementById('camZ'),
  yaw: document.getElementById('yaw'),
  pitch: document.getElementById('pitch'),
  fov: document.getElementById('fov'),
  readout: document.getElementById('readout'),

  viewW: document.getElementById('viewW'),
  viewH: document.getElementById('viewH'),
  renderW: document.getElementById('renderW'),
  renderH: document.getElementById('renderH'),
  applyViewSize: document.getElementById('applyViewSize'),
  sizeToOverlay: document.getElementById('sizeToOverlay'),

  overlayFile: document.getElementById('overlayFile'),
  overlayOpacity: document.getElementById('overlayOpacity'),
  showOverlay: document.getElementById('showOverlay'),
  showGrid: document.getElementById('showGrid'),
  gridRadius: document.getElementById('gridRadius'),
  gridRadiusLabel: document.getElementById('gridRadiusLabel'),
  showGrass: document.getElementById('showGrass'),

  blockX: document.getElementById('blockX'),
  blockY: document.getElementById('blockY'),
  blockZ: document.getElementById('blockZ'),
  setActiveBlock: document.getElementById('setActiveBlock'),

  offX: document.getElementById('offX'),
  offY: document.getElementById('offY'),
  offZ: document.getElementById('offZ'),
  applyOffsets: document.getElementById('applyOffsets'),
  centerOffsets: document.getElementById('centerOffsets'),

  selBlockX: document.getElementById('selBlockX'),
  selBlockY: document.getElementById('selBlockY'),
  selBlockZ: document.getElementById('selBlockZ'),
  applySelBlock: document.getElementById('applySelBlock'),

  grassList: document.getElementById('grassList'),
  exportOffsets: document.getElementById('exportOffsets'),
  exportBox: document.getElementById('exportBox'),
  crackCoords: document.getElementById('crackCoords'),
  crackOut: document.getElementById('crackOut'),
  crackCenterX: document.getElementById('crackCenterX'),
  crackCenterZ: document.getElementById('crackCenterZ'),
  crackRadius: document.getElementById('crackRadius'),
  crackYMin: document.getElementById('crackYMin'),
  crackYMax: document.getElementById('crackYMax'),
  crackVersion: document.getElementById('crackVersion'),
  crackStatus: document.getElementById('crackStatus'),
  clearGrass: document.getElementById('clearGrass'),
};

function num(v, fallback=0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
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

// Overlay image state (drawn into the compositor canvas, never scaled)
let overlayImage = null; // HTMLImageElement
let overlayOpacity = 0.65;
let overlayVisible = true;

function syncOverlayUI(){
  overlayOpacity = clamp(num(el.overlayOpacity?.value, 0.65), 0, 1);
  overlayVisible = Boolean(el.showOverlay?.checked);
}

function syncGridRadiusUI(){
  if (!el.gridRadiusLabel || !el.gridRadius) return;
  el.gridRadiusLabel.textContent = String(Math.floor(num(el.gridRadius.value, 24)));
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
el.overlayFile.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    overlayImage = img;
    syncOverlayUI();
  };
  img.src = url;
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
  const iw = overlayImage?.naturalWidth ?? 0;
  const ih = overlayImage?.naturalHeight ?? 0;
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

// --- Pan/zoom inside the fixed 960×540 viewport canvas ---
let mouseDown = false;
let mouseDownPixelX = 0;
let mouseDownPixelY = 0;
let spaceDown = false;

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

window.addEventListener('keydown', (e) => { if (e.code === 'Space') spaceDown = true; });
window.addEventListener('keyup', (e) => { if (e.code === 'Space') spaceDown = false; });

viewCanvas.addEventListener('mousedown', (event) => {
  // Space+drag pans the workspace. (Regular click remains available for selection.)
  if (!spaceDown) return;
  mouseDown = true;
  mouseDownPixelX = offsetToWorkspaceX(event.offsetX);
  mouseDownPixelY = offsetToWorkspaceY(event.offsetY);
  event.preventDefault();
});
window.addEventListener('mouseup', () => { mouseDown = false; });
viewCanvas.addEventListener('mousemove', (event) => {
  if (!mouseDown) return;
  setOffsetWorkspacePos(event.offsetX, event.offsetY, mouseDownPixelX, mouseDownPixelY);
  event.preventDefault();
});

viewCanvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  // Zoom around cursor (like local-overlay). One wheel tick ~ +/-1 zoom index.
  if (!mouseDown) {
    mouseDownPixelX = offsetToWorkspaceX(event.offsetX);
    mouseDownPixelY = offsetToWorkspaceY(event.offsetY);
  }
  zoomIndex = clamp(zoomIndex + Math.round(-event.deltaY / 100), -6, 6);
  zoom = Math.pow(2, zoomIndex);
  setOffsetWorkspacePos(event.offsetX, event.offsetY, mouseDownPixelX, mouseDownPixelY);
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

  camera.position.set(x, yEye, z);
  const forward = mcForwardFromYawPitch(yaw, pitch);
  camera.lookAt(new THREE.Vector3().copy(camera.position).add(forward));

  if (feetMode) {
    const yFeet = yInput;
    el.readout.textContent =
`Minecraft-style camera
pos   = (${x.toFixed(3)}, ${yEye.toFixed(3)}, ${z.toFixed(3)})   [eye]
feet  = (${x.toFixed(3)}, ${yFeet.toFixed(3)}, ${z.toFixed(3)})
yaw   = ${yaw.toFixed(3)}°   (0=+Z/south, -90=+X/east)
pitch = ${pitch.toFixed(3)}° (+=down, -=up)
fov   = ${fov.toFixed(3)}°   (vertical)`;
  } else {
    el.readout.textContent =
`Minecraft-style camera
pos   = (${x.toFixed(3)}, ${yEye.toFixed(3)}, ${z.toFixed(3)})   [blocks]
yaw   = ${yaw.toFixed(3)}°   (0=+Z/south, -90=+X/east)
pitch = ${pitch.toFixed(3)}° (+=down, -=up)
fov   = ${fov.toFixed(3)}°   (vertical)`;
  }

  // Keep helper visuals centered around the player (3x3 chunks) and prevent the grid/borders from stopping at +/-32.
  const feetY = feetMode ? yInput : (yEye - EYE_HEIGHT);
  updateHelpersAroundPlayer(new THREE.Vector3(x, feetY, z));
  ground.position.set(x, 0, z);
}

function syncCamYDisplayToMode() {
  const feetMode = Boolean(el.useFeetY?.checked);
  const yEye = camera.position.y;
  const yDisplay = feetMode ? (yEye - EYE_HEIGHT) : yEye;
  el.camY.value = fmt(yDisplay);
}

for (const k of ['camX','camY','camZ','yaw','pitch','fov']) {
  el[k].addEventListener('input', updateCameraFromUI);
}

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
const texture = await new THREE.TextureLoader().loadAsync(GRASS_PNG_DATA_URL);
texture.colorSpace = THREE.SRGBColorSpace;
texture.magFilter = THREE.NearestFilter;
texture.minFilter = THREE.NearestFilter;

const baseMat = new THREE.MeshBasicMaterial({
  map: texture,
  transparent: true,
  alphaTest: 0.5,
  // IMPORTANT (Minecraft parity): plants are not mirrored when viewed from the back.
  // A single DoubleSide plane in WebGL appears mirrored on the backface.
  // Vanilla achieves the correct look by effectively rendering each quad twice
  // (one for each side) with consistent UV orientation.
  side: THREE.FrontSide,
  depthWrite: true,
});
const selectedMat = baseMat.clone();
// Make selection "slightly brighter" (less tinted) rather than a strong color.
baseMat.color.setHex(0xdddddd);
selectedMat.color.setHex(0xffffff);

// Placement preview material (light gray)
const placementMat = baseMat.clone();
placementMat.color.setHex(0xd6d6d6);
placementMat.opacity = 0.65;
placementMat.transparent = true;
placementMat.depthWrite = false;

// We build the grass directly from the Minecraft model JSON (tinted_cross.json)
// so that rotations (including `rescale: true`) match the in-game geometry.
const RESCALE_22_5 = 1 / Math.cos(0.39269908169872414) - 1; // 22.5°
const RESCALE_45   = 1 / Math.cos(Math.PI / 4) - 1;         // 45°

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

function makeGrassMesh(){
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
      plane = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), baseMat);
      plane.position.set(cx, cy, cz);
      planeKind = 'xy';
    } else if (sx < eps) {
      // YZ plane (constant X)
      plane = new THREE.Mesh(new THREE.PlaneGeometry(sz, sy), baseMat);
      plane.rotation.y = Math.PI / 2;
      plane.position.set(cx, cy, cz);
      planeKind = 'yz';
    } else if (sy < eps) {
      // XZ plane (constant Y) — not used by tinted_cross but supported
      plane = new THREE.Mesh(new THREE.PlaneGeometry(sx, sz), baseMat);
      plane.rotation.x = -Math.PI / 2;
      plane.position.set(cx, cy, cz);
      planeKind = 'xz';
    } else {
      // Fallback: thin box (shouldn't happen for tinted_cross)
      plane = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), baseMat);
      plane.position.set(cx, cy, cz);
      planeKind = 'box';
    }

    // Minecraft parity: the plant quads must look identical from both sides.
    // Instead of DoubleSide (mirrors UVs), we duplicate the plane and flip it.
    if (plane.isMesh && plane.geometry?.type === 'PlaneGeometry') {
      const back = plane.clone();
      // Use FrontSide on both meshes so UVs remain consistent.
      back.material = baseMat;
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

function makePlacementPreviewMesh(){
  const m = makeGrassMesh();
  m.traverse(obj => {
    if (obj.isMesh) obj.material = placementMat;
  });
  return m;
}

// --- Grass instances state ---
let nextId = 1;
/** @type {Map<number, {id:number, block:THREE.Vector3, off:{x:number,y:number,z:number}, mesh:THREE.Group}>} */
const grasses = new Map();
let selectedId = null;
let activeBlock = new THREE.Vector3(0, 0, 0);

function keyForBlock(b){ return `${b.x}|${b.y}|${b.z}`; }
function grassLabel(g){
  const b = g.block;
  const o = g.off;
  return `#${g.id}  block(${b.x},${b.y},${b.z})  off(${o.x},${o.y},${o.z})`;
}

function updateGrassMeshTransform(g){
  const blockOrigin = new THREE.Vector3(g.block.x, g.block.y, g.block.z);
  const offset = offsetToVec3(g.off.x, g.off.y, g.off.z);
  // Minecraft renders baked model vertices in block-local space [0..1] with the origin at the
  // *block corner*, then translates by BlockState.getOffset(pos). So the correct world-space
  // placement is simply: blockPosCorner + offset.
  g.mesh.position.copy(blockOrigin.add(offset));
}

function setSelected(id){
  selectedId = id;
  for (const g of grasses.values()) {
    const isSel = g.id === id;
    g.mesh.traverse(obj => {
      if (obj.isMesh) obj.material = isSel ? selectedMat : baseMat;
    });
  }

  // sync UI
  if (id == null) return;
  const g = grasses.get(id);
  if (!g) return;
  el.blockX.value = String(g.block.x);
  el.blockY.value = String(g.block.y);
  el.blockZ.value = String(g.block.z);

  // Selected grass block position (separate from "active block")
  el.selBlockX.value = String(g.block.x);
  el.selBlockY.value = String(g.block.y);
  el.selBlockZ.value = String(g.block.z);
  el.offX.value = String(g.off.x);
  el.offY.value = String(g.off.y);
  el.offZ.value = String(g.off.z);

  // select in list
  for (const opt of el.grassList.options) {
    opt.selected = Number(opt.value) === id;
  }
}

function refreshGrassList(){
  const prev = selectedId;
  el.grassList.innerHTML = '';
  const ordered = [...grasses.values()].sort((a,b)=>a.id-b.id);
  for (const g of ordered) {
    const opt = document.createElement('option');
    opt.value = String(g.id);
    opt.textContent = grassLabel(g);
    el.grassList.appendChild(opt);
  }
  if (prev != null && grasses.has(prev)) setSelected(prev);
}

function addGrass(block, off = {x:7,y:7,z:7}){
  const id = nextId++;
  const mesh = makeGrassMesh();
  mesh.userData.__grassId = id;
  grassGroup.add(mesh);
  const g = { id, block: block.clone(), off: { ...off }, mesh };
  grasses.set(id, g);
  updateGrassMeshTransform(g);
  refreshGrassList();
  setSelected(id);
  return id;
}

function removeGrass(id){
  const g = grasses.get(id);
  if (!g) return;
  grassGroup.remove(g.mesh);
  grasses.delete(id);
  if (selectedId === id) selectedId = null;
  refreshGrassList();
  // pick a new selection if any remain
  const first = grasses.values().next().value;
  if (first) setSelected(first.id);
}

function clearAllGrass(){
  for (const id of [...grasses.keys()]) removeGrass(id);
  grasses.clear();
  selectedId = null;
  refreshGrassList();
}

// --- Active block UI ---
function setActiveBlockFromInputs(){
  activeBlock = new THREE.Vector3(
    Math.trunc(num(el.blockX.value, 0)),
    Math.trunc(num(el.blockY.value, 0)),
    Math.trunc(num(el.blockZ.value, 0))
  );
}

el.setActiveBlock.addEventListener('click', () => {
  setActiveBlockFromInputs();
});

// --- Offset UI apply ---
function applyOffsetsFromUI({syncUI=true} = {}){
  if (selectedId == null) return;
  const g = grasses.get(selectedId);
  if (!g) return;

  g.off.x = wrap(Math.trunc(num(el.offX.value, g.off.x)), 0, 15);
  g.off.y = wrap(Math.trunc(num(el.offY.value, g.off.y)), 0, 15);
  g.off.z = wrap(Math.trunc(num(el.offZ.value, g.off.z)), 0, 15);

  updateGrassMeshTransform(g);
  refreshGrassList();
  if (syncUI) setSelected(selectedId);
}

// --- Selected grass block position UI ---
function applySelectedBlockFromUI({syncUI=true} = {}){
  if (selectedId == null) return;
  const g = grasses.get(selectedId);
  if (!g) return;

  g.block.x = Math.trunc(num(el.selBlockX.value, g.block.x));
  g.block.y = Math.trunc(num(el.selBlockY.value, g.block.y));
  g.block.z = Math.trunc(num(el.selBlockZ.value, g.block.z));

  updateGrassMeshTransform(g);
  refreshGrassList();
  if (syncUI) setSelected(selectedId);
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
  el.offX.value = '7';
  el.offY.value = '7';
  el.offZ.value = '7';
  applyOffsetsFromUI();
});

el.grassList.addEventListener('change', () => {
  const id = Number(el.grassList.value);
  if (Number.isFinite(id) && grasses.has(id)) setSelected(id);
});

el.exportOffsets.addEventListener('click', () => {
  const ordered = [...grasses.values()].sort((a,b)=>a.id-b.id);
  const lines = ordered.map(g => {
    const b = g.block;
    const o = g.off;
    return `${b.x} ${b.y} ${b.z}  ${o.x} ${o.y} ${o.z}`;
  });
  el.exportBox.value = lines.join('\n');
  el.exportBox.focus();
  el.exportBox.select();
});


el.crackCoords.addEventListener('click', async () => {
  const centerX = num(el.crackCenterX.value, 0);
  const centerZ = num(el.crackCenterZ.value, 0);
  const radius = clamp(Math.round(num(el.crackRadius.value, 256)), 0, 50000);
  const yMin = Math.round(num(el.crackYMin.value, 62));
  const yMax = Math.round(num(el.crackYMax.value, 70));
  const version = el.crackVersion.value === 'postb1_5' ? 'postb1_5' : 'post1_12';

  el.crackOut.value = '';
  el.crackCoords.disabled = true;
  el.crackStatus.textContent = 'Cracking… (this can take a while for large radii)';

  const t0 = performance.now();
  try{
    const res = await GF.crack({
      centerX, centerZ, radius, yMin, yMax, version,
      onProgress: ({done, total, matches}) => {
        const pct = total ? (done/total*100) : 0;
        el.crackStatus.textContent = `Cracking… ${pct.toFixed(1)}%  checked ${done.toLocaleString()} / ${total.toLocaleString()}  matches ${matches}`;
      }
    });

    const dt = performance.now() - t0;
    if (res.warning) {
      el.crackOut.value = `⚠ ${res.warning}\n\n` + (res.matches.map(p => `${p.x} ${p.y} ${p.z}`).join('\n') || '(no matches)');
    } else {
      el.crackOut.value = res.matches.length
        ? res.matches.map(p => `${p.x} ${p.y} ${p.z}`).join('\n')
        : '(no matches in the searched range)';
    }
    el.crackStatus.textContent = `Done in ${(dt/1000).toFixed(2)}s — matches: ${res.matches.length}`;
    el.crackOut.focus();
    el.crackOut.select();
  } catch (err){
    console.error(err);
    el.crackStatus.textContent = 'Error while cracking — see console.';
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
  let obj = hits[0].object;
  while (obj && !obj.parent?.userData?.__grassId && !obj.userData.__grassId) obj = obj.parent;
  const id = obj?.userData?.__grassId ?? obj?.parent?.userData?.__grassId;
  return (typeof id === 'number') ? id : null;
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
  const X_MULT = 0x2fc20f;
  const Z_MULT = 0x6ebfff5;
  const LCG_MULT = 0x285b825n;
  const LCG_ADDEND = 11n;

  function getCoordRandom(x, y, z){
    // Use BigInt to keep 64-bit behavior consistent with Rust/Java long math.
    let seed = (BigInt(x * X_MULT) ^ BigInt(z * Z_MULT) ^ BigInt(y));
    seed = seed * seed * LCG_MULT + seed * LCG_ADDEND;
    return seed;
  }

  function grassOffset(x, y, z, version){
    const yy = (version === 'post1_12') ? 0 : y;
    const seed = getCoordRandom(x, yy, z);
    return {
      x: Number((seed >> 16n) & 15n),
      y: Number((seed >> 20n) & 15n),
      z: Number((seed >> 24n) & 15n),
    };
  }

  function equalOff(a,b){ return a.x===b.x && a.y===b.y && a.z===b.z; }

  function rowsFromGrasses(){
    const ordered = [...grasses.values()].sort((a,b)=>a.id-b.id);
    return ordered.map(g => ({
      pos: { x: g.block.x|0, y: g.block.y|0, z: g.block.z|0 },
      off: { x: g.off.x|0, y: g.off.y|0, z: g.off.z|0 },
    }));
  }

  function crack({centerX, centerZ, radius, yMin, yMax, version, onProgress}){
    const rows = rowsFromGrasses();
    if (rows.length < 2) {
      return { matches: [], warning: 'Add at least 2 grass blocks to crack coordinates.' };
    }

    const recorigin = rows[0].pos;
    const rel = rows.map(r => ({
      dx: r.pos.x - recorigin.x,
      dy: r.pos.y - recorigin.y,
      dz: r.pos.z - recorigin.z,
      off: r.off,
    }));

    const x0 = Math.floor(centerX - radius);
    const x1 = Math.floor(centerX + radius);
    const z0 = Math.floor(centerZ - radius);
    const z1 = Math.floor(centerZ + radius);
    const yy0 = Math.floor(Math.min(yMin, yMax));
    const yy1 = Math.floor(Math.max(yMin, yMax));

    const total = (x1-x0+1) * (z1-z0+1) * (yy1-yy0+1);
    let done = 0;
    const matches = [];

    function checkAt(x,y,z){
      for (let i=0;i<rel.length;i++){
        const r = rel[i];
        const ax = x + r.dx;
        const ay = y + r.dy;
        const az = z + r.dz;
        const o = grassOffset(ax, ay, az, version);
        if (!equalOff(o, r.off)) return false;
      }
      return true;
    }

    // Chunked scan to keep UI responsive.
    let cy = yy0, cz = z0, cx = x0;
    const MAX_MATCHES = 2000;
    const CHUNK = 8000;

    return new Promise(resolve => {
      function step(){
        let n = 0;
        while (n < CHUNK && cy <= yy1){
          if (checkAt(cx, cy, cz)) {
            matches.push({ x: cx, y: cy, z: cz });
            if (matches.length >= MAX_MATCHES) {
              resolve({ matches, warning: `Hit the cap of ${MAX_MATCHES} matches. Reduce radius / tighten inputs.` });
              return;
            }
          }

          // advance
          done++; n++;
          cx++;
          if (cx > x1){ cx = x0; cz++; }
          if (cz > z1){ cz = z0; cy++; }

          if (onProgress && (done % 50000 === 0)) onProgress({ done, total, matches: matches.length });
        }

        if (onProgress) onProgress({ done, total, matches: matches.length });

        if (cy > yy1) {
          resolve({ matches, warning: null });
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

// A reusable raycast plane that we move to the current placement Y.
const placementPlane = ground.clone();
placementPlane.material = ground.material; // invisible
scene.add(placementPlane);

function pickBlockOnPlaneY(e, y){
  if (!setNDCFromMouseEvent(e)) return null;
  raycaster.setFromCamera(ndc, camera);
  placementPlane.position.set(camera.position.x, y, camera.position.z);
  const hits = raycaster.intersectObject(placementPlane, false);
  if (!hits.length) return null;
  const p = hits[0].point;
  const bx = Math.floor(p.x);
  const bz = Math.floor(p.z);
  return new THREE.Vector3(bx, y, bz);
}

function updatePlacementPreviewFromEvent(e){
  if (!placementMode) return;
  const b = pickBlockOnPlaneY(e, placementY);
  if (!b) return;
  placementBlock.copy(b);
  if (placementPreview) {
    const off = offsetToVec3(placementOff.x, placementOff.y, placementOff.z);
    placementPreview.position.set(b.x + off.x, b.y + off.y, b.z + off.z);
  }
}

function enterPlacementMode(startY){
  placementMode = true;
  placementY = Math.trunc(startY);
  placementBlock.set(Math.trunc(activeBlock.x), placementY, Math.trunc(activeBlock.z));

  if (!placementPreview) {
    placementPreview = makePlacementPreviewMesh();
    // Preview should not be pickable as an existing grass instance.
    placementPreview.userData.__placementPreview = true;
    scene.add(placementPreview);
  }
  placementPreview.visible = true;
  const off = offsetToVec3(placementOff.x, placementOff.y, placementOff.z);
  placementPreview.position.set(placementBlock.x + off.x, placementBlock.y + off.y, placementBlock.z + off.z);
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
  // If we're currently panning (Space+drag), don't treat this as a placement/select click.
  if (spaceDown) return;
  // Left = select
  if (e.button === 0) {
    const id = pickGrass(e);
    if (id != null) setSelected(id);
    return;
  }

  // Right = place/remove
  if (e.button === 2) {
    // Placement mode confirmation
    if (placementMode) {
      const block = placementBlock.clone();
      activeBlock.copy(block);
      el.blockX.value = String(block.x);
      el.blockY.value = String(block.y);
      el.blockZ.value = String(block.z);
      addGrass(block, { ...placementOff });
      exitPlacementMode();
      return;
    }

    // Otherwise: enter placement mode.
    setActiveBlockFromInputs();
    enterPlacementMode(activeBlock.y);
    // Snap preview under the cursor immediately.
    updatePlacementPreviewFromEvent(e);
  }
});

// --- Keyboard offsets: WASD/arrows X/Z, R/F Y ---
window.addEventListener('keydown', (e) => {
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
        const off = offsetToVec3(placementOff.x, placementOff.y, placementOff.z);
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
  if (key === 'w' || e.key === 'ArrowUp') { g.off.z = wrap(g.off.z - 1, 0, 15); changed = true; }
  if (key === 's' || e.key === 'ArrowDown') { g.off.z = wrap(g.off.z + 1, 0, 15); changed = true; }
  if (key === 'a' || e.key === 'ArrowLeft') { g.off.x = wrap(g.off.x - 1, 0, 15); changed = true; }
  if (key === 'd' || e.key === 'ArrowRight') { g.off.x = wrap(g.off.x + 1, 0, 15); changed = true; }

  if (key === 'r') { g.off.y = wrap(g.off.y + 1, 0, 15); changed = true; }
  if (key === 'f') { g.off.y = wrap(g.off.y - 1, 0, 15); changed = true; }

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
  // Draw 3D render
  viewCtx.drawImage(webglCanvas, renderLeft, renderTop, RENDER_W, RENDER_H);

  // Draw overlay on top (never scaled), centered in the workspace.
  if (overlayVisible && overlayImage) {
    const ox = Math.round((VIEW_W - overlayImage.naturalWidth) / 2);
    const oy = Math.round((VIEW_H - overlayImage.naturalHeight) / 2);
    viewCtx.globalAlpha = overlayOpacity;
    viewCtx.drawImage(overlayImage, ox, oy);
    viewCtx.globalAlpha = 1;
  }
  requestAnimationFrame(animate);
}
animate();