/**
 * Typer för onnxruntime-node 1.20.1.
 *
 * Paketet pekar ut `dist/index.d.ts` i sin package.json men publicerar inte filen — ett
 * paketeringsfel i just den versionen. Versionen är vald med flit: från 1.21 slutade ORT skicka med
 * en binär för darwin/x64, och den här maskinen är en Intel-Mac. 1.20.1 bär både den och Linux
 * arm64/x64, alltså både utvecklingsmaskinen och Oracle-burken.
 *
 * Deklarerar bara det segment.ts faktiskt anropar. Ett `declare module` utan innehåll hade tystat
 * felet men också tagit bort typkontrollen på tensorformen — och det är just formen som är lätt att
 * få fel (NCHW mot NHWC) och svår att se när den blir fel.
 */
declare module "onnxruntime-node" {
  export class Tensor {
    constructor(type: "float32", data: Float32Array, dims: number[]);
    readonly data: Float32Array | Uint8Array | Int32Array;
    readonly dims: readonly number[];
  }

  export interface SessionOptions {
    intraOpNumThreads?: number;
    graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
  }

  export class InferenceSession {
    static create(path: string, options?: SessionOptions): Promise<InferenceSession>;
    readonly inputNames: string[];
    readonly outputNames: string[];
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    release(): Promise<void>;
  }
}
