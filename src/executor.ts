import fs from "fs";
import path from "path";
import vm from "vm";
import Module from "module";
import * as ts from "@tslab/typescript-for-tslab";
import {
  Converter,
  CompletionInfo,
  IsCompleteResult,
  SideOutput
} from "./converter";

export interface Executor {
  /**
   * Transpiles and executes `src`.
   *
   * Note: Although this method returns a promise, `src` is executed immdiately
   * when this code is executed.
   * @param src source code to be executed.
   * @returns Whether `src` was executed successfully.
   */
  execute(src: string): Promise<boolean>;
  inspect(src: string, position: number): ts.QuickInfo;
  complete(src: string, positin: number): CompletionInfo;
  isCompleteCode(src: string): IsCompleteResult;
  reset(): void;

  /**
   * Interrupts non-blocking code execution. This method is called from SIGINT signal handler.
   * Note that blocking code execution is terminated by SIGINT separately because it is impossible
   * to call `interrupt` while `execute` is blocked.
   */
  interrupt(): void;
  locals: { [key: string]: any };

  /** Release internal resources to terminate the process gracefully. */
  close(): void;
}

export interface ConsoleInterface {
  log(message?: any, ...optionalParams: any[]): void;
  error(message?: any, ...optionalParams: any[]): void;
}

/**
 * createRequire creates `require` which resolves modules from `rootDir`.
 */
export function createRequire(rootDir: string): NodeRequire {
  // createRequire is added in Node v12. createRequireFromPath is deprecated.
  const create = Module.createRequire || Module.createRequireFromPath;
  return create(path.join(rootDir, "src.js"));
}

/**
 * Wrap `require` to hook import of tslab and imports from sideOutputs.
 */
function wrapRequire(
  req: NodeRequireFunction,
  dirname: string,
  sideOutputs: Map<string, string>,
  sideModules: Map<string, NodeModule>
): NodeRequireFunction {
  function requireFromSideOutputs(id: string): any {
    let filename = path.join(dirname, id);
    if (path.extname(filename) === "") {
      filename += ".js";
    }
    const cached = sideModules.get(filename);
    if (cached) {
      return cached.exports;
    }
    if (!sideOutputs.has(filename)) {
      return null;
    }
    const mod = new Module(filename, module);
    // Emulate load of Module:
    // https://github.com/nodejs/node/blob/118b28abed73f82f0d6aab33031edfc78934d90f/lib/internal/modules/cjs/loader.js#L1033
    mod.filename = filename;
    mod.paths = Module["_nodeModulePaths"](path.dirname(filename));
    // Wrap require to hook tslab and imports from sideOutputs.
    mod.require = wrapRequire(
      mod.require,
      path.dirname(filename),
      sideOutputs,
      sideModules
    );
    (mod as any)._compile(sideOutputs.get(filename), filename);
    sideModules.set(filename, mod);
    return mod.exports;
  }

  return new Proxy<NodeRequireFunction>(req, {
    // TODO: Test this behavior.
    apply: (_target: object, thisArg: any, argArray?: any): any => {
      if (argArray.length !== 1) {
        return req.apply(thisArg, argArray);
      }
      const arg = argArray[0];
      if (arg === "tslab") {
        // Hook require('tslab').
        return require("..");
      }
      const mod = requireFromSideOutputs(arg);
      if (mod) {
        return mod;
      }
      return req.apply(thisArg, argArray);
    }
  });
}

export function createExecutor(
  rootDir: string,
  conv: Converter,
  console: ConsoleInterface
): Executor {
  const locals: { [key: string]: any } = {};

  const sideOutputs = new Map<string, string>();
  const sideModules = new Map<string, NodeModule>();
  function updateSideOutputs(outs: SideOutput[]): void {
    for (const out of outs) {
      if (!sideModules.has(out.path)) {
        sideModules.delete(out.path);
      }
      sideOutputs.set(out.path, out.data);
    }
  }

  let exports: any = null;
  const req = wrapRequire(
    createRequire(rootDir),
    rootDir,
    sideOutputs,
    sideModules
  );
  const proxyHandler: ProxyHandler<{ [key: string]: any }> = {
    get: function(_target, prop) {
      if (prop === "require") {
        return req;
      }
      if (prop === "exports") {
        return exports;
      }
      if (locals.hasOwnProperty(prop)) {
        return locals[prop as any];
      }
      return global[prop];
    }
  };
  const sandbox = new Proxy(locals, proxyHandler);
  vm.createContext(sandbox);

  let prevDecl = "";

  let interrupted = new Error("Interrupted asynchronously");
  let rejectInterruptPromise: (reason?: any) => void;
  let interruptPromise: Promise<void>;
  function resetInterruptPromise(): void {
    interruptPromise = new Promise((_, reject) => {
      rejectInterruptPromise = reject;
    });
    // Suppress "UnhandledPromiseRejectionWarning".
    interruptPromise.catch(() => {});
  }
  resetInterruptPromise();

  function interrupt(): void {
    rejectInterruptPromise(interrupted);
    resetInterruptPromise();
  }

  function createExports(locals: { [key: string]: any }) {
    const exprts: { [key: string]: any } = {};
    return new Proxy(exprts, {
      set: (_target, prop, value) => {
        locals[prop as any] = value;
        return true;
      }
    });
  }

  async function execute(src: string): Promise<boolean> {
    const converted = conv.convert(prevDecl, src);
    if (converted.sideOutputs) {
      updateSideOutputs(converted.sideOutputs);
    }
    if (converted.diagnostics.length > 0) {
      for (const diag of converted.diagnostics) {
        console.error(
          "%d:%d - %s",
          diag.start.line + 1,
          diag.start.character + 1,
          diag.messageText
        );
      }
      return false;
    }
    if (!converted.output) {
      prevDecl = converted.declOutput || "";
      return true;
    }
    let promise: Promise<any> = null;
    try {
      // Wrap code with (function(){...}) to improve the performance (#11)
      // Also, it's necessary to redeclare let and const in tslab.
      exports = createExports(locals);
      const prefix = converted.hasToplevelAwait
        ? "(async function() { "
        : "(function() { ";
      const wrapped = prefix + converted.output + "\n})()";
      const ret = vm.runInContext(wrapped, sandbox, {
        breakOnSigint: true
      });
      if (converted.hasToplevelAwait) {
        promise = ret;
      }
    } catch (e) {
      console.error(e);
      return false;
    }
    if (promise) {
      try {
        await Promise.race([promise, interruptPromise]);
      } catch (e) {
        console.error(e);
        return false;
      }
    }
    prevDecl = converted.declOutput || "";
    if (
      converted.lastExpressionVar &&
      locals[converted.lastExpressionVar] != null
    ) {
      let ret: any = locals[converted.lastExpressionVar];
      delete locals[converted.lastExpressionVar];
      console.log(ret);
    }
    return true;
  }

  function inspect(src: string, position: number): ts.QuickInfo {
    return conv.inspect(prevDecl, src, position);
  }

  function complete(src: string, position: number): CompletionInfo {
    return conv.complete(prevDecl, src, position);
  }

  function reset(): void {
    prevDecl = "";
    for (const name of Object.getOwnPropertyNames(locals)) {
      delete locals[name];
    }
  }

  function isCompleteCode(src: string): IsCompleteResult {
    return conv.isCompleteCode(src);
  }

  function close(): void {
    conv.close();
  }

  return {
    execute,
    inspect,
    complete,
    locals,
    reset,
    interrupt,
    isCompleteCode,
    close
  };
}
