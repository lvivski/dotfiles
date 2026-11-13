import type { CopilotSession } from "@github/copilot-sdk";
import type { OfferedToolExecutor } from "./parallel.js";

type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;
type NativePort = NonNullable<CopilotSession["rpc"]["tools"]>;
type ExecuteInput = Assert<Fits<Parameters<OfferedToolExecutor["execute"]>[0], Parameters<NativePort["execute"]>[0]>>;
type ExecutePort = Assert<Fits<NativePort, OfferedToolExecutor>>;
