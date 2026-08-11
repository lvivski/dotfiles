/** @module marker — stable progress markers for correlating native Factory runs. */

const RESERVATION = "foundry:verification-reservation:";

/** Build the exact progress marker emitted by a verification Factory. @param {string} reservationId */
export function verificationMarker(reservationId) {
	return `${RESERVATION}${reservationId}`;
}

/** Parse a verification reservation marker, or return `null`. @param {unknown} value */
export function parseVerificationMarker(value) {
	if (typeof value !== "string" || !value.startsWith(RESERVATION)) return null;
	const reservationId = value.slice(RESERVATION.length);
	return reservationId || null;
}
