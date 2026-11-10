# Fetches keys with the 1Password Python SDK. The token and references arrive on
# stdin only, never argv or the environment, so no other program can read them.
#   stdin:  line 1 = service account token, then one op:// reference per line,
#           or the single word "vault-list" or "item-names".
#   item-names prints each item's op:// references (item and field names), never a value.
#   stdout: each resolved value followed by NUL, then "OK" and NUL.
import asyncio
import sys

PYLIB = "/usr/local/libexec/op-scoped/pylib"
sys.path.insert(0, PYLIB)

try:
    from onepassword.client import Client
except Exception as e:
    print(f"op-scoped: 1Password library failed to load ({type(e).__name__})", file=sys.stderr)
    sys.exit(1)


def clean(text: str) -> str:
    return "".join(c if c.isprintable() else "?" for c in text)


async def main() -> int:
    lines = sys.stdin.read().split("\n")
    token, refs = lines[0], [r for r in lines[1:] if r]
    del lines
    try:
        client = await Client.authenticate(auth=token, integration_name="op-scoped", integration_version="2.0")
    except Exception as e:
        print(f"op-scoped: sign-in failed ({type(e).__name__})", file=sys.stderr)
        return 1
    del token

    out = sys.stdout
    try:
        if refs == ["vault-list"]:
            for v in await client.vaults.list():
                out.write(f"{v.id}  {v.title}\n")
            return 0
        if refs == ["item-names"]:
            for v in await client.vaults.list():
                for o in sorted(await client.items.list(v.id), key=lambda o: o.title.lower()):
                    item = await client.items.get(v.id, o.id)
                    sections = {sec.id: sec.title for sec in item.sections}
                    for f in item.fields:
                        sec = sections.get(f.section_id or "", "")
                        path = f"{sec}/{f.title}" if sec else f.title
                        out.write(clean(f"op://{v.title}/{item.title}/{path}") + "\n")
                    del item
            return 0
        for r in refs:
            out.write(await client.secrets.resolve(r) + "\0")
    except Exception as e:
        print(f"op-scoped: read failed ({type(e).__name__})", file=sys.stderr)
        return 1
    out.write("OK\0")
    return 0


sys.exit(asyncio.run(main()))
