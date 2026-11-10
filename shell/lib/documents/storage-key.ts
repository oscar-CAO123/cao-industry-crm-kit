// A storage key is only ever issued by /api/upload/presigned-url: a known folder, a random UUID and a short extension.
// Anything else sent by a browser is refused, so a client can never point a document row at somebody else's file.
const ISSUED_KEY = /^(avatars|images|documents|uploads)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9]{1,10}$/;

export function isIssuedKey(key: unknown): key is string {
  return typeof key === "string" && ISSUED_KEY.test(key);
}

/** The stored file URL must be https (http only for a local MinIO host) and must be exactly the URL of the issued key. */
export function isIssuedFileUrl(url: unknown, key: string, publicBase: string | undefined, bucket: string | undefined): boolean {
  if (typeof url !== "string" || !publicBase || !bucket) return false;
  return url === `${publicBase}/${bucket}/${key}`;
}

/** Only the person who created a document, or an admin, may delete it. */
export function canManageDocument(user: { id: string; role?: string | null }, doc: { createdBy?: string | null }): boolean {
  return user.role === "admin" || (!!doc.createdBy && doc.createdBy === user.id);
}
