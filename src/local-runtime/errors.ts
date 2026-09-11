/**
 * Stable driver error types for the `privos-local-runtime-driver-v1` ABI —
 * TS port of `infra/local-runtime-driver/privos_local_runtime_driver/errors.py`.
 * Every error carries a stable `code` (surfaced to the Hub in the response
 * body) and an HTTP `status` the route handlers map 1:1.
 */
export class DriverError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = new.target.name;
	}
}

/** The ENSURE_READY/ACTIVATE/REMOVE request (or persisted evidence) failed contract validation. */
export class ContractError extends DriverError {
	constructor(message = 'The local runtime ABI request is invalid.') {
		super('ENSURE_READY_INVALID', message, 422);
	}
}

/** The staged artifact failed digest, size, or OCI-layout verification. */
export class ArtifactError extends DriverError {
	constructor(message = 'The local runtime artifact failed verification.') {
		super('LOCAL_ARTIFACT_INVALID', message, 422);
	}
}

/** An ENSURE_READY/ACTIVATE/REMOVE request for a known runtime/generation carries different immutable affinity than the persisted record. */
export class AffinityConflict extends DriverError {
	constructor(message = 'The generation is already claimed with different affinity.') {
		super('GENERATION_AFFINITY_CONFLICT', message, 409);
	}
}

/** Docker (or the free-space preflight, or the readiness probe) could not bring the runtime to the requested state. */
export class RuntimeUnavailable extends DriverError {
	constructor(message = 'The supervised local runtime is not ready.') {
		super('LOCAL_RUNTIME_UNAVAILABLE', message, 503);
	}
}

/** No claimed runtime exists for the requested `runtime_id`/`generation_id`. */
export class RuntimeNotFound extends DriverError {
	constructor() {
		super('LOCAL_RUNTIME_NOT_FOUND', 'No claimed runtime exists for this generation.', 404);
	}
}

/** ENSURE_READY referenced an `artifact.digest` that was never staged via the `stage` op. */
export class ArtifactNotStaged extends DriverError {
	constructor() {
		super('ARTIFACT_NOT_STAGED', 'The referenced artifact digest was never staged.', 409);
	}
}

/** The artifact store rejected a stage attempt before any write (free-space preflight, size ceiling). */
export class ArtifactStagingRefused extends DriverError {
	constructor(message: string) {
		super('LOCAL_ARTIFACT_STAGING_REFUSED', message, 422);
	}
}
