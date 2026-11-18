// ---------- câmera ----------

// Optional webcam, off by default. Light on purpose (whoever shares a game must
// not feel it): captured small, capped in the encoder, and in a mesh it is one
// encode per person *who sees your card*. Each viewer tells us whether our card
// is on their screen (tab visible and card scrolled into view), so a friend who
// is gaming with the browser minimized costs nothing. Like the screen, the
// fourth transceiver of each connection is negotiated once and filled with
// replaceTrack().
const CAM = {
  normal: { height: 360, fps: 15, bitrate: 400_000 },
  light: { height: 240, fps: 12, bitrate: 250_000 }, // while you share your screen
};
const cam = { track: null, starting: false, deviceId: load('camId') };
const camBtn = $('cam-btn');
const myCamVideo = buildCamVideo();
myCamVideo.classList.add('mirror'); // your own preview reads like a mirror

ICONS.camera = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3z"/></svg>';
ICONS.cameraOff = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3zM3 3l18 18"/></svg>';

function buildCamVideo() {
  const video = el('video', 'cam-video');
  video.autoplay = true;
  video.muted = true; // the camera carries no sound (voice has its own track)
  video.playsInline = true;
  return video;
}

function camProfile() {
  return localTrack ? CAM.light : CAM.normal;
}

async function startCamera() {
  if (cam.track || cam.starting) return;
  cam.starting = true;
  refresh();
  try {
    const { height, fps } = CAM.normal;
    const video = {
      width: { ideal: Math.round((height * 16) / 9) },
      height: { ideal: height },
      frameRate: { ideal: fps, max: fps },
      deviceId: cam.deviceId ? { exact: cam.deviceId } : undefined,
    };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video });
    } catch (err) {
      if (!cam.deviceId || err.name !== 'OverconstrainedError') throw err;
      cam.deviceId = ''; // the saved camera is gone: use the default one
      save('camId', '');
      stream = await navigator.mediaDevices.getUserMedia({ video: { ...video, deviceId: undefined } });
    }
    cam.track = stream.getVideoTracks()[0];
  } catch {
    toast('Não deu para usar a câmera. Libere o acesso no cadeado ao lado do endereço e tente de novo.', 7000);
    return;
  } finally {
    cam.starting = false;
  }
  cam.track.contentHint = 'motion';
  cam.track.onended = stopCamera; // unplugged, or taken by another app
  myCamVideo.srcObject = new MediaStream([cam.track]);
  peers.forEach((peer) => {
    send(peer.id, { camera: true });
    sendCameraTo(peer); // goes out only to those who already see our card
  });
  refresh();
}

function stopCamera() {
  if (!cam.track) return;
  cam.track.onended = null;
  cam.track.stop();
  cam.track = null;
  myCamVideo.srcObject = null;
  peers.forEach((peer) => {
    sendCameraTo(peer);
    send(peer.id, { camera: false });
  });
  refresh();
}

camBtn.onclick = () => (cam.track ? stopCamera() : startCamera());

// --- sending: only to people who see our card ---

function sendCameraTo(peer) {
  const sender = peer.camTransceiver?.sender;
  if (!sender) return;
  const track = cam.track && peer.camWantsMe ? cam.track : null;
  if (sender.track === track) return;
  sender.replaceTrack(track)
    .then(() => track && tuneCamSender(peer))
    .catch((err) => console.warn('camera', err));
}

async function tuneCamSender(peer) {
  const sender = peer.camTransceiver?.sender;
  if (!sender?.track) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) return; // not negotiated yet: retried once connected
  const { height, fps, bitrate } = camProfile();
  const captured = sender.track.getSettings().height || height;
  Object.assign(params.encodings[0], {
    maxBitrate: bitrate,
    maxFramerate: fps,
    scaleResolutionDownBy: Math.max(1, captured / height),
  });
  await sender.setParameters(params).catch((err) => console.warn('camera encoder', err));
}

// Sharing the screen switches the camera to its lightest profile, and back.
function retuneCamera() {
  if (cam.track) peers.forEach(tuneCamSender);
}

// --- receiving: ask for a camera only while its card is on screen ---

const tileVisible = new Map(); // peer id -> card at least partly on screen
const tileObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) tileVisible.set(Number(entry.target.dataset.pid), entry.isIntersecting);
  updateCamWants();
});

function attachCamera(peer, camTransceiver) {
  if (peer.camTransceiver === camTransceiver) return; // ICE restarts re-run the answer path
  peer.camTransceiver = camTransceiver;
  const track = camTransceiver.receiver.track;
  peer.camVideo.srcObject = new MediaStream([track]);
  // The receiver track is "muted" while no frames arrive: show the avatar then.
  track.onmute = refresh;
  track.onunmute = refresh;
  sendCameraTo(peer);
}

function updateCamWants() {
  peers.forEach((peer) => {
    const want = peer.camOn && !document.hidden && tileVisible.get(peer.id) !== false;
    if (want === peer.iWantCam) return;
    peer.iWantCam = want;
    send(peer.id, { camWatch: want });
  });
}
document.addEventListener('visibilitychange', updateCamWants);

// Whether a card shows its camera instead of the avatar.
function camLive(peer) {
  return peer.camOn && peer.iWantCam && !!peer.camTransceiver && !peer.camTransceiver.receiver.track.muted;
}

// Called by refresh() after rebuilding the participant cards.
function observeTiles() {
  tileObserver.disconnect();
  document.querySelectorAll('#tiles .tile[data-pid]').forEach((tile) => tileObserver.observe(tile));
}

function renderCameraUi() {
  camBtn.disabled = cam.starting || myId === null || !navigator.mediaDevices?.getUserMedia;
  camBtn.innerHTML = cam.track ? ICONS.camera : ICONS.cameraOff;
  camBtn.classList.toggle('on', !!cam.track);
  const label = cam.track ? 'Desligar câmera' : 'Ligar câmera';
  camBtn.title = label;
  camBtn.setAttribute('aria-label', label);
}
