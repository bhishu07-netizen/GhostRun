// Live-camera photo hint. Opens the back camera, captures one frame, returns a compressed JPEG data URL.
// Falls back to the phone's camera picker if the browser blocks live camera access.

async function toJpeg(source, w, h) {
  const scale = Math.min(1, 720 / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  let q = 0.7, url = c.toDataURL('image/jpeg', q);
  while (url.length > 380000 && q > 0.3) { q -= 0.1; url = c.toDataURL('image/jpeg', q); }
  return url;
}

export function openCamera(root, { deadline, onPhoto, onClose }) {
  root.innerHTML = `
    <div class="cam" role="dialog" aria-modal="true" aria-label="Send a photo hint">
      <div class="cam-top">
        <span class="cam-title">Photo hint</span>
        <span class="cam-timer" id="camTimer">60s</span>
      </div>
      <p class="cam-rule">Show the place around you. Keep people's faces out of the shot.</p>
      <div class="cam-view"><video id="camVideo" playsinline muted autoplay></video><img id="camShot" alt="Your photo" hidden></div>
      <p class="cam-err" id="camErr" hidden></p>
      <div class="cam-actions">
        <button class="btn soft" id="camRetake" hidden>Retake</button>
        <button class="btn primary" id="camShoot">Take photo</button>
        <button class="btn primary" id="camSend" hidden>Send hint</button>
        <label class="btn soft" id="camPickWrap" hidden>Open camera<input id="camPick" type="file" accept="image/*" capture="environment" hidden></label>
      </div>
    </div>`;
  const $ = (id) => root.querySelector('#' + id);
  const video = $('camVideo'), shot = $('camShot');
  let stream = null, photo = null;

  const stop = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
  let closed = false;
  const close = () => { if (closed) return; closed = true; stop(); clearInterval(timer); if (root.contains(video)) root.innerHTML = ''; onClose && onClose(); };

  const timer = setInterval(() => {
    if (!root.contains(video)) { close(); return; } // something else replaced the dialog
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    $('camTimer').textContent = left + 's';
    if (left <= 0) close();
  }, 250);

  const showPhoto = (url) => {
    photo = url; shot.src = url; shot.hidden = false; video.hidden = true;
    $('camShoot').hidden = true; $('camSend').hidden = false; $('camRetake').hidden = false; $('camPickWrap').hidden = true;
  };

  navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    ? navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
      .then((s) => { stream = s; video.srcObject = s; })
      .catch(() => fallback())
    : fallback();

  function fallback() {
    video.hidden = true; $('camShoot').hidden = true; $('camPickWrap').hidden = false;
    const e = $('camErr'); e.hidden = false; e.textContent = 'Live camera is blocked here. Use your phone camera instead.';
  }

  $('camShoot').onclick = async () => {
    if (!video.videoWidth) return;
    showPhoto(await toJpeg(video, video.videoWidth, video.videoHeight));
  };
  $('camRetake').onclick = () => {
    photo = null; shot.hidden = true;
    if (stream) { video.hidden = false; $('camShoot').hidden = false; } else { $('camPickWrap').hidden = false; }
    $('camSend').hidden = true; $('camRetake').hidden = true;
  };
  $('camPick').onchange = (ev) => {
    const f = ev.target.files && ev.target.files[0];
    if (!f) return;
    const img = new Image();
    img.onload = async () => { showPhoto(await toJpeg(img, img.naturalWidth, img.naturalHeight)); URL.revokeObjectURL(img.src); };
    img.src = URL.createObjectURL(f);
  };
  $('camSend').onclick = async () => {
    if (!photo) return;
    $('camSend').disabled = true; $('camSend').textContent = 'Sending…';
    try { await onPhoto(photo); close(); } catch (err) {
      const e = $('camErr'); e.hidden = false; e.textContent = err.message;
      $('camSend').disabled = false; $('camSend').textContent = 'Send hint';
    }
  };
  return { close };
}
