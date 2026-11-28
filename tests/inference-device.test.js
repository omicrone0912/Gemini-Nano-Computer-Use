import test from 'node:test';
import assert from 'node:assert/strict';
import { INFERENCE_ENGINES } from '../shared/constants.js';
import {
  classifyGpuAdapter,
  computeOptimalCpuThreads,
  detectInferenceDevices,
  resolveInferenceExecution
} from '../shared/inference-device.js';

test('classifyGpuAdapter differentiates PCIe GPU, integrated GPU, and software renderers', () => {
  assert.equal(classifyGpuAdapter({ type: 'discrete GPU', vendor: 'unknown' }), 'gpu_pcie');
  assert.equal(classifyGpuAdapter({ type: 'integrated GPU', vendor: 'unknown' }), 'gpu_integrated');
  assert.equal(classifyGpuAdapter({ isFallbackAdapter: true, description: 'NVIDIA RTX 4070' }), 'software');
  assert.equal(classifyGpuAdapter({ description: 'Google SwiftShader' }), 'software');
  assert.equal(classifyGpuAdapter({ vendor: 'nvidia', description: 'NVIDIA GeForce RTX 4060' }), 'gpu_pcie');
  assert.equal(classifyGpuAdapter({ description: 'AMD Radeon RX 7800 XT' }), 'gpu_pcie');
  assert.equal(classifyGpuAdapter({ description: 'Intel(R) Arc(TM) A770 Graphics' }), 'gpu_pcie');
  assert.equal(classifyGpuAdapter({ vendor: 'intel', description: 'Intel(R) Iris(R) Xe Graphics' }), 'gpu_integrated');
  assert.equal(classifyGpuAdapter({ description: 'AMD Radeon(TM) 780M Graphics' }), 'gpu_integrated');
  assert.equal(classifyGpuAdapter({ description: 'Apple M3' }), 'gpu_integrated');
});

test('detectInferenceDevices identifies dual-GPU + WebNN NPU and recommends PCIe GPU', async () => {
  let npuDestroyed = false;
  const mockEnv = {
    navigator: {
      hardwareConcurrency: 16,
      deviceMemory: 32,
      gpu: {
        async requestAdapter({ powerPreference }) {
          if (powerPreference === 'low-power') {
            return { info: { vendor: 'intel', description: 'Intel(R) UHD Graphics 770', type: 'integrated GPU' } };
          }
          return { info: { vendor: 'nvidia', description: 'NVIDIA GeForce RTX 4070', type: 'discrete GPU' } };
        }
      },
      ml: {
        async createContext({ deviceType }) {
          assert.equal(deviceType, 'npu');
          return {
            destroy() {
              npuDestroyed = true;
            }
          };
        }
      }
    }
  };

  const detection = await detectInferenceDevices(mockEnv);
  assert.equal(npuDestroyed, true);
  assert.equal(detection.recommendedEngine, INFERENCE_ENGINES.GPU_PCIE);
  assert.equal(detection.devices.cpu.available, true);
  assert.equal(detection.devices.cpu.cores, 16);
  assert.equal(detection.devices.gpu_integrated.available, true);
  assert.match(detection.devices.gpu_integrated.name, /UHD Graphics 770/);
  assert.equal(detection.devices.gpu_pcie.available, true);
  assert.match(detection.devices.gpu_pcie.name, /RTX 4070/);
  assert.equal(detection.devices.npu.available, true);
});

test('detectInferenceDevices falls back to WebGL for integrated GPU and detects CPU/NPU when GPUs are software', async () => {
  let lostContextCalled = false;
  const glMockEnv = {
    navigator: { hardwareConcurrency: 8 },
    document: {
      createElement(tag) {
        assert.equal(tag, 'canvas');
        return {
          getContext(kind) {
            if (kind !== 'webgl2') return null;
            return {
              getExtension(name) {
                if (name === 'WEBGL_debug_renderer_info') {
                  return { UNMASKED_RENDERER_WEBGL: 1, UNMASKED_VENDOR_WEBGL: 2 };
                }
                if (name === 'WEBGL_lose_context') {
                  return {
                    loseContext() {
                      lostContextCalled = true;
                    }
                  };
                }
                return null;
              },
              getParameter(param) {
                if (param === 1) return 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11)';
                if (param === 2) return 'Google Inc. (Intel)';
                return '';
              }
            };
          }
        };
      }
    }
  };

  const igpuOnly = await detectInferenceDevices(glMockEnv);
  assert.equal(lostContextCalled, true);
  assert.equal(igpuOnly.recommendedEngine, INFERENCE_ENGINES.GPU_INTEGRATED);
  assert.equal(igpuOnly.devices.gpu_integrated.available, true);
  assert.equal(igpuOnly.devices.gpu_pcie.available, false);
  assert.equal(igpuOnly.devices.npu.available, false);

  const npuOnlyEnv = {
    navigator: {
      hardwareConcurrency: 4,
      gpu: {
        async requestAdapter() {
          return { isFallbackAdapter: true, info: { description: 'SwiftShader', type: 'CPU' } };
        }
      },
      ml: {
        async createContext() {
          return {};
        }
      }
    }
  };
  const npuRec = await detectInferenceDevices(npuOnlyEnv);
  assert.equal(npuRec.recommendedEngine, INFERENCE_ENGINES.NPU);
  assert.equal(npuRec.devices.gpu_integrated.available, false);
  assert.equal(npuRec.devices.gpu_pcie.available, false);

  const cpuOnly = await detectInferenceDevices({ navigator: { hardwareConcurrency: 4 } });
  assert.equal(cpuOnly.recommendedEngine, INFERENCE_ENGINES.CPU);
});

test('resolveInferenceExecution maps selected engines to Ollama options and missing-device warnings', () => {
  assert.equal(computeOptimalCpuThreads(4), 4);
  assert.equal(computeOptimalCpuThreads(16), 8);

  const igpuDetection = {
    recommendedEngine: INFERENCE_ENGINES.GPU_INTEGRATED,
    devices: {
      cpu: { available: true, cores: 12 },
      gpu_integrated: { available: true, name: 'Iris Xe' },
      gpu_pcie: { available: false, name: '' },
      npu: { available: false, name: '' }
    }
  };

  const autoRes = resolveInferenceExecution({
    requestedEngine: INFERENCE_ENGINES.AUTO,
    detection: igpuDetection
  });
  assert.equal(autoRes.effectiveEngine, INFERENCE_ENGINES.GPU_INTEGRATED);
  assert.deepEqual(autoRes.ollamaOptions, { num_gpu: -1 });
  assert.equal(autoRes.warning, '');

  const cpuRes = resolveInferenceExecution({
    requestedEngine: INFERENCE_ENGINES.CPU,
    detection: igpuDetection
  });
  assert.deepEqual(cpuRes.ollamaOptions, { num_gpu: 0, num_thread: 6 });

  const missingPcieRes = resolveInferenceExecution({
    requestedEngine: INFERENCE_ENGINES.GPU_PCIE,
    detection: igpuDetection
  });
  assert.deepEqual(missingPcieRes.ollamaOptions, { num_gpu: -1 });
  assert.match(missingPcieRes.warning, /PCIe GPU が未検出/);

  const npuFallbackGpu = resolveInferenceExecution({
    requestedEngine: INFERENCE_ENGINES.NPU,
    detection: igpuDetection
  });
  assert.deepEqual(npuFallbackGpu.ollamaOptions, { num_gpu: -1 });
  assert.match(npuFallbackGpu.warning, /NPU が未検出/);
});
