import { EventEmitter } from "node:events";

const emitter = new EventEmitter();
emitter.setMaxListeners(100);

function key(workspacePath, planId) {
    return `${workspacePath}\0${planId}`;
}

export function publishPlanChange(event) {
    emitter.emit(key(event.workspacePath, event.planId), event);
}

export function subscribeToPlan(workspacePath, planId, listener) {
    const eventName = key(workspacePath, planId);
    emitter.on(eventName, listener);
    return () => emitter.off(eventName, listener);
}
