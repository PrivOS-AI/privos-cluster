const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

/**
 * The repository half of an image reference, with any digest pin removed.
 *
 * A running container's `image` is pinned to the digest it is SERVING. Reusing
 * it as the base for a reference to a DIFFERENT digest — which is exactly what
 * an upgrade does — makes `resolveImmutableImageReference` refuse the
 * disagreeing pin. Callers that are deliberately moving to a new digest must
 * pass the repository, not the running reference.
 */
export function imageRepositoryOf(image: string): string {
    const pinned = image.match(/^(.*)@sha256:[a-f0-9]{64}$/);
    return pinned ? pinned[1] : image;
}

export function resolveImmutableImageReference(image: string, tag = 'latest', digest?: string): string {
    if (!digest) {
        if (/@sha256:[a-f0-9]{64}$/.test(image)) return image;
        return `${image}:${tag}`;
    }
    if (!DIGEST_PATTERN.test(digest)) throw new Error('Invalid image digest');
    const pinned = image.match(/^(.*)@(sha256:[a-f0-9]{64})$/);
    if (pinned && pinned[2] !== digest) throw new Error('Image digest does not match the repository pin');
    const repository = pinned ? pinned[1] : image;
    if (!repository || repository.includes('@')) throw new Error('Invalid image repository');
    return `${repository}@${digest}`;
}
