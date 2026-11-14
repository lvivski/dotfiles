import type { CopilotSession } from "@github/copilot-sdk";
import type { OfferedToolExecutor } from "./parallel.js";

type Assert<T extends true> = T;
type Fits<A, B> = [A] extends [B] ? true : false;
type NativePort = NonNullable<CopilotSession["rpc"]["tools"]>;
type ExecuteInput = Assert<Fits<Parameters<OfferedToolExecutor["execute"]>[0], Parameters<NativePort["execute"]>[0]>>;
type ExecutePort = Assert<Fits<NativePort, OfferedToolExecutor>>;

declare const executor: OfferedToolExecutor;
executor.execute({ name: "get_session", arguments: { project_session_id: "child" }, toolCallId: "call" });
// @ts-expect-error The consumed executor requires explicit JSON arguments.
executor.execute({ name: "get_session" });
// @ts-expect-error Functions cannot cross the offered tool's JSON boundary.
executor.execute({ name: "get_session", arguments: { callback: () => "child" } });
// @ts-expect-error Offered-tool invocation cannot override native permissions.
executor.execute({ name: "get_session", arguments: {}, skipPermission: true });
const result = executor.execute({ name: "get_session", arguments: {} });
// @ts-expect-error Raw results must be decoded before claiming successful admission.
result.then(value => value.accepted);
