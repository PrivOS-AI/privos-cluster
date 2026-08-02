const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

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
