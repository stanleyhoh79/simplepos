import qrcode from "./qrcode-generator.js";

export function createLocalQrSvg(text, options = {}) {
  const payload = String(text || "");
  if (!payload) return "";
  const cellSize = Number(options.cellSize || 8);
  const margin = Number(options.margin || 3);
  const qr = qrcode(0, options.errorCorrection || "M");
  qr.addData(payload);
  qr.make();
  return qr.createSvgTag({ cellSize, margin }).replace("<svg ", '<svg shape-rendering="crispEdges" ');
}

export function createLocalQrHtml(text, options = {}) {
  const payload = String(text || "");
  if (!payload) return "";
  const qr = qrcode(0, options.errorCorrection || "M");
  qr.addData(payload);
  qr.make();
  const moduleCount = qr.getModuleCount();
  const cells = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let col = 0; col < moduleCount; col += 1) {
      cells.push(`<span class="${qr.isDark(row, col) ? "is-dark" : ""}"></span>`);
    }
  }
  return `<div class="qr-matrix" style="--qr-size:${moduleCount}">${cells.join("")}</div>`;
}

export function createLocalQrDataUrl(text, options = {}) {
  const svg = createLocalQrSvg(text, options);
  return svg ? `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}` : "";
}
