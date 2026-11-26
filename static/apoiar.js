// /apoiar: shows the Pix code and its QR when the server has one (src/apoio.rs).
'use strict';
fetch('/api/apoio', { cache: 'no-store' })
  .then((res) => (res.ok ? res.json() : null))
  .catch(() => null)
  .then((data) => {
    if (!data?.pix) {
      document.getElementById('pix-off').hidden = false;
      return;
    }
    document.getElementById('qr').src = '/api/apoio/qr.svg';
    document.getElementById('pix-name').textContent = data.name;
    document.getElementById('pix-code').value = data.pix;
    document.getElementById('pix').hidden = false;
  });
document.getElementById('pix-copy').onclick = async () => {
  const input = document.getElementById('pix-code');
  const button = document.getElementById('pix-copy');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select(); // no clipboard (no HTTPS): select it to copy by hand
    return;
  }
  button.textContent = '✓ Copiado';
  setTimeout(() => (button.textContent = 'Copiar'), 2000);
};
