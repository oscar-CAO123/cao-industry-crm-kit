import { GET, POST, DELETE } from "@/app/api/[...unknown]/route";

it("answers 404 for any /api path without its own route", async () => {
  for (const handler of [GET, POST, DELETE]) expect((await handler()).status).toBe(404);
});
