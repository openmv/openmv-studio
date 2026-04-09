// WebGL fullscreen-quad renderer for camera framebuffer display.
// Uploads raw pixel data (RGB565, grayscale, or decoded JPEG) as a
// texture and draws it to a canvas. No application state dependencies.

const VERTEX_SHADER = `
  attribute vec2 a_pos;
  varying vec2 v_uv;
  void main() {
    v_uv = a_pos * 0.5 + 0.5;
    v_uv.y = 1.0 - v_uv.y;
    gl_Position = vec4(a_pos, 0, 1);
  }`;

const FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 v_uv;
  uniform sampler2D u_tex;
  void main() {
    gl_FragColor = texture2D(u_tex, v_uv);
  }`;

const QUAD_VERTS = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

let ctx: WebGLRenderingContext;
let canvas: HTMLCanvasElement;
let width = 0;
let height = 0;

export function wglInit(el: HTMLCanvasElement) {
  canvas = el;

  ctx = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: false,
  })!;

  function compile(type: number, src: string) {
    const s = ctx.createShader(type)!;

    ctx.shaderSource(s, src);
    ctx.compileShader(s);
    return s;
  }

  const prog = ctx.createProgram()!;

  ctx.attachShader(prog, compile(ctx.VERTEX_SHADER, VERTEX_SHADER));
  ctx.attachShader(prog, compile(ctx.FRAGMENT_SHADER, FRAGMENT_SHADER));
  ctx.linkProgram(prog);
  ctx.useProgram(prog);

  ctx.bindBuffer(ctx.ARRAY_BUFFER, ctx.createBuffer());
  ctx.bufferData(ctx.ARRAY_BUFFER, QUAD_VERTS, ctx.STATIC_DRAW);

  const aPos = ctx.getAttribLocation(prog, "a_pos");

  ctx.enableVertexAttribArray(aPos);
  ctx.vertexAttribPointer(aPos, 2, ctx.FLOAT, false, 0, 0);

  const tex = ctx.createTexture();

  ctx.bindTexture(ctx.TEXTURE_2D, tex);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MIN_FILTER, ctx.LINEAR);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_MAG_FILTER, ctx.LINEAR);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_S, ctx.CLAMP_TO_EDGE);
  ctx.texParameteri(ctx.TEXTURE_2D, ctx.TEXTURE_WRAP_T, ctx.CLAMP_TO_EDGE);
}

export function wglCtx(): WebGLRenderingContext {
  return ctx;
}

export function wglWidth(): number {
  return width;
}

export function wglHeight(): number {
  return height;
}

function resize(w: number, h: number) {
  if (w !== width || h !== height) {
    canvas.width = w;
    canvas.height = h;
    ctx.viewport(0, 0, w, h);
    width = w;
    height = h;
  }
}

export function wglDrawRgb565(data: Uint16Array, w: number, h: number) {
  resize(w, h);
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGB, w, h, 0, ctx.RGB, ctx.UNSIGNED_SHORT_5_6_5, data);
  ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);
}

export function wglDrawGrayscale(data: Uint8Array, w: number, h: number) {
  resize(w, h);
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.LUMINANCE, w, h, 0, ctx.LUMINANCE, ctx.UNSIGNED_BYTE, data);
  ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);
}

export function wglDrawBitmap(bitmap: ImageBitmap) {
  resize(bitmap.width, bitmap.height);
  ctx.texImage2D(ctx.TEXTURE_2D, 0, ctx.RGBA, ctx.RGBA, ctx.UNSIGNED_BYTE, bitmap);
  ctx.drawArrays(ctx.TRIANGLE_STRIP, 0, 4);
}
