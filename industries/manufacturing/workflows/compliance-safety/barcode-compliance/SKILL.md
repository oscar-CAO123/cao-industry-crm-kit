---
name: manufacturing-barcode-compliance
description: Checks a manufacturer's product barcodes against GS1 rules (digits, 8, 12, 13 or 14 digits, correct check digit, no two products sharing one) and turns a corrected GTIN into an approved update in Unleashed. Use when setting this up for a client, when the check flags products, or when an owner asks why a barcode has not changed.
---

# Barcode compliance

Checks each active product's barcode against GS1 rules. The rules are a format check (digits only, 8, 12, 13 or 14 digits, a correct check digit) and a duplicate check (two products sharing one GTIN). The checks read the product master only. Nothing changes a product until a person approves it.

## What runs on its own
Two crons in `index.ts`, scheduled by `workflow.json`:
- `check-barcodes` (daily) reads the product list and stores a finding for each active product: ok, or flagged with the reasons.
- `queue-fixes` (every 30 minutes) takes each corrected GTIN a person has recorded and queues one barcode update for approval.

The crons read and queue. Every barcode change waits in the CRM shell until a person approves it.

## Setting it up for a client
1. Confirm the client's system is Unleashed and that its API ID, API key and client type are in the deploy environment (`UNLEASHED_API_ID`, `UNLEASHED_API_KEY`, `UNLEASHED_CLIENT_TYPE`). Core signs every call with them. The workflow has not yet run against a real Unleashed account (see gaps), so watch the first run.
2. Fill `settings.json` from `settings.example.json`: the business name.
3. Run the first check and read the flagged list with the owner before anything is changed.

## When a product is flagged
- `no barcode`: the product has none. Ask the owner whether it is sold to customers. A product that is not sold does not need one.
- `check digit is wrong` or `not digits only`: the number was typed or copied wrong. Check it against the carton or the GS1 licence before changing anything.
- `same barcode as ...`: two products share a GTIN. One of them is wrong or was copied. Do not change either until the owner says which product owns the number.
- Length errors: GS1 keys are 8, 12, 13 or 14 digits. Any other length is not a GTIN. Confirm where the number came from (GS1, or a case or pack level number that needs its own GS1 key).

## Recording a corrected GTIN
Only the owner can give a corrected GTIN, from their own GS1 allocation or a verified carton. Record it as a fix (product guid, barcode, digits only) in the workflow store. The next `queue-fixes` run queues the update for approval. Never make up a GTIN, and never enter a number you have not verified.

## Not covered
GTIN allocation from GS1, barcode image generation, print quality checks, retailer and EDI sync, and renewals. Do these the business's usual way. Fishbowl and Odoo barcode checks are not built: the kit has no mapped operations for them yet.
