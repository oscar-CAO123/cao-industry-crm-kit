import { S3Client } from "@aws-sdk/client-s3";

// The image build loads every route to collect its settings, and no file store is set then. Placeholders are used only
// during that build; a running server still refuses to start the file store without its four settings.
const building = process.env.NEXT_PHASE === "phase-production-build";
function need(name: string): string {
  const value = process.env[name];
  if (value) return value;
  if (building) return "build-placeholder";
  throw new Error(`${name} is not defined`);
}
const endpoint = need("MINIO_ENDPOINT");
const accessKeyId = need("MINIO_ACCESS_KEY");
const secretAccessKey = need("MINIO_SECRET_KEY");
const bucket = need("MINIO_BUCKET");

export const minioClient = new S3Client({
  endpoint,
  region: "us-east-1", // MinIO requires a region value; actual value doesn't matter
  credentials: {
    accessKeyId,
    secretAccessKey,
  },
  forcePathStyle: true, // REQUIRED for MinIO — without this, SDK uses virtual-hosted-style which breaks
});

export const MINIO_BUCKET = bucket;
export const MINIO_PUBLIC_URL = process.env.NEXT_PUBLIC_MINIO_ENDPOINT;
