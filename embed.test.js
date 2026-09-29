import test from 'node:test';
import assert from 'node:assert/strict';
import { windows, MODEL_ID } from './embed.js';

const ramp = (n) => Float32Array.from({ length: n }, (_, i) => i);

test('the model is WeSpeaker ResNet34', () => {
  assert.equal(MODEL_ID, 'onnx-community/wespeaker-voxceleb-resnet34-LM');
});

test('input shorter than a window is one window, the whole input', () => {
  const w = windows(ramp(16000), 3, 1.5, 16000);
  assert.equal(w.length, 1);
  assert.equal(w[0].length, 16000);
});

test('input of exactly one window is one window', () => {
  const w = windows(ramp(48000));
  assert.equal(w.length, 1);
  assert.equal(w[0].length, 48000);
});

test('windows are secs long and start every hop', () => {
  const w = windows(ramp(16000 * 6));
  assert.equal(w.length, 3);
  for (const x of w) assert.equal(x.length, 48000);
  assert.deepEqual(w.map((x) => x[0]), [0, 24000, 48000]);
});

test('a tail the hops miss gets one window ending at the last sample', () => {
  const w = windows(ramp(16000 * 5));
  assert.deepEqual(w.map((x) => x[0]), [0, 24000, 32000]);
  assert.equal(w.at(-1).at(-1), 16000 * 5 - 1);
  assert.equal(w.at(-1).length, 48000);
});

test('the sample rate and sizes are parameters', () => {
  const w = windows(ramp(10), 4, 2, 1);
  assert.deepEqual(w.map((x) => [x[0], x.length]), [[0, 4], [2, 4], [4, 4], [6, 4]]);
});
