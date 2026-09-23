import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = ts.createSourceFile("hook.ts", readFileSync(new URL("./useLocalEngine.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function callback(name: string, bindings: Record<string, unknown>) {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (name === "inventory" && ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("offline is not an empty installed inventory")) {
      found = node.arguments[0];
    }
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name && node.initializer && ts.isCallExpression(node.initializer)) {
      found = node.initializer.arguments[0];
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`Missing ${name}`);
  const { outputText } = ts.transpileModule(`const fn = ${found.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  return new Function(...Object.keys(bindings), `${outputText}; return fn;`)(...Object.values(bindings));
}

function harness() {
  let settings: any = { imageProvider: "local", localBackend: "comfyui", engineBackend: "comfyui", engineBaseUrl: "http://localhost:8188", localModel: "qwen21", a1111Path: "C:/a1111" };
  const models = vi.fn(async () => [{ id: "sdxl", label: "SDXL" }]);
  class Backend {
    listModels = models;
    async listComponents() { return { textEncoders: [], vaes: [] }; }
    async listVideoComponents() { return { diffusionModels: [], upscalers: [], ltxTextEncoders: [] }; }
  }
  const setSettings = vi.fn((f: any) => { settings = f(settings); });
  const setInstalledModels = vi.fn();
  const setLocalError = vi.fn();
  const ensureA1111 = vi.fn(async () => "http://localhost:7860");
  const common = {
    isDesktop: true, isRemoteClient: false, settingsRef: { current: settings },
    connectingBackendRef: { current: false },
    Automatic1111Backend: Backend, ComfyUIBackend: Backend, DirectTransport: class {}, desktopFetch: vi.fn(),
    setInstalledModels, setInstalledModelsByBackend: vi.fn(), setInstalledTextEncoders: vi.fn(), setInstalledVaes: vi.fn(),
    setInstalledDiffusionModels: vi.fn(), setInstalledUpscalers: vi.fn(), setInstalledLtxTextEncoders: vi.fn(),
    setSettings, applyLocalModelComponents: (s: any, model: string) => ({ ...s, localModel: model }),
    setEngineStatus: vi.fn(), setConnectingLocal: vi.fn(), setLocalError, ensureA1111, ensureEngine: vi.fn(),
  };
  const probeServer = callback("probeServer", common);
  const connect = callback("onConnectLocalServer", { ...common, probeServer });
  return { connect, probeServer, models, ensureA1111, setSettings, setLocalError, setInstalledModels, settings: () => settings };
}

describe("local engine transactional switches", () => {
  it("discovers external ComfyUI models while A1111 is selected, without switching engines", async () => {
    const inventories: Record<string, unknown> = {};
    const setInstalledModels = vi.fn();
    const settings = { localBackend: "a1111", engineBackend: "a1111" };
    const discovery = callback("inventory", {
      isDesktop: false, isRemoteClient: false, settingsRef: { current: settings },
      knownUrlFor: () => "", LOCAL_ENGINE_DEFAULT_URL: { comfyui: "http://localhost:8188", a1111: "http://localhost:7860" },
      ComfyUIBackend: class { async listModels() { return [{ id: "qwen_image_2.1_int8_convrot.safetensors" }]; } },
      Automatic1111Backend: class { async listModels() { throw new Error("offline"); } },
      setInstalledModelsByBackend: (f: any) => Object.assign(inventories, f(inventories)),
      setInstalledModels,
    });
    discovery();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inventories.comfyui).toEqual([{ id: "qwen_image_2.1_int8_convrot.safetensors" }]);
    expect(inventories.a1111).toBeUndefined();
    expect(setInstalledModels).not.toHaveBeenCalled();
    expect(settings.engineBackend).toBe("a1111");
  });

  it("keeps the current backend, model and inventory when A1111 startup fails", async () => {
    const h = harness();
    h.ensureA1111.mockRejectedValue(new Error("Python missing: launcher exited 1"));
    await h.connect("a1111", "http://localhost:7860", "sdxl");
    expect(h.setSettings).not.toHaveBeenCalled();
    expect(h.setInstalledModels).not.toHaveBeenCalled();
    expect(h.setLocalError).toHaveBeenLastCalledWith(expect.stringContaining("Python missing"));
    expect(h.settings()).toMatchObject({ engineBackend: "comfyui", localModel: "qwen21" });
  });

  it("commits the selected backend and its own model after a successful probe", async () => {
    const h = harness();
    await h.connect("a1111", "http://localhost:7860", "sdxl");
    expect(h.settings()).toMatchObject({ localBackend: "a1111", engineBackend: "a1111", localModel: "sdxl", engineBaseUrl: "http://localhost:7860" });
    expect(h.setInstalledModels).toHaveBeenCalledWith([{ id: "sdxl", label: "SDXL" }]);
  });

  it("does not silently substitute ComfyUI when the requested API is offline", async () => {
    const h = harness();
    h.models.mockRejectedValue(new Error("connection refused"));
    await h.connect("a1111", "http://localhost:7860");
    expect(h.setSettings).not.toHaveBeenCalled();
    expect(h.setLocalError).toHaveBeenLastCalledWith(expect.stringContaining("connection refused"));
  });

  it("rejects a stale model selection before changing inventory or engine", async () => {
    const h = harness();
    await h.connect("a1111", "http://localhost:7860", "qwen21");
    expect(h.setSettings).not.toHaveBeenCalled();
    expect(h.setInstalledModels).not.toHaveBeenCalled();
    expect(h.setLocalError).toHaveBeenLastCalledWith(expect.stringContaining("no longer available"));
  });
});
