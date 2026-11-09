/** @template T @returns {{promise: Promise<T>, resolve: (value: T | PromiseLike<T>) => void, reject: (error?: unknown) => void}} */
export function deferred() {
	/** @type {(value: T | PromiseLike<T>) => void} */
	let resolve = () => { throw new Error("Deferred promise was not initialized"); };
	/** @type {(error?: unknown) => void} */
	let reject = () => { throw new Error("Deferred promise was not initialized"); };
	/** @type {Promise<T>} */
	const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
	return { promise, resolve, reject };
}
