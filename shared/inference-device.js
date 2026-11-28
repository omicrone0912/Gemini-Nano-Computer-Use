import { INFERENCE_ENGINES } from './constants.js';

export const INFERENCE_ENGINE_LABELS = Object.freeze({
  [INFERENCE_ENGINES.AUTO]: '自動選択',
  [INFERENCE_ENGINES.CPU]: 'CPU',
  [INFERENCE_ENGINES.GPU_INTEGRATED]: 'GPU（CPU内蔵）',
  [INFERENCE_ENGINES.GPU_PCIE]: 'GPU（PCIe）',
  [INFERENCE_ENGINES.NPU]: 'NPU'
});

const SOFTWARE_GPU_PATTERN = /swiftshader|llvmpipe|microsoft basic render|software|warp/i;
const NVIDIA_DISCRETE_PATTERN = /nvidia|geforce|rtx|gtx|quadro|tesla|titan/i;
const AMD_DISCRETE_PATTERN = /radeon\s*rx|radeon\s*pro|firepro|instinct|radeon\s*vii|\brx\s*[45679]\d{2,3}|\br[79]\s*\d{3}/i;
const INTEL_DISCRETE_PATTERN = /arc(?:\s*\(tm\)|™|®)?\s*(?:a[357]\d{2}|b[57]\d{2}|pro)|\bdg[12]\b|alchemist|battlemage/i;
const INTEL_INTEGRATED_PATTERN = /uhd\s*graphics|iris|hd\s*graphics|arc\(tm\)\s*graphics|arc\s*graphics|arc\s*1[34]0v|\bintel\b/i;
const AMD_INTEGRATED_PATTERN = /radeon(?:\s*\(tm\)|™|®)?\s*(?:graphics|(?:610|660|680|740|760|780|880|890)m)|vega\s*\d+|renoir|cezanne|rembrandt|phoenix|hawk\s*point|strix/i;
const APPLE_ARM_INTEGRATED_PATTERN = /apple\s*m\d|apple\s*gpu|adreno|mali/i;

export function classifyGpuAdapter({
  type = '',
  vendor = '',
  architecture = '',
  device = '',
  description = '',
  isFallbackAdapter = false
} = {}) {
  const normalizedType = String(type || '').toLowerCase();
  const combined = [vendor, architecture, device, description].filter(Boolean).join(' ');

  if (isFallbackAdapter || normalizedType === 'cpu' || SOFTWARE_GPU_PATTERN.test(combined)) {
    return 'software';
  }
  if (normalizedType.includes('discrete')) {
    return 'gpu_pcie';
  }
  if (normalizedType.includes('integrated')) {
    return 'gpu_integrated';
  }
  if (
    NVIDIA_DISCRETE_PATTERN.test(combined) ||
    AMD_DISCRETE_PATTERN.test(combined) ||
    INTEL_DISCRETE_PATTERN.test(combined)
  ) {
    return 'gpu_pcie';
  }
  if (
    AMD_INTEGRATED_PATTERN.test(combined) ||
    INTEL_INTEGRATED_PATTERN.test(combined) ||
    APPLE_ARM_INTEGRATED_PATTERN.test(combined)
  ) {
    return 'gpu_integrated';
  }
  return 'unknown';
}

function buildGpuDisplayName(info = {}) {
  const desc = String(info?.description || '').trim();
  if (desc) return desc;
  return [info?.vendor, info?.device || info?.architecture]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ');
}

async function readWebGpuAdapterEntry(gpuApi, powerPreference) {
  try {
    const adapter = await gpuApi.requestAdapter({ powerPreference });
    if (!adapter) return null;
    let info = adapter.info || null;
    if (!info && typeof adapter.requestAdapterInfo === 'function') {
      info = await adapter.requestAdapterInfo().catch(() => null);
    }
    const safeInfo = info || {};
    const isFallbackAdapter = Boolean(adapter.isFallbackAdapter || safeInfo.isFallbackAdapter);
    const kind = classifyGpuAdapter({
      type: safeInfo.type,
      vendor: safeInfo.vendor,
      architecture: safeInfo.architecture,
      device: safeInfo.device,
      description: safeInfo.description,
      isFallbackAdapter
    });
    return {
      powerPreference,
      kind,
      name: buildGpuDisplayName(safeInfo),
      vendor: String(safeInfo.vendor || '').trim(),
      type: String(safeInfo.type || '').trim()
    };
  } catch {
    return null;
  }
}

function readWebGlRendererInfo(doc) {
  try {
    const canvas = doc.createElement('canvas');
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return null;

    let renderer = '';
    let vendor = '';
    try {
      const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugExt) {
        renderer = String(gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) || '').trim();
        vendor = String(gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL) || '').trim();
      }
      if (!renderer && typeof gl.getParameter === 'function' && gl.RENDERER !== undefined) {
        renderer = String(gl.getParameter(gl.RENDERER) || '').trim();
      }
    } finally {
      try {
        gl.getExtension('WEBGL_lose_context')?.loseContext?.();
      } catch {
        // Ignore cleanup errors
      }
    }

    if (!renderer && !vendor) return null;
    return {
      kind: classifyGpuAdapter({ vendor, description: renderer }),
      name: renderer || vendor,
      vendor
    };
  } catch {
    return null;
  }
}

export async function detectInferenceDevices(env = globalThis) {
  const nav = env?.navigator || {};
  const rawCores = Number(nav.hardwareConcurrency);
  const cores = Number.isFinite(rawCores) && rawCores > 0 ? Math.round(rawCores) : null;
  const rawMemory = Number(nav.deviceMemory);
  const memoryGb = Number.isFinite(rawMemory) && rawMemory > 0 ? rawMemory : null;

  const cpuDetailParts = [];
  if (cores) cpuDetailParts.push(`${cores} スレッド`);
  if (memoryGb) cpuDetailParts.push(`${memoryGb}GB RAM`);

  const devices = {
    cpu: {
      available: true,
      cores,
      memoryGb,
      name: cpuDetailParts.length > 0 ? cpuDetailParts.join(' / ') : '標準 CPU',
      detail: 'すべての環境で利用可能'
    },
    gpu_integrated: {
      available: false,
      name: '',
      detail: 'CPU内蔵 GPU は検出されませんでした'
    },
    gpu_pcie: {
      available: false,
      name: '',
      detail: 'PCIe (外付け) GPU は検出されませんでした'
    },
    npu: {
      available: false,
      name: '',
      detail: 'WebNN API 未有効（chrome://flags/#web-machine-learning-neural-network）または未対応'
    }
  };

  if (typeof nav?.gpu?.requestAdapter === 'function') {
    const [lowPower, highPerf] = await Promise.all([
      readWebGpuAdapterEntry(nav.gpu, 'low-power'),
      readWebGpuAdapterEntry(nav.gpu, 'high-performance')
    ]);

    const applyEntry = (entry, fallbackSlot = null) => {
      if (!entry || entry.kind === 'software') return;
      const slot = entry.kind === 'gpu_pcie' || entry.kind === 'gpu_integrated' ? entry.kind : fallbackSlot;
      if (!slot) return;
      if (!devices[slot].available) {
        devices[slot] = {
          available: true,
          name: entry.name || (slot === 'gpu_pcie' ? 'PCIe GPU (WebGPU)' : 'CPU内蔵 GPU (WebGPU)'),
          detail: 'WebGPU により検出'
        };
      } else if (!devices[slot].name && entry.name) {
        devices[slot].name = entry.name;
      }
    };

    const nonSoftEntries = [lowPower, highPerf].filter((e) => e && e.kind !== 'software');
    if (nonSoftEntries.length === 2) {
      applyEntry(lowPower, 'gpu_integrated');
      applyEntry(highPerf, 'gpu_pcie');
    } else if (nonSoftEntries.length === 1) {
      const only = nonSoftEntries[0];
      const fallbackSlot = only.powerPreference === 'low-power' ? 'gpu_integrated' : 'gpu_pcie';
      applyEntry(only, fallbackSlot);
    }
  }

  if (typeof env?.document?.createElement === 'function') {
    const glInfo = readWebGlRendererInfo(env.document);
    if (glInfo && glInfo.kind !== 'software') {
      const slot =
        glInfo.kind === 'gpu_pcie' || glInfo.kind === 'gpu_integrated'
          ? glInfo.kind
          : !devices.gpu_pcie.available && !devices.gpu_integrated.available
            ? 'gpu_integrated'
            : null;
      if (slot) {
        if (!devices[slot].available) {
          devices[slot] = {
            available: true,
            name: glInfo.name || (slot === 'gpu_pcie' ? 'PCIe GPU (WebGL)' : 'CPU内蔵 GPU (WebGL)'),
            detail: 'WebGL レンダラーから検出'
          };
        } else if (!devices[slot].name && glInfo.name) {
          devices[slot].name = glInfo.name;
        }
      }
    }
  }

  if (typeof nav?.ml?.createContext === 'function') {
    try {
      const ctx = await nav.ml.createContext({ deviceType: 'npu' });
      try {
        ctx?.destroy?.();
      } catch {
        // Ignore context destroy errors
      }
      devices.npu = {
        available: true,
        name: 'WebNN NPU',
        detail: 'WebNN API 経由で NPU を検出しました'
      };
    } catch {
      devices.npu = {
        available: false,
        name: '',
        detail: 'NPU ハードウェアまたは対応ドライバが検出されませんでした'
      };
    }
  }

  let recommendedEngine = INFERENCE_ENGINES.CPU;
  if (devices.gpu_pcie.available) {
    recommendedEngine = INFERENCE_ENGINES.GPU_PCIE;
  } else if (devices.gpu_integrated.available) {
    recommendedEngine = INFERENCE_ENGINES.GPU_INTEGRATED;
  } else if (devices.npu.available) {
    recommendedEngine = INFERENCE_ENGINES.NPU;
  }

  return {
    detectedAt: Date.now(),
    recommendedEngine,
    devices
  };
}

export function computeOptimalCpuThreads(cores) {
  const n = Number(cores);
  if (!Number.isFinite(n) || n <= 0) return 4;
  return Math.max(1, n <= 4 ? Math.round(n) : Math.min(16, Math.ceil(n / 2)));
}

export function resolveInferenceExecution({
  requestedEngine = INFERENCE_ENGINES.AUTO,
  detection = null
} = {}) {
  const validEngines = Object.values(INFERENCE_ENGINES);
  const requested = validEngines.includes(requestedEngine) ? requestedEngine : INFERENCE_ENGINES.AUTO;
  const effectiveEngine =
    requested === INFERENCE_ENGINES.AUTO
      ? detection?.recommendedEngine || INFERENCE_ENGINES.CPU
      : requested;

  const cpuThreads = computeOptimalCpuThreads(detection?.devices?.cpu?.cores);
  const hasAnyGpu = Boolean(
    detection?.devices?.gpu_pcie?.available || detection?.devices?.gpu_integrated?.available
  );

  switch (effectiveEngine) {
    case INFERENCE_ENGINES.CPU:
      return {
        requestedEngine: requested,
        effectiveEngine,
        ollamaOptions: { num_gpu: 0, num_thread: cpuThreads },
        note: `Qwen 2.5 VL (Ollama) を CPU 専用 (num_gpu=0 / ${cpuThreads} スレッド) で推論します。`,
        warning: ''
      };
    case INFERENCE_ENGINES.GPU_PCIE:
      return {
        requestedEngine: requested,
        effectiveEngine,
        ollamaOptions: { num_gpu: -1 },
        note: 'Qwen 2.5 VL (Ollama) で PCIe GPU へのフルオフロード (num_gpu=-1) を優先します。',
        warning:
          detection && !detection.devices?.gpu_pcie?.available
            ? 'ブラウザから PCIe GPU が未検出です。Ollama 側で認識できない場合は CPU または内蔵 GPU にフォールバックします。'
            : ''
      };
    case INFERENCE_ENGINES.GPU_INTEGRATED:
      return {
        requestedEngine: requested,
        effectiveEngine,
        ollamaOptions: { num_gpu: -1 },
        note: 'Qwen 2.5 VL (Ollama) で CPU内蔵 GPU へのオフロード (num_gpu=-1) を試みます（非対応バックエンド時は自動フォールバック）。',
        warning:
          detection && !detection.devices?.gpu_integrated?.available
            ? 'ブラウザから CPU内蔵 GPU が未検出です。対応バックエンドが見つからない場合は CPU で実行されます。'
            : ''
      };
    case INFERENCE_ENGINES.NPU:
      return {
        requestedEngine: requested,
        effectiveEngine,
        ollamaOptions: hasAnyGpu ? { num_gpu: -1 } : { num_gpu: 0, num_thread: cpuThreads },
        note: `NPU モードが選択されています。なお Ollama (Qwen 2.5 VL) は NPU 直接オフロード未対応のため、${hasAnyGpu ? 'GPU' : 'CPU'} 設定で安全にフォールバック実行します。`,
        warning:
          detection && !detection.devices?.npu?.available
            ? 'ブラウザから NPU が未検出です（Chrome フラグ未有効または NPU 非搭載の可能性があります）。'
            : ''
      };
    default:
      return {
        requestedEngine: requested,
        effectiveEngine: INFERENCE_ENGINES.CPU,
        ollamaOptions: { num_gpu: 0, num_thread: cpuThreads },
        note: `Qwen 2.5 VL (Ollama) を CPU モード (num_gpu=0 / ${cpuThreads} スレッド) で推論します。`,
        warning: ''
      };
  }
}
