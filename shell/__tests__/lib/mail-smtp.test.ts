// How the shell connects to mail: one SMTP_URL handed to nodemailer.createTransport, then sendMail. These cases were
// recorded from nodemailer 8.0.5 and produced identical results on 10.1.4 (the two-major upgrade of 10 Nov 2026), so a
// future mail-library change that reads a connection URL differently fails here before it reaches a deploy.
import nodemailer from "nodemailer";

type Opts = { host?: string; port?: number; secure?: boolean; requireTLS?: boolean; pool?: boolean; auth?: { user?: string; pass?: string } };
const opts = (url: string) => nodemailer.createTransport(url).options as unknown as Opts;

describe("SMTP_URL is read the same way", () => {
  test("plain and secure ports, with credentials", () => {
    expect(opts("smtp://user:pass@smtp.example.com:587")).toMatchObject({ host: "smtp.example.com", port: 587, secure: false, auth: { user: "user", pass: "pass" } });
    expect(opts("smtps://apikey:SG.abc_def-123@smtp.sendgrid.net:465")).toMatchObject({ host: "smtp.sendgrid.net", port: 465, secure: true, auth: { user: "apikey", pass: "SG.abc_def-123" } });
  });

  test("percent-encoded and awkward characters in the user name and password", () => {
    const o = opts("smtp://user%40example.com:p%40ss%3Aw%2Frd@smtp.example.com:587");
    expect(o.auth).toEqual({ user: "user@example.com", pass: "p@ss:w/rd" });
    expect(opts("smtp://us.er:pa.ss@mail.example.co.uk:2525")).toMatchObject({ host: "mail.example.co.uk", port: 2525, auth: { user: "us.er", pass: "pa.ss" } });
    expect(opts("smtp://user:p@ss@smtp.example.com:587")).toMatchObject({ host: "smtp.example.com", auth: { user: "user", pass: "p@ss" } });
  });

  test("no port, no credentials, an IPv6 host, and options in the query string", () => {
    expect(opts("smtp://user:pass@smtp.example.com")).toMatchObject({ host: "smtp.example.com", secure: false, auth: { user: "user" } });
    expect(opts("smtp://smtp.example.com:25")).toMatchObject({ host: "smtp.example.com", port: 25 });
    expect(opts("smtp://smtp.example.com:25").auth).toBeUndefined();
    expect(opts("smtp://user:pass@[2001:db8::1]:587")).toMatchObject({ host: "2001:db8::1", port: 587 });
    expect(opts("smtp://user:pass@smtp.example.com:587/?pool=true&secure=false")).toMatchObject({ pool: true, secure: false });
    expect(opts("smtp://user:pass@smtp.example.com:587?requireTLS=true")).toMatchObject({ requireTLS: true });
  });
});

describe("a message is built with the fields the shell sends", () => {
  test("from, to (two recipients), subject, text and html all arrive", async () => {
    const r = await nodemailer.createTransport({ jsonTransport: true }).sendMail({ from: "a@example.com", to: "b@example.com, c@example.com", subject: "Hello", text: "plain", html: "<p>html</p>" });
    const m = JSON.parse(String((r as unknown as { message: string }).message));
    expect(Object.keys(m).sort()).toEqual(["from", "headers", "html", "messageId", "subject", "text", "to"]);
    expect(m.to).toHaveLength(2);
    expect(m.subject).toBe("Hello");
    expect(m.html).toBe("<p>html</p>");
  });
});
