/**
 * In-process plan-change notifications used to refresh open Mobius canvases.
 *
 * @module mobius/events
 */
import { EventEmitter } from "node:events";

/**
 * @typedef {object} PlanChangeEvent
 * @property {string} workspacePath Session workspace that owns the plan.
 * @property {string} planId Stable Mobius plan identifier.
 * @property {number} revision Persisted plan revision after the change.
 */

/** Shared emitter for the current extension process. */
const emitter = new EventEmitter();
emitter.setMaxListeners(100);

/**
 * Builds a collision-resistant emitter key for one workspace-owned plan.
 *
 * @param {string} workspacePath
 * @param {string} planId
 * @returns {string}
 */
function key(workspacePath, planId) {
    return `${workspacePath}\0${planId}`;
}

/**
 * Publishes a persisted plan change to local canvas subscribers.
 *
 * @param {PlanChangeEvent} event
 * @returns {void}
 */
export function publishPlanChange(event) {
    emitter.emit(key(event.workspacePath, event.planId), event);
}

/**
 * Subscribes to changes for one plan.
 *
 * @param {string} workspacePath
 * @param {string} planId
 * @param {(event: PlanChangeEvent) => void} listener
 * @returns {() => void} Unsubscribe callback.
 */
export function subscribeToPlan(workspacePath, planId, listener) {
    const eventName = key(workspacePath, planId);
    emitter.on(eventName, listener);
    return () => emitter.off(eventName, listener);
}
